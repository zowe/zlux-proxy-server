

/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/

export const constants = {
  ARG_TYPE_FLAG: 1,
  ARG_TYPE_VALUE: 2
};

export function CLIArgument(longName: string, shortName: string, type: any) {
  if (!longName || (type != exports.constants.ARG_TYPE_FLAG && type != exports.constants.ARG_TYPE_VALUE)) {
    console.log("WARNING: CLI Argument missing name ("+longName+") or has unsupported type="+type);
    return null;
  }
  var longMatch = '--'+longName;
  var shortMatch = shortName ? '-'+shortName : null;
  var argName = longName;
  var argType = type;

  var getMatch = function(string, nextString) {
    if (longMatch && string.startsWith(longMatch)) {
      if (argType === exports.constants.ARG_TYPE_FLAG) {
        return {arg: argName, value: true};
      }
      else if (string.length > longMatch.length && (string.charAt(longMatch.length)== '=')) {
        return {arg: argName, value: string.substr(longMatch.length+1)} ;
      }
      else if (string.length == longMatch.length) {
        return {arg: argName, value: nextString};
      }
    }
    else if (shortMatch && string.startsWith(shortMatch)) {
      if (argType === exports.constants.ARG_TYPE_FLAG) {
        return {arg: argName, value: true};
      }
      if (string.length > shortMatch.length && (string.charAt(shortMatch.length)== '=')) {
        return {arg: argName, value: string.substr(shortMatch.length+1)} ;
      }
      else if (string.length == shortMatch.length) {
        return {arg: argName, value: nextString};
      }
    }
    return null;
  };
  return {
    getMatch: getMatch
  };
};
exports.CLIArgument = CLIArgument;

export function ArgumentParser(validArgs: any[], argArray: any[]) {
  var validArguments = validArgs;
  var args = argArray;

  var parse = function(args) {
    var argumentValues = {};
    var arg;
    var validArg;
    for (var i = 0; i < args.length; i++) {
      var found = false;
      arg = args[i];
      for (var j = 0; j < validArguments.length; j++) {
        validArg = validArguments[j];
        if (validArg) {
          var result = validArguments[j].getMatch(arg, (i < (args.length-1)) ? args[i+1] : null);
          if (result && result.arg && result.value) {
            argumentValues[result.arg] = result.value;
            if (result.value == args[i+1]) {
              i++;
            }
            found = true;
            break;
          }
        }
      }
      if (!found) {
        console.log("WARNING: Unrecognized command: "+arg);
      }    
    }
    return argumentValues;
  };
  return {parse: parse};
}
exports.createParser = function(stringArray) {
  return new (ArgumentParser as any)(stringArray);
};


/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/

