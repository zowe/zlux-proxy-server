

/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/

const fs = require('fs');
const util = require('./util');
const Promise = require('bluebird');
const log = global.COM_RS_COMMON_LOGGER.makeComponentLogger("_zsf.json");

function JSONUtils(){

}


function readJSONStringWithComments(contents, filename) {
  var cleanJSON = ""; 
  var pos = 0;
  var done = false;
  while (!done){
    var newlinePos = contents.indexOf('\n',pos);
    var line = "";
    if (newlinePos != -1){
      line = contents.substring(pos,newlinePos);
    } else {
      line = contents.substring(pos);
      done = true;
    }
    // console.log("LINE: "+line);
    let inQuote = false;
    let quoteType;
    let ignoreNext = false;
    let len = line.length - 1;
    let slashSlashPos = -1;
    for (let i =0; i < len; i++) {
      let c = line[i];
      if (c==='"' || c==="'") {
        if (ignoreNext) {
          ignoreNext = false;
          continue;
        }        
        if (!inQuote) {
          inQuote = true;
          quoteType = c;
        } else if (quoteType === c) {
          inQuote = false;
          quoteType = null;
        }
      } else if (inQuote && c === "\\") {
        ignoreNext = true;
      } else if (!inQuote && c === '/') {
        if (line[i+1] === '/') {
          slashSlashPos = i;
          break;
        }
      }
      if (ignoreNext) {
        ignoreNext = false;
      }
    }
    if (slashSlashPos != -1){
      cleanJSON += (line.substring(0,slashSlashPos)+"\n");
    } else {
      cleanJSON += (line+"\n");
    }
    pos = newlinePos+1;
  }
  var parsedJSON = null;
  try {
    parsedJSON = JSON.parse(cleanJSON);
  }
  catch (e) {
    var msg = 'Encountered parse exception while reading '+filename;
    if (log) {
      log.warn('ZWED0028W', filename); //log.warn(msg);
    } else {
      console.log("ZWED0028W - " + msg);
    }
    throw e;
  }
  return parsedJSON;
}

JSONUtils.readJSONFileWithComments = function(filename){
 var fileAsString = fs.readFileSync(filename).toString();  // because readFileSync returns Buffer
  return readJSONStringWithComments(fileAsString, filename);
};

JSONUtils.readJSONFileWithCommentsAsync = function(filename) {
  return new Promise(function(resolve, reject) {
    fs.readFile(filename, function(err, contents) {
      if (err) {
        reject(err);
      } else {
        const fileAsString = contents.toString();
        resolve(readJSONStringWithComments(fileAsString, filename));
      }
    });
  });
}

exports.parseJSONWithComments = function(filename) {
  return JSONUtils.readJSONFileWithComments(filename);
};

exports.readJSONFileWithComments = JSONUtils.readJSONFileWithComments;
exports.readJSONFileWithCommentsAsync = JSONUtils.readJSONFileWithCommentsAsync;
exports.readJSONStringWithComments = readJSONStringWithComments;

/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/

