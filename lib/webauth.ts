
/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/
const BBPromise = require('bluebird');
const util = require('./util');
const UNP = require('./unp-constants');

const authLogger = util.loggers.authLogger;
const REASON_ZLUX_SESSION_EXPIRE = 'ZLUXSessionExp';

//It is not enough for an auth to not return an expiration value, or 0. It must be explicit
const TIMEOUT_VALUE_NO_EXPIRE = -1;

function initZLUXSession(req: any) {
  if (!req.session.zlux) {
    req.session.zlux = {};
  }
}

function getAuthHandler(req: any, authManager: any) {
  const appData = req[`${UNP.APP_NAME}Data`];
  if (appData.service && appData.service.def) {
    const service = appData.service.def;
    const authenticationData = service.configuration.getContents(
        ['authentication.json']);
    if (authenticationData) {
      return authManager.getAuthHandlerForService(authenticationData);
    }
  } 
  return authManager.getBestAuthenticationHandler(null);
}

function getAuthPluginSession(req: any, pluginID: any, dflt: any) {
  if (req.session && req.session.authPlugins) {
    let value = req.session.authPlugins[pluginID];
    if (value) {
      return value;
    }
  }
  return dflt;
}

function setAuthPluginSession(req: any, pluginID: any, authPluginSession: any) {
  if (req.session) {
    // FIXME Note that it does something only when req.session.authPlugins[pluginID] is 
    // undefined. Otherwise it does nothing (see getAuthPluginSession()) 
    // -- don't get confused

    if (!req.session.authPlugins) {
      req.session.authPlugins = {};
    }

    req.session.authPlugins[pluginID] = authPluginSession;
  }
}

function getRelevantHandlers(authManager: any, body: any) {
  let handlers = authManager.getAllHandlers();
  if (body && body.categories) {
    const authCategories = {};
    body.categories.map(t => authCategories[t] = true);
    handlers = handlers.filter(h => 
      authCategories.hasOwnProperty(h.pluginDef.authenticationCategory));
  }
  return handlers;
}

export class AuthResponse{
  private categories: any;
  public keyField: any;
  public expms: any;

  constructor() {
    /* TODO 
     * this.doctype = ...;
     * this.version = ...;
     */
    this.categories = {};
  }

  /**
   * Takes a report from an auth plugin and adds it to the structure 
   */
  addHandlerResult(handlerResult: any, handler: any) {
    const pluginID = handler.pluginID;
    const authCategory = handler.pluginDef.authenticationCategory;
    const authCategoryResult = util.getOrInit(this.categories, authCategory, {
      [this.keyField]: false,
      plugins: {}
    });
    if (handlerResult[this.keyField]) {
      authCategoryResult[this.keyField] = true;
    }
    //alert client of when this session expires one way or another
    if (handlerResult.authenticated && !handlerResult.expms) {
      //handler may only know expiration time due to login process, as a response,
      //or may know ahead of time due to set value or retrievable server config.
      handlerResult.expms = handler.sessionExpirationMS;
    }
    //overall expiration when last auth expires
    if (!this.expms
        || (handlerResult.expms && handlerResult.expms > this.expms)) {
      this.expms = handlerResult.expms;
    }
    authCategoryResult.plugins[pluginID] = handlerResult;
  }
  
  /**
   * Checks if all auth types are successful (have at least one succesful plugin)
   * and updates the summary field on this object
   */
  updateStatus(defaultExpiration: any) {
    let result = false;
    for (const type of Object.keys(this.categories)) {
      const authCategoryResult = this.categories[type];
      if (!((typeof authCategoryResult) === "object")) {
        continue;
      }
      if (!authCategoryResult[this.keyField]) {
        result = false;
        break;
      } else {
        result = true;
      }
    }
    //default expiration if none found
    if (!this.expms) {
      this.expms = defaultExpiration;
    }
    this[this.keyField] = result;
  }
}

class LoginResult extends AuthResponse{
  constructor() {
    super()
  }
  
  keyField = "success"
}

class StatusResponse extends AuthResponse{
  constructor() {
    super()
  }
 
  keyField: "authenticated"
}

const SESSION_ACTION_TYPE_AUTHENTICATE = 1;
const SESSION_ACTION_TYPE_REFRESH = 2;

/*
 * Assumes req.session is there and behaves as it should
 */
