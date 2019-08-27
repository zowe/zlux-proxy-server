

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
const BBPromise = require('bluebird');
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
const expressStaticGzip = require("express-static-gzip");


/**
 * Sets up an Express application to serve plugin data files and services  
 */


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
var routingLog = zluxUtil.loggers.routing;

const jsonParser = bodyParser.json()
const urlencodedParser = bodyParser.urlencoded({ extended: false })

const proxyMap = new Map();

export class DataserviceContext{
  private serviceDefinition: any;
  private serviceConfiguration: any;
  private plugin: any;
  private logger: any;

  constructor(serviceDefinition: any, serviceConfiguration: any, pluginContext: any) {
    this.serviceDefinition = serviceDefinition;
    this.serviceConfiguration = serviceConfiguration;
    this.plugin = pluginContext;
    this.logger = (global as any).COM_RS_COMMON_LOGGER.makeComponentLogger(
      pluginContext.pluginDef.identifier + ":" + serviceDefinition.name);
    
    // makeErrorObject: zluxUtil.makeErrorObject
  }


  makeSublogger(name: string) {
    return makeSubloggerFromDefinitions(this.plugin.pluginDef,
        this.serviceDefinition, name);
  }
  
  addBodyParseMiddleware(router: any) {
    router.use(bodyParser.json({type:'application/json'}));
    router.use(bodyParser.text({type:'text/plain'}));
    router.use(bodyParser.text({type:'text/html'}));
  }
  
};

function do404(URL: string, res: any, message: any) {
  contentLogger.debug("404: "+message+", url="+URL);
  if (URL.indexOf('<')!=-1) {
    //sender didn't URI encode (browsers generally do)
    //Not a catch-all for missed encoding - specifically to prevent HTML tag insertion
    URL = encodeURI(URL);
  }
  res.statusMessage = message;
  res.status(404).send("<h1>Resource not found, URL: "+URL+"</h1></br><h2>Additional info: "+message+"</h2>");
}

// function sendAuthenticationFailure(res, authType) {
//   res.status(401).json({
//     'error':'unauthorized',
//     'plugin':pluginDefinition.identifier,
//     'service':serviceDefinition.name,
//     'authenticationType':authType
//   });
// };
// function sendAuthorizationFailure(res, authType, resource) {
//   res.status(403).json({
//     'error':'forbidden',
//     'plugin':pluginDefinition.identifier,
//     'service':serviceDefinition.name,
//     'authenticationType':authType,
//     'resource':resource
//   });
// };

