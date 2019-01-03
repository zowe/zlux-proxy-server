

/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/

'use strict';
const express = require('express');
const util = require('util');
const url = require('url');
const expressWs = require('express-ws');
const path = require('path');
const Promise = require('bluebird');
const http = require('http');
const https = require('https');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser')
const session = require('express-session');
const zluxUtil = require('./util');
const configService = require('../plugins/config/lib/configService.js');
const proxy = require('./proxy');
const zLuxUrl = require('./url');
const UNP = require('./unp-constants');
const translationUtils = require('./translation-utils');

/**
 * Sets up an Express application to serve plugin data files and services  
 */

const DEFAULT_SESSION_TIMEOUT_MS = 60 /* min */ * 60 * 1000;

const SERVICE_TYPE_NODE = 0;
const SERVICE_TYPE_PROXY = 1;
const PROXY_SERVER_CONFIGJS_URL = '/plugins/com.rs.configjs/services/data/';
//TODO: move this (and other consts) to a commonly accessible constants file when moving to typescript
const WEBSOCKET_CLOSE_INTERNAL_ERROR = 4999; 
const WEBSOCKET_CLOSE_BY_PROXY = 4998;
const WEBSOCKET_CLOSE_CODE_MINIMUM = 3000;
const DEFAULT_READBODY_LIMIT = process.env.ZLUX_DEFAULT_READBODY_LIMIT || 102400;//100kb

var contentLogger = zluxUtil.loggers.contentLogger;
var bootstrapLogger = zluxUtil.loggers.bootstrapLogger;
var installLog = zluxUtil.loggers.installLogger;
var utilLog = zluxUtil.loggers.utilLogger;

const jsonParser = bodyParser.json()
const urlencodedParser = bodyParser.urlencoded({ extended: false })

const proxyMap = new Map();

function DataserviceContext(serviceDefinition, serviceConfiguration, 
    pluginContext) {
  this.serviceDefinition = serviceDefinition;
  this.serviceConfiguration = serviceConfiguration;
  this.plugin = pluginContext;
  this.logger = global.COM_RS_COMMON_LOGGER.makeComponentLogger(
    pluginContext.pluginDef.identifier + "." + serviceDefinition.name);
}
DataserviceContext.prototype = {
  makeSublogger(name) {
    return makeSubloggerFromDefinitions(this.plugin.pluginDef,
        this.serviceDefinition, name);
  },
  
  addBodyParseMiddleware(router) {
    router.use(bodyParser.json({type:'application/json'}));
    router.use(bodyParser.text({type:'text/plain'}));
    router.use(bodyParser.text({type:'text/html'}));
  },
  
  makeErrorObject: zluxUtil.makeErrorObject
};

function do404(URL, res, message) {
  contentLogger.debug("404: "+message+", url="+URL);
  res.statusMessage = message;
  res.status(404).send("<h1>Resource not found, URL: "+URL+"</h1></br><h2>Additional info: "+message+"</h2>");
}

function sendAuthenticationFailure(res, authType) {
  res.status(401).json({
    'error':'unauthorized',
    'plugin':pluginDefinition.identifier,
    'service':serviceDefinition.name,
    'authenticationType':authType
  });
};
function sendAuthorizationFailure(res, authType, resource) {
  res.status(403).json({
    'error':'forbidden',
    'plugin':pluginDefinition.identifier,
    'service':serviceDefinition.name,
    'authenticationType':authType,
    'resource':resource
  });
};

