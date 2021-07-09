

/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/

'use strict';
const express = require('express');
const expressApp = express();

const fs = require('fs');
const util = require('util');
const url = require('url');
const path = require('path');
const Promise = require('bluebird');
const http = require('http');
const https = require('https');
const bodyParser = require('body-parser');
const jsonUtils = require('./jsonUtils');
const cookieParser = require('cookie-parser')
const session = require('express-session');
const zluxUtil = require('./util');
const configService = require('../plugins/config/lib/configService.js');
const proxy = require('./proxy');
const zLuxUrl = require('./url');
const constants = require('./unp-constants');
const installApp = require('../utils/install-app');
const translationUtils = require('./translation-utils');
const expressStaticGzip = require("express-static-gzip");
const apiml = require('./apiml');
const os = require('os');
const semver = require('semver');
const ipaddr = require('ipaddr.js');
const pluginStorage = require('./pluginStorage');
const crypto = require('crypto');

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
const DEFAULT_RELOAD_RETRIES = 3;
const DEFAULT_RELOAD_TIMEOUT = 2000; //2 seconds
const DEFAULT_HSTS_TIME_SECONDS = 604800; //1 week
const nodeVer = process.version.substring(1, process.version.length);
let nodeMajorVer = nodeVer.split('.')[0];

var contentLogger = zluxUtil.loggers.contentLogger;
var bootstrapLogger = zluxUtil.loggers.bootstrapLogger;
var installLog = zluxUtil.loggers.installLogger;
var utilLog = zluxUtil.loggers.utilLogger;
var routingLog = zluxUtil.loggers.routing;
const LOG_LEVEL_MIN = 0;
const LOG_LEVEL_MAX = 5;

const jsonParser = bodyParser.json()
const urlencodedParser = bodyParser.urlencoded({ extended: false })
const ZLUX_LOOPBACK_HEADER = 'X-ZLUX-Loopback';
const proxyMap = new Map();


//Referrer check used to be done for security, but the same thing can be accomplished in a much less obtrusive way
// via samesite attribute of cookies, which all supported browsers support
const SHOULD_CHECK_REFERRER = process.env.ZWE_CHECK_REFERRER !== undefined ? (process.env.ZWE_CHECK_REFERRER == "true") : false;

function DataserviceContext(serviceDefinition, serviceConfiguration, 
    pluginContext, webapp) {
  this.serviceDefinition = serviceDefinition;
  this.serviceConfiguration = serviceConfiguration;
  this.plugin = pluginContext;
  this.storage = pluginStorage.PluginStorageFactory(this.plugin.pluginDef.identifier, utilLog);
  this.logger = createDataserviceLogger(pluginContext, serviceDefinition);
  this.tlsOptions = Object.assign({},webapp.options.tlsOptions);
  this.wsRouterPatcher = webapp.expressWs.applyTo;
}

