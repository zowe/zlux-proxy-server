
/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/
const Promise = require('bluebird');
const util = require('./util');
const constants = require('./unp-constants');
const crypto = require('crypto');

const authLogger = util.loggers.authLogger;
const REASON_ZLUX_SESSION_EXPIRE = 'ZLUXSessionExp';

//It is not enough for an auth to not return an expiration value, or 0. It must be explicit
const TIMEOUT_VALUE_NO_EXPIRE = -1;

const HTTP_STATUS_PRECONDITION_REQUIRED = 428;
const EXPIRED_PASSWORD = 'Expired Password';

function initZLUXSession(req) {
  if (!req.session.zlux) {
    req.session.zlux = {};
  }
}

function getAuthHandler(req, authManager) {
  const appData = req[`${constants.APP_NAME}Data`];
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

function getAuthPluginSession(req, pluginID, dflt) {
  if (req.session && req.session.authPlugins) {
    let value = req.session.authPlugins[pluginID];
    if (value) {
      return value;
    }
  }
  return dflt;
}

function setAuthPluginSession(req, pluginID, authPluginSession) {
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

function getRelevantHandlers(authManager, body) {
  let handlers = authManager.getAllHandlers();
  if (body && Array.isArray(body.categories)) {
    const authCategories = {};
    body.categories.map(t => authCategories[t] = true);
    handlers = handlers.filter(h => 
      authCategories.hasOwnProperty(h.pluginDef.authenticationCategory));
  }
  return handlers;
}

const restorePluginHaSession = Promise.coroutine(function*(req, handler, authPluginID, authPluginSession) {
  const result = yield handler.restoreSessionState(req, authPluginSession);
  if (result.success) {
    yield regenerateSessionId(req);
  }
  if (result.success && result.expms !== TIMEOUT_VALUE_NO_EXPIRE) {
    initZLUXSession(req);
    req.session.zlux.expirationTime = Date.now() + result.expms;
  }
  setAuthPluginSession(req, authPluginID, authPluginSession);
});

const regenerateSessionId = function (request) {
  return new Promise((resolve, reject) => {
    request.session.regenerate(err => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  })
}

function AuthResponse() {
  /* TODO 
   * this.doctype = ...;
   * this.version = ...;
   */
  this.categories = {};
}
AuthResponse.prototype = {
  constructor: AuthResponse,
  
  /**
   * Takes a report from an auth plugin and adds it to the structure 
   */
  addHandlerResult(handlerResult, handler, res, cookies) {
    const pluginID = handler.pluginID;
    let authCategories;
    if (handler.getCategories) {
      authCategories = handler.getCategories();
    } else if (handler.pluginDef.authenticationCategories) {
      authCategories = handler.pluginDef.authenticationCategories;
    } else {
      authCategories = [handler.pluginDef.authenticationCategory];
    }
    authCategories.forEach((authCategory)=> {
      const authCategoryResult = util.getOrInit(this.categories, authCategory, {
        [this.keyField]: false,
        plugins: {}
      });
      if (handlerResult[this.keyField]) {
        authCategoryResult[this.keyField] = true;
      }
      authCategoryResult.plugins[pluginID] = handlerResult;
    });
    if (typeof handler.getCapabilities === 'function') {
      handlerResult.capabilities = handler.getCapabilities();
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

    if (cookies) {
      cookies.forEach((cookie)=> {
        if (cookie.name && cookie.value) {
          try {
            res.cookie(cookie.name,cookie.value,cookie.options);
          } catch (e) {
            authLogger.warn(`Auth handler ${handler.pluginDef.identifier} caused exception when setting cookie`);
          }
        }
      });
    }
  },
  
  /**
   * Checks if all auth types are successful (have at least one succesful plugin)
   * and updates the summary field on this object
   */
  updateStatus(defaultExpiration) {
    let result = false;
    for (const type of Object.keys(this.categories)) {
      const authCategoryResult = this.categories[type];
      if (typeof authCategoryResult !== "object") {
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
    if (!this.expms && (defaultExpiration != -1)) {
      this.expms = defaultExpiration;
    }
    this[this.keyField] = result;
  }
}

function LoginResult() {
  AuthResponse.call(this);
}
LoginResult.prototype = {
  constructor: LoginResult,
  __proto__: AuthResponse.prototype,
  
  keyField: "success"
}

function StatusResponse() {
  AuthResponse.call(this);
}
StatusResponse.prototype = {
  constructor: StatusResponse,
  __proto__: AuthResponse.prototype,
  
  keyField: "authenticated"
}

const SESSION_ACTION_TYPE_AUTHENTICATE = 1;
const SESSION_ACTION_TYPE_REFRESH = 2;

/*
 * Assumes req.session is there and behaves as it should
 */
module.exports = function(authManager, cookiePort, isSecurePort) {
  const cookieName = util.getCookieName(cookiePort);
  const _doLogoutInner = Promise.coroutine(function*(req, res) {
    //FIXME XSRF
    const handlers = getRelevantHandlers(authManager, req.body);
    const result = new LoginResult();      
    for (const handler of handlers) {
      const pluginID = handler.pluginID;
      authLogger.info("ZWED0205I", req.session.id, pluginID);
      let handlerResult;
      if (handler.getCapabilities) {
        try {
          let authPluginSession = getAuthPluginSession(req, pluginID, {});
          let caps = handler.getCapabilities();
          if (caps.canLogout === true) {
            handlerResult = yield handler.logout(req, authPluginSession);
          } else {
            handlerResult = {success: true};
          }
        } catch (e) {
          handlerResult = {success: false, reason: e.message};
        }
      } else {
        handlerResult = {success: true};
      }
      result.addHandlerResult(handlerResult, handler, res, handlerResult.cookies);
      if (req.session.authPlugins) {
        delete req.session.authPlugins[pluginID];
      }
    }

    result.updateStatus(-1);
    if (!req.session.authPlugins || Object.keys(req.session.authPlugins).length == 0) {
      if (req.session.id) {
        req.session.zlux = undefined;
        req.sessionStore.destroy(req.session.id);
      }
      req.session.id = null;
      res.clearCookie(cookieName, { path: '/',
                                                   httpOnly: true,
                                                   sameSite: true,
                                                   secure: isSecurePort});
    }

    res.status(result.success? 200 : 500).json(result);
    return;
  });

  const _passwordResetInner = Promise.coroutine(function*(req, res, type) {
    const handlers = authManager.getAllHandlers();
    let handlerResult;
    for (const handler of handlers) {
      const pluginID = handler.pluginID;
      if (pluginID == req.body.serviceHandler) {
        if (handler.getCapabilities) {
          try {
            let authPluginSession = getAuthPluginSession(req, pluginID, {});
            let caps = handler.getCapabilities();
            if (caps.canResetPassword == true) {
              handlerResult = yield handler.passwordReset(req, authPluginSession);
            } else {
              handlerResult = { success: false, response: "Password reset not available"};
            }
          } catch (e) {
            handlerResult = {success: false, response: e.message};
          }
        } else {
          handlerResult = {success: false};
        }
        res.status(handlerResult.success? 200 : 500).json(handlerResult);
        return;
      }
    }
    handlerResult = {success: false, response: "Authentication service for password reset not found"};
    res.status(400).json(handlerResult);
    return;
  });

  const _authenticateOrRefresh = Promise.coroutine(function*(req, res, type) {
    let functionName;
    if (type == SESSION_ACTION_TYPE_AUTHENTICATE) {
      functionName = 'authenticate';
    } else if (type == SESSION_ACTION_TYPE_REFRESH) {
      functionName = 'refreshStatus';
    } else {
      res.status(500).json({error: "ZWED0142E - Invalid session action type attempted"});
      return;
    }
    try {
      const result = new LoginResult();
      const handlers = getRelevantHandlers(authManager, req.body);
      const authServiceHandleMaps = 
            req[`${constants.APP_NAME}Data`].webApp.authServiceHandleMaps;

      const timeout = req.session.zlux ? req.session.zlux.expirationTime : 0;
      for (const handler of handlers) {
        const pluginID = handler.pluginID;
        const authPluginSession = getAuthPluginSession(req, pluginID, {});
        req[`${constants.APP_NAME}Data`].plugin.services = 
          authServiceHandleMaps[pluginID];
        
        const authHandlerStatus = handler.getStatus(authPluginSession);
        const wasAuthenticated = authHandlerStatus.authenticated;
        const hasGetCapabilities = !!((typeof handler.getCapabilities) === 'function');
        let handlerResult;

       if(!hasGetCapabilities){
        authLogger.warn(`ZWED0066W`, pluginID); //authLogger.warn(`${pluginID}: getCapabilities() is not a function`);
       }

        if(type === SESSION_ACTION_TYPE_REFRESH){
          if(authManager.sessionTimeoutMs !== TIMEOUT_VALUE_NO_EXPIRE
              && (timeout && timeout < Date.now())){
            req.session.zlux = undefined;
            handlerResult = {success:false, reason:REASON_ZLUX_SESSION_EXPIRE};
          } else if (hasGetCapabilities && handler.getCapabilities().canRefresh){
            handlerResult = yield handler.refreshStatus(req, authPluginSession);
          } else if (hasGetCapabilities && handler.getCapabilities().canGetStatus){
            handlerResult = handler.getStatus(authPluginSession);
            if (!handlerResult.authenticated) {
              handlerResult = yield handler.authenticate(req, authPluginSession);
            } else {
              handlerResult.success = handlerResult.authenticated;
              delete handlerResult.authenticated;
            }
          } else {
            handlerResult = { success: true };
          }
        } else if(type == SESSION_ACTION_TYPE_AUTHENTICATE){
          handlerResult = yield handler.authenticate(req, authPluginSession);
        }
        let resultCopy = Object.assign({},handlerResult);
        //dont print
        delete resultCopy.cookies;
        delete resultCopy.password;
        if (handlerResult.success) {
          authLogger.info(`ZWED0070I`, req.session.id, functionName, pluginID, JSON.stringify(resultCopy)); //authLogger.info(`${req.session.id}: Session security call ${functionName} succesful for auth ` + `handler ${pluginID}. Plugin response: ` + JSON.stringify(handlerResult));
        } else {
          //new sessions get a refresh call which always fails unless sso is involved, so don't warn for this.
          authLogger[type === SESSION_ACTION_TYPE_AUTHENTICATE ? 'warn' : 'debug'](`ZWED0003W`,
            req.session.id, functionName, pluginID, JSON.stringify(resultCopy));
          //authLogger.info(`${req.session.id}: Session security call ${functionName} failed for auth ` + `handler ${pluginID}. Plugin response: ` + JSON.stringify(handlerResult));
        }
        //do not modify session if not authenticated or deauthenticated
        if (wasAuthenticated || handlerResult.success) {
          setAuthPluginSession(req, pluginID, authPluginSession);
        }
        result.addHandlerResult(resultCopy, handler, res, handlerResult.cookies);
      }
      
      result.updateStatus(authManager.sessionTimeoutMs);
      if (result.expms !== TIMEOUT_VALUE_NO_EXPIRE) {
        initZLUXSession(req);
        req.session.zlux.expirationTime = Date.now() + result.expms;
      }
      result.defaultCategory = authManager.defaultType;
      for (let [authHandler, authObject] of Object.entries(result.categories)) {
        if (authObject.success == false) {
          for (let [authPlugin, authPluginObject] of Object.entries(authObject.plugins)) {
            if (authPluginObject.reason == EXPIRED_PASSWORD) {
              res.status(HTTP_STATUS_PRECONDITION_REQUIRED).json(result);
              return;
            }
          }
        }
      }
      res.status(result.success? 200 : 401).json(result);
    } catch (e) {
      authLogger.warn("ZWED0067W", e); //authLogger.warn(e);
      res.status(500).send(e.message);
      return;
    }
  });

  
  return {
    
    addProxyAuthorizations(req1, req2Options) {
      const handler = getAuthHandler(req1, authManager);
      if (!handler) {
        return;
      }
      const authPluginSession = getAuthPluginSession(req1, handler.pluginID, {});
      try {
        handler.addProxyAuthorizations(req1, req2Options, authPluginSession);
      } catch (e) {
        authLogger.warn(`ZWED0068W`,e); //authLogger.warn(`Failed to set proxy authorizations. Error=`,e);
      }
    },

    processProxiedHeaders(req, headers) {
      const handler = getAuthHandler(req, authManager);
      if (handler && handler.processProxiedHeaders) {
        const authPluginSession = getAuthPluginSession(req, handler.pluginID, {});
        try {
          return handler.processProxiedHeaders(req, headers, authPluginSession);
        } catch (e) {
          return headers;
        }
      } else {
        return headers;
      }
    },    
    
    getStatus(req, res) {
      const handlers = authManager.getAllHandlers();
      const result = new StatusResponse();
      for (const handler of handlers) {
        const pluginID = handler.pluginID;
        const authPluginSession = getAuthPluginSession(req, pluginID, {});
        let status;
        try {
          status = handler.getStatus(authPluginSession);
        } catch (error) {
          status = {
            error
          }
        }
        result.addHandlerResult(status, handler, res);
      }
      res.status(200).json(result);
    },

    refreshStatus(req, res) {
      return _authenticateOrRefresh(req,res,SESSION_ACTION_TYPE_REFRESH);
    },
    
    doLogin(req, res) {
      return _authenticateOrRefresh(req,res,SESSION_ACTION_TYPE_AUTHENTICATE);
    },

    doPasswordReset(req, res) {
      return _passwordResetInner(req, res);
    },
    
    doLogout(req, res) {
      return _doLogoutInner(req, res);
    },

    // This only checks to see if there is a username or not therefore it does
    // not fail even if it is not authenticated or authorized 
    semiAuthenticatedMiddleware: Promise.coroutine(function*(req, res, next) {
      try {
        const isWebsocket = req.url.endsWith(".websocket");
        if (isWebsocket && (res._header == null)) {
          //workaround for https://github.com/HenningM/express-ws/issues/64
          //copied from https://github.com/HenningM/express-ws/pull/92
          //TODO remove this once that bug is fixed
          res._header = '';
        }
        const handler = getAuthHandler(req, authManager);
        if (!handler) {
          res.status(401).send("Authentication failed: auth type missing")
          return;
        }
        const authPluginID = handler.pluginID;
        let result;
        const authPluginSession = getAuthPluginSession(req, authPluginID, {});
        result = yield handler.authorized(req, authPluginSession, {
          syncOnly: isWebsocket,
          bypassAuthorizatonCheck: !authManager.isRbacEnabled
        });
        next();
        return;
      } catch (e) {
        console.warn("ZWED0155W - ", e);
        res.status(500).send("ZWED0155W - " + e.message);
        return;
      }
    }),
    
    middleware: Promise.coroutine(function*(req, res, next) {
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
        const sessionIsEmpty = !req.session.authPlugins && !req.session.zlux;
        const timeout = req.session.zlux ? req.session.zlux.expirationTime : 0;
        const haveToRestoreHaSession = sessionIsEmpty && util.isHaMode();
        if (!haveToRestoreHaSession && authManager.sessionTimeoutMs !== TIMEOUT_VALUE_NO_EXPIRE
            && (!timeout || timeout < Date.now())) {
          req.session.zlux = undefined;
          result = {authenticated:false, authorized: false};
        }
        else {
          const authPluginSession = getAuthPluginSession(req, authPluginID, {});
          const capabilities = typeof handler.getCapabilities === 'function' ? handler.getCapabilities() : undefined;
          if (haveToRestoreHaSession && capabilities && capabilities.haCompatible) {
            yield restorePluginHaSession(req, handler, authPluginID, authPluginSession);
          }
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
        console.warn("ZWED0158W - ", e);
        res.status(500).send("ZWED0158W - " + e.message);
        return;
      }
    }),
    
    generateHaSessionId: function(request) {
      const handlers = authManager.getAllHandlers();
      for (const handler of handlers) {
        const capabilities = typeof handler.getCapabilities === 'function' ? handler.getCapabilities() : undefined;
        const canGenerateHaSessionId = capabilities ? capabilities.canGenerateHaSessionId : false;
        if (canGenerateHaSessionId) {
          const sessionId = handler.generateHaSessionId(request);
          if (sessionId) {
            return sessionId;
          }
        }
      }
      return crypto.randomBytes(24).toString('hex');
    },

  }
};


/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/
