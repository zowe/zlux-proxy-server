
/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/

'use strict';
const util = require('util');
const fs = require('fs');
const http = require('http');
const https = require('https');
const url = require('url');
const path = require('path');
const os = require('os');
const assert = require('assert');
const requireFromString = require('require-from-string');
const EventEmitter = require('events');
const semver = require('semver');
const zluxUtil = require('./util');
const jsonUtils = require('./jsonUtils.js');
const configService = require('../plugins/config/lib/configService.js');
const pluginDefinitionValidation = require('./pluginDefinitionValidation.js')
const DependencyGraph = require('./depgraph');
const translationUtils = require('./translation-utils.js');
const makeSwaggerCatalog = require('./swagger-catalog');

/**
 * Plugin loader: reads the entire plugin configuration tree
 * 
 *  - resolves plugin refs
 *  - reads plugin definition files
 *  - loads any supplemental modules required by plugins
 *  - performs some validation 
 * 
 */
const bootstrapLogger = zluxUtil.loggers.bootstrapLogger;

const defaultOptions = {
  productCode: null,
  authManager: null,
  pluginsDir: null,
  serverConfig: null
}

var uniquePluginIdentifiers = []
var uniquePluginPaths = []

function Service(def, configuration, plugin) {
  this.configuration = configuration;
  //don't do this here: avoid circular structures:
  //this.plugin = plugin; 
  Object.assign(this, def);
  if (this.version === undefined) {
    //FIXME temporary hack until everyone has fixed their plugin defs.
    bootstrapLogger.warn(`Service ${plugin.identifier}::${this.name} doesn't` 
      + ` specify a version. Resorting to the plugin's API version ${plugin.apiVersion}`);
    this.version = plugin.apiVersion;
  }
}
Service.prototype = {
  constructor: Service,
  
  validate() {
    if (!semver.valid(this.version)) {
      throw new Error(`${this.name}: invalid version "${this.version}"`)
    }
    if (this.versionRequirements) {
      for (let serviceName of Object.keys(this.versionRequirements)) {
        if (!semver.validRange(this.versionRequirements[serviceName])) {
          throw new Error(`${this.localName}: invalid version range ` +
              `${serviceName}: ${this.versionRequirements[serviceName]}`)
        }
      }
    }
  }
}

function Import(def, configuration, plugin) {
  Service.call(this, def, configuration, plugin);
}
Import.prototype = {
  constructor: Import,
  __proto__:  Service.prototype,
  
  validate() {
    if (!semver.validRange(this.versionRange)) {
      throw new Error(`${this.localName}: invalid version range "${this.versionRange}"`)
    }
  }
}

function NodeService(def, configuration, plugin) {
  Service.call(this, def, configuration, plugin);
}
NodeService.prototype = {
  constructor: NodeService,
  __proto__:  Service.prototype,
  
  loadImplementation(dynamicallyCreated, location) {
    if (dynamicallyCreated) {
      const nodeModule = requireFromString(this.source);
      this.nodeModule = nodeModule;
    } else {
      // Quick fix before MVD-947 is merged
      var fileLocation = ""
      if (this.filename) {
        fileLocation = path.join(location, 'lib', this.filename);
      } else if (this.fileName) {
        fileLocation = path.join(location, 'lib', this.fileName);
      } else {
        throw new Error(`No file name for data service`)
      }
      const nodeModule = require(fileLocation);
      this.nodeModule = nodeModule;
    }
  }
}

//first checks if the parent plugin has a host and port 
//and if not, looks them up in the config
function ExternalService(def, configuration, plugin) {
  Service.call(this, def, configuration, plugin);
  if (!this.host) {
    this.host = plugin.host;
  }
  if (!this.port) {
    this.port = plugin.port;
  }
  const remoteConfig = configuration.getContents(["remote.json"]);
  if (remoteConfig) {
    if (!this.host) {
      this.host = remoteConfig.host;
    }
    if (!this.port) {
      this.port = remoteConfig.port;
    }
  }
}
ExternalService.prototype = {
  constructor: ExternalService,
  __proto__:  Service.prototype
}

