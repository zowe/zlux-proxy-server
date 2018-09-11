
/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/
'use strict';
//based on description from https://www.npmjs.com/package/express-session

const util = require('util');
const events = require('events');
const expressSession = require('express-session');
const superstore = expressSession.Store || expressSession.session.Store;
const superstore_createSession = superstore.prototype.createSession;
const defaultMaxAge = process.env.sessionMaxAge;
const defaultMaxAge2 = process.env.sessionMaxAge2 || 1000*60*60*24*7;//week
const storedSessionsLimit = process.env.storedSessionsLimit || 500000;

function createLimitedQueue(limit, removeHandler) {
  var array = new Array();
  array.push = function () {
    if (this.length >= limit) {
      var removed = this.shift();
      removeHandler(removed);
    }
    return Array.prototype.push.apply(this,arguments);
  }
  return array;
}

function SessionStore() {
  events.EventEmitter.call(this);
  superstore.call(this);
  this.sessions = new Map();
  this.sessionsQueue = createLimitedQueue(storedSessionsLimit, function(removedSid) {
    this.sessions.delete(removedSid);
    //console.log('pushed out session ' + removedSid);
  }.bind(this));
  if (this.isLocalStorage()) {
    setInterval(function() {
      //tomeout cleaner
      if (this.sessions.size > 10000) {
        console.log('SessionStore.sessions.size=' + this.sessions.size);
      }
      const checkTimestamp = this.getTimestamp();
      this.sessions.forEach((session,key,map)=>
      {
        if (session.cookie && session.cookie.maxAge && checkTimestamp > session.lastTouch + session.cookie.maxAge) {
          map.delete(key);
          //console.log('Timeout cleaner expired session=' + session + ' key=' + key + ' map.size=' + map.size);
        }
        if (checkTimestamp - session.lastTouch > defaultMaxAge2) {
          map.delete(key);
          console.log('Timeout cleaner dead session=' + session + ' key=' + key + ' map.size=' + map.size);
        }
      });
    }.bind(this), 10000);
  }
  //console.log('Session Store initialized');
}
util.inherits(SessionStore, events.EventEmitter);
util.inherits(SessionStore, superstore);

SessionStore.prototype.addSession = function(sid, session) {
  if (!this.sessions.has(sid)) {
    this.sessionsQueue.push(sid);
  }
  this.sessions.set(sid, session);
}

SessionStore.prototype.removeSid = function(sid) {
  if (this.sessions.delete(sid)) {
    this.sessionsQueue.splice(array.indexOf(sid), 1);
  }
}

SessionStore.prototype.updateLastTouch = function(sess) {
  sess.lastTouch = this.getTimestamp();
}

SessionStore.prototype.ensureMaxAge = function(sess) {
  if (!sess.cookie.maxAge && defaultMaxAge) {
    sess.cookie.maxAge = defaultMaxAge;
  }
}

SessionStore.prototype.createSession = function(req, sess) {
  var result = superstore_createSession.apply(this, [req, sess]);
  this.updateLastTouch(result);
  this.ensureMaxAge(result);
  return result;
}

SessionStore.prototype.isLocalStorage = function() {
  return !process.clusterManager || process.clusterManager.isMaster;
}

SessionStore.prototype.getTimestamp = function() {
  return new Date().getTime();
}

SessionStore.prototype.clusterRemoteCall = function(methodName, args, callback) {
    process.clusterManager.callClusterMethodRemote('./sessionStore', "sessionStore", methodName, args,
        callback,
        function(e) {
            console.log("Error at call sessionStore." + methodName + ': ' + e);
        }
    );
}

SessionStore.prototype.all = function(callback) {
  //Optional, callback(error, sessions);
  if (this.isLocalStorage()) {
    try {
      let valuesArray = Array.from(this.sessions.values());
      callback(null, valuesArray);
    } catch (error) {
      if (callback) {
        callback(error, null);
      }
    }
  } else {
    this.clusterRemoteCall("all", [], function(result) {
        callback(result[0], result[1]);
    });
  }
}

SessionStore.prototype.destroy = function(sid, callback) {
  //Required, callback(error) once the session is destroyed
  if (this.isLocalStorage()) {
    try {
        //console.log('SessionStore.destroy ' + sid);
        this.removeSid(sid);
        callback(null);
    } catch (error) {
        if (callback) {
            callback(error);
        }
    }
  } else {
    this.clusterRemoteCall("destroy", [sid], function(result) {
        callback(result[0]);
    });
  }
}

SessionStore.prototype.clear = function(callback) {
  //Optional, callback(error) once the store is cleared
  if (this.isLocalStorage()) {
    try {
      //console.log('SessionStore.clear');
      this.sessions.clear();
      this.sessionsQueue.splice(0,this.sessionsQueue.length);
      callback(null);
    } catch (error) {
      if (callback) {
        callback(error);
      }
    }
  } else {
    this.clusterRemoteCall("clear", [], function(result) {
        callback(result[0]);
    });
  }
}

SessionStore.prototype.length = function(callback) {
  //Optional, callback(error, len)
  if (this.isLocalStorage()) {
    try {
      //console.log('SessionStore.length ' + this.sessions.size);
      callback(null, this.sessions.size);
    } catch (error) {
      if (callback) {
        callback(error, null);
      }
    }
  } else {
    this.clusterRemoteCall("length", [], function(result) {
        callback(result[0], result[1]);
    });
  }
}

SessionStore.prototype.get = function(sid, callback) {
  //Required, callback(error, session)
  if (this.isLocalStorage()) {
    try {
      //console.log('SessionStore.get ' + sid);
      var session = this.sessions.get(sid);
      callback(null, session);
    } catch (error) {
      if (callback) {
        callback(error, null);
      }
    }
  } else {
    this.clusterRemoteCall("get", [sid], function(result) {
        callback(result[0], result[1]);
    });
  }
}

SessionStore.prototype.set = function(sid, session, callback) {
  //Required, callback(error)
  if (this.isLocalStorage()) {
    try {
      //console.log('SessionStore.set ' + sid);
      this.addSession(sid, session);
      callback(null);
    } catch (error) {
      if (callback) {
        callback(error);
      }
    }
  } else {
    this.clusterRemoteCall("set", [sid, session], function(result) {
        callback(result[0]);
    });
  }
}

SessionStore.prototype.touch = function(sid, session, callback) {
  //Recommended, callback(error)
  if (this.isLocalStorage()) {
    try {
        //console.log('SessionStore.touch ' + sid);
        this.updateLastTouch(session);
        this.addSession(sid, session);//or just update cookie.maxAge field?
        callback(null);
    } catch (error) {
        if (callback) {
          callback(error);
        }
    }
  } else {
    this.clusterRemoteCall("touch", [sid, session], function(result) {
        callback(result[0]);
    });
  }
}

var sessionStore = new SessionStore();
module.exports.sessionStore = sessionStore;
/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/
