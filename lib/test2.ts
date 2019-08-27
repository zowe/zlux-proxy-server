
/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/

const makeWebServer = require('./webserver');
const loadPlugins = require('./plugin-loader').loadPlugins;
const makeWebApp = require('./webapp').makeWebApp;
const makeProcessManager = require('./process');

const rootServices  = [
  {
    method: '*',
    url: '/login'
  },
  {
    method: '*',
    url: '/logout'
  },
  {
    method: '*',
    url: '/unixFileContents'
  },
  {
    method: '*',
    url: '/unixFileMetadata'
  },
  {
    method: '*',
    url: '/datasetContents'
  },
  {
    method: '*',
    url: '/VSAMdatasetContents'
  },
  {
    method: '*',
    url: '/datasetMetadata'
  },
  {
    method: '*',
    url: '/ras'
  }  
];

const configData = {
  "zssPort":31338,
  // All paths relative to ZLUX/node or ZLUX/bin
  // In real installations, these values will be configured during the install.
  "rootDir":"../deploy",
  "productDir":"../deploy/product",
  "siteDir":"../deploy/site",
  "instanceDir":"../deploy/instance",
  "groupsDir":"../deploy/instance/groups",
  "usersDir":"../deploy/instance/users",
  "pluginsDir":"../deploy/instance/ZLUX/plugins",
  

  "productCode": 'ZLUX',
  "node": {
    "http": {
      "port": 31339
    },
    "https": {
      "port": 31340,
      //pfx (string), keys, certificates, certificateAuthorities, and certificateRevocationLists are all valid here.
      "keys": ["../deploy/product/ZLUX/serverConfig/server.key"],
      "certificates": ["../deploy/product/ZLUX/serverConfig/server.cert"]
    }
  },
  "dataserviceAuthentication": {
    //this specifies the default authentication type for dataservices that didn't specify which type to use. These dataservices therefore should not expect a particular type of authentication to be used.
    "defaultAuthentication": "fallback",
    
    //each authentication type may have more than one implementing plugin. define defaults and fallbacks below as well
    //any types that have no implementers are ignored, and any implementations specified here that are not known to the server are also ignored.
    "implementationDefaults": {
      //each type has an object which describes which implementation to use based on some criteria to find which is best for the task. For now, just "plugins" will
      //be used to state that you want a particular plugin.
      "fallback": {
        "plugins": ["com.rs.auth.trivialAuth"]
      }
    }
  }  
};

const processManager = makeProcessManager();
const context = loadPlugins(configData, process.cwd());
context.proxy = {
  hostname: "rs28",
  port: "31338"
};
context.rootServices = rootServices;
const webServer = makeWebServer();
if (!webServer.isConfigValid(configData)) {
  throw new Error("config invalid")
}
console.log("config valid");
webServer.setConfig(configData);
console.log("will now listen...");
makeWebApp(context).then((webApp) => {
  webServer.startListening(webApp.expressApp);
});

/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/

