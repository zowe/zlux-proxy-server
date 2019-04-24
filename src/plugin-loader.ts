import { AnyRecordWithTtl } from "dns";

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

const defaultOptions: any = {
  productCode: null,
  authManager: null,
  pluginsDir: null,
  serverConfig: null,
  relativePathResolver: zluxUtil.resolveRelativePathAgainstCWD
}

export class Service{
  public configuration: any;
  public version: any;
  public name: string;
  public versionRequirements: any;
  public localName: string;

  constructor(def: any, configuration: any, plugin: any) {
    this.configuration = configuration;
    //don't do this here: avoid circular structures:
    //this.plugin = plugin; 
    Object.assign(this, def);
  }

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

class Import extends Service{
  public versionRange: any;
  public localName: any;

  constructor(def: any, configuration: any, plugin: any){
    super(def, configuration, plugin);
  }

  validate() {
    if (!semver.validRange(this.versionRange)) {
      throw new Error(`${this.localName}: invalid version range "${this.versionRange}"`)
    }
  }
}

class NodeService extends Service{
  public nodeModule: any;
  public source: any;
  public filename: any;
  public fileName: any;

  constructor(def: any, configuration: any, plugin: any) {
    super(def, configuration, plugin);
  }
  
  loadImplementation(dynamicallyCreated: any, location: any) {
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
class ExternalService extends Service{
  public host: any;
  public port: any;

  constructor(def: any, configuration: any, plugin: any) {
    super(def, configuration, plugin);
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
}

function makeDataService(def: any, plugin: any, context: any) {
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

export class Plugin{
  public configuration: any;
  public location: any;
  public translationMaps: any;
  public identifier: any;
  public pluginVersion: any;
  public apiVersion: any;
  public pluginType: any;
  public copyright: any;
  public webContent: any;
  public configurationData: any;
  public dataServices: any;
  public dataServicesGrouped: any;
  public importsGrouped: any;
  public dynamicallyCreated: any;

  constructor(def: any, configuration: any) {
    Object.assign(this, def);
    this.configuration = configuration;
    if (!this.location) {
      this.location = process.cwd();
    }
    this.translationMaps = {};
  }
  
  toString() {
    return `[Plugin ${this.identifier}]`
  }
  
  isValid(context?: any) {
    //TODO detailed diagnostics
    return this.identifier && (typeof this.identifier === "string")
      && this.pluginVersion && (typeof this.pluginVersion === "string")
      && this.apiVersion && (typeof this.apiVersion === "string")
      //this might cause some pain, but I guess it's better to
      //leave it here and make everyone tidy up their plugin defs:
      && this.pluginType && (typeof this.pluginType === "string")
      ;
  }
  
  init(context?: any) {
    //Nothing here anymore: startup checks for validity will be superceeded by 
    //https://github.com/zowe/zlux-server-framework/pull/18 and initialization 
    //concept has not manifested for many plugin types, so a warning is not needed.
  }
  
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
  }

  exportTranslatedDef(acceptLanguage: any) {
    const def = this.exportDef();
    if (typeof this.webContent === 'object') {
      return translationUtils.translate(def, this.translationMaps, acceptLanguage);
    }
    return def;
  }

  loadTranslations() {
    if (typeof this.webContent === 'object') {
      this.translationMaps = translationUtils.loadTranslations(this.location);
    }
  }
  
  verifyStaticWebContent() {
    if (this.webContent) {
      let contentPath = path.join(this.location, "web");
      if (!fs.existsSync(contentPath)) {
        throw new Error(`plugin ${this.identifier} has web content but `
            + `no web directory under ${this.location}`); 
      } else {
        bootstrapLogger.info(`plugin ${this.identifier} `
            + `will serve static files from ${contentPath}`);
      }
    }
  }
  
  initDataServices(context: any) {
    function addService(service: any, name: string, container: any) {
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
      const dataservice: any = makeDataService(dataServiceDef, this, context);
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
  }
  
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
  }
  
  getApiCatalog(productCode: any) {
    return makeSwaggerCatalog.makeCatalogForPlugin(this, productCode)
  }
  
};


class LibraryPlugIn extends Plugin{
  constructor(def: any, configuration: any) {
    super(def, configuration);
  }
  
  init(context?: any) {
    assert(this.pluginType === "library");
    if (!fs.existsSync(this.location)) {
      bootstrapLogger.log(bootstrapLogger.WARNING,
        `${this.identifier}: library path ${this.location} does not exist`);
      return;
    }
    bootstrapLogger.log(bootstrapLogger.INFO,
      `Plugin ${this.identifier} will serve library data from directory ${this.location}`);
  }
};

class ApplicationPlugIn extends Plugin {
  constructor(def: any, configuration: any) {
    super(def, configuration)
  }
};

class WindowManagerPlugIn extends Plugin{
  constructor(def: any, configuration: any) {
    super(def, configuration)
  }
};

class BootstrapPlugIn extends Plugin{
  constructor(def: any, configuration: any) {
    super(def, configuration)
  }
};

class DesktopPlugIn extends Plugin{
  constructor(def: any, configuration: any) {
    super(def, configuration)
  }
};

class NodeAuthenticationPlugIn extends Plugin{
  public authenticationCategory: any;
  public filename: any;
  public authenticationModule: any;

  constructor(def: any, configuration: any) {
    super(def, configuration)
  }
  
  isValid(context: any) {
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
  }
  
  exportDef() {
    return Object.assign(super.exportDef(), {
      filename: this.filename,
      authenticationCategory: this.authenticationCategory
    });
  }
  
  init(context: any) {
    let filepath = path.join(this.location, 'lib', this.filename);
    // Make the relative path clear. process.cwd() is zlux-app-server/bin/
    if (!path.isAbsolute(filepath)) {
      filepath = path.join(process.cwd(),filepath);
    }
    bootstrapLogger.log(bootstrapLogger.INFO,
      `Auth plugin ${this.identifier}: loading auth handler module ${filepath}`)
    this.authenticationModule = require(filepath);
    context.authManager.registerAuthenticator(this);
  }
};

class ProxyConnectorPlugIn extends Plugin{
  public host: any;
  public port: any;
  
  constructor(def: any, configuration: any) {
    super(def, configuration)
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
  
  isValid(context: any) {
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
  }
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

function makePlugin(def: any, pluginConfiguration: any, pluginContext: any, dynamicallyCreated: any = false) {
  const pluginConstr = (plugInConstructorsByType as any)[def.pluginType];
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
    self.verifyStaticWebContent();
  }
  self.init(pluginContext);
  self.loadTranslations();
  return self;
};

class PluginLoader extends EventEmitter{
  constructor(options: any) {
    super()
    this.options = zluxUtil.makeOptionsObject(defaultOptions, options);
    this.plugins = [];
    this.pluginMap = {};
  }

  _readPluginDef(pluginDescriptorFilename: string) {
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
      pluginBasePath = this.options.relativePathResolver(pluginBasePath, 
          "plugin-def");
    }
    if (!fs.existsSync(pluginBasePath)) {
      throw new Error(`${pluginDescriptorFilename}: No plugin directory found at`
        + ` ${pluginPtrDef.pluginLocation}`);
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
    if (!pluginDef.pluginType) {
      throw new Error(`No plugin type found for ${pluginDef.identifier} `
      + `found at ${pluginBasePath}, skipping`)
    }
    bootstrapLogger.info(`Read ${pluginBasePath}: found plugin id = ${pluginDef.identifier}, `
        + `type = ${pluginDef.pluginType}`);
    pluginDef.location = pluginBasePath;
    return pluginDef;
  }
  
  readPluginDefs() {
    const defs = [];
    bootstrapLogger.log(bootstrapLogger.INFO,
      `Reading plugins dir ${this.options.pluginsDir}`);
    const pluginLocationJSONs = fs.readdirSync(this.options.pluginsDir)
      .filter(function(value: any){
        return value.match(/.*\.json/);
      });
    bootstrapLogger.log(bootstrapLogger.FINER, util.inspect(pluginLocationJSONs));
    for (const pluginDescriptorFilename of pluginLocationJSONs) {
      try {
        const plugin = this._readPluginDef(pluginDescriptorFilename);
        defs.push(plugin);
      } catch (e) {
        console.log(e);
        bootstrapLogger.log(bootstrapLogger.INFO,
          `Failed to load ${pluginDescriptorFilename}\n`);
      }
    } 
    return defs;
  }
  
  loadPlugins() {
    const defs = this.readPluginDefs();
    this.installPlugins(defs);
  }
  
  installPlugins(pluginDefs: any) {
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
          + zluxUtil.formatErrorStatus(rejectedPlugin.validationError, 
              DependencyGraph.statuses));
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
        bootstrapLogger.log(bootstrapLogger.INFO,
          `Failed to load ${pluginDef.identifier}: ${e}`);
      }
    }
    for (const plugin of this.plugins) {
      this.emit('pluginAdded', {
        data: plugin
      });
    }
  }
  
  addDynamicPlugin(pluginDef: any) {
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
    const plugin = makePlugin(pluginDef, pluginConfiguration, pluginContext,
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

export{};
module.exports = PluginLoader;
PluginLoader.makePlugin = makePlugin;

/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/