const staticHandlers = {
  plugins: function(plugins: any) {
    return function(req: any, res: any) {
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
        response.pluginDefinitions = pluginDefs.filter((def: any) => {
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
  apiManagement(webApp: any) {
    const r = express.Router();
    r.post('/plugins', jsonParser, function api(req: any, res: any) {
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
    router.get('/server/eureka/info', function(req: any, res: any, next: any) {
      res.send('{"id":"zlux"}');
    });
    router.get('/server/eureka/health', function(req: any, res: any, next: any) {
      res.send('{"status":"UP"}');
    });
    return router;
  },
  
  proxies(options: any) {
    return (req: any, res: any) => {
      res.json({
        "zssServerHostName": options.proxiedHost,
        "zssPort": options.proxiedPort
      });
    }
  },
  
  echo() {
    return (req: any, res: any) =>{
      contentLogger.log(contentLogger.INFO, 'echo\n' + util.inspect(req));
      res.json(req.params);
    }
  }
};

/**
 *  This is passed to every other service of the plugin, so that 
 *  the service can be called by other services under the plugin
 */
export class WebServiceHandle{
  private urlPrefix: string;
  private port: number;
  private environment: any;

  constructor(urlPrefix: string, environment: any) {
    this.urlPrefix = urlPrefix;
    if (!environment.loopbackConfig.port) {
      installLog.severe(`loopback configuration not valid,`,environment.loopbackConfig,
                        `loopback calls will fail!`);
    }
    this.environment = environment;
  }
  //This is currently suboptimal: it makes an HTTP call
  //to localhost for every service call. We could instead just call
  //the corresponding router directly with mock request and
  //response objects, but that's tricky, so let's do that
  //later.

  // //  router: null,
  // port: 0,
  // urlPrefix: null,

  call(path: string, options: any, originalRequest: any) {
    return new Promise((resolve: any, reject: any) => {
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
      if (this.environment.loopbackConfig.isHttps) {
        protocol = 'https:';
        rejectUnauthorized = false;
      } else {
        protocol = 'http:';
      }
      const requestOptions: any = {
        hostname: this.environment.loopbackConfig.host,
        port: this.environment.loopbackConfig.port,
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
      let httpOrHttps = this.environment.loopbackConfig.isHttps ? https : http;
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
  
  addAppSpecificDataToRequest(globalAppData: any) {
    return function addAppSpecificData(req: any, res: any, next: any) {
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
      appData.webApp.callRootService = function callRootService(name: string, url: string, 
          options: any) {
        if (!this.rootServices[name]) {
          throw new Error(`root service ${name} not found`);
        }
        return this.rootServices[name].call(url, options, req);
      }
      if (!appData.plugin) {
        appData.plugin = {};
      } else {
      	appData.plugin = Object.create(appData.plugin);
      }
      appData.plugin.callService = function callService(name: string, url: string, options: any) {
        try {
          const allHandles = this.services[name];
          let version = '_current';
          if (appData.service.def
              /* 
                 TODO this does not cover the case in which an auth plugin wanted to do callService. See: zosmf-auth
                 In that case, appData.service = {} because it isn't a service itself.
              */
              && appData.service.def.versionRequirements 
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
  
  injectPluginDef(pluginDef: any) {
    return function(req: any, res: any, next: any) {
      req[`${UNP.APP_NAME}Data`].plugin.def = pluginDef;
      next();
    }
  },
  
  injectServiceDef(serviceDef: any) {
    return function _injectServiceDef(req: any, res: any, next: any) {
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
  injectServiceHandles(serviceHandles: any, isRoot?: boolean) {
    if (isRoot) {
      return function injectRoot(req: any, res: any, next: any) {
        //console.log('injecting services: ', Object.keys(serviceHandles))
        req[`${UNP.APP_NAME}Data`].webApp.rootServices = serviceHandles;
        next();
      }
    } else {
      return function inject(req: any, res: any, next: any) {
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
    return function readBody(req: any, res: any, next: any) {
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

  httpNoCacheHeaders() {
    return function httpCachingHeaders(req: any, res: any, next: any) {
      //service.httpCaching = false means
      //"Cache-control: no-store" and "Pragma: no-cache"
      res.set('Cache-control', 'no-store');
      res.set('Pragma', 'no-cache');
      next();
    }
  },
  
  logRootServiceCall(proxied: boolean, serviceName: string) {
    const type = proxied? "Proxied root" : "root"
    return function logRouting(req: any, res: any, next: any) {
      routingLog.debug(`${req.session.id}: ${type} service called: `
          +`${serviceName}, ${req.method} ${req.url}`);
      next();
    }
  },
  
  logServiceCall(pluginId: any, serviceName: string) {
    return function logRouting(req, res, next) {
      routingLog.debug(`${req.session.id}: Service called: `
          +`${pluginId}::${serviceName}, ${req.method} ${req.url}`);
      next();
    }
  }
}

function makeSubloggerFromDefinitions(pluginDefinition: any, serviceDefinition: any, name: string) {
  return (global as any).COM_RS_COMMON_LOGGER.makeComponentLogger(pluginDefinition.identifier
      + "." + serviceDefinition.name + ':' + name);
}

function ImportManager() {
  this.routers = {};
}
ImportManager.prototype = {
  constructor: ImportManager,
  
  routers: null
  
}


const defaultOptions: any = {
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

function makeLoopbackConfig(nodeConfig: any) {
  /* TODO do we really prefer loopback HTTPS? Why not simply choose HTTP? */
  if (nodeConfig.https && nodeConfig.https.enabled) {
    return {
      port: nodeConfig.https.port,
      isHttps: true,
      host: zluxUtil.getLoopbackAddress(nodeConfig.https.ipAddresses)
    }
  } else {
    return {
      port: nodeConfig.http.port,
      isHttps: false,
      host: zluxUtil.getLoopbackAddress(nodeConfig.http.ipAddresses)
    }
  }
}

function getAgentProxyOptions(serverConfig: any, agentConfig: any) {
  if (!agentConfig) return null;
  let options: any = {};
  if (agentConfig.https || (agentConfig.http && agentConfig.http.attls === true)) {
    options.isHttps = true;
    options.allowInvalidTLSProxy = serverConfig.allowInvalidTLSProxy
  }
  return options;
}

export class WebApp{
  private expressApp: any;
  private wsEnvironment: any;
  private options: any;
  private auth: any;
  private pluginRouter: any;
  private routers: any;
  private appData: any;
  private plugins: any[];
  private authServiceHandleMaps: any;

  constructor(options: any){
    this.expressApp = express();
    const port = options.httpsPort ? options.httpsPort : options.httpPort;
    this.expressApp.use(cookieParser());
    this.expressApp.use(session({
      //TODO properly generate this secret
      name: 'connect.sid.' + port,
      secret: process.env.expressSessionSecret ? process.env.expressSessionSecret : 'whatever',
      // FIXME: require magic is an anti-pattern. all require() calls should 
      // be at the top of the file. TODO Ensure this can be safely moved to the
      // top of the file: it must have no side effects and it must not depend
      // on any global state
      store: require("./sessionStore").sessionStore,
      resave: true, saveUninitialized: false,
      cookie: {
        secure: 'auto'
      }
    }));
    this.wsEnvironment = {
      loopbackConfig: makeLoopbackConfig(options.serverConfig.node)
    }
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

  toString() {
    return `[WebApp product: ${this.options.productCode}]`
  }
  
  makeProxy(urlPrefix: string, noAuth: boolean, overrideOptions: any, host?: string, port?: number) {
    const r = express.Router();
    let proxiedHost;
    let proxiedPort;
    if (host && port) {
      proxiedHost = host;
      proxiedPort = port;
    } else {
      proxiedHost = this.options.proxiedHost;
      proxiedPort = this.options.proxiedPort;
    }
    let options = {
      urlPrefix, 
      isHttps: false, 
      addProxyAuthorizations: (noAuth? null : this.auth.addProxyAuthorizations),
      allowInvalidTLSProxy: this.options.allowInvalidTLSProxy
    };
    if (overrideOptions) {
      options = Object.assign(options, overrideOptions);
    }
    r.use(proxy.makeSimpleProxy(proxiedHost, proxiedPort,
                                options));
    r.ws('/', proxy.makeWsProxy(proxiedHost, proxiedPort, 
                                urlPrefix, options.isHttps))
    return r;
  }
  
  makeExternalProxy(host: string, port: number, urlPrefix: string, isHttps: boolean, noAuth: boolean, pluginID: any, serviceName: string) {
    const r = express.Router();
    installLog.info(`Setting up ${isHttps? 'HTTPS' : 'HTTP'} proxy `
                    +`(${pluginID}:${serviceName}) to destination=${host}:${port}/${urlPrefix}`);
    let myProxy = proxy.makeSimpleProxy(host, port, {
      urlPrefix, 
      isHttps, 
      addProxyAuthorizations: (noAuth? null : this.auth.addProxyAuthorizations),
      allowInvalidTLSProxy: this.options.allowInvalidTLSProxy
    }, pluginID, serviceName);
    proxyMap.set(pluginID + ":" + serviceName, myProxy);
    r.use(myProxy);
    return r;
  }
  
  installStaticHanders() {
    const webdir = path.join(path.join(this.options.productDir,
      this.options.productCode), 'web');
    const rootPage = this.options.rootRedirectURL? this.options.rootRedirectURL 
        : '/';
    if (rootPage != '/') {
      this.expressApp.get('/', function(req: any,res: any) {
        res.redirect(rootPage);
      });
    }
    this.expressApp.use(rootPage, express.static(webdir));
  }

  installCommonMiddleware() {
    this.expressApp.use(commonMiddleware.addAppSpecificDataToRequest(
        this.appData));
  }

  _installRootService(url: string, method: any, handler: any, {needJson, needAuth, isPseudoSso}: any) {
    const handlers = [commonMiddleware.logRootServiceCall(false, url), commonMiddleware.httpNoCacheHeaders()];
    if (needJson) {
      handlers.push(jsonParser);
    }
    if (isPseudoSso) {
      handlers.push((req: any, res: any, next: any) => {
        //hack for pseudo-SSO
        req[`${UNP.APP_NAME}Data`].webApp.authServiceHandleMaps = 
          this.authServiceHandleMaps;
        next();
      })
    }
    if (needAuth) {
      handlers.push(this.auth.middleware); 
    }
    handlers.push(handler);
    installLog.info(`installing root service at ${url}`);
    this.expressApp[method](url, handlers); 
  }
  
  installRootServices() {
    const serviceHandleMap = {};
    for (const proxiedRootService of this.options.rootServices || []) {
      const name = proxiedRootService.name || proxiedRootService.url.replace("/", "");
      installLog.info(`installing root service proxy at ${proxiedRootService.url}`);
      //note that it has to be explicitly false. other falsy values like undefined
      //are treated as default, which is true
      if (proxiedRootService.requiresAuth === false) {
        const _router = this.makeProxy(proxiedRootService.url, true, getAgentProxyOptions(this.options, this.options.serverConfig.agent));
        this.expressApp.use(proxiedRootService.url,
            [commonMiddleware.logRootServiceCall(true, name), _router]);
      } else {
        const _router = this.makeProxy(proxiedRootService.url, false,
                                       getAgentProxyOptions(this.options, this.options.serverConfig.agent));
        this.expressApp.use(proxiedRootService.url,
            this.auth.middleware,
            [commonMiddleware.logRootServiceCall(true, name), _router]);
      }
      serviceHandleMap[name] = new WebServiceHandle(proxiedRootService.url, 
          this.wsEnvironment);
    }
    this.expressApp.use(commonMiddleware.injectServiceHandles(serviceHandleMap,
        true));
    
    this._installRootService('/auth', 'post', this.auth.doLogin, 
        {needJson: true, needAuth: false, isPseudoSso: true});
    this._installRootService('/auth', 'get', this.auth.getStatus, 
        {needJson: true, needAuth: false, isPseudoSso: true});
    this._installRootService('/auth-refresh', 'get', this.auth.refreshStatus, 
        {needJson: true, needAuth: false, isPseudoSso: true});    
    this._installRootService('/auth-logout', 'post', this.auth.doLogout, 
        {needJson: true, needAuth: false, isPseudoSso: true});
    this._installRootService('/auth-logout', 'get', this.auth.doLogout, 
        {needJson: true, needAuth: false, isPseudoSso: true});
    serviceHandleMap['auth'] = new WebServiceHandle('/auth', this.wsEnvironment);
    this._installRootService('/plugins', 'get', staticHandlers.plugins(this.plugins), 
        {needJson: false, needAuth: false, isPseudoSso: false});
    serviceHandleMap['plugins'] = new WebServiceHandle('/plugins', this.wsEnvironment);
    this._installRootService('/server/proxies', 'get', staticHandlers.proxies(this.options),
        {needJson: false, needAuth: true, isPseudoSso: false});
    serviceHandleMap['server/proxies'] = new WebServiceHandle('/server/proxies',
        this.wsEnvironment);
    this._installRootService('/echo/*', 'get', staticHandlers.echo(),
        {needJson: false, needAuth: true, isPseudoSso: false});
    serviceHandleMap['echo'] = new WebServiceHandle('/echo', this.wsEnvironment);
    this._installRootService('/apiManagement', 'use', staticHandlers.apiManagement(this),
        {needJson: false, needAuth: true, isPseudoSso: false});
    serviceHandleMap['apiManagement'] = new WebServiceHandle('/apiManagement', 
        this.wsEnvironment);
    this.expressApp.use(staticHandlers.eureka());
  }
  
  _makeRouterForLegacyService(pluginContext: any, service: any) {
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
    const handleWebsocketException = function(e: any, ws: any) {
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
      logger: (global as any).COM_RS_COMMON_LOGGER.makeComponentLogger(plugin.identifier
          + "." + service.name),
      toString: toString,
      urlSpec: urlSpec,
      makeSublogger(name: string) {
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
        router.ws('/',(ws: any,req: any) => {
          var session;
          try {
            session = handler.createSession(req);
          } catch (e) {
            handleWebsocketException(e,ws);
          }
          ws.on('message', function(msg: any) {
            try {
              session.handleWebsocketMessage(msg,ws);
            } catch (e) {
              handleWebsocketException(e,ws);
            }
          });
          
          ws.on('close', function(code: any, reason: any) {
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
  }

  *_makeRouter(service: any, plugin: any, pluginContext: any, pluginChain: any) {
    const serviceRouterWithMiddleware = pluginChain.slice();
    serviceRouterWithMiddleware.push(commonMiddleware.injectServiceDef(
        service));
    serviceRouterWithMiddleware.push(this.auth.middleware);
    serviceRouterWithMiddleware.push(commonMiddleware.logServiceCall(
        plugin.identifier, service.name));
    if (service.httpCaching !== true) {
      //Per-dataservice middleware to handle tls no-cache
      serviceRouterWithMiddleware.push(commonMiddleware.httpNoCacheHeaders());
    }    
    let router: any;
    switch (service.type) {
    case "service":
      //installLog.info(`${plugin.identifier}: installing proxy at ${subUrl}`);
      router = this.makeProxy(service.urlPrefix ? 
        service.urlPrefix : zLuxUrl.makePluginURL(this.options.productCode, plugin.identifier) +
                              zLuxUrl.makeServiceSubURL(service, false, true), false,
                              getAgentProxyOptions(this.options, this.options.serverConfig.agent));
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
    default:
      //maybe a lang manager knows how to handle this...
      let langManagers = this.options.langManagers;
      let foundManager = false;
      for (let i = 0; i < langManagers.length; i++) {
        const langManager = langManagers[i];
        if (langManager.getSupportedTypes().includes(service.type)) {
          let connectionInfo = langManager.getConnectionInfo(plugin.identifier, service.name, service.type);
          if (connectionInfo) {
            installLog.info(`Found connection info for ${plugin.identifier}:${service.name}=`,connectionInfo);
            //TODO resolve localhost to something better... allow binding to specific IPs like we did for node
            router = this.makeProxy(connectionInfo.url, true,
                                    connectionInfo.options, 'localhost', connectionInfo.port);
          } else {
            throw new Error(`Could not resolve service URL. Plugin=${plugin.identifier}, service=${service.name}`);
          }
          foundManager = true;
          break;
        }
      }
      if (!foundManager) {
        throw new Error(`Could not load service ${plugin.identifier}:${service.name} `
                        +`due to unknown type=${service.type}`);
      }
    }
    serviceRouterWithMiddleware.push(router);
    return serviceRouterWithMiddleware;
  }
  
  _makeServiceHandleMap(plugin: any, urlBase: string) {
    const serviceHandleMap = {};
    for (const group of zluxUtil.concatIterables(
        (Object as any).values(plugin.dataServicesGrouped),
        (Object as any).values(plugin.importsGrouped))) {
      let versionHandles = serviceHandleMap[group.name];
      if (!versionHandles) {
        versionHandles = serviceHandleMap[group.name] = {};
      }
      for (const version of Object.keys(group.versions)) {
        const service = group.versions[version];
        const subUrl = urlBase + zLuxUrl.makeServiceSubURL(service);
        const handle = new WebServiceHandle(subUrl, this.wsEnvironment);
        versionHandles[version] = handle;
        if (version === group.highestVersion) {
          const defaultSubUrl = urlBase + zLuxUrl.makeServiceSubURL(service, true);
          versionHandles['_current'] = handle;
        }
      }
    }
    return serviceHandleMap;
  }
  
  *_installDataServices(pluginContext: any, urlBase: string) {
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
        const router = yield* this._makeRouter(service, plugin, pluginContext, pluginChain);
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
  }

  _resolveImports(plugin: any, urlBase: string) {
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
            `Import ${importedService.sourcePlugin}:${importedService.sourceName}`
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
  }

  _installPluginStaticHandlers(plugin: any, urlBase: string) {
    installLog.info(`${plugin.identifier}: installing static file handlers...`);
    if (plugin.webContent && plugin.location) {
      let url = `${urlBase}/web`;
      installLog.info(`${plugin.identifier}: serving static files at ${url}`);
      this.pluginRouter.use(url, expressStaticGzip(path.join(plugin.location, '/web'),
                                                   {enableBrotli: true, orderPreference: ['br', 'gzip']}));
    }
    if (plugin.pluginType === "library") {
      let url = `/lib/${plugin.identifier}/${plugin.libraryVersion}`;
      installLog.info(`${plugin.identifier}: serving library files at ${url}`);
      this.pluginRouter.use(url, express.static(plugin.location));
    }
  }
  
  _installSwaggerCatalog(plugin: any, urlBase: string, nodeContext: any) {
    plugin.getApiCatalog(this.options.productCode, nodeContext).then((openApi) => {
      const router = express.Router();
      installLog.info(`Creating composite swagger endpoint for ${plugin.identifier}`);
      router.get("/", (req: any, res: any) => {
        res.status(200).json(openApi.pluginCatalog);
      });
      if (openApi.serviceDocs.length > 0) {
        openApi.serviceDocs.forEach(function (service) {
          installLog.info(`Creating swagger endpoint for${plugin.identifier}:${service.serviceName}`);
          router.get(`/${service.serviceName}`, (req, res) => {
            res.status(200).json(service.serviceDoc)
          });
        });
      }
      this.pluginRouter.use(zLuxUrl.join(urlBase, '/catalogs/swagger'),
          router);
    });
  }

  injectPluginRouter() {
    this.expressApp.use(this.pluginRouter);
  }
  
  installPlugin = BBPromise.coroutine(function*(pluginContext: any) {
    const plugin = pluginContext.pluginDef;
    const urlBase = zLuxUrl.makePluginURL(this.options.productCode, 
        plugin.identifier);
    const nodeContext = pluginContext.server.config.user.node;
    try {
      //dataservices load first since in case of error, we want to skip the rest of the plugin load
      yield *this._installDataServices(pluginContext, urlBase);
      this._installSwaggerCatalog(plugin, urlBase, nodeContext);
      this._installPluginStaticHandlers(plugin, urlBase);      
    } catch (e) {
      //index.js listens and logs, so dont log twice here
      //throw so that plugin isnt pushed to list if there's something wrong with it
      throw e;
    }
    this._resolveImports(plugin, urlBase);
    this.plugins.push(plugin);
  })

  installErrorHanders() {
    this.expressApp.use((req: any, res: any, next: any) => {
      const headers = req.headers
      let referrerPresent = false;
      for (const header of Object.keys(headers)) {
        /* Try to find a referer header and try to
         * redirect to our server,
         */
        if (header == 'referer') {
          referrerPresent = true;
          let referrer = headers[header];
          var pattern = new RegExp('^http.+\/'+this.options.productCode+'\/plugins\/.+');
          if (pattern.test(referrer)) {
            const parts = headers[header].split("/");
            const zluxIndex = parts.indexOf(this.options.productCode);
            const pluginID = parts[zluxIndex + 2];
            const serviceName = parts[zluxIndex + 4];
            const myProxy = proxyMap.get(pluginID + ":" + serviceName);
            const fullUrl = req.originalUrl;
            req.url = fullUrl;
            if (myProxy != undefined) {
              utilLog.debug("About to call myProxy");
              myProxy(req, res);
              utilLog.debug("After myProxy call");
            } else {
              utilLog.debug(`Referrer proxying miss. Resource not found, sending`
                  + ` 404 because referrer (${referrer}) didn't match an existing proxy service`);
              return do404(req.url, res, this.options.productCode
                  + ": unknown resource requested");
            }
          } else {
              utilLog.debug(`Referrer proxying miss. Resource not found, sending`
                  + ` 404 because referrer (${referrer}) didn't match a plugin pattern`);               
            return do404(req.url, res, this.options.productCode + ": unknown resource requested");
          }
          break;
        }
      }
      if (!referrerPresent) {
        return do404(req.url, res, this.options.productCode
                     + ": unknown resource requested");
      }
    });
  }
};

export function makeWebApp(options: any) {
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

