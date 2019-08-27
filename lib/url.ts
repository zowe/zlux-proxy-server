
/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/


export function makePluginURL(productCode: string, pluginID: any) {
  return `/${productCode}/plugins/${pluginID}`;
}

export function makeServiceSubURL(service: any, latest: any, omitVersion: boolean) {
  let nameForURL;
  if (service.type === 'import') {
    nameForURL = service.localName;
  } else {
    nameForURL = service.name;
  }
  if (omitVersion) {
    return `/services/${nameForURL}`;
  } else {
    const version = latest? '_current' : service.version;
    return `/services/${nameForURL}/${version}`;
  }
}

export function join(baseUrl: string, relativePath: string) {
  //TODO a better implementation
  return baseUrl + relativePath;
}


/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/