function createDataserviceLogger(pluginContext, serviceDefinition) {
  let logLanguage = pluginContext.server.config.user.logLanguage;
  const logLocation = pluginContext.pluginDef.location;

  if (!logLanguage) {
    logLanguage = "en"; // Default to English if no language is specified
  }
  if (!logLocation) {
    bootstrapLogger.warn("ZWED0058W", pluginContext.pluginDef.identifier, serviceDefinition.name); //bootstrapLogger.warn("Log location for logger '" + pluginContext.pluginDef.identifier + ":" + serviceDefinition.name + "' is undefined")
    return;
  }

  let messages;
  try { // Attempt to get a log message for a language a user may have specified
    var logFile = require(`${logLocation}/lib/assets/i18n/log/messages_${logLanguage}.json`);
    messages = logFile;

    if (logLanguage != 'en') {
      let logFileEN = require(`${logLocation}/lib/assets/i18n/log/messages_en.json`);
      messages = Object.assign(logFileEN, messages); // Merge the two, with the language-specific file
      // overwriting the non-English one (so English messages get preserved even if no translations exist)
    }
  } catch (err) { // If we encountered an error...
      try {
        if (messages) { // and 'messages' exist, then these messages came from a language file,
          // but the EN language file lookup failed (that is why we are in this catch), so we are all done here.
        } 
        else if (logLanguage != 'en') { // If 'messages' does not exist, then the first 'logFile' lookup failed and put us here,
          let logFileEN = require(`${logLocation}/lib/assets/i18n/log/messages_en.json`); // so let's try English.
          messages = logFileEN;
        }
      }
      catch (err) { // If all else fails, create loggers without specified messages.
        messages = undefined;
      }
  }

  return global.COM_RS_COMMON_LOGGER.makeComponentLogger(
    pluginContext.pluginDef.identifier + ":" + serviceDefinition.name, messages);
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

function createDataserviceStorage(pluginId) {
  
  return process.clusterManager.getStorageAll(pluginId).then(function (clusterStorage) {
    let storageObj = new Object;

    /* Get the whole plugin storage */
    storageObj.getAll = function () {
      return process.clusterManager.getStorageAll(pluginId);
    }

    storageObj.get = function (key) {
      return process.clusterManager.getStorageByKey(pluginId, key);
    }

    /* Set the whole plugin storage object */
    storageObj.setAll = function (dict) {
      return process.clusterManager.setStorageAll(pluginId, dict);
    }

    storageObj.set = function (key, value) {
      return process.clusterManager.setStorageByKey(pluginId, key, value);
    }

    storageObj.delete = function (key) {
      return process.clusterManager.deleteStorageByKey(pluginId, key);
    }

    storageObj.deleteAll = function () {
      return process.clusterManager.setStorageAll(pluginId, {});
    }

    contentLogger.debug("'" + pluginId + "' context is loaded with storage object: ", storageObj);
    return storageObj;
  })
}

function do404(URL, res, message) {
  contentLogger.debug("ZWED0189I", message, URL); //contentLogger.debug("404: "+message+", url="+URL);
  if (URL.indexOf('<')!=-1) {
    //sender didn't URI encode (browsers generally do)
    //Not a catch-all for missed encoding - specifically to prevent HTML tag insertion
    URL = encodeURI(URL);
  }
  res.statusMessage = message;
  res.status(404).send("<h1>Resource not found, URL: "+URL+"</h1></br><h2>Additional info: "+message+"</h2>");
}

function getPresetHeader(name, preset, req) {
  let nameLower = name.toLowerCase();
  switch (nameLower) {
  //See https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP    
  case 'content-security-policy':
    if (preset == 'strict') {
      return `default-src 'self' ${req.hostname};`;
    } else if (preset == 'frame-strict') {
      return `frame-src 'self' ${req.hostname};`;
    }
    break;
  }
  return null;
}

function getSubstitutedHeader(value, substitutes, req) {
  const substituteNames = Object.keys(substitutes);
  let domain;
  for (let i = 0; i < substituteNames.length; i++) {
    const name = substituteNames[i];
    const type = substitutes[name];
    switch (type) {
    case 'domain':
      if (!domain) {
        let subdomains = req.subdomains;
        let length = req.subdomains.length-1;
        for (let j = 0; j < subdomains.length; j++) {
          length += subdomains[j].length;
        }
        domain = req.hostname.substr(length);        
      }
      value.replace(name, domain);
      break;
    }
  }
  return value;
}

const arch = os.arch();
const release = os.release();
const cpus = os.cpus();
const hostname = os.hostname();

function getUserEnv(rbac, serverConfig){
  var date = new Date();
  return new Promise(function(resolve, reject){
    if (rbac) {
      resolve({
        "timestamp": date.toUTCString(),
        "args": process.argv,
        "nodeArgs": process.execArgv,
        "platform": process.platform,
        "arch": arch,
        "osRelease": release,
        "cpus": cpus,
        "freeMemory": os.freemem(),
        "hostname": hostname,
        "userEnvironment": process.env,
        "agent": {
          "mediationLayer": serverConfig.agent ? serverConfig.agent.mediationLayer : undefined
        },
        "PID": process.pid,
        "PPID": process.ppid,
        "nodeVersion": process.version,
        "nodeRelease": process.release,
      })
    } else { //shorter list for security. limit exposure.
      resolve({
        //needed for sync check
        "timestamp": date.toUTCString(),
        //needed to do dependency checks
        "platform": process.platform,
        "arch": arch,
        //needed for any cross-server communication requirements
        "userEnvironment": {
          "EXTERNAL_COMPONENTS": process.env.EXTERNAL_COMPONENTS,
          "LAUNCH_COMPONENT_GROUPS": process.env.LAUNCH_COMPONENT_GROUPS,
          "ZWED_node_mediationLayer_enabled": process.env.ZWED_node_mediationLayer_enabled,

          //expected to be identical
          "ZOWE_EXPLORER_HOST": process.env.ZOWE_EXPLORER_HOST,
          "ZWED_node_mediationLayer_server_hostname": process.env.ZWED_node_mediationLayer_server_hostname,

          //may diverge from above
          "ZWE_EXTERNAL_HOSTS": process.env.ZWE_EXTERNAL_HOSTS,
          
          //expected to be identical
          "ZWED_node_mediationLayer_server_gatewayPort": process.env.ZWED_node_mediationLayer_server_gatewayPort,
          "GATEWAY_PORT": process.env.GATEWAY_PORT
        },
        "agent": {
          "mediationLayer": serverConfig.agent ? serverConfig.agent.mediationLayer : undefined
        }
      })
    }
  });
}

function getAttrib(object, path){
  if(object === undefined || path === undefined || 
    typeof path !== 'string' || typeof object !== 'object') return undefined;
  let objCopy = Object.assign({}, object);
  let props = path.split('.');
  try{
    for(let i = 0; i < props.length; i++){
      objCopy = objCopy[props[i]];
    }
  }catch(e){
    return undefined;
  }
  return (objCopy === undefined) ? undefined : objCopy;
}

function setAttrib(object, path, value){
  if(object === undefined || path === undefined || 
      Array.isArray(path) && path.length === 0 || typeof object !== 'object'){
    return undefined
  };
  if(typeof path === 'string'){
    path = path.split(".");
  }
  if(path.length === 1){
    try{
      object[path[0]] = value;
    }catch(e){
      return undefined;
    }
    return;
  }
  setAttrib(object[path.shift()], path, value);
}

function waitForHeadersBeforeReload(res, maxRetries, timeout){
  if(typeof waitForHeadersBeforeReload.retries === 'undefined'){
    waitForHeadersBeforeReload.retries = 0;
  }
  setTimeout(() => {
    if(waitForHeadersBeforeReload.retries > maxRetries){
      return;
    }
    if(!res.headersSent){
      waitForHeadersBeforeReload.retries++;
      waitForHeadersBeforeReload(res, maxRetries, timeout);
    }
    if(process.clusterManager){
      process.clusterManager.reloadAllWorkers();
      // TODO: Server startup after initial reload doesn't complete 100% with Node < 8.x. Resulting in
      // failed ZSS authentication issues. Error is uncertain, as increasing the timeout doesn't solve
      // the issue. Is probably a deeper sync that newer versions of Node handle in correct order.
      if (nodeMajorVer <= 7) {
        process.clusterManager.reloadAllWorkers();
      }
    }
  }, timeout);
}

const staticHandlers = {
  plugins: function(webapp) {
    const respondToGetPlugins = function(req, res, webapp, type, plugins) {
      const acceptLanguage = 
            translationUtils.getAcceptLanguageFromCookies(req.cookies) || req.headers['accept-language'] || '';
      const pluginDefs = plugins.map(p => p.exportTranslatedDef(acceptLanguage));
      let pluginId;
      let pluginLocation;
      let filteredPluginDefs = [];
      let allowedPlugins;
      if (webapp.options.serverConfig.dataserviceAuthentication.rbac) {
        for (let plugin of plugins) {
          if (plugin.pluginType === "bootstrap") {
            pluginId = plugin.identifier
            pluginLocation = plugins.location
            break;
          }
        }
        allowedPlugins = configService.getAllowedPlugins(webapp.options, req.username, pluginId, pluginLocation);
        if (allowedPlugins != null) {
          for(let plugin of pluginDefs) {
            let obj = allowedPlugins.allowedPlugins.find(o => o.identifier === plugin.identifier)
            if (obj) {
              if (obj.versions.includes('*') || obj.versions.includes(plugin.pluginVersion)) {
                if (semver.valid(plugin.pluginVersion)) {
                  filteredPluginDefs.push(plugin)
                }
              }
            }
          }
        } else {
          filteredPluginDefs = pluginDefs;
        }
      } else {
        filteredPluginDefs = pluginDefs;
      }

      const response = {
        //TODO type/version
        pluginDefinitions: null 
      };
      contentLogger.debug('ZWED0190I', type); //contentLogger.debug('Type requested ='+type);
      if (type == "all") {
        response.pluginDefinitions = filteredPluginDefs;
      } else {
        response.pluginDefinitions = filteredPluginDefs.filter(def => {
          if (def.pluginType != null) {
            contentLogger.debug('ZWED0191I', def.pluginType); //contentLogger.debug('Returning true if type matches, type='
            //+ def.pluginType);
            return def.pluginType === type;
          } else if (type == 'application') {
            contentLogger.debug('ZWED0192I'); //contentLogger.debug('Returning true because type is application');
            return true;
          } else {
            contentLogger.debug('ZWED0193I'); //contentLogger.debug('Returning false because type did not match');
            return false;
          }
        });
      }
      res.json(response);
    }

    let lastCall = Date.now();
    const CALL_INTERVAL = 1000;
    //To not abuse FS, cache for a second
    
    return function(req, res) {
      let parsedRequest = url.parse(req.url, true);
      const type = parsedRequest.query["type"] ? parsedRequest.query["type"] : 'all';
      const refresh = parsedRequest.query['refresh'];
      const now = Date.now();
      if (refresh == 'true' && (lastCall+CALL_INTERVAL < now)) {
        lastCall = now;
        if (!req.username) {
          res.status(400).json({error: 'Login required for refresh feature'});
        } else {
          if (process.clusterManager) {
            process.clusterManager.scanPlugins();
          }
          const loader = webapp.options.pluginLoader;
          loader.readNewPluginDefs().then((defs)=> {
            if (defs.length === 0) {
              respondToGetPlugins(req, res, webapp, type, webapp.plugins);
            } else {
              loader.once('refreshFinish', (event) => {
                respondToGetPlugins(req, res, webapp, type, webapp.plugins);
              });
              loader.installPlugins(defs).then( () => {
                return;
              });
            }
          });
        }
      } else {
        respondToGetPlugins(req, res, webapp, type, webapp.plugins);
      } 
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
          res.status(400).send('ZWED0059W - failed to add the plugin: ' + err.message);
          contentLogger.warn("ZWED0059W", err);
        });
    });
    return r;
  },

  getServerProxies(options) {
    return function(req,res) {
      res.json({
        "zssServerHostName": options.proxiedHost,
        "zssPort": options.proxiedPort
      });
    };
  },

  server(options){
    const router = express.Router();
    router.use((req, res, callback) => {
      bodyParser.json({type:'application/json'})(req, res, err => {
        if(err) {
          contentLogger.warn("ZWED0060W", err); //contentLogger.warn(err);
          return res.status(400).json({error: "ZWED0060W - Invalid JSON"});
        }
        callback();
      })
    });
    const dataserviceAuth = options.serverConfig["dataserviceAuthentication"];
    const rbac = (dataserviceAuth == undefined) ? false : dataserviceAuth.rbac === true;
    //endpoints that handle rbac decision-making within
    router.get('/environment', function(req, res){
      getUserEnv(rbac, options.serverConfig).then(result => {
        res.status(200).json(result);
      });
    }).all('/environment', function (req, res) {
        return res.status(405).json({error: 'ZWED0130E - Only GET method supported'});
    });

    const agentSwaggerBaseUrl = `${zLuxUrl.makePluginURL('zlux', zluxUtil.agentSwaggerPluginId)}/catalogs/swagger`;
    router.get('/agent/swagger', function(req, res, next) {
      res.redirect(`${agentSwaggerBaseUrl}`);
    });
    router.get('/agent/swagger/:api', function(req, res, next) {
      res.redirect(`${agentSwaggerBaseUrl}/${req.params.api || ''}`);
    });

    const zluxSwaggerBaseUrl = `${zLuxUrl.makePluginURL(options.productCode, zluxUtil.serverSwaggerPluginId)}/catalogs/swagger`;
    router.get(`/swagger`, function(req, res, next) {
      res.redirect(`${zluxSwaggerBaseUrl}`);
    }); 

    //per-endpoint rbac behavior follows
    if(!rbac){
      router.all('/*', (req, res) => {
        return res.status(506).send("Set dataserviceAuthentication.rbac to true in server configuration");
      })
      return router;
    } else {
      router.get('/', function(req, res){
        return res.status(200).json({
          "links": [
            {
              "href": "/server/agent",
              "rel": "agent",
              "type": "GET"
            },
            {
              "href": "/server/config",
              "rel": "config",
              "type": "GET"
            },
            {
              "href": "/server/log",
              "rel": "log",
              "type": "GET"
            },
            {
              "href": "/server/logLevels",
              "rel": "logLevels",
              "type": "GET"
            },
            {
              "href": "/server/environment",
              "rel": "environment",
              "type": "GET"
            },
            {
              "href": "/server/swagger",
              "rel": "swagger",
              "type": "GET"
            },
            {
              "href": "/server/agent/swagger",
              "rel": "swagger",
              "type": "GET"
            },
          ]
        });
      }).all('/', function (req, res) {
        return res.status(405).json({error: 'ZWED0143E - Only GET method supported'});
      });
      let proxyOptions = {
        isHttps: false, 
        addProxyAuthorizations: options.auth.addProxyAuthorizations,
        allowInvalidTLSProxy: options.allowInvalidTLSProxy
      };
      proxyOptions = Object.assign(proxyOptions, getAgentProxyOptions(options.serverConfig, options.tlsOptions, true));
      proxyOptions.urlPrefix = proxyOptions.urlPrefix ?  proxyOptions.urlPrefix + '/server' : '/server';

      router.get('/agent*', proxy.makeSimpleProxy(options.proxiedHost, options.proxiedPort,
        proxyOptions));
      router.get('/reload', function(req, res){
        if (process.clusterManager) {
          res.status(200).json({message: 'Reloading server, please wait a moment.'});
          waitForHeadersBeforeReload(res, DEFAULT_RELOAD_RETRIES, DEFAULT_RELOAD_TIMEOUT);
        } else {
          res.status(500).json({error: 'ZWED0116E - Cannot reload server unless cluster mode is in use.'});
        }
      }).all('/reload', function (req, res) {
        return res.status(405).json({error: 'ZWED0117E - Only GET method supported'});
      });
      router.get('/config', function(req, res){
        return res.status(200).json({
          "options": options.serverConfig
        });
      }).all('/config', function (req, res) {
        return res.status(405).json({error: 'ZWED0118E - Only GET method supported'});
      });
      //This route consumes the replacement key/value pair in the request body.
      //For example, post(/config/node.https.ipAddresses), with a JSON request body:
      //"ipAddresses": ["0.0.0.0"]
      router.post('/config/:attribute/', function(req, res){
        if(!process.clusterManager){
          return res.status(400).json({error: 'ZWED0119E - Server must be running in cluster mode to rewrite configuration file'});
        }
        let attrib = req.params.attribute;
        let attribParts = attrib.split(".");
        let lastProperty = attribParts[attribParts.length - 1];
        let body = req.body;
        if(body[lastProperty] == undefined){
          return res.status(400).json({
            error: "ZWED0120E - Request body property name does not match query property name",
            queryPropertyName: attrib,
            requestBody: body
          });
        }
        let conf = options.serverConfig;
        let allowed = {
          node: {
            usersDir: typeof conf.usersDir,
            groupsDir: typeof conf.groupsDir,
            allowInvalidTLSProxy: typeof conf.node.allowInvalidTLSProxy,
            noPrompt: typeof conf.node.noPrompt,
            noChild: typeof conf.node.noChild,
            https: {
              ipAddresses: typeof conf.node.https.ipAddresses,
              port: typeof conf.node.https.port
            },
            mediationLayer: {
              server: {
                hostname: typeof conf.node.mediationLayer.server.hostname,
                port: typeof conf.node.mediationLayer.server.port,
                isHttps: typeof conf.node.mediationLayer.server.isHttps
              },
              enabled: typeof conf.node.mediationLayer.enabled
            },
            childProcesses: typeof conf.node.childProcesses
          },
          agent: {
            host: typeof conf.agent.host,
            // either http or https can be missing
            http: {
              ipAddresses: 'object',
              port: 'number',
            },
            https: {
              ipAddresses: 'object',
              port: 'number'
            }
          },
          logLevels: typeof conf.logLevels,
          logLanguage: typeof conf.logLanguage,
          zssPort: typeof conf.zssPort
        };
        let allowedPropertyType = getAttrib(allowed, attrib);
        if(allowedPropertyType !== undefined){
          if(allowedPropertyType === (typeof body[lastProperty])){
            let newConfig = JSON.parse(JSON.stringify(options.serverConfig));
            if((newConfig.agent && newConfig.agent.host) &&
                options.proxiedHost != newConfig.agent.host){
              newConfig.agent.host = options.proxiedHost;
            }
            if((newConfig.agent && newConfig.agent.http && newConfig.agent.http.port) &&
                options.proxiedPort != newConfig.agent.http.port){
              newConfig.agent.http.port = options.proxiedPort;
            }
            if((newConfig.agent && newConfig.agent.https && newConfig.agent.https.port) &&
                options.proxiedPort != newConfig.agent.https.port){
              newConfig.agent.https.port = options.proxiedPort;
            }
            if(newConfig.zssPort && options.proxiedPort != newConfig.zssPort){
              newConfig.zssPort = options.proxiedPort;
            }
            setAttrib(newConfig, attrib, body[lastProperty]);
            try{
              fs.writeFileSync(options.configLocation, JSON.stringify(newConfig, null, 2));
            }catch(e){
              return res.status(500).json({error: e});
            }
            process.clusterManager.setOverrideFileConfig(false);
            res.status(200).json({
              message: "Config updated. Reloading server, please wait.",
              expectedType: allowedPropertyType,
              receivedType: (typeof body[attribParts[attribParts.length - 1]]),
              requestBody: body,
              newConfig: newConfig
            });
            waitForHeadersBeforeReload(res, DEFAULT_RELOAD_RETRIES, DEFAULT_RELOAD_TIMEOUT);
            return;
          } else {
            return res.status(400).json({
              error: `ZWED0121E - Request body of type ${(typeof body[attribParts[attribParts.length - 1]])} does not match expected type of ${allowedPropertyType}`,
              expectedType: allowedPropertyType,
              receivedType: typeof body[attribParts[attribParts.length - 1]]
            });
          }
        } else {
          return res.status(400).json({error: `ZWED0122E - ${attrib} is not available for modification`});
        }
      }).all('/config/:attribute', function (req, res) {
        return res.status(405).json({error: 'ZWED0123E - Only POST method supported'});
      });
      router.get('/log', function(req, res){
        if(process.env.ZLUX_LOG_PATH){
          return res.sendFile(process.env.ZLUX_LOG_PATH);
        } else {
          return res.status(500).json({error: 'ZWED0124E - Log not found'});
        }
      }).all('/log', function (req, res) {
        return res.status(405).json({error: 'ZWED0125E - Only GET method supported'});
      });
      router.get('/logLevels', function(req, res){
        return res.status(200).json(global.COM_RS_COMMON_LOGGER.getConfig());
      }).all('/logLevels', function (req, res) {
        return res.status(405).json({error: 'ZWED0126E - Only GET method supported'});
      });
      router.post('/logLevels/name/:componentName/level/:level', function(req, res){
        const logLevel = req.params.level;
        if(isNaN(Number(logLevel))){
          return res.status(400).json({error: "ZWED0127E - Log level must be a number"});
        } else {
          if (Number(logLevel) < LOG_LEVEL_MIN || Number(logLevel) > LOG_LEVEL_MAX) {
            return res.status(400).json({
              error: "ZWED0128E - Log level must be within the accepted levels of '" + LOG_LEVEL_MIN + "' and '" + LOG_LEVEL_MAX + "'",
              minLogLevel: LOG_LEVEL_MIN,
              maxLogLevel: LOG_LEVEL_MAX,
              receivedLogLevel: Number(logLevel)
            });
          }
          global.COM_RS_COMMON_LOGGER.setLogLevelForComponentName(req.params.componentName, Number(logLevel));
          return res.status(200).json(global.COM_RS_COMMON_LOGGER.getConfig());
        }
      }).all('/logLevels/name/:componentName/level/:level', function (req, res) {
        return res.status(405).json({error: 'ZWED0129E - Only POST method supported'});
      });
      return router;
    }
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
  },

  swagger(productCode) {
    const router = express.Router();
    const agentSwaggerPluginId = zluxUtil.agentSwaggerPluginId;
    const serverSwaggerPluginId = zluxUtil.serverSwaggerPluginId;
    const agentSwaggerBaseUrl = `${zLuxUrl.makePluginURL(productCode, agentSwaggerPluginId)}/catalogs/swagger`;
    router.get('/api-docs/agent', function(req, res, next) {
      res.redirect(`${agentSwaggerBaseUrl}`);
    });
    
    router.get('/api-docs/agent/:api', function(req, res, next) {
      res.redirect(`${agentSwaggerBaseUrl}/${req.params.api || ''}`);
    });

    const zluxSwaggerBaseUrl = `${zLuxUrl.makePluginURL(productCode, serverSwaggerPluginId)}/catalogs/swagger`;
    router.get(`/api-docs/server`, function(req, res, next) {
      res.redirect(`${zluxSwaggerBaseUrl}`);
    });

    return router;
  },

  pluginLifecycle(options, plugins){
    const router = express.Router();
    const dataserviceAuth = options.serverConfig["dataserviceAuthentication"];
    const rbac = (dataserviceAuth == undefined) ? false : dataserviceAuth.rbac === true;
    if(!rbac){
      router.use('/*', (req, res) => {
        return res.status(506).send("Set dataserviceAuthentication.rbac to true in server configuration");
      })
      return router;
    } else {
      router.put('/', function(req, res){
        if(process.clusterManager){
          let pathToApp = req.query.path;
          let name = req.query.name; //future possibility of a repo to search from. think foo@1.0.0
          if(pathToApp){
            pathToApp = path.normalize(pathToApp);
            if(!installApp.isFile(pathToApp)){
              var installResponse = installApp.addToServer(pathToApp, options.serverConfig.pluginsDir);
              if(installResponse.success === true){
                res.status(200).json({message: `Successfully installed '${installResponse.message}'. Reloading server, please wait a moment.`})
                waitForHeadersBeforeReload(res, DEFAULT_RELOAD_RETRIES, DEFAULT_RELOAD_TIMEOUT);
                return;
              } else {
                return res.status(400).json({error: `ZWED0131E - Failed to install plugin.  Error: ${installResponse.message}`});
              }
            } else {
              return res.status(400).json({error: 'ZWED0132E - Path query must be a directory.'});
            }
          } else if(name){
            return res.status(501).json({error: 'ZWED0133E - Name queries not yet supported.'});
          } else {
            return res.status(400).json({error:'ZWED0134E - Query must include a path to an application directory.'});
          }
        } else {
          return res.status(500).json({error: 'ZWED0135E - Cannot reload server unless cluster mode is in use.'});
        }
      });
      router.delete('/:id', function(req, res){
        if(process.clusterManager){
          const id = req.params.id;
          let found = false;
          for(let i = 0; i < plugins.length; i++){
            if(plugins[i].identifier === id){
              found = true;
              if(plugins[i].pluginType !== 'application'){
                return res.status(400).json({
                  error: `ZWED0136E - Cannot remove plugins of type ${plugins[i].pluginType}`,
                  expectedType: 'application',
                  receivedType: plugins[i].pluginType
                });
              }
            }
          }
          if(!found){
            return res.status(400).json({error: `ZWED0137E - ${id} does not exist.`});
          }
          let fullPath = path.join(options.serverConfig.pluginsDir, id+'.json');
          installLog.info(`ZWED0052I`, id, fullPath); //installLog.info(`Deleting plugin due to request, id '${id}', path '${fullPath}'`);
          fs.unlink(fullPath, (err) => {
            if(err && err.code == 'ENOENT'){
              return res.status(400).json({error: `ZWED0138E - ${id} does not exist.`});
            } else if(err && err.code == 'EACCES'){
              return res.status(400).json({error: `ZWED0139E - Cannot delete plugin with identifier '${id}'`});
            } else if(err){
              return res.status(400).json({error: err});
            }       
            res.status(200).json({message: "Deleting plugin '" + id + "'. Reloading server, please wait a moment."});
            waitForHeadersBeforeReload(res, DEFAULT_RELOAD_RETRIES, DEFAULT_RELOAD_TIMEOUT);
            return;
          })
        } else {
          return res.status(500).send({error: 'ZWED0140E - Cannot reload server unless cluster mode is in use.'});
        }
      })
    }
    return router;
  },
  
  echo() {
    return (req, res) =>{
      contentLogger.info("ZWED0128I", util.inspect(req)); //contentLogger.log(contentLogger.INFO, 'echo\n' + util.inspect(req));
      res.json(req.params);
    }
  }
};

