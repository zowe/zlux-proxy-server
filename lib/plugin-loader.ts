
/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/

import util from './util';
import * as Promise from 'bluebird';
import * as fs from 'graceful-fs';
import * as http from 'http';
import * as https from 'https';
import * as url from 'url';
import * as path from 'path';
import * as os from 'os';
import * as assert from 'assert';
import * as requireFromString from 'require-from-string';
import * as EventEmitter from 'events';
import * as semver from 'semver';
import * as zluxUtil from './util';
import * as jsonUtils from './jsonUtils.js';
import * as configService from '../plugins/config/lib/configService.js';
import * as DependencyGraph from './depgraph';
import * as translationUtils from './translation-utils.js';
import * as makeSwaggerCatalog from './swagger-catalog';

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

enum defaultOptions {
  productCode = null,
  authManager = null,
  pluginsDir = null,
  serverConfig = null,
  relativePathResolver = zluxUtil.normalizePath
}

enum dataServiceType {
  'service',
  'import',
  'nodeService',
  'router',
  'external'
}

enum pluginTypes {
  'library',
  'application',
  'windowManager',
  'bootstrap',
  'desktop',
  'nodeAuthentication',
  'proxyConnector'
}

type ServiceDefinition = { name: string, type: dataServiceType, version: string, versionRequirements: Object}
type ConfigDefinition = { getContents: any}
type PluginDefinition = { pluginType: typeof pluginTypes, nodeModule: any, host: string, port: string, identifier: string, location: string}
type ServiceContext = { productCode: string, config: ConfigDefinition, version: string}

interface IService {
  version: string;
  versionRequirements: object;
  localName?: string;
  name: string;
  type: dataServiceType;
  sourceName: string;
  sourcePlugin: any;
  loadImplementation: Function;
}


export class Service implements IService {
  public version: any;
  public versionRequirements: any;
  public localName: any;
  public name: string;
  public type: dataServiceType;
  public sourceName: string;
  public sourcePlugin: any;
  public loadImplementation: Function;

  constructor(public def: ServiceDefinition, public configuration: ConfigDefinition, public plugin: PluginDefinition) {}

  public validate(): void {
    if (!semver.valid(this.version)) {
      throw new Error(`ZWED0007E - ${this.name}: invalid version "${this.version}"`)
    }
    if (this.versionRequirements) {
      for (let serviceName of Object.keys(this.versionRequirements)) {
        if (!semver.validRange(this.versionRequirements[serviceName])) {
          throw new Error(`ZWED0008E - ${this.localName}: invalid version range ` +
          `${serviceName}: ${this.versionRequirements[serviceName]}`)
        }
      }
    }
  }
}

export class Import extends Service {
  private versionRange: string;

  constructor(def: ServiceDefinition, configuration: ConfigDefinition, plugin: PluginDefinition) {
    super(def, configuration, plugin);
  }

  public validate(): void {
    if (!semver.validRange(this.versionRange)) {
      throw new Error(`ZWED0009E - ${this.localName}: invalid version range "${this.versionRange}"`)
    }
  }
}

export class NodeService extends Service {
  private source: string;
  private nodeModule: string;
  private filename: string;
  private fileName: string;

  constructor(def: ServiceDefinition, configuration: ConfigDefinition, plugin: PluginDefinition) {
    super(def, configuration, plugin);
  }