const staticHandlers = {
  plugins: function(plugins) {
    return function(req, res) {
      let parsedRequest = url.parse(req.url, true);
      if (!parsedRequest.query) {
        do404(req.url, res, "A plugin query must be specified");
        return;
      }
      let type = parsedRequest.query["type"];
      /*
        Note: here, we query for installed plugins using a filter of either 'all' or a specific pluginType.
        But, some plugins do not have pluginTypes currently. People can forget to include that information.
        In our code, we've been assuming that plugins that do not declare a type are of type 'application',
        but this should be enforced somehow in the future.
      */
      if (!type) {
        do404(req.url, res, "A plugin type must be specified");
        return;
      }
      const acceptLanguage = 
        translationUtils.getAcceptLanguageFromCookies(req.cookies) || req.headers['accept-language'] || '';
      const pluginDefs = plugins.map(p => p.exportTranslatedDef(acceptLanguage));
      const response = {
        //TODO type/version
        pluginDefinitions: null 
      };
      contentLogger.debug('Type requested ='+type);
      if (type == "all") {
        response.pluginDefinitions = pluginDefs;
      } else {
        response.pluginDefinitions = pluginDefs.filter(def => {
          if (def.pluginType != null) {
            contentLogger.debug('Returning true if type matches, type='
                + def.pluginType);
            return def.pluginType === type;
          } else if (type == 'application') {
            contentLogger.debug('Returning true because type is application');
            return true;
          } else {
            contentLogger.debug('Returning false because type did not match');
            return false;
          }
        });
      }
      res.json(response);
    }
  },
  
  //TODO unify '/plugins' and '/apiManagement/plugins'
  apiManagement(webApp) {
    const r = express.Router();
    r.post('/plugins', jsonParser, function api(req, res) {
      const pluginDef = req.body;
      //TODO rewrite to EvenEmitter
      Promise.resolve().then(() => webApp.options.newPluginHandler(pluginDef))
        .then(() => {
          res.status(200).send('plugin added');
        }, (err) => {
          res.status(400).send('failed to add the plugin: ' + err.message);
          console.warn(err);
        });
    });
    return r;
  },
  
  eureka() {
    const router = express.Router();
    router.get('/server/eureka/info', function(req, res, next) {
      res.send('{"id":"zlux"}');
    });
    router.get('/server/eureka/health', function(req, res, next) {
      res.send('{"status":"UP"}');
    });
    return router;
  }
};

/**
 *  This is passed to every other service of the plugin, so that 
 *  the service can be called by other services under the plugin
 */
function WebServiceHandle(urlPrefix, httpPort, httpsPort) {
  this.urlPrefix = urlPrefix;
  if (httpsPort) {
    this.port = httpsPort;
    this.isHttps = true;
  } else {
    this.port = httpPort;
    this.isHttps = false;
  }
}
WebServiceHandle.prototype = {
  constructor: WebServiceHandle,
  //This is currently suboptimal: it makes an HTTP call
  //to localhost for every service call. We could instead just call
  //the corresponding router directly with mock request and
  //response objects, but that's tricky, so let's do that
  //later.

  //  router: null,
  port: 0,
  urlPrefix: null,

  call(path, options, originalRequest) {
    return new Promise((resolve, reject) => {
      if (typeof path === "object") {
        options = path;
        path = "";
      }
      options = options || {};
      let url = this.urlPrefix;
      if (path) {
        url += '/' + path;
      }
      let rejectUnauthorized;
      let protocol;
      if (this.isHttps) {
        protocol = 'https:';
        rejectUnauthorized = false;
      } else {
        protocol = 'http:';
      }
      const requestOptions = {
        hostname: "localhost",
        port: this.port,
        method: options.method || "GET",
        protocol: protocol,
        path: url,
        auth: options.auth,
        rejectUnauthorized: rejectUnauthorized
      };
      const headers = {};
      if (originalRequest) {
        var cookie = originalRequest.get('cookie');
        if (cookie) {
          headers["Cookie"] = cookie;
        }
      }
      Object.assign(headers, options.headers);
      if (options.body) {
        if (typeof options.body === "string") {
          if (options.contentType) {
            headers["Content-Type"] = options.contentType;
          } else {
            headers["Content-Type"] = "application/json";
          }
          headers["Content-Length"] =  options.body.length;
        } else {
          headers["Content-Type"] = "application/json";
          const json = JSON.stringify(options.body)
          headers["Content-Length"] =  json.length;
          options.body = json;
        }
      }
      //console.log("headers: ", headers)
      if (Object.getOwnPropertyNames(headers).length > 0) {
        requestOptions.headers = headers;
      }
      let httpOrHttps = this.isHttps ? https : http;
      const request = httpOrHttps.request(requestOptions, (response) => {
        var chunks = [];
        response.on('data',(chunk)=> {
          utilLog.debug('Callservice: Data received');
          chunks.push(chunk);
        });
        response.on('end',() => {
          utilLog.debug('Callservice: Service call completed.');
          response.body = Buffer.concat(chunks).toString();
          resolve(response);
        });
      }
      );
      request.on('error', (e) => {
        utilLog.warn('Callservice: Service call failed.');
        reject(e);
      });
      if (options.body) {
        request.write(options.body);
      }
      utilLog.debug('Callservice: Issuing request to service: ' 
          + JSON.stringify(requestOptions, null, 2));
      request.end();
    }
    );
  }
};


