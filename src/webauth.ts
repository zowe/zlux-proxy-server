
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
  if (req.session) {
    let value = req.session[pluginID];
    if (value) {
      return value;
    }
  }
  return dflt;
}

function setAuthPluginSession(req: any, pluginID: any, authPluginSession: any) {
  if (req.session) {
    // FIXME Note that it does something only when req.session[pluginID] is 
    // undefined. Otherwise it does nothing (see getAuthPluginSession()) 
    // -- don't get confused
    req.session[pluginID] = authPluginSession;
  }
}

function getRelevantHandlers(authManager: any, body: any) {
  let handlers = authManager.getAllHandlers();
  if (body && body.categories) {
    const authCategories: any = {};
    body.categories.map((t: any) => authCategories[t] = true);
    handlers = handlers.filter((h: any) => 
      authCategories.hasOwnProperty(h.pluginDef.authenticationCategory));
  }
  return handlers;
}


export class AuthResponse {
    /* TODO 
     * this.doctype = ...;
     * this.version = ...;
     */
    public categories: any;
    public keyField: any;
  
    constructor(){
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
    authCategoryResult.plugins[pluginID] = handlerResult;
  }
  
  /**
   * Checks if all auth types are successful (have at least one succesful plugin)
   * and updates the summary field on this object
   */
  updateStatus() {
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
    (this as any)[this.keyField] = result;
  }
}

class LoginResult extends AuthResponse {
  public keyField: string = "success";
  public success: boolean = false;
  constructor() {
    super()
  }
}

class StatusResponse extends AuthResponse {
  public keyField: string = "authenticated";
  public authenticated: boolean = false;
  constructor() {
    super()
  }
}

const SESSION_ACTION_TYPE_AUTHENTICATE = 1;
const SESSION_ACTION_TYPE_REFRESH = 2;

/*
 * Assumes req.session is there and behaves as it should
 */
module.exports = function(authManager: any) {
  const _authenticateOrRefresh = BBPromise.coroutine(function*(req: any, res: any, type: any) {
    let functionName;
    if (type == SESSION_ACTION_TYPE_AUTHENTICATE) {
      functionName = 'authenticate';
    } else if (type == SESSION_ACTION_TYPE_REFRESH) {
      functionName = 'refreshStatus';
    } else {
      res.status(500).json({error: "Invalid session action type attempted"});
      return;
    }
    
    try {
      const result = new LoginResult();
      const handlers = getRelevantHandlers(authManager, req.body);
      const authServiceHandleMaps = 
            req[`${UNP.APP_NAME}Data`].webApp.authServiceHandleMaps;
      for (const handler of handlers) {
        const pluginID = handler.pluginID;
        const authPluginSession = getAuthPluginSession(req, pluginID, {});
        req[`${UNP.APP_NAME}Data`].plugin.services = 
          authServiceHandleMaps[pluginID];
        const wasAuthenticated = handler.getStatus(authPluginSession).authenticated;
        const handlerResult = yield handler[functionName](req,
                                                          authPluginSession);
        if (handlerResult.success) {
          authLogger.info(`${req.session.id}: Session security call ${functionName} succesful for auth ` 
                          + `handler ${pluginID}. Plugin response: ` + JSON.stringify(handlerResult));
        }          
        //do not modify session if not authenticated or deauthenticated
        if (wasAuthenticated || handlerResult.success) {
          setAuthPluginSession(req, pluginID, authPluginSession);
        }
        result.addHandlerResult(handlerResult, handler);
      }
      result.updateStatus();
      res.status(result.success? 200 : 401).json(result);
    } catch (e) {
      console.warn(e)
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
        delete req.session[pluginID];
      }
      res.status(200).send('');
    },
    
    middleware: BBPromise.coroutine(function*(req: any, res: any, next: any) {
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
        const authPluginSession = getAuthPluginSession(req, authPluginID, {});
        const result = yield handler.authorized(req, authPluginSession, {
          syncOnly: isWebsocket,
          bypassAuthorizatonCheck: !authManager.isRbacEnabled()
        });
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