function makeDataService(def, plugin, context) {
  const configuration = configService.getServiceConfiguration(plugin.identifier,
      def.name, context.config, context.productCode);
  let dataservice;
  if (def.type == "external") {
    dataservice = new ExternalService(def, configuration, plugin);
  } else if (def.type == "import") {
    dataservice = new Import(def, configuration, plugin);
  } else if ((def.type == 'nodeService')
        || (def.type === 'router')) {
    dataservice = new NodeService(def, configuration, plugin);
  } else {
    dataservice = new Service(def, configuration, plugin);
  }
  dataservice.validate();
  return dataservice;
}

function Plugin(def, configuration) {
  Object.assign(this, def);
  this.configuration = configuration;
  if (!this.location) {
    this.location = process.cwd();
  }
  this.translationMaps = {};
}
Plugin.prototype = {
  constructor: Plugin,
  identifier: null,
  apiVersion: null,
  pluginVersion: null,
  pluginType: null,
  webContent: null,
  copyright:null,
  location: null,
  dataServices: null,
  dataServicesGrouped: null,
  configuration: null,
  //...
  
  toString() {
    return `[Plugin ${this.identifier}]`
  },
  
  isValid() {
    //TODO detailed diagnostics
    return this.identifier && (typeof this.identifier === "string")
      && this.pluginVersion && (typeof this.pluginVersion === "string")
      && this.apiVersion && (typeof this.apiVersion === "string")
      //this might cause some pain, but I guess it's better to
      //leave it here and make everyone tidy up their plugin defs:
      && this.pluginType && (typeof this.pluginType === "string")
      ;
  },
  
  init(context) {
    //Nothing here anymore: startup checks for validity will be superceeded by https://github.com/zowe/zlux-proxy-server/pull/18 and initialization concept has not manifested for many plugin types, so a warning is not needed.
  },
  
  exportDef() {
    return {
      identifier: this.identifier,
      pluginVersion: this.pluginVersion,
      apiVersion: this.apiVersion,
      pluginType: this.pluginType,
      copyright: this.copyright,
      //TODO move these to the appropraite plugin type(s)
      webContent: this.webContent, 
      configurationData: this.configurationData,
      dataServices: this.dataServices
    };
  },

  exportTranslatedDef(acceptLanguage) {
    const def = this.exportDef();
    if (typeof this.webContent === 'object') {
      return translationUtils.translate(def, this.translationMaps, acceptLanguage);
    }
    return def;
  },

  loadTranslations() {
    if (typeof this.webContent === 'object') {
      this.translationMaps = translationUtils.loadTranslations(this.location);
    }
  },
  
  initStaticWebDependencies() {
    if (this.webContent) {
      let contentPath = path.join(this.location, "web");
      if (!fs.existsSync(contentPath)) {
        bootstrapLogger.warn(`plugin ${this.identifier} has web content but `
            + `no web directory under ${this.location}`);
      } else {
        bootstrapLogger.info(`plugin ${this.identifier} `
            + `will serve static files from ${contentPath}`);
        this.webContent.path = contentPath;
      }
    }
  },
  
  initDataServices(context) {
    function addService(service, name, container) {
      let group = container[name];
      if (!group) {
        group = container[name] = {
          name,
          highestVersion: null,
          versions: {},
        };
      }
      if (!group.highestVersion 
          || semver.gt(service.version, group.highestVersion)) {
        group.highestVersion = service.version;
      }
      group.versions[service.version] = service;
    }
    
    if (!this.dataServices) {
      return;
    }
    this.dataServicesGrouped = {};
    this.importsGrouped = {};
    const filteredDataServices = [];
    for (const dataServiceDef of this.dataServices) {
      const dataservice = makeDataService(dataServiceDef, this, context);
      if (dataservice.type == "service") {          
        addService(dataservice, dataservice.name, this.dataServicesGrouped);
        bootstrapLogger.info(`${this.identifier}: `
            + `found proxied service '${dataservice.name}'`);
        filteredDataServices.push(dataservice);
      } else   if (dataservice.type === 'import') {
        bootstrapLogger.info(`${this.identifier}:`
            + ` importing service '${dataservice.sourceName}'`
            + ` from ${dataservice.sourcePlugin}`
            + ` as '${dataservice.localName}'`);
        addService(dataservice, dataservice.localName, this.importsGrouped);
        filteredDataServices.push(dataservice);
      } else if ((dataservice.type == 'nodeService')
          || (dataservice.type === 'router')) {
        //TODO what is this? Why do we need it?
//        if ((dataservice.serviceLookupMethod == 'internal')
//            || !dataservice.dependenciesIncluded) {
//          bootstrapLogger.warn(`${this.identifier}:`
//              + ` loading dataservice ${dataservice.name} failed, declaration invalid`);
//          continue;
//        }
        dataservice.loadImplementation(this.dynamicallyCreated, this.location);
        if (dataservice.type === 'router') {
          bootstrapLogger.info(`${this.identifier}: `
              + `found router '${dataservice.name}'`);
          addService(dataservice, dataservice.name, this.dataServicesGrouped);
        } else {
          bootstrapLogger.info(`${this.identifier}: `
              + `found legacy node service '${dataservice.name}'`);
          addService(dataservice, dataservice.name, this.dataServicesGrouped);
        }
        filteredDataServices.push(dataservice);
      } else if (dataservice.type == 'external') {
        addService(dataservice, dataservice.name, this.dataServicesGrouped);
        bootstrapLogger.info(`${this.identifier}: `
            + `found external service '${dataservice.name}'`);
        filteredDataServices.push(dataservice);
      } else {
        bootstrapLogger.warn(`${this.identifier}: `
            + `invalid service type '${dataservice.name}'`);
      }
    }
    this.dataServices = filteredDataServices;
    this._validateLocalVersionRequirements()
  },
  
  _validateLocalVersionRequirements() {
    for (let service of this.dataServices) {
      if (!service.versionRequirements) {
        continue;
      }
      for (let serviceName of Object.keys(service.versionRequirements)) {
        const allVersions = this.dataServicesGrouped[serviceName] 
            || this.importsGrouped[serviceName];
        if (!allVersions) {
          throw new Error(`${this.identifier}::${service.name} `
              + "Required local service missing: " + serviceName)
        }
        const requiredVersion = service.versionRequirements[serviceName];
        let found = null;
        for (let availableVersion of Object.keys(allVersions.versions)) {
          if (semver.satisfies(availableVersion, requiredVersion)) {
            found = availableVersion;
            break;
          }
        }
        if (!found) {
          throw new Error(`${this.identifier}::${service.name} `
              + `Could not find a version to satisfy local dependency `
              + `${serviceName}@${requiredVersion}`)
        } else {
          bootstrapLogger.debug(`${this.identifier}::${service.name}: found `
              + `${serviceName}@${found}`)
          //replace the mask in the def with an actual version to make the life 
          // simpler
          service.versionRequirements[serviceName] = found;
        }
      }
    }
  },
  
  getApiCatalog(productCode) {
    return makeSwaggerCatalog(this, productCode)
  }
  
};