const commonMiddleware = {
  /**
   * Initializes the req.mvdData (or whatever the name of the project at the moment is)
   *
   * The request object is cached in the closure scope here, so that a service
   * making a call to another service doesn't have to bother about passing the  
   * authentication data on: we'll do that
   */
  
  addAppSpecificDataToRequest(globalAppData) {
    return function addAppSpecificData(req, res, next) {
      const appData = Object.create(globalAppData);
      if (!req[`${UNP.APP_NAME}Data`]) {
        req[`${UNP.APP_NAME}Data`] = appData; 
      }
      appData.makeErrorObject = zluxUtil.makeErrorObject; 
      if (!appData.webApp) {
        appData.webApp = {};
      } else {
      	appData.webApp = Object.create(appData.webApp);
      }
      appData.webApp.callRootService = function callRootService(name, url, 
          options) {
        return this.rootServices[name].call(url, options, req);
      }
      if (!appData.plugin) {
        appData.plugin = {};
      } else {
      	appData.plugin = Object.create(appData.plugin);
      }
      appData.plugin.callService = function callService(name, url, options) {
        try {
          const allHandles = this.services[name];
          let version = '_current';
          if (appData.service.def.versionRequirements 
              && appData.service.def.versionRequirements[name]) {
            version = appData.service.def.versionRequirements[name];
          }
          const service = allHandles[version];
          return service.call(url, options, req);
        } catch (e) {
          return Promise.reject(e);
        }
      }
      if (!appData.service) {
        appData.service = {};
      } else {
        appData.service = Object.create(appData.service);
      }
      next();
    }
  },
  
  injectPluginDef(pluginDef) {
    return function(req, res, next) {
      req[`${UNP.APP_NAME}Data`].plugin.def = pluginDef;
      next();
    }
  },
  
  injectServiceDef(serviceDef) {
    return function _injectServiceDef(req, res, next) {
      req[`${UNP.APP_NAME}Data`].service.def = serviceDef;
      next();
    }
  },


  /**
   * Injects the service handles to the request so that a service can
   * call other serivces - root services or services created or imported
   * by the plugin, by reading 
   *   req.mvdData.plugin.services[serviceName] 
   * or
   *   req.mvdData.webApp.rootServices[serviceName] 
   *
   * It's context-sensitive, the behaviour depends on the plugin
   */
  injectServiceHandles(serviceHandles, isRoot) {
    if (isRoot) {
      return function injectRoot(req, res, next) {
        //console.log('injecting services: ', Object.keys(serviceHandles))
        req[`${UNP.APP_NAME}Data`].webApp.rootServices = serviceHandles;
        next();
      }
    } else {
      return function inject(req, res, next) {
       // console.log('injecting services: ', Object.keys(serviceHandles))
        req[`${UNP.APP_NAME}Data`].plugin.services = serviceHandles;
        next();
      }
    }
  },
  
  /**
   * A pretty crude request body reader
   */
  readBody() {
    return function readBody(req, res, next) {
      if (req.body) {
        next()
        return;
      }
      var bodyLen = 0;
      const body = [];
      const contentType = req.get('Content-Type');
      if ((req.method != 'POST') && (req.method != 'PUT')) {
        next();
        return;
      }
      var onData = function(chunk) {
        body.push(chunk);
        bodyLen += chunk.length;
        if (bodyLen > DEFAULT_READBODY_LIMIT) {
          req.removeListener('data', onData); 
          req.removeListener('end', onEnd);
          res.send(413, 'content too large');
        }
      };
      var onEnd = function() {
        req.body = Buffer.concat(body).toString();
        next();
        return;
      };
      req.on('data', onData).on('end', onEnd);
    }
  },
}