  public loadImplementation(dynamicallyCreated: boolean, location: string) {
    if (dynamicallyCreated) {
      const nodeModule = requireFromString(this.source);
      this.nodeModule = nodeModule;
    } else {
      // Quick fix before MVD-947 is merged
      let fileLocation = ""
      let serverModuleLocation = ""
      let clientModuleLocation = ""
      if (this.filename) {
        fileLocation = path.join(location, 'lib', this.filename);
      } else if (this.fileName) {
        fileLocation = path.join(location, 'lib', this.fileName);
      } else {
        throw new Error(`ZWED0010E - No file name for data service`)
      
      }
      serverModuleLocation = path.join(location, 'nodeServer', 'node_modules' );
      clientModuleLocation = path.join(location, 'lib', 'node_modules');
      let nodePathStore = process.env.NODE_PATH;
      let nodePathAdd = process.env.NODE_PATH;
      let operatingSystem = process.platform;
      let osDelim = operatingSystem === "win32" ? ";" : ":"; 
      bootstrapLogger.info("ZWED0116I", serverModuleLocation, clientModuleLocation); //bootstrapLogger.log(bootstrapLogger.INFO,
        //`The LOCATIONS are ${serverModuleLocation} and ${clientModuleLocation}`);
      nodePathAdd = `${process.env.NODE_PATH}${serverModuleLocation}${osDelim}${clientModuleLocation}${osDelim}.`
      process.env.NODE_PATH = nodePathAdd;
      require("module").Module._initPaths();    
      bootstrapLogger.info("ZWED0117I", fileLocation); //bootstrapLogger.log(bootstrapLogger.INFO, `The fileLocation is ${fileLocation}`);
      bootstrapLogger.info("ZWED0118I", process.env.NODE_PATH); //bootstrapLogger.log(bootstrapLogger.INFO,
        //`The NODE_PATH is ${process.env.NODE_PATH}`);
        const nodeModule = (require as any)(fileLocation);
      this.nodeModule = nodeModule;
      process.env.NODE_PATH = nodePathStore;
      require("module").Module._initPaths(); 
    }
  }
}

//first checks if the parent plugin has a host and port 
//and if not, looks them up in the config

export class ExternalService extends Service {
  private host: any;
  private port: any;