function LibraryPlugIn(def, configuration) {
  Plugin.call(this, def, configuration);
}
LibraryPlugIn.prototype = {
  __proto__: Plugin.prototype,
  constructor: LibraryPlugIn,
  
  init(context) {
    assert(this.pluginType === "library");
    if (!fs.existsSync(this.location)) {
      bootstrapLogger.log(bootstrapLogger.WARNING,
        `${def.identifier}: library path ${this.location} does not exist`);
      return;
    }
    bootstrapLogger.log(bootstrapLogger.INFO,
      `Plugin ${this.identifier} will serve library data from directory ${this.location}`);
  }
};

function ApplicationPlugIn(def, configuration) {
  Plugin.call(this, def, configuration);
}
ApplicationPlugIn.prototype = {
  __proto__: Plugin.prototype,
  constructor: ApplicationPlugIn,
};

function WindowManagerPlugIn(def, configuration) {
  Plugin.call(this, def, configuration);
}
WindowManagerPlugIn.prototype = {
  constructor: WindowManagerPlugIn,
  __proto__: Plugin.prototype,
};

function BootstrapPlugIn(def, configuration) {
  Plugin.call(this, def, configuration);
}
BootstrapPlugIn.prototype = {
  constructor: BootstrapPlugIn,
  __proto__: Plugin.prototype,
};