/**
 *  This is passed to every other service of the plugin, so that 
 *  the service can be called by other services under the plugin
 */
function WebServiceHandle(urlPrefix, environment) {
  this.urlPrefix = urlPrefix;
  if (!environment.loopbackConfig.port) {
    installLog.severe(`ZWED0003E`, loopbackConfig); //installLog.severe(`loopback configuration not valid,`,loopbackConfig, `loopback calls will fail!`);
  }
  this.environment = environment;
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
        url += path.startsWith('/') ? path : '/' + path;
      }
      let rejectUnauthorized;
      let protocol;
      if (this.environment.loopbackConfig.isHttps) {
        protocol = 'https:';
        rejectUnauthorized = false;
      } else {
        protocol = 'http:';
      }
      const requestOptions = {
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
      if (options.zluxLoopbackSecret) {
        //TODO use secret in a crypto scheme
        headers[ZLUX_LOOPBACK_HEADER] = options.zluxLoopbackSecret;
      }
      //console.log("headers: ", headers)
      if (Object.getOwnPropertyNames(headers).length > 0) {
        requestOptions.headers = headers;
      }
      let httpOrHttps = this.environment.loopbackConfig.isHttps ? https : http;
      const request = httpOrHttps.request(requestOptions, (response) => {
        var chunks = [];
        response.on('data',(chunk)=> {
          utilLog.debug('ZWED0194I'); //utilLog.debug('Callservice: Data received');
          chunks.push(chunk);
        });
        response.on('end',() => {
          utilLog.debug('ZWED0195I'); //utilLog.debug('Callservice: Service call completed.');
          response.body = Buffer.concat(chunks).toString();
          resolve(response);
        });
      }
      );
      request.on('error', (e) => {
        utilLog.warn('ZWED0061W'); //utilLog.warn('Callservice: Service call failed.');
        reject(e);
      });
      if (options.body) {
        request.write(options.body);
      }
      utilLog.debug('ZWED0196I', JSON.stringify(requestOptions, null, 2)); //utilLog.debug('Callservice: Issuing request to service: ' 
          //+ JSON.stringify(requestOptions, null, 2));
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
  
  addAppSpecificDataToRequest(globalAppData, loopbackSecret) {
    return function addAppSpecificData(req, res, next) {
      const appData = Object.create(globalAppData);
      if (!req[`${constants.APP_NAME}Data`]) {
        req[`${constants.APP_NAME}Data`] = appData; 
      }
      appData.makeErrorObject = zluxUtil.makeErrorObject; 
      if (!appData.webApp) {
        appData.webApp = {};
      } else {
      	appData.webApp = Object.create(appData.webApp);
      }
      appData.webApp.callRootService = function callRootService(name, url, 
          options) {
        if (!this.rootServices[name]) {
          throw new Error(`ZWED0050E - Root service ${name} not found`);
        }
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
          options = options || {};
          options.zluxLoopbackSecret = loopbackSecret;
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
      req[`${constants.APP_NAME}Data`].plugin.def = pluginDef;
      next();
    }
  },
  
  injectServiceDef(serviceDef) {
    return function _injectServiceDef(req, res, next) {
      req[`${constants.APP_NAME}Data`].service.def = serviceDef;
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
        req[`${constants.APP_NAME}Data`].webApp.rootServices = serviceHandles;
        next();
      }
    } else {
      return function inject(req, res, next) {
       // console.log('injecting services: ', Object.keys(serviceHandles))
        req[`${constants.APP_NAME}Data`].plugin.services = serviceHandles;
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

  httpNoCacheHeaders() {
    return function httpCachingHeaders(req, res, next) {
      //service.httpCaching = false means
      //"Cache-control: no-store" and "Pragma: no-cache"
      res.set('Cache-control', 'no-store');
      res.set('Pragma', 'no-cache');
      next();
    }
  },

  //See https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Strict-Transport-Security
  setHstsIfSecure() {
    return function conditonallyAddHsts(req, res, next) {
      if (req.protocol == 'https') {
        res.set('Strict-Transport-Security', 'max-age='+DEFAULT_HSTS_TIME_SECONDS+'; includeSubDomains');
      }
      next();
    }
  },


  /* Static handlers may be customized via the headers section within webContent:
headers: {
  "abc": {
    "value": "123%d",
    "preset": "blah",
    "substitutions": {
      "%d": "domain"
    }
  }
}
*/

  customHeaderInjection(headerDescriptions) {
    return function injectHeaders(req, res, next) {
      for (let i = 0; i < headerDescriptions.length; i++) {
        const headerDescription = headerDescriptions[i];

        const headerName = headerDescription.name;
        if (headerDescription.preset) {
          //TODO do preset
          const preset = getPresetHeader(headerName, headerDescription.preset, req);
          if (preset) {
            res.set(headerName, preset);
          }
        } else if (headerDescription.value) {
          if (headerDescription.substitutions) {
            const substituted = getSubstitutedHeader(headerDescription.value, headerDescription.substitutions, req);
            if (substituted) {
              res.set(headerName, substituted);
            }
          } else {
            res.set(headerName, headerDescription.value);
          }
        } //else nothing to do
      }
      next();
    };
  },
    
  localCheck(loopbackSecret, localIp) {
    return function localCheck(req, res, next) {
      const loopbackData = req.get(ZLUX_LOOPBACK_HEADER);
      const address = ipaddr.process(req.ip)
      if (loopbackSecret == loopbackData && (req.ip == localIp || address.range() == 'loopback')) {
        next();
      } else {
        res.status(403).json({"error":"Cannot access requested service externally"});
      }
    }
  },
  
  logRootServiceCall(proxied, serviceName) {
    const type = proxied? "Proxied root" : "root"
    return function logRouting(req, res, next) {
      routingLog.debug(`ZWED0197I`, req.session.id, type, serviceName, req.method, req.url); //routingLog.debug(`${req.session.id}: ${type} service called: `
          //+`${serviceName}, ${req.method} ${req.url}`);
      next();
    }
  },
  
  logServiceCall(pluginId, serviceName) {
    return function logRouting(req, res, next) {
      routingLog.debug(`ZWED0198I`, req.session.id, pluginId, serviceName, req.method, req.url); //routingLog.debug(`${req.session.id}: Service called: `
          //+`${pluginId}::${serviceName}, ${req.method} ${req.url}`);
      next();
    }
  }
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

function makeLoopbackConfig(nodeConfig) {
  /* TODO do we really prefer loopback HTTPS? Why not simply choose HTTP? */
  if (nodeConfig.https && nodeConfig.https.enabled) {
    return {
      port: nodeConfig.https.port,
      isHttps: true,
      host: nodeConfig.loopbackAddress ? nodeConfig.loopbackAddress : zluxUtil.getLoopbackAddress(nodeConfig.https.ipAddresses)
    }
  } else {
    return {
      port: nodeConfig.http.port,
      isHttps: false,
      host: nodeConfig.loopbackAddress ? nodeConfig.loopbackAddress : zluxUtil.getLoopbackAddress(nodeConfig.http.ipAddresses)
    }
  }
}

function getAgentProxyOptions(serverConfig, tlsOptions, includePrefix) {
  const requestOptions = zluxUtil.getAgentRequestOptions(serverConfig, tlsOptions, false);
  if (!requestOptions) return null;

  let options = {
    isHttps: requestOptions.protocol == 'https:' ? true : false,
    allowInvalidTLSProxy: !requestOptions.rejectUnauthorized,
    requestProcessingOptions: requestOptions.requestProcessingOptions
  }
  if (options.isHttps && !serverConfig.allowInvalidTLSProxy) {
    options.tlsOptions = tlsOptions;
  }
  if (includePrefix && requestOptions.apimlPrefix) {
    options.urlPrefix = requestOptions.apimlPrefix;
  }
  return options;
}

function WebApp(options){
  this.expressApp = expressApp;
  const port = options.httpsPort ? options.httpsPort : options.httpPort;
  let cookieSecret = this.makeCookieSecretUsingTlsOptions(options.tlsOptions);
  if (!cookieSecret) {
    cookieSecret = process.env.expressSessionSecret ? process.env.expressSessionSecret : 'whatever';
  }
  this.expressApp.disable('x-powered-by');
  this.expressApp.use(cookieParser());
  this.expressApp.use(session({
    //TODO properly generate this secret
    name: zluxUtil.getCookieName(port),
    genid: zluxUtil.isHaMode() ? options.auth.generateHaSessionId : undefined,
    secret: cookieSecret,
    // FIXME: require magic is an anti-pattern. all require() calls should 
    // be at the top of the file. TODO Ensure this can be safely moved to the
    // top of the file: it must have no side effects and it must not depend
    // on any global state
    store: require("./sessionStore").sessionStore,
    resave: true, saveUninitialized: false,
    cookie: {
      secure: 'auto',
      sameSite: true
    }
  }));
  this.loopbackSecret = process.env.loopbackSecret ? process.env.loopbackSecret : 'different';
  process.env.expressSessionSecret = undefined;
  process.env.loopbackSecret = undefined;

  this.loopbackConfig = makeLoopbackConfig(options.serverConfig.node);
  this.setValidReferrers(options.serverConfig.node);

  this.wsEnvironment = {
    loopbackConfig: this.loopbackConfig
  }
  this.options = zluxUtil.makeOptionsObject(defaultOptions, options);
  this.auth = options.auth;
  this.configLocation = options.configLocation;
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

  setValidReferrers(options) {
    if (process.env.ZWE_REFERRER_HOSTS) {
      this.validDomains = process.env.ZWE_REFERRER_HOSTS.toLowerCase().split(',');
    } else if (process.env.ZWE_REFERER_HOSTS) {
      this.validDomains = process.env.ZWE_REFERER_HOSTS.toLowerCase().split(',');
    } else {
      let validDomains = [os.hostname().toLowerCase()];
      if (process.env.ZOWE_EXPLORER_HOST && (validDomains[0] != process.env.ZOWE_EXPLORER_HOST)) {
        validDomains.push(process.env.ZOWE_EXPLORER_HOST.toLowerCase());
      }
      if (process.env.ZWE_EXTERNAL_HOSTS) {
        const externalHosts = process.env.ZWE_EXTERNAL_HOSTS.toLowerCase().split(',');
        externalHosts.forEach(host=> {
          if (validDomains.indexOf(host) == -1) {
            validDomains.push(host);
          }
        });
      }
      if (options.http && options.http.ipAddresses) {
        options.http.ipAddresses.forEach(addr => {
          if (validDomains.indexOf(addr) == -1) {
            validDomains.push(addr.toLowerCase());
          }
        });
      }
      if (options.https && options.https.ipAddresses) {
        options.https.ipAddresses.forEach(addr => {
          if (validDomains.indexOf(addr) == -1) {
            validDomains.push(addr.toLowerCase());
          }
        });
      }
      this.validDomains = validDomains;
    }
  },

  checkReferrer(req, res, next) {
    const ref = req.get('Referer');
    
    if (!ref) {
      const address = ipaddr.process(req.ip)
      if (req.ip == this.loopbackConfig.host || address.range() == 'loopback'
          || req.originalUrl.endsWith('/.websocket')) { //ws internal url
        routingLog.debug('Skip referrer on internal url');
        return next();
      }

      routingLog.warn('ZWED0171W',req.originalUrl,req.ip);
      return res.status(403).send('Forbidden due to referrer');
    }
    for (let i = 0; i < this.validDomains.length; i++) {
      let url = 'https://'+this.validDomains[i];
      if (ref.startsWith(url) && (ref[url.length] == ':' || ref[url.length] == '/')) {
        return next();
      }
    }

    routingLog.warn('ZWED0172W',ref,req.originalUrl,req.ip);
    return res.status(403).send('Forbidden due to referrer');
  },

  toString() {
    return `[WebApp product: ${this.options.productCode}]`
  },
  
  makeProxy(urlPrefix, noAuth, overrideOptions, host, port) {
    const r = express.Router();
    let options = {
      urlPrefix,
      isHttps: false, 
      addProxyAuthorizations: (noAuth? null : this.auth.addProxyAuthorizations),
      processProxiedHeaders: (noAuth? null: this.auth.processProxiedHeaders),
      allowInvalidTLSProxy: this.options.allowInvalidTLSProxy
    };
    if (!(host && port)) {
      //destined for agent rather than 3rd party server
      const requestOptions = zluxUtil.getAgentRequestOptions(this.options.serverConfig, this.options.tlsOptions, false, urlPrefix);
      host = requestOptions.host;
      port = requestOptions.port;
      options.urlPrefix = requestOptions.path;
      options.isHttps = requestOptions.protocol == 'https:';
      options.requestProcessingOptions = requestOptions.requestProcessingOptions;
    }
    
    if (overrideOptions) {
      options = Object.assign(options, overrideOptions);
    }
    r.use(proxy.makeSimpleProxy(host, port,
                                options));
    r.ws('/', proxy.makeWsProxy(host, port,
                                urlPrefix, options));
    return r;
  },
  
  makeExternalProxy(host, port, urlPrefix, isHttps, noAuth, pluginID, serviceName) {
    const r = express.Router();
    installLog.info(`ZWED0053I`, `${isHttps? 'HTTPS' : 'HTTP'}`, `${pluginID}:${serviceName}`, `${host}:${port}/${urlPrefix}`); //installLog.info(`Setting up ${isHttps? 'HTTPS' : 'HTTP'} proxy ` +`(${pluginID}:${serviceName}) to destination=${host}:${port}/${urlPrefix}`);
    let myProxy = proxy.makeSimpleProxy(host, port, {
      urlPrefix, 
      isHttps, 
      addProxyAuthorizations: (noAuth? null : this.auth.addProxyAuthorizations),
      processProxiedHeaders: (noAuth? null : this.auth.processProxiedHeaders),
      allowInvalidTLSProxy: this.options.allowInvalidTLSProxy
    }, pluginID, serviceName);
    proxyMap.set(pluginID + ":" + serviceName, myProxy);
    r.use(myProxy);
    return r;
  },
  
  installStaticHanders() {
    const webdir = path.join(path.join(this.options.productDir,
      this.options.productCode), 'web');
    const rootPage = this.options.rootRedirectURL? '.'+this.options.rootRedirectURL
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
      this.appData, this.loopbackSecret));
  },

  _installRootService(url, method, handler, {needJson, needAuth, authType, isPseudoSso}) {
    const handlers = [commonMiddleware.logRootServiceCall(false, url), commonMiddleware.httpNoCacheHeaders()];
    if (needJson) {
      handlers.push(jsonParser);
    }
    if (isPseudoSso) {
      handlers.push((req, res, next) => {
        //hack for pseudo-SSO
        req[`${constants.APP_NAME}Data`].webApp.authServiceHandleMaps = 
          this.authServiceHandleMaps;
        next();
      })
    }
    if (needAuth) {
      if (authType == "semi") {
        handlers.push(this.auth.semiAuthenticatedMiddleware);
      } else {
        handlers.push(this.auth.middleware); 
      }
    }
    handlers.push(handler);
    installLog.info(`ZWED0054I`, url); //installLog.info(`installing root service at ${url}`);
    this.expressApp[method](url, handlers); 
  },
  
  installRootServices() {
    const serviceHandleMap = {};
    const rootServicesMiddleware = commonMiddleware.injectServiceHandles(serviceHandleMap, true);
    for (const proxiedRootService of this.options.rootServices || []) {
      const name = proxiedRootService.name || proxiedRootService.url.replace("/", "");
      installLog.info(`ZWED0055I`, proxiedRootService.url); //installLog.info(`installing root service proxy at ${proxiedRootService.url}`);
      //note that it has to be explicitly false. other falsy values like undefined
      //are treated as default, which is true
      let middlewareArray = [commonMiddleware.logRootServiceCall(true, name)];
      if (SHOULD_CHECK_REFERRER) {
        middlewareArray.push((req,res,next)=> this.checkReferrer(req,res,next));
      }
      if (proxiedRootService.requiresAuth === false) {
        const _router = this.makeProxy(proxiedRootService.url, true,
                                       getAgentProxyOptions(this.options.serverConfig, this.options.tlsOptions, false));
        middlewareArray.push(_router);
        this.expressApp.use(proxiedRootService.url, middlewareArray);
      } else {
        const _router = this.makeProxy(proxiedRootService.url, false,
                                       getAgentProxyOptions(this.options.serverConfig, this.options.tlsOptions, false));
        middlewareArray.push(_router);
        this.expressApp.use(proxiedRootService.url, rootServicesMiddleware, this.auth.middleware, middlewareArray);
      }
      serviceHandleMap[name] = new WebServiceHandle(proxiedRootService.url, 
          this.wsEnvironment);
    }
    this.expressApp.use(rootServicesMiddleware);
    
    this._installRootService('/auth', 'post', this.auth.doLogin, 
        {needJson: true, needAuth: false, isPseudoSso: true});
    this._installRootService('/auth-password', 'post', this.auth.doPasswordReset,
        {needJson: true, needAuth: false, isPseudoSso: false});
    this._installRootService('/auth', 'get', this.auth.getStatus, 
        {needJson: true, needAuth: false, isPseudoSso: true});
    this._installRootService('/auth-refresh', 'get', this.auth.refreshStatus, 
        {needJson: true, needAuth: false, isPseudoSso: true});    
    this._installRootService('/auth-logout', 'post', this.auth.doLogout, 
        {needJson: true, needAuth: false, isPseudoSso: true});
    this._installRootService('/auth-logout', 'get', this.auth.doLogout, 
        {needJson: true, needAuth: false, isPseudoSso: true});
    serviceHandleMap['auth'] = new WebServiceHandle('/auth', this.wsEnvironment);
    this._installRootService('/plugins', 'get', staticHandlers.plugins(this), 
        {needJson: false, needAuth: true, authType: "semi", isPseudoSso: false}); 
    this._installRootService('/plugins', 'use', staticHandlers.pluginLifecycle(this.options, this.plugins),
      {needJson: true, needAuth: true, isPseudoSso: false});
    serviceHandleMap['plugins'] = new WebServiceHandle('/plugins', this.wsEnvironment);
    this._installRootService('/server/proxies','get',staticHandlers.getServerProxies(this.options),
        {needJson: false, needAuth: false, isPseudoSso: false});
    this._installRootService('/server', 'use', staticHandlers.server(this.options), 
        {needJson: false, needAuth: true, isPseudoSso: false});
    serviceHandleMap['server'] = new WebServiceHandle('/server', this.wsEnvironment);
    this._installRootService('/echo/*', 'get', staticHandlers.echo(),
        {needJson: false, needAuth: true, isPseudoSso: false});
    serviceHandleMap['echo'] = new WebServiceHandle('/echo', this.wsEnvironment);
    this._installRootService('/apiManagement', 'use', staticHandlers.apiManagement(this),
        {needJson: false, needAuth: true, isPseudoSso: false});
    serviceHandleMap['apiManagement'] = new WebServiceHandle('/apiManagement', 
        this.wsEnvironment);
    this.expressApp.use(staticHandlers.eureka());
    this.expressApp.use(staticHandlers.swagger(this.options.productCode));
  },
  
  _makeRouterForLegacyService(pluginContext, service) {
    const plugin = pluginContext.pluginDef;
    const subUrl = zLuxUrl.makeServiceSubURL(service);
    installLog.debug("ZWED0199I", plugin.identifier, subUrl); //installLog.debug(plugin.identifier + ": service " + subUrl);
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
          error: 'ZWED0141E - Internal Server Error'
        }));
      } catch (closeEx) {
        logException(closeEx);
      }
    };
    const logException = function(e) {
      utilLog.warn("ZWED0062W", toString(), e.message); //utilLog.warn(toString()+' Exception caught. Message='+e.message);
      utilLog.warn("ZWED0063W", e.stack); //utilLog.warn("Stack trace follows\n"+e.stack);
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
        installLog.warn("ZWED0064W", plugin.identifier, method); //installLog.warn(plugin.identifier + ": invalid method " + method);
        continue;
      }
      if (method === 'ws') {
        installLog.info("ZWED0056I", plugin.identifier); //installLog.info(plugin.identifier + ": installing websocket service");
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
          installLog.debug("ZWED0200I", plugin.identifier, method, route.path, service.handlerInstaller); //installLog.debug(`${plugin.identifier}: ${method} ${route.path} `
                           //+` handled by ${service.handlerInstaller}`);
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
    serviceRouterWithMiddleware.push(commonMiddleware.setHstsIfSecure());
    serviceRouterWithMiddleware.push(commonMiddleware.logServiceCall(
        plugin.identifier, service.name));
    if (service.httpCaching !== true) {
      //Per-dataservice middleware to handle tls no-cache
      serviceRouterWithMiddleware.push(commonMiddleware.httpNoCacheHeaders());
    }
    if (service.internalOnly) {
      serviceRouterWithMiddleware.push(commonMiddleware.localCheck(this.loopbackSecret, this.loopbackConfig.host));
    }
    let router;
    switch (service.type) {
    case "service":
      //installLog.info(`${plugin.identifier}: installing proxy at ${subUrl}`);
      router = this.makeProxy(service.urlPrefix
        ? service.urlPrefix
        : zLuxUrl.makePluginURL(this.options.productCode, plugin.identifier)
          + zLuxUrl.makeServiceSubURL(service, false, true),
        false,
        getAgentProxyOptions(this.options.serverConfig, this.options.tlsOptions, false));
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
            serviceConfiguration, pluginContext, this);
        if (!service.routerFactory) {
          router = yield service.nodeModule(dataserviceContext);
          installLog.debug("ZWED0057I", plugin.identifier, service.name, router); //installLog.info("Loaded Router for plugin=" + plugin.identifier + ", service="+service.name + ". Router="+router);
        } else {
          router = yield service.nodeModule[service.routerFactory](
              dataserviceContext);
              installLog.debug("ZWED0058I", plugin.identifier, service.name, service.routerFactory); //installLog.info("Loaded Router from factory for plugin=" + plugin.identifier + ", service=" + service.name + ". Factory="+service.routerFactory);
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
            installLog.info(`ZWED0059I`, `${plugin.identifier}:${service.name}`, JSON.stringify(connectionInfo)); //installLog.info(`Found connection info for ${plugin.identifier}:${service.name}=`,connectionInfo);
            //TODO resolve localhost to something better... allow binding to specific IPs like we did for node
            router = this.makeProxy(connectionInfo.url, true,
                                    connectionInfo.options, 'localhost', connectionInfo.port);
          } else {
            throw new Error(`ZWED0051E - Could not resolve service URL. Plugin=${plugin.identifier}, service=${service.name}`);
          }
          foundManager = true;
          break;
        }
      }
      if (!foundManager) {
        throw new Error(`ZWED0052E - Could not load service ${plugin.identifier}:${service.name} `
                        +`due to unknown type=${service.type}`);
      }
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
        const handle = new WebServiceHandle(subUrl, this.wsEnvironment);
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
    installLog.debug(`ZWED0060I`, plugin.identifier) //installLog.info(`${plugin.identifier}: installing data services`)
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
      installLog.debug(`ZWED0061I`,plugin.identifier, serviceName) //installLog.info(`${plugin.identifier}: installing service ${serviceName}`)
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
        installLog.info(`ZWED0062I`, plugin.identifier, subUrl); //installLog.info(`${plugin.identifier}: installing router at ${subUrl}`);
        
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
      installLog.debug(`ZWED0063I`, plugin.identifier, localName) //installLog.info(`${plugin.identifier}: importing service ${localName}`)
      const group = plugin.importsGrouped[localName];
      for (const version of Object.keys(group.versions)) {
        const importedService = group.versions[version];
        const subUrl = urlBase 
          + zLuxUrl.makeServiceSubURL(importedService);
        const importedRouter = this.routers[importedService.sourcePlugin]
          [importedService.sourceName][importedService.version];
        if (!importedRouter) {
          throw new Error(
            `ZWED0053E - Import ${importedService.sourcePlugin}:${importedService.sourceName}`
            + " can't be satisfied");
        }
        installLog.info(`ZWED0064I`, plugin.identifier, importedService.sourcePlugin, importedService.sourceName, subUrl); //installLog.info(`${plugin.identifier}: installing import` + ` ${importedService.sourcePlugin}:${importedService.sourceName}` + ` at ${subUrl}`);
        this.pluginRouter.use(subUrl, importedRouter);
        let pluginsRouters = this.routers[plugin.identifier];
        if (!pluginsRouters) {
          pluginsRouters = {};
          this.routers[plugin.identifier] = pluginsRouters;
        }
        let servicesRouters = pluginsRouters[localName];
        if (!servicesRouters) {
          servicesRouters = {};
          pluginsRouters[localName] = servicesRouters;
        }
        servicesRouters[importedService.version] = importedRouter;
        if (version === group.highestVersion) {
          const defaultSubUrl = urlBase 
              + zLuxUrl.makeServiceSubURL(importedService, true);
          this.pluginRouter.use(defaultSubUrl, importedRouter);
        }
      }
    }
  },


  _installPluginStaticHandlers(plugin, urlBase) {
    installLog.debug(`ZWED0065I`, plugin.identifier); //installLog.info(`${plugin.identifier}: installing static file handlers...`);
    if (plugin.webContent && plugin.location) {
      let url = `${urlBase}/web`;
      installLog.info(`ZWED0066I`, plugin.identifier, url); //installLog.info(`${plugin.identifier}: serving static files at ${url}`);
      
      let middleware = [];
      middleware.push(commonMiddleware.setHstsIfSecure());
      if (this.options.serverConfig.node.headers || plugin.webContent.headers) {
        let headers = Object.assign({}, this.options.serverConfig.node.headers || {});
        let pluginHeaders = plugin.webContent.headers;
        if (pluginHeaders) {
          if (Object.keys(headers).length == 0) {
            headers = plugin.webContent.headers;
          } else {
            let keys = Object.keys(pluginHeaders);
            for (let i = 0; i < keys.length; i++) {
              if (!headers[keys[i]]) {
                headers[keys[i]] = pluginHeaders[keys[i]];
              } else if (!headers[keys[i]].override) {
                headers[keys[i]] = pluginHeaders[keys[i]];
              }
            }
          }
        }
        let headersArray = [];
        let keys = Object.keys(headers);
        for (let i = 0; i < keys.length; i++) {
          let header = Object.assign({}, headers[keys[i]]);
          header.name = keys[i];
          headersArray.push(header);
        }
        middleware.push(commonMiddleware.customHeaderInjection(headersArray));
      }
      middleware.push(expressStaticGzip(path.join(plugin.location, '/web'),
                                        {enableBrotli: true, orderPreference: ['br', 'gzip']}));
      this.pluginRouter.use(url, middleware);
    }
    if (plugin.pluginType === "library") {
      if (plugin.libraryVersion) {
        let url = `/lib/${plugin.identifier}/${plugin.libraryVersion}`;
        installLog.info(`ZWED0067I`, plugin.identifier, url); //installLog.info(`${plugin.identifier}: serving library files at ${url}`);
        
        let middleware = [];
        middleware.push(commonMiddleware.setHstsIfSecure());
        middleware.push(expressStaticGzip(plugin.location,
                                          {enableBrotli: true, orderPreference: ['br', 'gzip']}));
        this.pluginRouter.use(url, middleware);
      } else {
        installLog.warn(`ZWED0065W`, `${plugin.identifier}`); //installLog.warn(`Library ${plugin.identifier} is missing libraryVersion attribute for hosting files. `
                        //+`Skipping file hosting.`);
      }
    }
  },

  _installIframePlugin(plugin, urlBase) {
    if(plugin.webContent && plugin.webContent.framework === 'iframe' && plugin.webContent.destination>'') {
      const iframeRouterWithMiddleware = [];
      iframeRouterWithMiddleware.push(this.auth.middleware);
      iframeRouterWithMiddleware.push(commonMiddleware.setHstsIfSecure());
      const destination = plugin.webContent.destination;
      const router = express.Router();
      router.use((req, res, callback) => {
        const remoteUrl = zluxUtil.makeRemoteUrl(destination, req);
        installLog.info("ZWED0299I", plugin.identifier, remoteUrl);
        const startingPage = zluxUtil.getRemoteIframeTemplate(remoteUrl);
        res.send(startingPage);
      });
      iframeRouterWithMiddleware.push(router);
      this.pluginRouter.use(`${urlBase}/iframe`, iframeRouterWithMiddleware);
    }
  },

  _installSwaggerCatalog(plugin, urlBase, nodeContext) {
    // let ms = plugin.identifier === zluxUtil.serverSwaggerPluginId ? 5000:0
    let ms = 0;
    if(plugin.identifier === zluxUtil.serverSwaggerPluginId) {
      ms = 10000;
    }
    zluxUtil.timeout(ms)
    .then(() => plugin.getApiCatalog(this.options.productCode, nodeContext)).then((openApi) => {
      const router = express.Router();
      installLog.info(`ZWED0068I`, plugin.identifier); //installLog.info(`Creating composite swagger endpoint for ${plugin.identifier}`);
      
      router.get("/", (req, res) => {
        res.status(200).json(openApi.pluginCatalog);
      });
      if (openApi && openApi.serviceDocs && openApi.serviceDocs.length > 0) {
        openApi.serviceDocs.forEach(function (service) {
          installLog.info(`ZWED0069I`, plugin.identifier, service.serviceName); //installLog.info(`Creating swagger endpoint for${plugin.identifier}:${service.serviceName}`);
          router.get(`/${service.serviceName}`, (req, res) => {
            res.status(200).json(service.serviceDoc)
          });
        });
      }

      this.pluginRouter.use(zLuxUrl.join(urlBase, '/catalogs/swagger'),
          router);
    });
  },

  injectPluginRouter() {
    this.expressApp.use(this.pluginRouter);
  },
  installPlugin: Promise.coroutine(function*(pluginContext) {
    const plugin = pluginContext.pluginDef;
    const urlBase = zLuxUrl.makePluginURL(this.options.productCode, 
        plugin.identifier);
    const nodeContext = pluginContext.server.config.user.node;

    try {
      //dataservices load first since in case of error, we want to skip the rest of the plugin load
      if (SHOULD_CHECK_REFERRER) {
        this.pluginRouter.use(zLuxUrl.join(urlBase, '/services/*'), (req,res,next)=> this.checkReferrer(req,res,next));
      }
      yield *this._installDataServices(pluginContext, urlBase);
      this._installSwaggerCatalog(plugin, urlBase, nodeContext);
      this._installPluginStaticHandlers(plugin, urlBase);      
      this._installIframePlugin(plugin, urlBase);      
    } catch (e) {
      //index.js listens and logs, so dont log twice here
      //throw so that plugin isnt pushed to list if there's something wrong with it
      throw e;
    }
    this._resolveImports(plugin, urlBase);
    this.plugins.push(plugin);
  }),

  installErrorHanders() {
    this.expressApp.use((req, res, next) => {
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
              utilLog.debug("ZWED0201I"); //utilLog.debug("About to call myProxy");
              myProxy(req, res);
              utilLog.debug("ZWED0202I"); //utilLog.debug("After myProxy call");
            } else {
              utilLog.debug("ZWED0203I", referrer); //utilLog.debug(`Referrer proxying miss. Resource not found, sending`
                  //+ ` 404 because referrer (${referrer}) didn't match an existing proxy service`);
              return do404(req.url, res, this.options.productCode
                  + ": unknown resource requested");
            }
          } else {
            utilLog.debug(`ZWED0204I`, referrer); //utilLog.debug(`Referrer proxying miss. Resource not found, sending`
                  //+ ` 404 because referrer (${referrer}) didn't match a plugin pattern`);               
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
  },

  makeCookieSecretUsingTlsOptions(tlsOptions) {
    if (tlsOptions && Array.isArray(tlsOptions.key) && tlsOptions.key[0] instanceof Buffer) {
      const key = tlsOptions.key[0];
      const hash = crypto.createHash('md5');
      return hash.update(key).digest('hex');
    }
    return undefined;
  },

  init() {
    this.expressWs.applyTo(express.Router);
    this.installRootServices();
    this.injectPluginRouter();
    this.installErrorHanders();
  }
};

module.exports.makeWebApp = function (options) {
  const webApp = new WebApp(options);
  webApp.installCommonMiddleware();
  webApp.installStaticHanders();
  return webApp;
};

/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/

