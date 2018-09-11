
/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/


const express = require('express');
const zLuxUrl = require('./url')

function getServiceSummary(service) {
  switch (service.type) {
  case "router":
  case "nodeService":
    return `${service.name} node service`
  case "import":
    return `import ${service.sourceName} from ${service.sourcePlugin}`;
  default:
    return `${service.name} data service`
  }
}

function makeCatalogForPlugin(plugin, productCode) {
  const router = express.Router();
  const openApi = {
    openapi: "3.0.0",
    info: {
      title:  plugin.identifier,
      description: plugin.descriptionDefault,
      version: plugin.version || "0.0.1"
    },
    servers: [
      {
        url: zLuxUrl.makePluginURL(productCode, plugin.identifier)
      }
    ],
    paths: {}
  };
  for (const service of plugin.dataServices || []) {
    //FIXME templates with an asterisk are not supported by open api
    //TODO we can actually somewhat inspect Express routers
    openApi.paths[zLuxUrl.makeServiceSubURL(service) + '/*'] = {
      summary: getServiceSummary(service),
      get: {
        responses: {
          200: {
            description: "service call succeeded"
          }
        }
      },
      post: {
        responses: {
          200: {
            description: "service call succeeded"
          }
        }
      },
      put: {
        responses: {
          200: {
            description: "service call succeeded"
          }
        }
      },
      delete: {
        responses: {
          200: {
            description: "service call succeeded"
          }
        }
      },
    }
  }
  router.get("/", (req, res) => {
    res.status(200).json(openApi);
  });
  return router;
}

module.exports = makeCatalogForPlugin;

/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/
