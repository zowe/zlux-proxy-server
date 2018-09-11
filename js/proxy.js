

/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/

/**
 * The half of the proxy that talks to the C server
 * 
 */
'use strict';
const http = require('http');
const https = require('https');
const express = require('express');
const util = require('./util');
const unpconst = require('./unp-constants');
const WebSocket = require('ws');

const proxyLog = util.loggers.proxyLogger;

function convertOptions(request, realHost, realPort, urlPrefix) {
  var options = {};
  proxyLog.debug("request host " + request.headers.host);
  var headers = request.headers;
  var newHeaders = {};
  for (var propName in headers) {
    if (headers.hasOwnProperty(propName)) {
      proxyLog.debug("header["+propName+"]="+headers[propName]);
      if (propName == "host"){
        newHeaders[propName] = realHost+":"+realPort;
      } else if (propName == "origin") {
        newHeaders[propName] = realHost+":"+realPort;
      } else if(propName.startsWith("sec-websocket")) {
        // Drop websocket headers
      } else {
        newHeaders[propName] = headers[propName];
      }
    }
  }
  options.host = realHost;
  options.port = realPort;
  options.family = 4;       /* "rs22" can resolve to IPV6 if otherwise */
  options.headers = newHeaders;
  options.path = urlPrefix + request.url;
  options.method = request.method;
  proxyLog.debug("proxied options "+JSON.stringify(options));
  return options;
}

function makeSimpleProxy(host, port, options) {
  if (!(host && port)) {
    throw new Error("Proxy: need a host and port");
  }
  const {urlPrefix, isHttps, addProxyAuthorizations, allowInvalidTLSProxy} = 
    options;
  const httpApi = isHttps? https : http;
  return function(req1, res1) {
    const requestOptions = convertOptions(req1, host, port, urlPrefix);
    if (isHttps) {
      requestOptions.rejectUnauthorized = !allowInvalidTLSProxy;
    }
    proxyLog.debug(`proxy request to ${requestOptions.host}:${requestOptions.port}`
        +`${requestOptions.path}`);
    if (addProxyAuthorizations) {
      proxyLog.debug('Callservice: given auth helper ');
      addProxyAuthorizations(req1, requestOptions);
    } else {
      proxyLog.debug('Callservice: no auth helper');
    }
    //utilLog.debug(requestOptions);
    const req2 = httpApi.request(requestOptions, (res2) => {
      proxyLog.debug("status code", res2.statusCode);
      res1.status(res2.statusCode);
      const headers = res2.headers;
      for (const header of Object.keys(headers)) {
        //proxyLog.debug(header, headers[header]);
        res1.set(header, headers[header])
      }
      res2.pipe(res1);
    });
    req2.on('error', (e) => {
      proxyLog.warn('Callservice: Service call failed.');
      console.warn(e);
      res1.status(500).send(`Unable to complete network request to ${host}:${port}: `
          + e.message, null, null);
    });
    if ((req1.method == 'POST') || (req1.method == 'PUT')) {
      proxyLog.debug('Callservice: Forwarding request body to service');
      req1.pipe(req2);
    } else {
      proxyLog.debug('Callservice: Issuing request to service');
      req2.end();
    }
  }
}