function DesktopPlugIn(def, configuration) {
  Plugin.call(this, def, configuration);
}
DesktopPlugIn.prototype = {
  constructor: DesktopPlugIn,
  __proto__: Plugin.prototype,
};

function NodeAuthenticationPlugIn(def, configuration) {
  Plugin.call(this, def, configuration);
}
NodeAuthenticationPlugIn.prototype = {
  constructor: NodeAuthenticationPlugIn,
  __proto__: Plugin.prototype,
  authenticationCategory: null,
  filename: null,
  
  isValid(context) {
    if (!(super.isValid(context) && this.filename 
        && this.authenticationCategory)) {
      return false;
    }
    //we should not load authentication types that are 
    //not requested by the administrator
    if (!context.authManager.authPluginRequested(this.identifier,
      this.authenticationCategory)) {
      bootstrapLogger.warn("Authentication plugin was found which was not requested in "
          + "the server configuration file's dataserviceAuthentication object. "
          + "Skipping load of this plugin");
      return false;
    }
    return true;
  },
  
  exportDef() {
    return Object.assign(super.exportDef(), {
      filename: this.filename,
      authenticationCategory: this.authenticationCategory
    });
  },
  
  init(context) {
    const filepath = path.join(this.location, 'lib', this.filename);
    bootstrapLogger.log(bootstrapLogger.INFO,
      `Auth plugin ${this.identifier}: loading auth handler module ${filepath}`)
    this.authenticationModule = require(filepath);
    context.authManager.registerAuthenticator(this);
  }
};

function ProxyConnectorPlugIn(def, configuration) {
  Plugin.call(this, def, configuration);
  const remoteConfig = configuration.getContents(["remote.json"]);
  if (remoteConfig) {
    if (!this.host) {
      this.host = remoteConfig.host;
    }
    if (!this.port) {
      this.host = remoteConfig.port;
    }
  }
}
ProxyConnectorPlugIn.prototype = {
  constructor: ProxyConnectorPlugIn,
  __proto__: Plugin.prototype,
  
  isValid(context) {
    if (!(super.isValid(context) && this.host && this.port)) {
      return false;
    }
//    //we should not load authentication types that are 
//    //not requested by the administrator
//    if (!context.authManager.authPluginRequested(this.identifier,
//      this.authenticationCategory)) {
//      bootstrapLogger.warn("Authentication plugin was found which was not requested in "
//          + "the server configuration file's dataserviceAuthentication object. "
//          + "Skipping load of this plugin");
//      return false;
//    }
    return true;
  },
};

const plugInConstructorsByType = {
  "library": LibraryPlugIn,
  "application": ApplicationPlugIn,
  "windowManager": WindowManagerPlugIn,
  "bootstrap": BootstrapPlugIn,
  "desktop": DesktopPlugIn,
  "nodeAuthentication": NodeAuthenticationPlugIn,
  "proxyConnector": ProxyConnectorPlugIn
};