function makeSubloggerFromDefinitions(pluginDefinition, serviceDefinition, name) {
  return global.COM_RS_COMMON_LOGGER.makeComponentLogger(pluginDefinition.identifier
      + "." + serviceDefinition.name + ':' + name);
}

function ImportManager() {
  this.routers = {};
}
ImportManager.prototype = {
  constructor: ImportManager,
  
  routers: null
  
}

const defaultOptions = {
  httpPort: 0,
  productCode: null,
  productDir: null,
  proxiedHost: null,
  proxiedPort: 0,
  rootRedirectURL: null,
  rootServices: null,
  staticPlugins: null,
  newPluginHandler: null
};

function WebApp(options){
  this.expressApp = express();
  let sessionTimeoutMs = DEFAULT_SESSION_TIMEOUT_MS;
  if (options.sessionTimeoutMs) {
    sessionTimeoutMs = options.sessionTimeoutMs;
  }
  this.expressApp.use(cookieParser());
  this.expressApp.use(session({
    //TODO properly generate this secret
    secret: process.env.expressSessionSecret ? process.env.expressSessionSecret : 'whatever',
    store: require("./sessionStore").sessionStore,
    resave: true, saveUninitialized: false,
    cookie: {
      maxAge: sessionTimeoutMs
    }
  }));
  this.options = zluxUtil.makeOptionsObject(defaultOptions, options);
  this.auth = options.auth;
  expressWs(this.expressApp);
  this.expressApp.serverInstanceUID = Date.now(); // hack
  this.pluginRouter = express.Router();
  this.routers = {};
  this.appData = {
    webApp: {
      proxiedHost: options.proxiedHost,
    }, 
    plugin: {

    }
    //more stuff can be added
  };
  this.plugins = [];
  //hack for pseudo-SSO
  this.authServiceHandleMaps = {};
}
WebApp.prototype = {
  constructor: WebApp,
  options: null,
  expressApp: null,
  routers: null,
  appData: null,
  //hack for pseudo-SSO
  authServiceHandleMaps: null,

  toString() {
    return `[WebApp product: ${this.options.productCode}]`
  },
  
  makeProxy(urlPrefix, noAuth) {
    const r = express.Router();
    r.use(proxy.makeSimpleProxy(this.options.proxiedHost, this.options.proxiedPort, 
    {
      urlPrefix, 
      isHttps: false, 
      addProxyAuthorizations: (noAuth? null : this.auth.addProxyAuthorizations) 
    }));
    r.ws('/', proxy.makeWsProxy(this.options.proxiedHost, this.options.proxiedPort, 
        urlPrefix, false))
    return r;
  },
  
  makeExternalProxy(host, port, urlPrefix, isHttps, noAuth, pluginID, serviceName) {
    const r = express.Router();
    installLog.info(`Setting up proxy (${pluginID}:${serviceName}) to destination=${host}:${port}/${urlPrefix}`);
    let myProxy = proxy.makeSimpleProxy(host, port, {
      urlPrefix, 
      isHttps, 
      addProxyAuthorizations: (noAuth? null : this.auth.addProxyAuthorizations),
      allowInvalidTLSProxy: this.options.allowInvalidTLSProxy
    }, pluginID, serviceName);
    proxyMap.set(pluginID + ":" + serviceName, myProxy);
    r.use(myProxy);
    return r;
  },
  
  installStaticHanders() {
    const webdir = path.join(path.join(this.options.productDir,
      this.options.productCode), 'web');
    const rootPage = this.options.rootRedirectURL? this.options.rootRedirectURL 
        : '/';
    if (rootPage != '/') {
      this.expressApp.get('/', function(req,res) {
        res.redirect(rootPage);
      });
    }
    this.expressApp.use(rootPage, express.static(webdir));
  },

  installCommonMiddleware() {
    this.expressApp.use(commonMiddleware.addAppSpecificDataToRequest(
        this.appData));
  },

  installRootServices() {
    const serviceHandleMap = {};
    for (const proxiedRootService of this.options.rootServices || []) {
      const name = proxiedRootService.name || proxiedRootService.url.replace("/", "");
      installLog.info(`installing root service proxy at ${proxiedRootService.url}`);
      //note that it has to be explicitly false. other falsy values like undefined
      //are treated as default, which is true
      if (proxiedRootService.requiresAuth === false) {
        const _router = this.makeProxy(proxiedRootService.url, true);
        this.expressApp.use(proxiedRootService.url,
            _router);
      } else {
        const _router = this.makeProxy(proxiedRootService.url);
        this.expressApp.use(proxiedRootService.url,
            this.auth.middleware,
            _router);
      }
      serviceHandleMap[name] = new WebServiceHandle(proxiedRootService.url, 
          this.options.httpPort, this.options.httpsPort);
    }
    this.expressApp.use(commonMiddleware.injectServiceHandles(serviceHandleMap,
        true));
    this.expressApp.post('/auth',
        jsonParser,
        (req, res, next) => {
          //hack for pseudo-SSO
          req[`${UNP.APP_NAME}Data`].webApp.authServiceHandleMaps = 
            this.authServiceHandleMaps;
          next();
        },
        this.auth.doLogin); 
    this.expressApp.get('/auth',
        jsonParser,
        (req, res, next) => {
          //hack for pseudo-SSO
          req[`${UNP.APP_NAME}Data`].webApp.authServiceHandleMaps = 
            this.authServiceHandleMaps;
          next();
        },
        this.auth.getStatus); 
    this.expressApp.post('/auth-logout',
        jsonParser,
        (req, res, next) => {
          //hack for pseudo-SSO
          req[`${UNP.APP_NAME}Data`].webApp.authServiceHandleMaps = 
            this.authServiceHandleMaps;
          next();
        },
        this.auth.doLogout); 
    this.expressApp.get('/auth-logout',
        jsonParser,
        (req, res, next) => {
          //hack for pseudo-SSO
          req[`${UNP.APP_NAME}Data`].webApp.authServiceHandleMaps = 
            this.authServiceHandleMaps;
          next();
        },
        this.auth.doLogout); 
    serviceHandleMap['auth'] = new WebServiceHandle('/auth', 
        this.options.httpPort, this.options.httpsPort);
    this.expressApp.get('/plugins', 
        //this.auth.middleware, 
        staticHandlers.plugins(this.plugins));
    serviceHandleMap['plugins'] = new WebServiceHandle('/plugins', 
        this.options.httpPort, this.options.httpsPort);
    this.expressApp.get('/server/proxies', 
        this.auth.middleware, 
      (req, res) =>{
        contentLogger.log(contentLogger.INFO, '/server/proxies\n' + util.inspect(req));      
        res.json({"zssServerHostName":this.options.proxiedHost,"zssPort":this.options.proxiedPort});
      }); 
    serviceHandleMap['server/proxies'] = new WebServiceHandle('/server/proxies', 
        this.options.httpPort, this.options.httpsPort);
    this.expressApp.get('/echo/*', 
      this.auth.middleware, 
      (req, res) =>{
        contentLogger.log(contentLogger.INFO, 'echo\n' + util.inspect(req));
        res.json(req.params);
      });
    serviceHandleMap['echo'] = new WebServiceHandle('/echo', 
        this.options.httpPort, this.options.httpsPort);
    this.expressApp.get('/echo/*',  
      this.auth.middleware, 
      (req, res) =>{
        contentLogger.log(contentLogger.INFO, 'echo\n' + util.inspect(req));
        res.json(req.params);
      });
    serviceHandleMap['echo'] = new WebServiceHandle('/echo', 
        this.options.httpPort, this.options.httpsPort);
    this.expressApp.use('/apiManagement/', 
        this.auth.middleware, 
        staticHandlers.apiManagement(this));
    serviceHandleMap['apiManagement'] = new WebServiceHandle('/apiManagement', 
        this.options.httpPort, this.options.httpsPort);
    this.expressApp.use(staticHandlers.eureka());
  },
  
  _makeRouterForLegacyService(pluginContext, service) {
    const plugin = pluginContext.pluginDef;
    const subUrl = zLuxUrl.makeServiceSubURL(service);
    installLog.debug(plugin.identifier + ": service " + subUrl);
    const constructor = service.nodeModule[service.handlerInstaller];
    const router = express.Router();
    const urlSpec = "/" + this.options.productCode + "/plugins/" 
      + plugin.identifier + "/services/" + service.name + "/";
    const manager = {
      serverConfig:pluginContext.server.config.user,
      plugins:pluginContext.server.state.pluginMap,
      productCode:this.options.productCode
    };
    const handleWebsocketException = function(e, ws) {
      logException(e);
      try {
        ws.close(WEBSOCKET_CLOSE_INTERNAL_ERROR,JSON.stringify({ 
          error: 'Internal Server Error'
        }));
      } catch (closeEx) {
        logException(closeEx);
      }
    };
    const logException = function(e) {
      utilLog.warn(toString()+' Exception caught. Message='+e.message);
      utilLog.warn("Stack trace follows\n"+e.stack);
    };
    const toString = function() {
      return '[Service URL: '+urlSpec+']';
    };
    const legacyDataserviceAttributes = {
      logger: global.COM_RS_COMMON_LOGGER.makeComponentLogger(plugin.identifier
          + "." + service.name),
      toString: toString,
      urlSpec: urlSpec,
      makeSublogger(name) {
        return makeSubloggerFromDefinitions(plugin,service,name);
      },
      pluginDefinition: plugin,
      serviceDefinition: service,
      manager: manager
    };
    const handler = new constructor(service, service.methods, manager,
      legacyDataserviceAttributes);
    for (const methodUC of service.methods || []) {
      const method = methodUC.toLowerCase();
      if (!/^(get|post|put|delete|ws)$/.exec(method)) {
        installLog.warn(plugin.identifier + ": invalid method " + method);
        continue;
      }
      if (method === 'ws') {
        installLog.info(plugin.identifier + ": installing websocket service");
        router.ws('/',(ws,req) => {
          var session;
          try {
            session = handler.createSession(req);
          } catch (e) {
            handleWebsocketException(e,ws);
          }
          ws.on('message', function(msg) {
            try {
              session.handleWebsocketMessage(msg,ws);
            } catch (e) {
              handleWebsocketException(e,ws);
            }
          });
          
          ws.on('close', function(code, reason) {
            try {
              session.handleWebsocketClosed(ws, code, reason);
            } catch (e) {
              handleWebsocketException(e,ws);            
            }
          });
          
          if (session.handleWebsocketConnect) {
            session.handleWebsocketConnect(ws);
          }
        });
      } else {
        for (const route of [router.route('/'), router.route('/*')]) {
          if (method === "post" || method === "put") {
            route[method](commonMiddleware.readBody());
          }
          installLog.debug(`${plugin.identifier}: ${method} ${route.path} `
                           +` handled by ${service.handlerInstaller}`);
          route[method]((req, res) => {
            handler.handleRequest(req, res, req.body, req.path.substring(1));
          });
        }
      }
    }
    return router;
  },

  _makeRouter: function *(service, plugin, pluginContext, pluginChain) {
    const serviceRouterWithMiddleware = pluginChain.slice();
    serviceRouterWithMiddleware.push(commonMiddleware.injectServiceDef(
        service));
    serviceRouterWithMiddleware.push(this.auth.middleware);
    let router;
    switch (service.type) {
    case "service":
      //installLog.info(`${plugin.identifier}: installing proxy at ${subUrl}`);
      router = this.makeProxy(zLuxUrl.makePluginURL(this.options.productCode, 
          plugin.identifier) + zLuxUrl.makeServiceSubURL(service, false, true));
      break;
    case "nodeService":
      //installLog.info(
      //    `${plugin.identifier}: installing legacy service router at ${subUrl}`);
      router = this._makeRouterForLegacyService(pluginContext, service);
      break;
    case "router": {
        //installLog.info(`${plugin.identifier}: installing node router at ${subUrl}`);
        const serviceConfiguration = configService.getServiceConfiguration(
            plugin.identifier,  service.name, 
            pluginContext.server.config.app, this.options.productCode);
        const dataserviceContext = new DataserviceContext(service, 
            serviceConfiguration, pluginContext);
        if (!service.routerFactory) {
          router = yield service.nodeModule(dataserviceContext);
          installLog.info("Loaded Router for plugin=" + plugin.identifier 
              + ", service="+service.name + ". Router="+router);          
        } else {
          router = yield service.nodeModule[service.routerFactory](
              dataserviceContext);
          installLog.info("Loaded Router from factory for plugin=" 
                          + plugin.identifier + ", service=" + service.name
                          + ". Factory="+service.routerFactory);
        }
      }
      break;
    case "external":
//      installLog.info(`${plugin.identifier}: installing external proxy at ${subUrl}`);
      router = this.makeExternalProxy(service.host, service.port,
          service.urlPrefix, service.isHttps,
          undefined, plugin.identifier, service.name);
      break;
    }
    serviceRouterWithMiddleware.push(router);
    return serviceRouterWithMiddleware;
  },
  
  _makeServiceHandleMap(plugin, urlBase) {
    const serviceHandleMap = {};
    for (const group of zluxUtil.concatIterables(
        Object.values(plugin.dataServicesGrouped),
        Object.values(plugin.importsGrouped))) {
      let versionHandles = serviceHandleMap[group.name];
      if (!versionHandles) {
        versionHandles = serviceHandleMap[group.name] = {};
      }
      for (const version of Object.keys(group.versions)) {
        const service = group.versions[version];
        const subUrl = urlBase + zLuxUrl.makeServiceSubURL(service);
        const handle = new WebServiceHandle(subUrl, this.options.httpPort,
            this.options.httpsPort);
        versionHandles[version] = handle;
        if (version === group.highestVersion) {
          const defaultSubUrl = urlBase + zLuxUrl.makeServiceSubURL(service, true);
          versionHandles['_current'] = handle;
        }
      }
    }
    return serviceHandleMap;
  },
  
  _installDataServices: function*(pluginContext, urlBase) {
    const plugin = pluginContext.pluginDef;
    if (!plugin.dataServicesGrouped) {
      return;
    }
    installLog.info(`${plugin.identifier}: installing data services`)
    const serviceHandleMap = this._makeServiceHandleMap(plugin, urlBase);
    if (plugin.pluginType === 'nodeAuthentication') {
      //hack for pseudo-SSO
      this.authServiceHandleMaps[plugin.identifier] = serviceHandleMap;
    }
    const pluginChain = [
      commonMiddleware.injectPluginDef(plugin),
      commonMiddleware.injectServiceHandles(serviceHandleMap),
    ];
    let pluginRouters = this.routers[plugin.identifier];
    if (!pluginRouters) {
      pluginRouters = this.routers[plugin.identifier] = {};
    }
    for (const serviceName of Object.keys(plugin.dataServicesGrouped)) {
      installLog.info(`${plugin.identifier}: installing service ${serviceName}`)
      let serviceRouters = pluginRouters[serviceName];
      if (!serviceRouters) {
        serviceRouters = pluginRouters[serviceName] = {};
      }
      const group = plugin.dataServicesGrouped[serviceName];
      for (const version of Object.keys(group.versions)) {
        const service = group.versions[version];
        const subUrl = urlBase + zLuxUrl.makeServiceSubURL(service);
        const router = yield* this._makeRouter(service, plugin, pluginContext, 
            pluginChain); 
        installLog.info(`${plugin.identifier}: installing router at ${subUrl}`);
        this.pluginRouter.use(subUrl, router);
        serviceRouters[version] = router;
        if (version === group.highestVersion) {
          const defaultSubUrl = urlBase + zLuxUrl.makeServiceSubURL(service, true);
          this.pluginRouter.use(defaultSubUrl, router);
          serviceRouters['_current'] = router;
        }
      }
    } 
  },

  _resolveImports(plugin, urlBase) {
    if (!plugin.importsGrouped) {
      return;
    }
    for (const localName of Object.keys(plugin.importsGrouped)) {
      installLog.info(`${plugin.identifier}: importing service ${localName}`)
      const group = plugin.importsGrouped[localName];
      for (const version of Object.keys(group.versions)) {
        const importedService = group.versions[version];
        const subUrl = urlBase 
          + zLuxUrl.makeServiceSubURL(importedService);
        const importedRouter = this.routers[importedService.sourcePlugin]
          [importedService.sourceName][importedService.version];
        if (!importedRouter) {
          throw new Error(
            `Import ${importedService.sourcePlugin}:${implortedService.sourceName}`
            + " can't be satisfied");
        }
        installLog.info(`${plugin.identifier}: installing import`
           + ` ${importedService.sourcePlugin}:${importedService.sourceName}`
           + ` at ${subUrl}`);
        this.pluginRouter.use(subUrl, importedRouter);
        if (version === group.highestVersion) {
          const defaultSubUrl = urlBase 
              + zLuxUrl.makeServiceSubURL(importedService, true);
          this.pluginRouter.use(defaultSubUrl, importedRouter);
        }
      }
    }
  },

  _installPluginStaticHandlers(plugin, urlBase) {
    installLog.info(`${plugin.identifier}: installing static file handlers...`);
    if (plugin.webContent && plugin.webContent.path) {
      let url = `${urlBase}/web`;
      installLog.info(`${plugin.identifier}: serving static files at ${url}`);
      //console.log(url, plugin.webContent.path);
      this.pluginRouter.use(url, express.static(plugin.webContent.path));
    }
    if (plugin.pluginType === "library") {
      let url = `/lib/${plugin.identifier}/${plugin.libraryVersion}`;
      installLog.info(`${plugin.identifier}: serving library files at ${url}`);
      this.pluginRouter.use(url, express.static(plugin.location));
    }
  },
  
  _installSwaggerCatalog(plugin, urlBase) {
    const openApi = plugin.getApiCatalog(this.options.productCode);
    const router = express.Router();
    router.get("/", (req, res) => {
      res.status(200).json(openApi);
    });
    this.pluginRouter.use(zLuxUrl.join(urlBase, '/catalogs/swagger'),
        router);
  },

  injectPluginRouter() {
    this.expressApp.use(this.pluginRouter);
  },
  
  installPlugin: Promise.coroutine(function*(pluginContext) {
    const plugin = pluginContext.pluginDef;
    const urlBase = zLuxUrl.makePluginURL(this.options.productCode, 
        plugin.identifier);
    this._installSwaggerCatalog(plugin, urlBase);
    this._installPluginStaticHandlers(plugin, urlBase);
    try {
      yield *this._installDataServices(pluginContext, urlBase);
    } catch (e) {
      installLog.warn("Error installing plugin " + plugin.identifier 
          + ": " + e.stack);
      throw e
    }
    this._resolveImports(plugin, urlBase);
    this.plugins.push(plugin);
  }),

  installErrorHanders() {
    this.expressApp.use((req, res, next) => {
      const headers = req.headers
      for (const header of Object.keys(headers)) {
        /* Try to find a referer header and try to
         * redirect to our server,
         */
        if (header == 'referer') {
          let referrer = headers[header];
          var pattern = new RegExp('^http.+\/'+this.options.productCode+'\/plugins\/.+');
          if (pattern.test(referrer)) {
            var parts = headers[header].split("/");
            var zluxIndex = parts.indexOf(this.options.productCode);
            var pluginID = parts[zluxIndex + 2];
            var serviceName = parts[zluxIndex + 4];
            var myProxy = proxyMap.get(pluginID + ":" + serviceName);
            var fullUrl = req.originalUrl;
            req.url = fullUrl;
            if (myProxy != undefined) {
              utilLog.debug("About to call myProxy");
              myProxy(req, res);
              utilLog.debug("After myProxy call");
            }
            else {
              utilLog.debug(`Referrer proxying miss. Resource not found, sending 404 because referrer (${referrer}) didn't match an existing proxy service`);
              return do404(req.url, res, this.options.productCode
              + ": unknown resource requested");
            }
          }
            else {
              utilLog.debug(`Referrer proxying miss. Resource not found, sending 404 because referrer (${referrer}) didn't match a plugin pattern`);               
            return do404(req.url, res, this.options.productCode
            + ": unknown resource requested. Referrer="+referrer);
          }
        } else {
          return do404(req.url, res, this.options.productCode
               + ": unknown resource requested");
        }
      }
    });
  }
};

module.exports.makeWebApp = function (options) {
  const webApp = new WebApp(options);
  webApp.installCommonMiddleware();
  webApp.installStaticHanders();
  webApp.installRootServices();
  webApp.injectPluginRouter();
  webApp.installErrorHanders();
  return webApp;
};

/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/