module.exports = function(authManager: any) {
  const _authenticateOrRefresh = BBPromise.coroutine(function*(req: any, res: any, type: any) {
    let functionName: string;
    if (type == SESSION_ACTION_TYPE_AUTHENTICATE) {
      functionName = 'authenticate';
    } else if (type == SESSION_ACTION_TYPE_REFRESH) {
      functionName = 'refreshStatus';
    } else {
      res.status(500).json({error: "Invalid session action type attempted"});
      return;
    }
    
    try {
      const result: any = new LoginResult();
      const handlers = getRelevantHandlers(authManager, req.body);
      const authServiceHandleMaps = 
            req[`${UNP.APP_NAME}Data`].webApp.authServiceHandleMaps;

      const timeout = req.session.zlux ? req.session.zlux.expirationTime : 0;
      for (const handler of handlers) {
        const pluginID = handler.pluginID;
        const authPluginSession = getAuthPluginSession(req, pluginID, {});
        req[`${UNP.APP_NAME}Data`].plugin.services = 
          authServiceHandleMaps[pluginID];
        
        const authHandlerStatus = handler.getStatus(authPluginSession);
        const wasAuthenticated = authHandlerStatus.authenticated;
        const hasGetCapabilities = !!((typeof handler.getCapabilities) === 'function');
        let handlerResult;

       if(!hasGetCapabilities){
         authLogger.warn(`${pluginID}: getCapabilities() is not a function`);
       }

        if(type === SESSION_ACTION_TYPE_REFRESH){
          if(authManager.sessionTimeoutMs !== TIMEOUT_VALUE_NO_EXPIRE
              && (!timeout || timeout < Date.now())){
            req.session.zlux = undefined;
            handlerResult = {success:false, reason:REASON_ZLUX_SESSION_EXPIRE};
          } else if (hasGetCapabilities && handler.getCapabilities().canRefresh){
            handlerResult = yield handler.refreshStatus(req, authPluginSession);
          } else {
            handlerResult = { success: true };
          }
        } else if(type == SESSION_ACTION_TYPE_AUTHENTICATE){
          handlerResult = yield handler.authenticate(req, authPluginSession);
        }
          
        if (handlerResult.success) {
          authLogger.info(`${req.session.id}: Session security call ${functionName} succesful for auth ` 
                          + `handler ${pluginID}. Plugin response: ` + JSON.stringify(handlerResult));
        } else {
          authLogger.info(`${req.session.id}: Session security call ${functionName} failed for auth ` 
                          + `handler ${pluginID}. Plugin response: ` + JSON.stringify(handlerResult));
        }
        //do not modify session if not authenticated or deauthenticated
        if (wasAuthenticated || handlerResult.success) {
          setAuthPluginSession(req, pluginID, authPluginSession);
        }
        result.addHandlerResult(handlerResult, handler);
      }
      
      result.updateStatus(authManager.sessionTimeoutMs);
      if (result.expms !== TIMEOUT_VALUE_NO_EXPIRE) {
        initZLUXSession(req);
        req.session.zlux.expirationTime = Date.now() + result.expms;
      }
      
      res.status(result.success? 200 : 401).json(result);
    } catch (e) {
      authLogger.warn(e);
      res.status(500).send(e.message);
      return;
    }
  });

  
  return {
    
    addProxyAuthorizations(req1: any, req2Options: any) {
      const handler = getAuthHandler(req1, authManager);
      if (!handler) {
        return;
      }
      const authPluginSession = getAuthPluginSession(req1, handler.pluginID, {});
      handler.addProxyAuthorizations(req1, req2Options, authPluginSession);     
    },
    
    getStatus(req: any, res: any) {
      const handlers = authManager.getAllHandlers();
      const result = new StatusResponse();
      for (const handler of handlers) {
        const pluginID = handler.pluginID;
        const authPluginSession = util.getOrInit(req.session, pluginID, {});
        let status;
        try {
          status = handler.getStatus(authPluginSession);
        } catch (error) {
          status = {
            error
          }
        }
        result.addHandlerResult(status, handler);
      }
      res.status(200).json(result);
    },

    refreshStatus(req: any, res: any) {
      return _authenticateOrRefresh(req,res,SESSION_ACTION_TYPE_REFRESH);
    },
    
    doLogin(req: any, res: any) {
      return _authenticateOrRefresh(req,res,SESSION_ACTION_TYPE_AUTHENTICATE);
    },
    
    doLogout(req: any, res: any) {
      //FIXME XSRF
      const handlers = getRelevantHandlers(authManager, req.body);
      for (const handler of handlers) {
        const pluginID = handler.pluginID;
        authLogger.debug(`${req.session.id}: User logout for auth handler ${pluginID}`);
        if (req.session.authPlugins) {
          delete req.session.authPlugins[pluginID];
        }
      }
      if (Object.keys(req.session.authPlugins).length == 0) {
        if (req.session.id) {
          req.session.zlux = undefined;
        }
        req.sessionStore.destroy(req.session.id);
        // (req.session.id as any) = null;
      }
      res.status(200).send('');
    },
    
    middleware:  BBPromise.coroutine(function*(req: any, res: any, next: any) {
      try {
        const isWebsocket = req.url.endsWith(".websocket");
        if (isWebsocket && (res._header == null)) {
          //workaround for https://github.com/HenningM/express-ws/issues/64
          //copied from https://github.com/HenningM/express-ws/pull/92
          //TODO remove this once that bug is fixed
          res._header = '';
        }
        //TODO maybe we should try all handlers in a category instead?
        //Or, should we denote one handler as "special"?
        const handler = getAuthHandler(req, authManager);
        if (!handler) {
          res.status(401).send('Authentication failed: auth type missing');
          return;
        }
        const authPluginID = handler.pluginID;
        let result;
        const timeout = req.session.zlux ? req.session.zlux.expirationTime : 0;
        if (authManager.sessionTimeoutMs !== TIMEOUT_VALUE_NO_EXPIRE
            && (!timeout || timeout < Date.now())) {
          req.session.zlux = undefined;
          result = {authenticated:false, authorized: false};
        }
        else {
          const authPluginSession = getAuthPluginSession(req, authPluginID, {});
          result = yield handler.authorized(req, authPluginSession, {
            syncOnly: isWebsocket,
            bypassAuthorizatonCheck: !authManager.isRbacEnabled()
          });
        }
        //we only care if its authorized
        if (!result.authorized) {
          const errorResponse = {
            /* TODO doctype/version */
            category: handler.pluginDef.authenticationCategory,
            pluginID: authPluginID,
            result
          };
          //and if not, we can distinguish why: unauthenticated or for
          //another reason
          if (!result.authenticated) {
            res.status(401).json(errorResponse);
            return;
          } else { 
            res.status(403).json(errorResponse);
            return;
          }
        } else {
          next();
          return;
        }
      } catch (e) {
        console.warn(e);
        res.status(500).send(e.message);
        return;
      }
    }),
    
  }
};


/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/