  constructor(def: ServiceDefinition, configuration: ConfigDefinition, plugin: PluginDefinition) {
    super(def, configuration, plugin)
    if (!this.host) {
      this.host = this.plugin.host;
    }
    if (!this.port) {
      this.port = this.plugin.port;
    }
    const remoteConfig = this.configuration.getContents(["remote.json"]);
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

function makeDataService(def: ServiceDefinition, plugin: PluginDefinition, context: ServiceContext): Service {
  const configuration = configService.getServiceConfiguration(plugin.identifier, plugin.location,
    def.name, context.config, context.productCode);
  let dataservice: Service;
  if (this.def.type == "external") {
    dataservice = new ExternalService(this.def, configuration, this.plugin);
  } else if (this.def.type == "import") {
    dataservice = new Import(this.def, configuration, this.plugin);
  } else if ((this.def.type == 'nodeService') || (this.def.type === 'router')) {
    dataservice = new NodeService(this.def, configuration, this.plugin);
  } else {
    dataservice = new Service(this.def, configuration, this.plugin);
  }
  dataservice.validate();
  return dataservice;
}

interface IPlugin {
  apiVersion: string;
  pluginVersion: string;
  webContent: any;
  copyright: any;
  dataServices: Array<ServiceDefinition>;
  dataServicesGrouped: Object;
  importsGrouped: Object;
  translationMaps: any;
  identifier: string;  
  pluginType: pluginTypes;
  location: string;
  definition: PluginDefinition;
  configuration: ConfigDefinition;
  dynamicallyCreated: boolean;
}

export class Plugin implements IPlugin {
  public apiVersion: string;
  public pluginVersion: string;
  public webContent: any;
  public copyright: any;
  public dataServices: Array<ServiceDefinition>;
  public dataServicesGrouped: Object;
  public importsGrouped: Object;
  public translationMaps: any;
  public identifier: string;  
  public pluginType: pluginTypes;
  public location: string;
  public definition: PluginDefinition;
  public configuration: ConfigDefinition;
  public dynamicallyCreated: boolean;

  constructor(def: PluginDefinition, configuration: ConfigDefinition) {
    this.definition = def
    delete this.definition.location;
    delete this.definition.nodeModule;
    this.configuration = configuration;
    if (!this.location) {
      this.location = process.cwd();
    }
    this.translationMaps = {};
  }

  public toString(): string {
    return `[Plugin ${this.identifier}]`
  }

  public isValid(context: ServiceContext) {
    //TODO detailed diagnostics
    return this.identifier && (typeof this.identifier === "string")
      && this.pluginVersion && (typeof this.pluginVersion === "string")
      && this.apiVersion && (typeof this.apiVersion === "string")
      //this might cause some pain, but I guess it's better to
      //leave it here and make everyone tidy up their plugin defs:
      && this.pluginType && (typeof this.pluginType === pluginTypes);
  }

  public init(context: ServiceContext) {
    //Nothing here anymore: startup checks for validity will be superceeded by 
    //https://github.com/zowe/zlux-server-framework/pull/18 and initialization 
    //concept has not manifested for many plugin types, so a warning is not needed.
  }
  
  public exportDef(): PluginDefinition {
    return this.definition;
  }

  public exportTranslatedDef(acceptLanguage: string): PluginDefinition {
    const def = this.exportDef();
    if (typeof this.webContent === 'object') {
      return translationUtils.translate(def, this.translationMaps, acceptLanguage);
    }
    return def;
  }

  public loadTranslations() {
    if (typeof this.webContent === 'object') {
      this.translationMaps = translationUtils.loadTranslations(this.location);
    }
  }
  
  public verifyStaticWebContent() {
    if (this.webContent) {
      let contentPath = path.join(this.location, "web");
      if (!fs.existsSync(contentPath)) {
        throw new Error(`ZWED0011E - Plugin ${this.identifier} has web content but `
            + `no web directory under ${this.location}`); 
      } else {
        bootstrapLogger.info(`ZWED0036I`, this.identifier, contentPath); //bootstrapLogger.info(`plugin ${this.identifier} ` + `will serve static files from ${contentPath}`);
      }
    }
  }
  
  public initDataServices(context: ServiceContext, langManagers: any) {
    function addService(service: ServiceDefinition, name: string, container: any) : any {
      let group : any = container[name];
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
      if (dataservice.type == dataServiceType.service) {          
        addService(dataservice, dataservice.name, this.dataServicesGrouped);
        bootstrapLogger.info(`ZWED0037I`, this.identifier, dataservice.name); //bootstrapLogger.info(`${this.identifier}: ` + `found proxied service '${dataservice.name}'`);
        filteredDataServices.push(dataservice);
      } else if (dataservice.type === dataServiceType.import) {
        bootstrapLogger.info(`ZWED0038I`, this.identifier, dataservice.sourceName, dataservice.sourcePlugin, dataservice.localName); //bootstrapLogger.info(`${this.identifier}:` + ` importing service '${dataservice.sourceName}'` + ` from ${dataservice.sourcePlugin}` + ` as '${dataservice.localName}'`);
        addService(dataservice, dataservice.localName, this.importsGrouped);
        filteredDataServices.push(dataservice);
      } else if ((dataservice.type == dataServiceType.nodeService)
          || (dataservice.type === dataServiceType.router)) {
        //TODO what is this? Why do we need it?
//        if ((dataservice.serviceLookupMethod == 'internal')
//            || !dataservice.dependenciesIncluded) {
//          bootstrapLogger.warn(`${this.identifier}:`
//              + ` loading dataservice ${dataservice.name} failed, declaration invalid`);
//          continue;
//        }
        dataservice.loadImplementation(this.dynamicallyCreated, this.location);
        if (dataservice.type === dataServiceType.router) {
          bootstrapLogger.info(`ZWED0039I`, this.identifier, dataservice.name); //bootstrapLogger.info(`${this.identifier}: ` + `found router '${dataservice.name}'`);
          addService(dataservice, dataservice.name, this.dataServicesGrouped);
        } else {
          bootstrapLogger.info(`ZWED0040I`, this.identifier, dataservice.name); //bootstrapLogger.info(`${this.identifier}: ` + `found legacy node service '${dataservice.name}'`);
          addService(dataservice, dataservice.name, this.dataServicesGrouped);
        }
        filteredDataServices.push(dataservice);
      } else if (dataservice.type == dataServiceType.external) {
        addService(dataservice, dataservice.name, this.dataServicesGrouped);
        bootstrapLogger.info(`ZWED0041I`, this.identifier, dataservice.name); //bootstrapLogger.info(`${this.identifier}: ` + `found external service '${dataservice.name}'`);
        filteredDataServices.push(dataservice);
      } else {
        addService(dataservice, dataservice.name, this.dataServicesGrouped);
        bootstrapLogger.info(`ZWED0042I`, this.identifier, dataservice.type, dataservice.name); //bootstrapLogger.info(`${this.identifier}: ` + `found ${dataservice.type} service '${dataservice.name}'`);
        filteredDataServices.push(dataservice);            
        /*
          maybe a lang manager knows how to handle this...
          don't error out here if no valid lang manager. webapp.js will do the check later.
        */
      }
    }
    this.dataServices = filteredDataServices;
    this._validateLocalVersionRequirements()
  }

  private _validateLocalVersionRequirements() {
    for (let service of this.dataServices) {
      if (!service.versionRequirements) {
        continue;
      }
      for (let serviceName of Object.keys(service.versionRequirements)) {
        const allVersions = this.dataServicesGrouped[serviceName] 
            || this.importsGrouped[serviceName];
        if (!allVersions) {
          throw new Error(`ZWED0012E - ${this.identifier}::${service.name} `
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
          throw new Error(`ZWED0013E - ${this.identifier}::${service.name} `
              + `Could not find a version to satisfy local dependency `
              + `${serviceName}@${requiredVersion}`)
        } else {
          bootstrapLogger.debug(`ZWED0163I`, this.identifier, service.name, `${serviceName}@${found}`); //bootstrapLogger.debug(`${this.identifier}::${service.name}: found `
              //+ `${serviceName}@${found}`)
          //replace the mask in the def with an actual version to make the life 
          // simpler
          service.versionRequirements[serviceName] = found;
        }
      }
    }
  }
  
  public getApiCatalog(productCode: any, nodeContext: any) {
    return makeSwaggerCatalog(this, productCode, nodeContext);
  }
  
}

export class LibraryPlugIn extends Plugin {

  constructor(def: PluginDefinition, configuration: ConfigDefinition) {
    super(def, configuration);
  }

  public init(context: ServiceContext) {
    assert(this.pluginType === pluginTypes.library);
    if (!fs.existsSync(this.location)) {
      bootstrapLogger.warn("ZWED0150W", this.definition.identifier, this.location); //bootstrapLogger.log(bootstrapLogger.WARNING,
        //`${def.identifier}: library path ${this.location} does not exist`);
      return;
    }
    bootstrapLogger.info("ZWED0119I", this.identifier, this.location); //bootstrapLogger.log(bootstrapLogger.INFO,
      //`Plugin ${this.identifier} will serve library data from directory ${this.location}`);
  }
}

export class ApplicationPlugIn extends Plugin {
  constructor(def: PluginDefinition, configuration: ConfigDefinition) {
    super(def, configuration);
  }
}

export class WindowManagerPlugIn extends Plugin {
  constructor(def: PluginDefinition, configuration: ConfigDefinition) {
    super(def, configuration);
  }
}

export class BootstrapPlugIn extends Plugin {
  constructor(def: PluginDefinition, configuration: ConfigDefinition) {
    super(def, configuration);
  }
}

export class DesktopPlugIn extends Plugin {
  constructor(def: PluginDefinition, configuration: ConfigDefinition) {
    super(def, configuration);
  }
}

export class NodeAuthenticationPlugIn extends Plugin {
  private authenticationModule: string;
  private authenticationCategory: any;
  private authenticationCategories: any;
  private filename: string;

  constructor(def: PluginDefinition, configuration: ConfigDefinition) {
    super(def, configuration);
  }

  public isValid(context: any) {
    if (!(super.isValid(context) && this.filename 
          && (this.authenticationCategory || this.authenticationCategories))) {
      return false;
    }
    //we should not load authentication types that are 
    //not requested by the administrator
    if (!context.authManager.authPluginRequested(this.identifier,
      this.authenticationCategory)) {
        bootstrapLogger.warn("ZWED0029W"); //bootstrapLogger.warn("Authentication plugin was found which was not requested in "
          //+ "the server configuration file's dataserviceAuthentication object. "
          //+ "Skipping load of this plugin");
      return false;
    }
    return true;
  }

  public exportDef() {
    return Object.assign({}, super.exportDef(), {
      filename: this.filename,
      authenticationCategory: this.authenticationCategory
    });
  }
  
  public init(context: any) {
    let filepath = path.join(this.location, 'lib', this.filename);
    // Make the relative path clear. process.cwd() is zlux-app-server/bin/
    if (!path.isAbsolute(filepath)) {
      filepath = path.join(process.cwd(),filepath);
    }
    bootstrapLogger.info("ZWED0120I", this.identifier, filepath); //bootstrapLogger.log(bootstrapLogger.INFO,
      //`Auth plugin ${this.identifier}: loading auth handler module ${filepath}`)
    this.authenticationModule = require(filepath);
    context.authManager.registerAuthenticator(this);
  }
}

export class ProxyConnectorPlugIn extends Plugin {
  private host: any;
  private port: any;

  constructor(def: PluginDefinition, configuration: ConfigDefinition) {
    super(def, configuration);
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
  
  public isValid(context: any): boolean {
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
}

enum plugInConstructorsByType {
  library = LibraryPlugIn,
  application = ApplicationPlugIn,
  windowManager = WindowManagerPlugIn,
  bootstrap = BootstrapPlugIn,
  desktop = DesktopPlugIn,
  nodeAuthentication = NodeAuthenticationPlugIn,
  proxyConnector = ProxyConnectorPlugIn
}

function makePlugin(def: PluginDefinition, pluginConfiguration: any, pluginContext: any, dynamicallyCreated: any, langManagers: any) {
  const pluginConstr = plugInConstructorsByType[def.pluginType];
    if (!pluginConstr) {
      throw new Error(`ZWED0020E - ${def.identifier}: pluginType ${def.pluginType} is unknown`); 
    }
    // one can think in terms of Java: `def` is a JSON-serialized instance of the
    // "class" referred to by `proto`. Create an instance and inject the
    // de-serialized instance data there.
    // (We don't need an extra indirection level, e.g. self.definition = def)
    const self = new pluginConstr(def, pluginConfiguration);
    self.dynamicallyCreated = dynamicallyCreated;
    if (!self.isValid(pluginContext)) {
      if (def.pluginType.nodeAuthentication && !pluginContext.authManager.authPluginRequested(self.identifier,
        self.authenticationCategory)) {
          bootstrapLogger.info(`ZWED0043I`, self.identifier); //bootstrapLogger.info(`Plugin ${self.identifier} is not requested skipping without error`);
        return null;
      } else {
        bootstrapLogger.warn(`ZWED0030W`, def.location); //bootstrapLogger.warn(`${def.location} points to an`
          //+ " invalid plugin definition, skipping");
        throw new Error(`ZWED0014E - Plugin ${def.identifier} invalid`);
      }
    }
    self.initDataServices(pluginContext, langManagers);
    if (!dynamicallyCreated) {
      self.verifyStaticWebContent();
    }
    self.init(pluginContext);
    self.loadTranslations();
    return self;
}

export class PluginLoader {
  private plugins: any;
  private pluginMap: any;
  public intervalScanner: any;
  public makePlugin: typeof makePlugin;
  public emit: any;

  constructor(private options: any) {
    EventEmitter.call(this);
    this.options = zluxUtil.makeOptionsObject(defaultOptions, options);
    this.plugins = [];
    this.pluginMap = {};
  }

  private _readPluginDef(pluginDescriptorFilename: string) {
    const pluginPtrPath = this.options.relativePathResolver(pluginDescriptorFilename,
                                                 this.options.pluginsDir);
    bootstrapLogger.info(`ZWED0044I`, pluginPtrPath); //bootstrapLogger.info(`Processing plugin reference ${pluginPtrPath}...`);
    if (!fs.existsSync(pluginPtrPath)) {
      throw new Error(`ZWED0021E - ${pluginPtrPath} is missing`);
    }
    const pluginPtrDef = jsonUtils.parseJSONWithComments(pluginPtrPath);
    bootstrapLogger.debug("ZWED0121I", util.inspect(pluginPtrDef)); //bootstrapLogger.log(bootstrapLogger.FINER, util.inspect(pluginPtrDef));
    let pluginBasePath = pluginPtrDef.pluginLocation;
    if (!path.isAbsolute(pluginBasePath)) {
      pluginBasePath = this.options.relativePathResolver(pluginBasePath, process.cwd());
    }
    if (!fs.existsSync(pluginBasePath)) {
      return {location: pluginBasePath,
              identifier: pluginPtrDef.identifier,
              error: new Error(`ZWED0015E - No plugin directory found at ${pluginPtrDef.pluginLocation}`)};
     }
    let pluginDefPath = path.join(pluginBasePath, 'pluginDefinition.json');
    if (!fs.existsSync(pluginDefPath)) {
      return {location: pluginBasePath,
              identifier: pluginPtrDef.identifier,
              error: new Error(`ZWED0016E - No pluginDefinition.json found at ${pluginBasePath}`)};
    }
    let pluginDef = jsonUtils.parseJSONWithComments(pluginDefPath);
    bootstrapLogger.debug("ZWED0122I", util.inspect(pluginDef)); //bootstrapLogger.log(bootstrapLogger.FINER,util.inspect(pluginDef));
    if (pluginDef.identifier !== pluginPtrDef.identifier) {
      return {location: pluginBasePath,
              identifier: pluginPtrDef.identifier,
              error: new Error(`ZWED0017E - Identifier doesn't match one found in pluginDefinition: ${pluginDef.identifier}`)};
    }
    if (!pluginDef.pluginType) {
      return {location: pluginBasePath,
              identifier: pluginPtrDef.identifier,
              error: new Error(`ZWED0018E - No plugin type found, skipping`)};
    }
    bootstrapLogger.info(`ZWED0214I`, pluginBasePath, pluginDef.identifier, pluginDef.pluginType); //bootstrapLogger.info(`Read ${pluginBasePath}: found plugin id = ${pluginDef.identifier}, `
        //+ `type = ${pluginDef.pluginType}`);
    pluginDef.location = pluginBasePath;
    return pluginDef;
  }

  private _readPluginDefAsync(pluginDescriptorFilename: any): Promise<object> {
    return new Promise((resolve, reject)=> {
      const pluginPtrPath = this.options.relativePathResolver(pluginDescriptorFilename,
                                                              this.options.pluginsDir);
      bootstrapLogger.info(`Processing plugin reference ${pluginPtrPath}...`);
      jsonUtils.readJSONFileWithCommentsAsync(pluginPtrPath).then((pluginPtrDef)=> {
        bootstrapLogger.log(bootstrapLogger.FINER, util.inspect(pluginPtrDef));
        let pluginBasePath = pluginPtrDef.pluginLocation;
        if (!path.isAbsolute(pluginBasePath)) {
          pluginBasePath = this.options.relativePathResolver(pluginBasePath, process.cwd());
        }
        let pluginDefPath = path.join(pluginBasePath, 'pluginDefinition.json');
        jsonUtils.readJSONFileWithCommentsAsync(pluginDefPath).then(function(pluginDef){
          bootstrapLogger.log(bootstrapLogger.FINER,util.inspect(pluginDef));
          if (pluginDef.identifier !== pluginPtrDef.identifier) {
            return reject({location: pluginBasePath,
                     identifier: pluginPtrDef.identifier,
                     error: new Error(`Identifier doesn't match one found in pluginDefinition: ${pluginDef.identifier}`)});
          }
          if (!pluginDef.pluginType) {
            return reject({location: pluginBasePath,
                           identifier: pluginPtrDef.identifier,
                           error: new Error(`No plugin type found, skipping`)});
          }
          bootstrapLogger.info(`Read ${pluginBasePath}: found plugin id = ${pluginDef.identifier}, `
                               + `type = ${pluginDef.pluginType}`);
          pluginDef.location = pluginBasePath;
          resolve(pluginDef);
        }).catch((e)=> {
        reject({location: pluginBasePath,
                identifier: pluginPtrDef.identifier,
                error: e});
        });
      }).catch((e)=> {
        reject({error: e});
      });
    });
  }
  
  public readPluginDefs() {
    const defs: Array<[]> = [];
    bootstrapLogger.info(`ZWED0045I`, this.options.pluginsDir); //bootstrapLogger.log(bootstrapLogger.INFO, `Reading plugins dir ${this.options.pluginsDir}`);
    const pluginLocationJSONs = fs.readdirSync(this.options.pluginsDir)
      .filter(function(value){
        return value.match(/.*\.json/);
      });
      bootstrapLogger.debug("ZWED0123I", util.inspect(pluginLocationJSONs)); //bootstrapLogger.log(bootstrapLogger.FINER, util.inspect(pluginLocationJSONs));
    for (const pluginDescriptorFilename of pluginLocationJSONs) {
      try {
        const plugin = this._readPluginDef(pluginDescriptorFilename);
        defs.push(plugin);
      } catch (e) {
        bootstrapLogger.warn("ZWED0031W", e) //bootstrapLogger.warn(e)
        bootstrapLogger.warn("ZWED0032W", pluginDescriptorFilename); //bootstrapLogger.warn(bootstrapLogger.INFO,
          //`Failed to load ${pluginDescriptorFilename}\n`);
      }
    } 
    return defs;
  }

  public readNewPluginDefs() {
    const defs: Array<[]> = [];
    bootstrapLogger.debug(`Scanning for new plugins in ${this.options.pluginsDir}`);
    return new Promise((resolve, reject)=> {
      fs.readdir(this.options.pluginsDir, (err, results)=> {
        if (!err) {
          const pluginLocationJSONs = results.filter((value)=>{
            if (value.endsWith('.json')) {
              return !this.pluginMap[value.substr(0,value.length-5)];
            } else {
              return false;
            }
          });
          let counter = 0;
          if (pluginLocationJSONs.length === 0) {
            return resolve(pluginLocationJSONs);
          }
          for (const pluginDescriptorFilename of pluginLocationJSONs) {
            const plugin = this._readPluginDefAsync(pluginDescriptorFilename).then((plugin)=> {
              defs.push(plugin);
              counter++;
              if (counter == pluginLocationJSONs.length) {
                resolve(defs);
              }
            }).catch(function(e: any) {
              counter++;
              bootstrapLogger.log(bootstrapLogger.INFO,
                                  `Failed to load ${pluginDescriptorFilename}\n`);
              bootstrapLogger.warn(e)
              if (counter == pluginLocationJSONs.length) {
                resolve(defs);
              }
            });
          }
        } else {
          bootstrapLogger.warn('Could not read plugins dir, e=', err);
        }
      });
    });
  }
  
  public loadPlugins() {
    const defs = this.readPluginDefs();
    this.installPlugins(defs);
  }

  public scanForPlugins() {
    this.readNewPluginDefs().then((defs)=> {
      this.installPlugins(defs);
    });
  }

  public enablePluginScanner(intervalSec) {
    if (intervalSec >= 1) {
      this.intervalScanner = setInterval(()=> {
        this.scanForPlugins();
      },intervalSec*1000);
    }
  }
  
  public installPlugins(pluginDefs: any) {
    const pluginContext = {
      productCode: this.options.productCode,
      config: this.options.serverConfig,
      authManager: this.options.authManager
    };
    let newPlugins: Array<[]> = [];
    let successCount: number = 0;
    const depgraph = new DependencyGraph(this.plugins);
    for (const pluginDef of pluginDefs) {
      if (pluginDef.error) {
        //downstream will pick up error
        newPlugins.push(pluginDef);
      } else {
        depgraph.addPlugin(pluginDef);
      }
    }
    const sortedAndRejectedPlugins = depgraph.processImports();
    sortedAndRejectedPlugins.plugins = sortedAndRejectedPlugins.plugins.filter((plugin)=> {
      return !this.pluginMap[plugin.identifier];
    });
    for (const rejectedPlugin of sortedAndRejectedPlugins.rejects) {
      bootstrapLogger.warn(`ZWED0033W`, rejectedPlugin.pluginId, zluxUtil.formatErrorStatus(rejectedPlugin.validationError, DependencyGraph.statuses)); //bootstrapLogger.warn(`Could not initialize plugin` 
          //+ ` ${rejectedPlugin.pluginId}: `  
          //+ zluxUtil.formatErrorStatus(rejectedPlugin.validationError, 
              //DependencyGraph.statuses));
    }

    let isFirstRun = Object.keys(this.pluginMap).length === 0;
    
    for (const pluginDef of sortedAndRejectedPlugins.plugins) { 
      try {
        if (this.pluginMap[pluginDef.identifier]) {
          bootstrapLogger.warn(`ZWED0034W`, pluginDef.identifier); //bootstrapLogger.warn(`Skipping install of plugin due to existing plugin with same id=${plugin.identifier}`);

           continue;
        }
        const pluginConfiguration = configService.getPluginConfiguration(
          pluginDef.identifier, pluginDef.location,
          this.options.serverConfig, this.options.productCode);
          bootstrapLogger.debug("ZWED0165I", pluginDef.identifier, JSON.stringify(pluginConfiguration)); //bootstrapLogger.debug(`For plugin with id=${pluginDef.identifier}, internal config` 
                                //+ ` found=\n${JSON.stringify(pluginConfiguration)}`);

        const plugin = makePlugin(pluginDef, pluginConfiguration, pluginContext, false, this.options.langManagers);
        if (plugin) {
          bootstrapLogger.info("ZWED0124I", plugin.identifier, plugin.location); //bootstrapLogger.log(bootstrapLogger.INFO,
            //`Plugin ${plugin.identifier} at path=${plugin.location} loaded.\n`);
            bootstrapLogger.debug("ZWED0164I", plugin.toString()); //bootstrapLogger.debug(' Content:\n' + plugin.toString());
          let frozen = zluxUtil.deepFreeze(plugin);
          this.plugins.push(frozen);
          newPlugins.push(frozen);
          this.pluginMap[plugin.identifier] = plugin;
          successCount++;
        } else {
          bootstrapLogger.info("ZWED0125I", pluginDef.identifier); //bootstrapLogger.log(bootstrapLogger.INFO,
            //`Plugin ${pluginDef.identifier} not loaded`);
          this.pluginMap[pluginDef.identifier] = {}; //mark it as having failed so it will not be retried
        }
      } catch (e) {
        bootstrapLogger.warn("ZWED0035W", pluginDef.identifier, e);
        //downstream will pick up error
        newPlugins.push(Object.assign(pluginDef, {error:e}));
      }
    }
    this.registerStaticPluginsWithManagers(sortedAndRejectedPlugins.plugins);
    for (const plugin of newPlugins) {
      this.emit('pluginFound', {
        data: plugin,
        count: newPlugins.length
      });
    }
  }

  public issueRefreshFinish() {
    this.emit('refreshFinish', {});
  }

  /**
     Language managers that need to know about all plugins in advance should be informed here.
     These managers may or may not support dynamic addition as well.
   */
  public registerStaticPluginsWithManagers(pluginDefs: any) {
    if (this.options.langManagers) {
      for (let i = 0; i < this.options.langManagers.length; i++) {
        this.options.langManagers[i].registerPlugins(pluginDefs);
      }
    }
  }
  
  public addDynamicPlugin(pluginDef: any) {
    if (this.pluginMap[pluginDef.identifier]) {
      throw new Error('ZWED0019E - Plugin already registered');
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
    bootstrapLogger.info("ZWED0046I", pluginDef.identifier); //bootstrapLogger.info("Adding dynamic plugin " + pluginDef.identifier);
    const pluginConfiguration = configService.getPluginConfiguration(
      pluginDef.identifier, pluginDef.location,
      this.options.serverConfig, this.options.productCode);
    const plugin = makePlugin(pluginDef, pluginConfiguration, null, pluginContext, true);
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


/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/

