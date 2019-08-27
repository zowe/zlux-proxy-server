
/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/

// 'use strict';

if (!(global as any).COM_RS_COMMON_LOGGER) {
  const loggerFile = require('../../zlux-shared/src/logging/logger.js');
  (global as any).COM_RS_COMMON_LOGGER = new loggerFile.Logger();
  (global as any).COM_RS_COMMON_LOGGER.addDestination((global as any).COM_RS_COMMON_LOGGER.makeDefaultDestination(true,true,true,true,true));
}

const path = require('path');
const fs = require('fs');
const BBPromise = require('bluebird');
const ipaddr = require('ipaddr.js');
const dns = require('dns');
const dnsLookup = BBPromise.promisify(dns.lookup);

export const loggers = {
  bootstrapLogger: (global as any).COM_RS_COMMON_LOGGER.makeComponentLogger("_zsf.bootstrap"),
  authLogger: (global as any).COM_RS_COMMON_LOGGER.makeComponentLogger("_zsf.auth"),
  contentLogger: (global as any).COM_RS_COMMON_LOGGER.makeComponentLogger("_zsf.static"),
  childLogger: (global as any).COM_RS_COMMON_LOGGER.makeComponentLogger("_zsf.child"),
  utilLogger: (global as any).COM_RS_COMMON_LOGGER.makeComponentLogger("_zsf.utils"),
  proxyLogger: (global as any).COM_RS_COMMON_LOGGER.makeComponentLogger("_zsf.proxy"),
  installLogger: (global as any).COM_RS_COMMON_LOGGER.makeComponentLogger("_zsf.install"),
  apiml: (global as any).COM_RS_COMMON_LOGGER.makeComponentLogger("_zsf.apiml"),
  routing: (global as any).COM_RS_COMMON_LOGGER.makeComponentLogger("_zsf.routing"),
  network: (global as any).COM_RS_COMMON_LOGGER.makeComponentLogger("_zsf.network"),
  langManager: (global as any).COM_RS_COMMON_LOGGER.makeComponentLogger("_zsf.lang")
};


export function resolveRelativePaths(root: any, resolver: any, relativeTo: any) {
  for (const key of Object.keys(root)) {
    const value = root[key];
    const valueType = typeof value;
    if (valueType == 'object') {
      resolveRelativePaths(value, resolver, relativeTo);
    } else if ((valueType == 'string') && value.startsWith('../')) {
      const old = root[key];
      root[key] = resolver(value, relativeTo);
    }
  }
};

export function makeOptionsObject(defaultOptions: any, optionsIn: any) {
  const o = Object.create(defaultOptions);
  Object.assign(o, optionsIn);
  return Object.seal(o);
};

export function clone(obj: any) {
  return JSON.parse(JSON.stringify(obj));
};

export function deepFreeze(obj: any, seen: any) {
  if (!seen) {
    seen = new Map();
  }
  if (seen.get(obj)) {
    return;
  }
  seen.set(obj, true);
  const propNames = Object.getOwnPropertyNames(obj);
  for (const name of propNames) {
    const prop = obj[name];
    if (typeof prop == 'object' && prop !== null) {
      deepFreeze(prop, seen);
    }
  }
  return Object.freeze(obj);
};

export function readOnlyProxy(obj: any) {
  return new Proxy(obj, {
    get: function(target, property) {
      return target[property];
    }
  });  
};

export function getOrInit(obj: any, key: any, dflt: any) {
  let value = obj[key];
  if (!value) {
    value = obj[key] = dflt;
  }
  return value;
};

export function readFilesToArray(fileList: any[]) {
  var contentArray = [];
  fileList.forEach(function(filePath) {
    try {
      contentArray.push(fs.readFileSync(filePath));
    } catch (e) {
      loggers.bootstrapLogger.warn('Error when reading file='+filePath+'. Error='+e.message);
    }
  });
  if (contentArray.length > 0) {
    return contentArray;
  } else {
    return null;
  }
};