function makePlugin(def, pluginConfiguration, pluginContext, dynamicallyCreated) {
  const pluginConstr = plugInConstructorsByType[def.pluginType];
  if (!pluginConstr) {
    throw new Error(`${def.identifier}: pluginType ${def.pluginType} is unknown`); 
  }
  // one can think in terms of Java: `def` is a JSON-serialized instance of the
  // "class" referred to by `proto`. Create an instance and inject the
  // de-serialized instance data there.
  // (We don't need an extra indirection level, e.g. self.definition = def)
  const self = new pluginConstr(def, pluginConfiguration);
  self.dynamicallyCreated = dynamicallyCreated;
  if (!self.isValid(pluginContext)) {
    bootstrapLogger.warn(`${def.location} points to an`
        + " invalid plugin definition, skipping");
    throw new Error(`Plugin ${def.identifier} invalid`)
  }
  self.initDataServices(pluginContext);
  if (!dynamicallyCreated) {
    self.initStaticWebDependencies();
  }
  self.init(pluginContext);
  return self;
};

function PluginLoader(options) {
  EventEmitter.call(this);
  this.options = zluxUtil.makeOptionsObject(defaultOptions, options);
  this.plugins = [];
  this.pluginMap = {};
};
PluginLoader.prototype = {
  constructor: PluginLoader,
  __proto__: EventEmitter.prototype,
  options: null,
  plugins: null,
  pluginMap: null,

  _readPluginDef(pluginDescriptorFilename) {
    const pluginPtrPath = path.join(this.options.pluginsDir, 
        pluginDescriptorFilename);
    bootstrapLogger.info(`Processing plugin reference ${pluginPtrPath}...`);
    if (!fs.existsSync(pluginPtrPath)) {
      throw new Error(`${pluginPtrPath} is missing`);
    }
    const pluginPtrDef = jsonUtils.parseJSONWithComments(pluginPtrPath);
    bootstrapLogger.log(bootstrapLogger.FINER, util.inspect(pluginPtrDef));
    let pluginBasePath = pluginPtrDef.pluginLocation;
    if (!path.isAbsolute(pluginBasePath)) {
      pluginBasePath = path.join(process.cwd(), pluginBasePath);
    }
    if (!fs.existsSync(pluginBasePath)) {
      throw new Error(`${pluginDescriptorFilename}: No plugin directory found at`
        + `${pluginPtrDef.pluginLocation}`);
     }
    let pluginDefPath = path.join(pluginBasePath, 'pluginDefinition.json');
    if (!fs.existsSync(pluginDefPath)) {
      throw new Error(`${pluginDescriptorFilename}: No pluginDefinition.json `
          + `found at ${pluginBasePath}`);
    }
    let pluginDef = jsonUtils.parseJSONWithComments(pluginDefPath);
    bootstrapLogger.log(bootstrapLogger.FINER,util.inspect(pluginDef));
    if (pluginDef.identifier !== pluginPtrDef.identifier) {
      throw new Error(`${pluginDef.identifier} and ${pluginPtrDef.identifier} `
          + `don't match - plugin ignored`);
    }
    bootstrapLogger.info(`Validating Plugin Definition at ${pluginBasePath}/pluginDefinition.json`)
    if(!pluginDefinitionValidation.validatePluginDef(pluginDef)){
      throw new Error(`${pluginDef.identifier} is invalid`)
    }
    var identifierIndex = uniquePluginIdentifiers.indexOf(pluginDef.identifier);
    if(identifierIndex > -1) {
      throw new Error(`Error in file ${pluginDefPath}.  The identifier '${pluginDef.identifier}' is already used in file ${uniquePluginPaths[identifierIndex]}.  Please choose a unique identifier.`)
    }
    uniquePluginIdentifiers.push(pluginDef.identifier)
    uniquePluginPaths.push(pluginDefPath)
    bootstrapLogger.info(`Read ${pluginBasePath}: found plugin type `
        + `'${pluginDef.pluginType}'`);
    pluginDef.location = pluginBasePath;
    return pluginDef;
  },
  
  readPluginDefs() {
    const defs = [];
    bootstrapLogger.log(bootstrapLogger.INFO,
      `Reading plugins dir ${this.options.pluginsDir}`);
    const pluginLocationJSONs = fs.readdirSync(this.options.pluginsDir)
      .filter(function(value){
        return value.match(/.*\.json/);
      });
    bootstrapLogger.log(bootstrapLogger.FINER, util.inspect(pluginLocationJSONs));
    for (const pluginDescriptorFilename of pluginLocationJSONs) {
      try {
        const plugin = this._readPluginDef(pluginDescriptorFilename);
        defs.push(plugin);
      } catch (e) {
        bootstrapLogger.warn(e)
        bootstrapLogger.log(bootstrapLogger.INFO,
          `Failed to load ${pluginDescriptorFilename}\n`);
      }
    } 
    return defs;
  },
  
  loadPlugins() {
    const defs = this.readPluginDefs();
    this.installPlugins(defs);
  },
  
  installPlugins(pluginDefs) {
    const pluginContext = {
      productCode: this.options.productCode,
      config: this.options.serverConfig,
      authManager: this.options.authManager
    };
    let successCount = 0;
    const depgraph = new DependencyGraph(this.plugins);
    for (const pluginDef of pluginDefs) {
      depgraph.addPlugin(pluginDef);
    }
    const sortedAndRejectedPlugins = depgraph.processImports();
    for (const rejectedPlugin of sortedAndRejectedPlugins.rejects) {
      bootstrapLogger.warn(`Could not initialize plugin` 
          + ` ${rejectedPlugin.pluginId}: `  
          + rejectedPlugin.validationError.status);
    }
    for (const pluginDef of sortedAndRejectedPlugins.plugins) { 
      try {
        const pluginConfiguration = configService.getPluginConfiguration(
            pluginDef.identifier, this.options.serverConfig,
            this.options.productCode);
        bootstrapLogger.debug(`For plugin with id=${pluginDef.identifier}, internal config` 
                                + ` found=\n${JSON.stringify(pluginConfiguration)}`);
        const plugin = makePlugin(pluginDef, pluginConfiguration, pluginContext);
        bootstrapLogger.log(bootstrapLogger.INFO,
            `Plugin ${plugin.identifier} at path=${plugin.location} loaded.\n`);
        bootstrapLogger.debug(' Content:\n' + plugin.toString());
        this.plugins.push(zluxUtil.deepFreeze(plugin));
        this.pluginMap[plugin.identifier] = plugin;
        successCount++;
      } catch (e) {
        console.log(e);
        //bootstrapLogger.warn(e)
        bootstrapLogger.log(bootstrapLogger.INFO,
          `Failed to load ${pluginDef.identifier}: ${e}`);
      }
    }
    for (const plugin of this.plugins) {
      this.emit('pluginAdded', {
        data: plugin
      });
    }
  },
  
  addDynamicPlugin(pluginDef) {
    if (this.pluginMap[pluginDef.identifier]) {
      throw new Error('plugin already registered');
    }
    const pluginContext = {
      productCode: this.options.productCode,
      config: this.options.serverConfig,
      authManager: this.options.authManager
    };
    //
    //TODO resolving dependencies correctly
    //see also: the FIXME note at the end of installPlugins()
    //
    bootstrapLogger.info("Adding dynamic plugin " + pluginDef.identifier);
    const pluginConfiguration = configService.getPluginConfiguration(
      pluginDef.identifier, this.options.serverConfig,
      this.options.productCode);
    const plugin = makePlugin(pluginDef, pluginConfiguration, null, pluginContext,
        true);
//    if (!this.unresolvedImports.allImportsResolved(pluginContext.plugins)) {
//      throw new Error('unresolved dependencies');
//      this.unresolvedImports.reset();
//    }
    zluxUtil.deepFreeze(plugin);
    this.plugins.push(plugin);
    this.pluginMap[plugin.identifier] = plugin;
    this.emit('pluginAdded', {
      data: plugin
    });
  }
};

module.exports = PluginLoader;
PluginLoader.makePlugin = makePlugin;

/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/

