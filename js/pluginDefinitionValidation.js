
/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/

'use strict';

const zluxUtil = require('./util');
const bootstrapLogger = zluxUtil.loggers.bootstrapLogger;
const fs = require('fs');

// **************************************************************************************************************************************************
// Set up JSON Schema using ajv library

const Ajv = require('ajv')
const ajv = new Ajv({ allErrors: true, jsonPointers: true, verbose: true, $data: true })
require('ajv-errors')(ajv)

const pdSchemaContents = fs.readFileSync(__dirname + "/../lib/schema/pluginDefinitionSchema.json");
const wcSchemaContents = fs.readFileSync(__dirname + "/../lib/schema/webContentSchema.json");
const pluginDefinitionSchema = JSON.parse(pdSchemaContents);
const webContentSchema = JSON.parse(wcSchemaContents);
const validate = ajv.addSchema(webContentSchema).compile(pluginDefinitionSchema);

// **************************************************************************************************************************************************
// Validates the plugin definition based on the json schema defined above
// Uses custom error messages in conjunction with the error messages defined in the schema

module.exports.validatePluginDef = function validatePluginDef(pluginDef) {
    const valid = validate(pluginDef)
    if(pluginDef.apiVersion !== pluginDefinitionSchema.apiVersion){
        bootstrapLogger.warn(`Cannot validate ${pluginDef.identifier}. Key 'apiVersion=${pluginDef.apiVersion} is incompatible with schema version (apiVersion=${pluginDefinitionSchema.apiVersion}).`);
        return false;
    }
    if (!valid) {
        var errorMessage = "Unknown Error Occured";  // Default error message
        if (validate.errors.length > 0) {
            var failedField = ""
            if (validate.errors[0].params.errors) {
                failedField = searchErrors(validate.errors[0].params.errors[0], "keyword")
            }
            else {
                failedField = searchErrors(validate.errors[0], "keyword")
            }
            var message = searchErrors(validate.errors[0], "message")
            const failedData = searchErrors(validate.errors[0], "data")
            var key = replaceSlashes(searchErrors(validate.errors[0], "dataPath"))
            var pluginId = pluginDef.identifier;
            switch (failedField) {
                case "type":
                    errorMessage = `Error validating plugin ${pluginId}. Key "${key}" of value ${JSON.stringify(failedData)} ${message}, is ${typeof (failedData)}`
                    break;
                case "enum":
                    errorMessage = `Error validating plugin ${pluginId}. Key "${key}" is ${failedData}, ${message}`
                    break;
                case "pattern":
                    errorMessage = `Error validating plugin ${pluginId}. Key "${key}" ${message}, is ${failedData}`
                    break;
                case "required":
                    if (validate.errors[0].params.errors) {
                        message = searchErrors(validate.errors[0].params.errors[0], "message")
                    }
                    if (key === "") {
                        key = "Plugin Definition"
                    }
                    errorMessage = `${key} ${message}`
                    break;
            }
        }
        else {
            errorMessage = JSON.stringify(validate.errors)
        }
        bootstrapLogger.warn(errorMessage);
        return false;
        //TODO: Check for warnings and dont throw errors just log the warning (i.e. semantic versioning)
    }
    else {
        bootstrapLogger.info("Plugin Definition Validated")
        return true;
    }
}


// **************************************************************************************************************************************************
// Replaces slashes with dot, and removes the first slash

function replaceSlashes(string) {
    var finalString = ""
    const splitString = string.split("/")
    for (var s in splitString) {
        if (splitString[s] !== "") {
            if (finalString === "") {
                finalString = splitString[s]
            }
            else if (/^\d+$/.test(splitString[s])) {
                finalString = finalString + "[" + splitString[s] + "]"
            }
            else {
                finalString = finalString + "." + splitString[s]
            }
        }
    }
    return finalString
};

// **************************************************************************************************************************************************
// Cycles through layers of validate JSON until a the input property field is found

function searchErrors(obj, search) {
    if (!obj.hasOwnProperty(search)) {
        if (obj.params.errors) {
            return searchErrors(obj.params.errors[0], search)
        }
    }
    else {
        return obj[search]
    }
}


/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/
