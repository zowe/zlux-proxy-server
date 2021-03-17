/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/

const Promise = require('bluebird');
const https = require('https');
const fs = require('fs');

/*495 minutes default session length for zosmf
 * TODO: This is the session length of a zosmf session according to their documentation.
 * However, it is not clear if that is configurable or if APIML may use a different value under other circumstances
 */
const DEFAULT_EXPIRATION_MS = 29700000;
const TOKEN_NAME = 'apimlAuthenticationToken';
const TOKEN_LENGTH = TOKEN_NAME.length;

function readUtf8FilesToArray(fileArray) {
  var contentArray = [];
  for (var i = 0; i < fileArray.length; i++) {
    const filePath = fileArray[i];
    try {
      var content = fs.readFileSync(filePath);
      if (content.indexOf('-BEGIN CERTIFICATE-') > -1) {
        contentArray.push(content);
      }
      else {
        content = fs.readFileSync(filePath, 'utf8');
        if (content.indexOf('-BEGIN CERTIFICATE-') > -1) {
          contentArray.push(content);
        }
        else {
          this.logger.warn('Error: file ' + filePath + ' is not a certificate')
        }
      }
    } catch (e) {
      this.logger.warn('Error when reading file=' + filePath + '. Error=' + e.message);
    }
  }

  if (contentArray.length > 0) {
    return contentArray;
  } else {
    return null;
  }
}


class ApimlHandler {
  constructor(pluginDef, pluginConf, serverConf, context) {
    this.logger = context.logger;    
    this.apimlConf = serverConf.node.mediationLayer.server;    
    this.gatewayUrl = `https://${this.apimlConf.hostname}:${this.apimlConf.gatewayPort}`;

    if (serverConf.node.https.certificateAuthorities === undefined) {
      this.logger.warn("This server is not configured with certificate authorities, so it will not validate certificates with APIML");
      this.httpsAgent = new https.Agent({
        rejectUnauthorized: false
      });
    } else {
      this.httpsAgent = new https.Agent({
        rejectUnauthorized: true,
        ca: context.tlsOptions.ca
      });
    }
  }

  logout(request, sessionState) {
    return new Promise((resolve, reject) => {
      if (!(request.cookies && request.cookies[TOKEN_NAME])) {
        return resolve({success: true});
      }
      const gatewayUrl = this.gatewayUrl;
      const options = {
        hostname: this.apimlConf.hostname,
        port: this.apimlConf.gatewayPort,
//TODO uncertainty about using apicatalog route instead of something part of the gateway itself
        path: '/api/v1/apicatalog/auth/logout',
        method: 'POST',
        headers: {
          'apimlAuthenticationToken': request.cookies[TOKEN_NAME]
        },
        agent: this.httpsAgent
      }

      const req = https.request(options, (res) => {
        let data = [];
        res.on('data', (d) => {data.push(d)});
        res.on('end', () => {
          let apimlCookie;
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ success: true, cookies: [{name:TOKEN_NAME,
                                                value:'non-token',
                                                options: {httpOnly: true,
                                                          secure: true,
                                                          expires: new Date(1)}}]});
            return;
          } else {
            let response = {
              success: false,
              reason: 'Unknown',
              error: {
                message: `APIML ${res.statusCode} ${res.statusMessage}`,
                body: Buffer.concat(data).toString()
              }
            };
            //Seems that when auth is first called, it may not be loaded yet, so you get a 405.
            if (res.statusCode == 405) {
              response.reason = 'TryAgain';
            }
            resolve(response);
            return;
          }
        });
      });

