
/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/


const express = require('express');
const BBPromise = require('bluebird');
const zLuxUrl = require('./url')
const path = require('path');
const fs = require('fs');
const jsyaml = require('js-yaml');
const swaggerParser = require('swagger-parser')
const os = require('os');
const zluxUtil = require('./util');

var installLog = zluxUtil.loggers.installLogger;

function getServiceSummary(service: any) {
  switch (service.type) {
  case "router":
  case "nodeService":
    return `${service.name} node service`
  case "external":
    return `proxy of ${service.isHttps ? 'https://' : 'http://'}${service.host}:${service.port}${service.urlPrefix?
                                                                                                 service.urlPrefix:''}`;
  case "import":
    return `import of ${service.sourcePlugin}:${service.sourceName}`;
  default:
    return `${service.name} data service`
  }
}

export function makeCatalogForPlugin(plugin: any, productCode: any, nodeContext: any) {
  return new Promise((resolve) => {
    const openApi = {
      swagger: "2.0",
      info: {
        title:  plugin.identifier,
        description: plugin.webContent ? plugin.webContent.descriptionDefault : undefined,
        version: plugin.pluginVersion || "0.0.1",
        license: plugin.license
      },
      basePath: zLuxUrl.makePluginURL(productCode, plugin.identifier) + "/services",
      host: getHost(nodeContext),
      schemes: getSchemesFromContext(nodeContext),
      paths: {}
    };
    getSwaggerDocs(plugin, productCode, nodeContext).then((swaggerDocs) => {
      swaggerDocs.forEach((service)=> {
        const servicePaths = service.serviceDoc.paths;
        let version = service.serviceVersion;
        for (let route in servicePaths) {
          openApi.paths[`/${service.serviceName}/${version}${route}`] = servicePaths[route];
        }
      });
      for (const service of plugin.dataServices || []) {
        //Missing swagger should get a placeholder
        //TODO we can actually somewhat inspect Express routers
        const servicePath = (zLuxUrl.makeServiceSubURL(service) + '/').substring(9);
        if (!openApi.paths[servicePath]) {
          openApi.paths[servicePath] = {
            get: {
              summary: getServiceSummary(service),
              responses: {
                200: {
                  description: "This is a placeholder because the plugin did not supply a swagger document"
                }
              }
            }
          };
        }
      }
      // pass everything back at once the plugin catalog with all services together
      // swaggerdocs is the list of all the docs for each service
      var allDocumentation = {
        pluginCatalog: openApi,
        serviceDocs: swaggerDocs
      }
      resolve(allDocumentation)
    });
  })
}

var getSwaggerDocs = BBPromise.coroutine(function* (plugin: any, productCode: any, nodeContext: any) {
  var allServiceDocs: any = [];
  if (plugin.dataServices){
    for (let i = 0; i < plugin.dataServices.length; i++) {
      let service = plugin.dataServices[i];
      if (service.type === 'import') {
        continue; //resolve later in load process
      } else if (service.type === 'external') {
        continue; //resolve never... API enhancement needed if this is desired
      }
      installLog.debug(`Reading swagger for ${plugin.identifier}:${service.name}`);
      let fileContent;
      try {
        fileContent = yield readSingleSwaggerFile(path.join(plugin.location, "doc/swagger"),
                                                  service.name,
                                                  service.version);
      } catch (err) {
        if (err.code === 'ENOENT') {
          installLog.warn(`Swagger file for service (${plugin.identifier}:${service.name}) not found`);
        } else {
          installLog.warn(`Invalid Swagger from file for service (${plugin.identifier}:${service.name})`);
          installLog.warn(err);
        }
      }
      if (fileContent) {
        fileContent = overwriteSwaggerFieldsForServer(fileContent, 
                                                      zLuxUrl.makePluginURL(productCode, plugin.identifier),
                                                      nodeContext);
        allServiceDocs.push({
          "serviceName" : service.name,
          "serviceVersion": service.version,
          "serviceDoc" : fileContent
        });
      }
    }
  }
  return allServiceDocs;
})

function readSingleSwaggerFile (dirName: string, serviceName: string, serviceVersion: any) {
  // read one swagger file and validate the json that is returned
  return new Promise ((resolve, reject) => {
    const jsonName = serviceName+'.json';
    const jsonNameV = serviceName+'_'+serviceVersion+'.json';
    const yamlName = serviceName+'.yaml';
    const yamlNameV = serviceName+'_'+serviceVersion+'.yaml';
    let swaggerPath;
    
    fs.readdir(dirName,(err, files)=> {
      if (err) {
        installLog.warn(`Could not read swagger doc folder ${dirName}`);
        return reject(err);
      } else {
        let bestPath = undefined;
        for (let i = 0; i < files.length; i++) {
          if (files[i] == jsonNameV) {
            bestPath = jsonNameV;
            //ideal
            break;
          } else if (files[i] == jsonName) {
            bestPath = jsonName;
          } else if (files[i] == yamlNameV) {
            bestPath = yamlNameV;
          } else if (files[i] == yamlName) {
            bestPath = yamlName;
          }
        }
        if (bestPath) {
          swaggerPath = path.join(dirName, bestPath);
          installLog.debug(`Reading swagger at path=${swaggerPath}`);
          fs.readFile(swaggerPath,{encoding:'utf-8'},(err, fileContent)=> {
            if (err) {
              return reject(err);
            }
            let swaggerJson = jsyaml.safeLoad(fileContent);
            swaggerParser.validate(swaggerJson).then(function(valid) {
              return resolve(swaggerJson)
            }).catch(function(err) {
              return reject(err.message)
            });
          });          
        } else {
          return reject({code: 'ENOENT', message: `No swagger found`});
        }
      }
    });
  });
}

function overwriteSwaggerFieldsForServer (swaggerJson: any, urlBase: string, nodeContext: any) {
  // overwrite swagger fields with more accurate info from server and config
  swaggerJson.basePath = urlBase + "/services" + swaggerJson.basePath + "/" + swaggerJson.info.version;
  swaggerJson.schemes = getSchemesFromContext(nodeContext);
  swaggerJson.host = getHost(nodeContext)
  return swaggerJson;
}

function getSchemesFromContext (nodeContext: any) {
  let schemes = [];
  if (nodeContext.http) {
    schemes.push("http");
  }
  if (nodeContext.https) {
    schemes.push("https");
  }
  return schemes;
}

function getHost(nodeContext: any) {
  return nodeContext.https ? `${os.hostname()}:${nodeContext.https.port}`
                           : `${os.hostname()}:${nodeContext.http.port}`;
}

module.exports = makeCatalogForPlugin;

/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/