const errorProto = {
    "_objectType": "org.zowe.zlux.error",
    "_metaDataVersion": "1.0.0",
    "returnCode": "1",
    "messageID": "ZOE000E",
    "messageTemplate": "An error occurred",
    "messageParameters": {},
    "messageDetails": "An error occurred when processing the request"
  };

export function makeErrorObject(details: any) {
  if ((details._objectType !== undefined) 
      || (details._metaDataVersion !== undefined)) {
    throw new Error("can't specify error metadata");
  }
  const err = {};
  Object.assign(err, errorProto);
  Object.assign(err, details);
  return err;
}

//problem
export function* concatIterables(...args: any[]) {
  for (let i=0; i < args.length; i++) {
    yield *args[i];
  }
}

/**
 * Makes sure that the invocations of an asynchronous event handler are properly
 * queued. Creates an event listener that wraps the asynchronous `listenerFun`
 * 
 * `listenerFun` should return a promise
 */
export function asyncEventListener(listenerFun: any, logger: any) {
  //the handler for the most recent event: when this is resolved,
  //another event can be handled
  let promise = BBPromise.resolve();
  
  return function(event: any) {
    promise = promise.then(() => {
      return listenerFun(event);
    }, err => {
      if (logger) {
        logger.warn("Event handler failed: " + err);
      }
    });
  }
}

export let uniqueIps = BBPromise.coroutine(function *uniqueIps(hostnames: string[]) {
  if (hostnames == null) {
    loggers.network.debug("uniqueIps: no addresses specified, returning 0.0.0.0");
    return [ '0.0.0.0' ];
  }
  let set = new Set();
  for (let hostname of hostnames) {
    if (typeof hostname == 'string') { //really... dnsLookup would not throw on a non-string such as false
      try {
        const ipAddress = yield dnsLookup(hostname);
        set.add(ipAddress);
      } catch (e) {
        loggers.network.warn(`Skipping invalid listener address=${hostname}`);
      }
    } else {
      loggers.network.warn(`Skipping invalid listener address=${hostname}`);
    }
  }
  const arr = Array.from(set)
  loggers.network.debug("uniqueIps: " + arr);
  return arr;
})

// export uniqueIps

export function getLoopbackAddress(listenerAddresses: any[]) {
  if (listenerAddresses == null || listenerAddresses.length === 0) {
    loggers.network.debug("getLoopbackAddress: no addresses specified, "
        + "loopback address is 127.0.0.1");
    return '127.0.0.1';
  }
  for (let addressString of listenerAddresses) {
    try {
      const address = ipaddr.process(addressString);
      if (address.range() == 'loopback') {
        const result = address.toString();
        loggers.network.debug(`found loopback address ${result}`);
        return result;
      } else if (address.toNormalizedString() == '0.0.0.0') {
        loggers.network.debug("getLoopbackAddress: will listen on 0.0.0.0, "
            + "loopback address is 127.0.0.1");
        return '127.0.0.1';
      }
    } catch (e) {
      loggers.network.warn(`Couldn't process ${addressString} as IP`);
    }
  }
  loggers.network.warn(
      `Loopback calls: localhost equivalent address not found in list ${listenerAddresses}. `
      + `Using first address (${listenerAddresses[0]}); Verify firewall will allow this.`);
  return listenerAddresses[0];
}

export function formatErrorStatus(err: any, descriptions: any) {
  const description = (descriptions[err.status] || err.status) + ": ";
  const keywords = [];
  
  for (let key of Object.keys(err)) {
    if (key == "status") {
      continue;
    } 
    keywords.push(`${key}: ${err[key]}`);
  }
  return description + keywords.join(', ');
}

export function normalizePath(oldPath: any, relativeTo: any) {
  let normalized = oldPath;
  if (!relativeTo) { relativeTo = process.cwd();}
  if (!path.isAbsolute(oldPath)) {
    normalized = path.normalize(path.join(relativeTo,oldPath));
  }
  if (normalized.endsWith(path.sep)) {
    normalized = normalized.substring(0,normalized.length-1);
  }
  loggers.utilLogger.info(`Resolved path: ${oldPath} -> ${normalized}`);  
  return normalized;
}
/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/

