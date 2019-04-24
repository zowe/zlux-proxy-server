import { AnyRecordWithTtl } from "dns";


/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/

'use strict';

const BBPromise = require('bluebird');
const fs = require('fs');
const http = require('http');
const https = require('https');
const url = require('url');
const WebSocket = require('ws');
const expressWs = require('express-ws');
const util = require('./util');
const constants = require('./unp-constants');
const reader = require('./reader');
const crypto = require('crypto');

const bootstrapLogger = util.loggers.bootstrapLogger;
const contentLogger = util.loggers.contentLogger;
const childLogger = util.loggers.childLogger;
const networkLogger = util.loggers.network;

function readCiphersFromArray(stringArray: string[]) {
  if (stringArray && Array.isArray(stringArray)) {
    let uppercase = [];
    for (let i = 0; i < stringArray.length; i++) {
      if (typeof stringArray[i] != 'string') {
        bootstrapLogger.warn(`Returning null for cipher array because input had non-string: `,stringArray[i]);
        return null;
      }
      uppercase[i] = stringArray[i].toUpperCase();
    }
    return uppercase.join(':');
  } else {
    return null;
  }
};


function readTlsOptionsFromConfig(config: any, httpsOptions: any) {
  if (config.https.pfx) {
    try {
      httpsOptions.pfx = fs.readFileSync(config.https.pfx);
      bootstrapLogger.info('Using PFX: '+ config.https.pfx);
    } catch (e) {
      bootstrapLogger.warn('Error when reading PFX. Server cannot continue. Error='
          + e.message);
      //process.exit(UNP_EXIT_PFX_READ_ERROR);
      throw e;
    }
  } else {
    if (config.https.certificates) {
      httpsOptions.cert = util.readFilesToArray(
          config.https.certificates);
      bootstrapLogger.info('Using Certificate: ' + config.https.certificates);
    }
    if (config.https.keys) {
      httpsOptions.key = util.readFilesToArray(config.https.keys);
    }
  }
  if (config.https.certificateAuthorities) {
    httpsOptions.ca = util.readFilesToArray(config.https.certificateAuthorities);
  }
  if (config.https.certificateRevocationLists) {
    httpsOptions.crl = util.readFilesToArray(config.https.certificateRevocationLists);
  }
}
  
export class WebServer {
  public config: any;
  public httpOptions: any;
  public httpsOptions: any;
  public httpsServers: any[];
  public httpServers: any[];
  public expressWsHttps: any[];
  public expressWsHttp: any[];

  constructor() {
    this.config = null;
    this.httpOptions = null;
    this.httpsOptions = null;
    this.httpsServers = [];
    this.httpServers = [];
    this.expressWsHttps = [];
    this.expressWsHttp = [];
  }
  
  _setErrorLogger(server: any, type: any, ipAddress: any, port: any) {
    //the server object will not tell the ipAddr & port unless it has successfully connected,
    //making logging poor unless passed
    server.on('error',(e: any)=> {
      switch (e.code) {
      case 'EADDRINUSE':
        networkLogger.severe(`Could not listen on address ${ipAddress}:${port}. It is already in use by another process.`);
        //While I'd like to close the server here,
        //it seems that an exception is thrown that can't be caught, causing server to stop anyway
        break;
      case 'ENOTFOUND':
      case 'EADDRNOTAVAIL':
        networkLogger.severe(`Could not listen on address ${ipAddress}:${port}. Invalid IP for this system.`);
        //While I'd like to close the server here,
        //it seems that an exception is thrown that can't be caught, causing server to stop anyway
        break;
      default:
        networkLogger.warn(`Unexpected error on server ${ipAddress}:${port}. E=${e}. Stack trace follows.`);
        networkLogger.warn(e.stack);
      }
    });
  }
  
  getTlsOptions() {
    return this.httpsOptions;
  }

  validateAndPreprocessConfig = BBPromise.coroutine(function *validateAndPreprocessConfig(config: any) {
    let canRun = false;
    if (config.http && config.http.port) {
      const uniqueIps = yield util.uniqueIps(config.http.ipAddresses);
      if (uniqueIps.length > 0) {
        canRun = true;
        networkLogger.info('HTTP config valid, will listen on: ' + uniqueIps);
        config.http.enabled = true;
      }
      config.http.ipAddresses = uniqueIps;
    } 
    /* TODO this 'canRun' logic has long been here, but I'm wondering if is's
     * adequate: I think we might want to make sure that everything 
     * the user requested is doable, not just something. If either HTTP or HTTPS
     * was requested and we couldn't start it, then we might want to signal an
     * error, rather than trying to chug along somehow... */
    if (config.https && config.https.port) {
      const uniqueIps =  yield util.uniqueIps(config.https.ipAddresses);
      if (uniqueIps.length > 0) {
        if (config.https.pfx) {
          canRun = true;
          networkLogger.info('HTTPS config valid, will listen on: ' + uniqueIps);
          config.https.enabled = true;
        } else if (config.https.certificates && config.https.keys) {
          canRun = true;
          networkLogger.info('HTTPS config valid, will listen on: ' + uniqueIps);
          config.https.enabled = true;
        }
      } 
      config.https.ipAddresses = uniqueIps;
    }
    return canRun;
  })

