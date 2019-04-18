

/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/

export const UNP_EXIT_TERMINATED = 1;
export const UNP_EXIT_AUTH_ERROR = 2;
export const UNP_EXIT_PFX_READ_ERROR = 3;
export const UNP_EXIT_HTTPS_LOAD_ERROR = 4;
export const UNP_EXIT_NO_PLUGINS = 5;
export const UNP_EXIT_UNCAUGHT_ERROR = 6;

export const WEBSOCKET_CLOSE_INTERNAL_ERROR = 4999;
export const WEBSOCKET_CLOSE_BY_PROXY = 4998;
export const WEBSOCKET_CLOSE_CODE_MINIMUM = 3000;

export const APP_NAME = "zlux"; //this seems to be pretty "variable"

export function setProductCode(productCode: any) {
  exports.APP_NAME = productCode.toLowerCase();
}

exports.HTTPS_DEFAULT_CIPHERS = [
  'AES128-GCM-SHA256',
  'AES128-SHA256',
  'AES256-GCM-SHA384',
  'AES256-SHA256',
  'DHE-RSA-AES128-GCM-SHA256',
  'DHE-RSA-AES128-SHA256',
  'DHE-RSA-AES256-GCM-SHA384',
  'DHE-RSA-AES256-SHA256',
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES128-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-AES256-SHA384',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-SHA256',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-SHA384'
];

/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/

