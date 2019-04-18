/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
if (!global.COM_RS_COMMON_LOGGER) {
    const loggerFile = require('../../zlux-shared/src/logging/logger.js');
    global.COM_RS_COMMON_LOGGER = new loggerFile.Logger();
    global.COM_RS_COMMON_LOGGER.addDestination(global.COM_RS_COMMON_LOGGER.makeDefaultDestination(true, true, true));
}
const path = require('path');
const fs = require('fs');
const BBPromise = require('bluebird');
const ipaddr = require('ipaddr.js');
const dns = require('dns');
const dnsLookup = BBPromise.promisify(dns.lookup);
function compoundPathFragments(left, right) {
    return path.join(left, right).normalize();
}
exports.compoundPathFragments = compoundPathFragments;
function resolveRelativePathAgainstCWD(path, x) {
    return compoundPathFragments(process.cwd(), path);
}
exports.resolveRelativePathAgainstCWD = resolveRelativePathAgainstCWD;
exports.loggers = {
    bootstrapLogger: global.COM_RS_COMMON_LOGGER.makeComponentLogger("_zsf.bootstrap"),
    authLogger: global.COM_RS_COMMON_LOGGER.makeComponentLogger("_zsf.auth"),
    contentLogger: global.COM_RS_COMMON_LOGGER.makeComponentLogger("_zsf.static"),
    childLogger: global.COM_RS_COMMON_LOGGER.makeComponentLogger("_zsf.child"),
    utilLogger: global.COM_RS_COMMON_LOGGER.makeComponentLogger("_zsf.utils"),
    proxyLogger: global.COM_RS_COMMON_LOGGER.makeComponentLogger("_zsf.proxy"),
    installLogger: global.COM_RS_COMMON_LOGGER.makeComponentLogger("_zsf.install"),
    apiml: global.COM_RS_COMMON_LOGGER.makeComponentLogger("_zsf.apiml"),
    routing: global.COM_RS_COMMON_LOGGER.makeComponentLogger("_zsf.routing"),
    network: global.COM_RS_COMMON_LOGGER.makeComponentLogger("_zsf.network"),
};
// module.exports.loggers = loggers;
function resolveRelativePaths(root, resolver, callerKey) {
    for (const key of Object.keys(root)) {
        const value = root[key];
        const valueType = typeof value;
        if (valueType == 'object') {
            resolveRelativePaths(value, resolver, callerKey);
        }
        else if ((valueType == 'string') && value.startsWith('../')) {
            const old = root[key];
            root[key] = resolver(value, callerKey);
            exports.loggers.utilLogger.info(`Resolved path: ${old} -> ${root[key]}`);
        }
    }
}
exports.resolveRelativePaths = resolveRelativePaths;
;
function makeOptionsObject(defaultOptions, optionsIn) {
    const o = Object.create(defaultOptions);
    Object.assign(o, optionsIn);
    return Object.seal(o);
}
exports.makeOptionsObject = makeOptionsObject;
;
function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
}
exports.clone = clone;
;
function deepFreeze(obj, seen) {
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
}
exports.deepFreeze = deepFreeze;
;
function readOnlyProxy(obj) {
    return new Proxy(obj, {
        get: function (target, property) {
            return target[property];
        }
    });
}
exports.readOnlyProxy = readOnlyProxy;
;
function getOrInit(obj, key, dflt) {
    let value = obj[key];
    if (!value) {
        value = obj[key] = dflt;
    }
    return value;
}
exports.getOrInit = getOrInit;
;
function readFilesToArray(fileList) {
    var contentArray = [];
    fileList.forEach(function (filePath) {
        try {
            contentArray.push(fs.readFileSync(filePath));
        }
        catch (e) {
            exports.loggers.bootstrapLogger.warn('Error when reading file=' + filePath + '. Error=' + e.message);
        }
    });
    if (contentArray.length > 0) {
        return contentArray;
    }
    else {
        return null;
    }
}
exports.readFilesToArray = readFilesToArray;
;
const errorProto = {
    "_objectType": "org.zowe.zlux.error",
    "_metaDataVersion": "1.0.0",
    "returnCode": "1",
    "messageID": "ZOE000E",
    "messageTemplate": "An error occurred",
    "messageParameters": {},
    "messageDetails": "An error occurred when processing the request"
};
function makeErrorObject(details) {
    if ((details._objectType !== undefined)
        || (details._metaDataVersion !== undefined)) {
        throw new Error("can't specify error metadata");
    }
    const err = {};
    Object.assign(err, errorProto);
    Object.assign(err, details);
    return err;
}
exports.makeErrorObject = makeErrorObject;
function* concatIterables() {
    for (let i = 0; i < arguments.length; i++) {
        yield* arguments[i];
    }
}
exports.concatIterables = concatIterables;
/**
 * Makes sure that the invocations of an asynchronous event handler are properly
 * queued. Creates an event listener that wraps the asynchronous `listenerFun`
 *
 * `listenerFun` should return a promise
 */
function asyncEventListener(listenerFun, logger) {
    //the handler for the most recent event: when this is resolved,
    //another event can be handled
    let promise = BBPromise.resolve();
    return function (event) {
        promise = promise.then(() => {
            return listenerFun(event);
        }, (err) => {
            if (logger) {
                logger.warn("Event handler failed: " + err);
            }
        });
    };
}
exports.asyncEventListener = asyncEventListener;
module.exports.uniqueIps = BBPromise.coroutine(function* uniqueIps(hostnames) {
    if (hostnames == null) {
        exports.loggers.network.debug("uniqueIps: no addresses specified, returning 0.0.0.0");
        return ['0.0.0.0'];
    }
    let set = new Set();
    for (let hostname of hostnames) {
        if (typeof hostname == 'string') { //really... dnsLookup would not throw on a non-string such as false
            try {
                const ipAddress = yield dnsLookup(hostname);
                set.add(ipAddress);
            }
            catch (e) {
                exports.loggers.network.warn(`Skipping invalid listener address=${hostname}`);
            }
        }
        else {
            exports.loggers.network.warn(`Skipping invalid listener address=${hostname}`);
        }
    }
    const arr = Array.from(set);
    exports.loggers.network.debug("uniqueIps: " + arr);
    return arr;
});
function getLoopbackAddress(listenerAddresses) {
    if (listenerAddresses == null || listenerAddresses.length === 0) {
        exports.loggers.network.debug("getLoopbackAddress: no addresses specified, "
            + "loopback address is 127.0.0.1");
        return '127.0.0.1';
    }
    for (let addressString of listenerAddresses) {
        try {
            const address = ipaddr.process(addressString);
            if (address.range() == 'loopback') {
                const result = address.toString();
                exports.loggers.network.debug(`found loopback address ${result}`);
                return result;
            }
            else if (address.toNormalizedString() == '0.0.0.0') {
                exports.loggers.network.debug("getLoopbackAddress: will listen on 0.0.0.0, "
                    + "loopback address is 127.0.0.1");
                return '127.0.0.1';
            }
        }
        catch (e) {
            exports.loggers.network.warn(`Couldn't process ${addressString} as IP`);
        }
    }
    exports.loggers.network.warn(`Loopback calls: localhost equivalent address not found in list ${listenerAddresses}. `
        + `Using first address (${listenerAddresses[0]}); Verify firewall will allow this.`);
    return listenerAddresses[0];
}
exports.getLoopbackAddress = getLoopbackAddress;
function formatErrorStatus(err, descriptions) {
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
exports.formatErrorStatus = formatErrorStatus;
//# sourceMappingURL=util.js.map