function makeWsProxy(host, port, urlPrefix, isHttps) {
  // copied and pasted with only minimal fixes to formatting
  var toString = function() {
    return '[Proxy URL: '+urlPrefix+']';
  };

  var logException = function(e) {
    proxyLog.warn(toString()+' Exception caught. Message='+e.message);
    proxyLog.warn("Stack trace follows\n"+e.stack);
  };

  var handleProxyWSException = function(e, ws, proxyws) {
    logException(e);
    try {
      if (ws) {
        ws.close(unpconst.WEBSOCKET_CLOSE_INTERNAL_ERROR,
                 JSON.stringify({error: 'Internal Server Error'}));
      }
      if (proxyws) {
        proxyws.close(unpconst.WEBSOCKET_CLOSE_INTERNAL_ERROR,
                      JSON.stringify({error: 'Internal Server Error'}));
      }
    } catch (closeEx) {
      logException(closeEx);
    }
  };
  return function(ws, req) {
    proxyLog.debug(toString()+" WS proxy request to: " + req.originalUrl);
    if (req.originalUrl.indexOf('?') !== -1) {
      const parts = req.originalUrl.split('?');
      req.originalUrl = parts[0].substring(0, parts[0].length - ".websocket".length)
        + "?" + parts[1];
      proxyLog.debug("t:" + req.originalUrl);
    } else {
      req.originalUrl = req.originalUrl.substring(0, req.originalUrl.length
          - ".websocket".length);
      proxyLog.debug("s:" + req.originalUrl);
    }
    var options = convertOptions(req, host, port, urlPrefix);
    var targetUrl = url.format({protocol: "ws:",
      slashes: true,
      hostname: options.host,
      port: options.port,
      pathname: options.path});
    options.url = targetUrl;
    var proxyWs = new WebSocket(targetUrl, options);
    var proxyOpen = false;
    var bufferedMessages = [];
    var handleBufferedMessages = function() {
      if (bufferedMessages && bufferedMessages.length > 0) {
        for (var i = 0; i < bufferedMessages.length; i++) {
          var bufferedMessage = bufferedMessages[i];
          proxyWs.send(bufferedMessage.data, {
            binary: bufferedMessage.binary,
            mask: bufferedMessage.masked
          });
        }
        bufferedMessages = null;
      }
    };
    ws.on('message', function(data, flags) {
      if (!proxyOpen) {
        bufferedMessages.push({data:data, flags:flags});
      }
      else {
        try {
          handleBufferedMessages();
          proxyWs.send(data, {
            binary: flags.binary,
            mask: flags.masked
          });
        } catch (e) {
          handleProxyWSException(e,ws,proxyWs);
          bufferedMessages = null;
        }
      }
    });
    ws.on('close', function(code, reason) {
      proxyLog.debug('ws Seen close with code='+code);
      if (code < unpconst.WEBSOCKET_CLOSE_CODE_MINIMUM) {
        //application-level code is not allowed to issue a close
        //command with values under 4000, and library level not under 3000.
        code =  unpconst.WEBSOCKET_CLOSE_BY_PROXY;
      }
      try {
        proxyWs.close(code, reason);
      } catch (e) {
        handleProxyWSException(e,ws,null);
      }
    });
    ws.on('ping', function(data, flags) {
      try {
        proxyWs.ping(data, flags.masked);
      } catch (e) {
        handleProxyWSException(e,ws,proxyWs);
      }
    });
    ws.on('pong', function(data, flags) {
      try {
        proxyWs.pong(data, flags.masked);
      } catch (e) {
        handleProxyWSException(e,ws,proxyWs);
      }
    });
    proxyWs.on('open', function open() {
      try {
        handleBufferedMessages();
        proxyOpen = true;
      } catch (e) {
        handleProxyWSException(e,ws,proxyWs);
        bufferedMessages = null;
      }
      if (proxyOpen) {
        proxyWs.on('close', function(code, reason) {
          proxyLog.debug('proxyws Seen close with code='+code);
          if (code < unpconst.WEBSOCKET_CLOSE_CODE_MINIMUM) {
            //application-level code is not allowed to issue a close
            //command with values under 4000, and library level not under 3000.
            code = unpconst.WEBSOCKET_CLOSE_BY_PROXY;
          }
          try {
            ws.close(code, reason);
          } catch (e) {
            handleProxyWSException(e,null,proxyWs);
          }
        });
        proxyWs.on('message', function(data, flags) {
          try {
            ws.send(data, {
              binary: flags.binary,
              mask: flags.masked
            });
          } catch (e) {
            handleProxyWSException(e,ws,proxyWs);
          }
        });
        proxyWs.on('ping', function(data, flags) {
          try {
            ws.ping(data, flags.masked);
          } catch (e) {
            handleProxyWSException(e,ws,proxyWs);
          }
        });
        proxyWs.on('pong', function(data, flags) {
          try {
            ws.pong(data, flags.masked);
          } catch (e) {
            handleProxyWSException(e,ws,proxyWs);
          }
        });
      }
    });
    proxyWs.on('error', function(error) {
      proxyLog.warn(toString()+" proxyWS error:" + error);
      if (ws) {
        ws.terminate();
      }
      proxyWs.terminate();
      bufferedMessages = null;
    });
    ws.on('error', function(error) {
      proxyLog.warn(toString()+" WS error:" + error);
      if (proxyWs) {
        proxyWs.terminate();
      }
      ws.terminate();
      bufferedMessages = null;
    });
  };
};

exports.makeSimpleProxy = makeSimpleProxy;
exports.makeWsProxy = makeWsProxy;


/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/