      req.on('error', (error) => {
        this.logger.warn("APIML logout has failed:");
        this.logger.warn(error);
        var details = error.message;
        if ((error.response !== undefined) && (error.response.data !== undefined)) {
          details = error.response.data;
        }
        resolve({
          success: false,
          reason: 'Unknown',
          error: { message: `APIML ${details}`}
        });
        return;
      });
      req.end();
    });
  }

  /**
     Authenticate in 1 of 2 ways: is body present? Use body to try to get new cookie.
     If it fails, is cookie present? Try that.
     If no body, try cookie.
     Return a success or failure, which sso-auth will handle
   */
  authenticate(request, sessionState) {
    if (request.body) {
      this.logger.debug(`Authenticate with body`);
      return new Promise((resolve, reject) => {
        this.doLogin(request, sessionState).then(result=> {
          if (result.success === true) {
            resolve(result);
          } else {
            this.authenticateViaCookie(request, sessionState).then(result=> resolve(result))
              .catch(e => reject(e));
          }
        }).catch(e=> {
          this.authenticateViaCookie(request, sessionState).then(result=> resolve(result))
            .catch(e => reject(e));
        });
      });
    } else if (request.cookies && request.cookies[TOKEN_NAME]) {
      return this.authenticateViaCookie(request, sessionState);
    } else {
      return Promise.resolve({success: false});
    }
  }

  authenticateViaCookie(request, sessionState) {
    return new Promise((resolve, reject)=> {
      this.logger.debug(`Authenticate with cookie`,TOKEN_NAME);
      this.queryToken(request.cookies[TOKEN_NAME]).then(data=> {
        let expiration;
        const expirationDate = new Date(data.expiration);
        const creationDate = new Date(data.creation);
        if (creationDate.getTime() > expirationDate.getTime()) {
          expiration = -1;
        } else {
          const now = new Date();
          expiration = expirationDate.getTime() - now.getTime();
        }
        if (expiration < 1) {
          this.doLogin(request, sessionState).then(result=> resolve(result))
            .catch(e => reject(e));
        } else {
          this.setState(request.cookies[TOKEN_NAME],
                        data.userId, sessionState);
          resolve({success: true, username: sessionState.username, expms: expiration});
        }
      }).catch(e=> {
        this.logger.debug('APIML query failed, trying login.');
        this.doLogin(request, sessionState).then(result=> resolve(result))
          .catch(e => reject(e));
      });
    });
  }

  setState(token, username, sessionState) {
    sessionState.username = username.toUpperCase();
    sessionState.apimlToken =  token;
  }

  makeOptions(path, method, cookie, dataLength) {
    let headers = undefined;
    if (cookie) {
      headers = {'cookie': cookie};
    }
    if (dataLength) {
      if (!headers) {headers = {};}
      headers['Content-Type']= 'application/json';
      headers['Content-Length']= dataLength;
    }
    
    return {
      hostname: this.apimlConf.hostname,
      port: this.apimlConf.gatewayPort,
      path: path,
      method: method,
      headers: headers,
      agent: this.httpsAgent
    };
  }


  /**
     Data in the form of
     {
     "domain": "PRODUCTION",
     "userId": "DAVE",
     "creation": 1497030118362,
     "expiration": 1497116518362
     }
     Or, creation and expiration may be a timezone string like:
     "2020-03-21T15:44:27.000+0000"
  **/
  queryToken(token) {
    return new Promise((resolve, reject) => {
      const options = this.makeOptions('/api/v1/gateway/auth/query',
                                       'GET',
                                       TOKEN_NAME+'='+token);
      
      let data = [];
      const req = https.request(options, (res) => {
        res.on('data', (chunk) => data.push(chunk));
        res.on('end', () => {
          this.logger.debug(`Query rc=`,res.statusCode);
          if (res.statusCode == 200) {
            if (data.length > 0) {
              try {
                const dataJson = JSON.parse(Buffer.concat(data).toString());
                this.logger.debug(`Query body=`,dataJson);
                resolve(dataJson);
              } catch (e) {
                reject(new Error('Could not parse body as JSON'));
              }
            } else {
              reject(new Error('No body in response'));
            }
          } else {
            reject(new Error('Status code:'+res.statusCode));
          }
        });
      });

      req.on('error', (error) => {
        this.logger.warn("APIML query error:", error.message);
        reject(error);
      });
      req.end();
    });
  }

  doLogin(request, sessionState) {
    return new Promise((resolve, reject) => {
      const gatewayUrl = this.gatewayUrl;
      const data = JSON.stringify({
        username: request.body.username,
        password: request.body.password
      });
      const options = this.makeOptions('/api/v1/gateway/auth/login','POST', undefined, data.length);

      const req = https.request(options, (res) => {
        res.on('data', (d) => {});
        res.on('end', () => {
          this.logger.debug(`Login rc=`,res.statusCode);
          let token;
          if (res.statusCode == 204) {
            if (typeof res.headers['set-cookie'] === 'object') {
              for (const cookie of res.headers['set-cookie']) {
                const content = cookie.split(';')[0];
                let index = content.indexOf(TOKEN_NAME);
                if (index >= 0) {
                  token = content.substring(index+1+TOKEN_LENGTH);
                }
              }
            }
          }
          if (token) {
            this.logger.debug(`Getting expiration for token`);
            this.queryToken(token).then(data=> {
              let expiration;
              const expirationDate = new Date(data.expiration);
              const creationDate = new Date(data.creation);
              if (creationDate.getTime() > expirationDate.getTime()) {
                expiration = -1;
              } else {
                const now = new Date();
                expiration = expirationDate.getTime() - now.getTime();
              }
              if (expiration > 0) {
                this.setState(token, data.userId, sessionState);
                resolve({ success: true, username: sessionState.username, expms: expiration,
                          cookies: [{name:TOKEN_NAME, value:token, options: {httpOnly: true, secure: true}}]});
              } else {
                resolve({ success: false, reason: 'Unknown'});
              }
            }).catch(e=> {
              reject({ success: false, reason: 'Unknown', error: {message:e.message.toString()}});
            });
            return;
          } else {
            let response = {
              success: false,
              reason: 'Unknown',
              error: {
                message: `APIML ${res.statusCode} ${res.statusMessage}`
              }
            };
            //Seems that when auth is first called, it may not be loaded yet, so you get a 405.
            if (res.statusCode == 405) {
              response.reason = 'TryAgain';
            }
            resolve(response);
            return;
          }
        });
      });

      req.on('error', (error) => {
        this.logger.warn("APIML login has failed:");
        this.logger.warn(error);
        var details = error.message;
        if ((error.response !== undefined) && (error.response.data !== undefined)) {
          details = error.response.data;
        }
        resolve({
          success: false,
          reason: 'Unknown',
          error: { message: `APIML ${details}`}
        });
        return;
      });

      req.write(data);
      req.end();
    });
  }

  cleanupSession(sessionState) {
    delete sessionState.apimlToken;
  }

  /**
   * Invoked for every service call by the middleware.
   *
   * Checks if the session is valid in a stateful scheme, or authenticates the
   * request in a stateless scheme. Then checks if the user can access the
   * resource.  Modifies the request if necessary.
   *
   * `sessionState` is this plugin's private storage within the session (if
   * stateful)
   *
   * The promise should resolve to an object containing, at least,
   * { authorized: true } if everything is fine. Should not reject the promise.
   */
  authorized(request, sessionState) {
    if (sessionState.authenticated) {
      request.username = sessionState.username;
      request.ssoToken = request.cookies[TOKEN_NAME];
      return Promise.resolve({ authenticated: true, authorized: true });
    } else {
      return Promise.resolve({ authenticated: false, authorized: false });
    }
  }

  addProxyAuthorizations(req1, req2Options, sessionState, usingSso) {
    if (!sessionState.apimlToken) {
      return;
    }
//    req2Options.headers[TOKEN_NAME] = sessionState.apimlToken;
    if (this.usingSso) {
      req2Options.headers['Authorization'] = 'Bearer '+sessionState.apimlToken;
    }
  }
}

module.exports = function(pluginDef, pluginConf, serverConf, context) {
  return new ApimlHandler(pluginDef, pluginConf, serverConf, context);
}