  setConfig(config: any) {
    this.config = config;
    if (this.config.http && this.config.http.port) {
      this.httpOptions = {};
    }
    if (this.config.https && this.config.https.port) {
      let options = this.config.https;
      this.httpsOptions = {};
      //secureOptions and secureProtocol documented here: 
      //https://nodejs.org/api/tls.html#tls_tls_createsecurecontext_options
      if (typeof options.secureOptions == 'number') {
        //the numbers you want here actually come from openssl, and are likely 
        //in this file: https://github.com/openssl/openssl/blob/master/include/openssl/ssl.h
        this.httpsOptions.secureOptions = options.secureOptions;
      } else if (typeof options.secureProtocol == 'string') {
        this.httpsOptions.secureProtocol = options.secureProtocol;
      } else {
        let consts = crypto.constants;
        //tls 1.3 was released in 2018, and tls 1.2 should be in this blacklist list when it has widespread support
        this.httpsOptions.secureOptions = consts.SSL_OP_NO_SSLv2 | 
          consts.SSL_OP_NO_SSLv3 | consts.SSL_OP_NO_TLSv1 | consts.SSL_OP_NO_TLSv1_1;
      }
      
      let ciphers = readCiphersFromArray(options.ciphers);
      if (ciphers == null || ciphers.length==0) {
        ciphers = readCiphersFromArray(constants.HTTPS_DEFAULT_CIPHERS);
      }
      if (ciphers != 'NODEJS') {//for using nodejs defaults - very unlikely to overlap as a reserved word
        this.httpsOptions.ciphers = ciphers;
      }
      
      readTlsOptionsFromConfig(this.config, this.httpsOptions);
    }
  }

  startListening = BBPromise.coroutine(function* (app: any) {
    if (this.config.https && this.config.https.port) {
      const port = this.config.https.port;
      for (let ipAddress of this.config.https.ipAddresses) {
        let listening = false;
        let httpsServer;
        const httpsOptions = this.getTlsOptions();
        while (!listening) {
          try {
            httpsServer = https.createServer(httpsOptions, app);
            this._setErrorLogger(httpsServer, 'HTTPS', ipAddress, port);
            this.httpsServers.push(httpsServer);
            this.expressWsHttps.push(expressWs(app, httpsServer, {maxPayload: 50000}));
            listening = true;
          } catch (e) {
            if (e.message == 'mac verify failure') {
              const r = reader();
              try {
                this.httpsOptions.passphrase = yield reader.readPassword(
                  'HTTPS key or PFX decryption failure. Please enter passphrase: ');
              } finally {
                r.close();
              }
            } else {
              throw e;
            }
          }
        }
        this.callListen(httpsServer, 'https', 'HTTPS', ipAddress, port);
      }
    }
    if (this.config.http && this.config.http.port) {
      const port = this.config.http.port;
      for (let ipAddress of this.config.http.ipAddresses) {
        let httpServer = http.createServer(app);
        this._setErrorLogger(httpServer, 'HTTP', ipAddress, port);
        this.httpServers.push(httpServer);
        this.expressWsHttp.push(expressWs(app, httpServer));
        this.callListen(httpServer, 'http', 'HTTP', ipAddress, port);
      }
    }
  })

  callListen(methodServer: any, methodName: string, methodNameForLogging: string, ipAddress: any, port: any) {
    const addressForLogging = `${ipAddress}:${port}`;
    const logFunction = function () {
      networkLogger.log(bootstrapLogger.INFO,`(${methodNameForLogging})  `
          + `Listening on ${addressForLogging}`)
    };
    networkLogger.log(bootstrapLogger.INFO, `(${methodNameForLogging})  `
        + `About to start listening on ${addressForLogging}`);
    methodServer.listen(port, ipAddress, logFunction);
  }

  close() {
    this.httpServers.forEach((server)=> {
      let info = server.address();
      if (info) {
        //could be undefined if there was an error binding, yet close() still works
        networkLogger.info(`(HTTP) Closing server ${info.address}:${info.port}`);
      }
      server.close();      
    });
    this.httpsServers.forEach((server)=> {
      let info = server.address();
      if (info) {
        //could be undefined if there was an error binding, yet close() still works
        networkLogger.info(`(HTTPS) Closing server ${info.address}:${info.port}`);
      }
      server.close();      
    });
  }
};

module.exports = WebServer;
module.exports.readTlsOptionsFromConfig = readTlsOptionsFromConfig;

/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/

