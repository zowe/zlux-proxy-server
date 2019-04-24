

/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/

const crypto = require("crypto");

export function encryptWithKey(text: string, key: any) {
  var cipher = crypto.createCipher('AES-256-CTR',key);
  var encrypted = cipher.update(text,'utf8','hex');
  encrypted += cipher.final('hex');
  return encrypted;
}

export function getKeyFromPassword(password: any, salt: any, length: any, callback: any) {
  var rounds = 500;
  crypto.pbkdf2(password,salt,rounds,length,'sha256',(error: any, derivedKey: any) => {
    if (error) {
      throw error;
    }
    else {
      callback(derivedKey);
    }
  });
}

export function encryptWithKeyAndIV(text: string,key: any,iv: any) {
  var cipher = crypto.createCipheriv('AES-256-CBC',key,iv);
  var encrypted = cipher.update(text,'utf8','hex');
  encrypted += cipher.final('hex');
  return encrypted;
}

export function decryptWithKey(text: string,key: any) {
  var decipher = crypto.createDecipher('AES-256-CTR',key);
  var decrypted = decipher.update(text,'hex','utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export function decryptWithKeyAndIV(text: string,key: any,iv: any) {
  var cipher = crypto.createDecipheriv('AES-256-CBC',key,iv);
  var decrypted = cipher.update(text,'hex','utf8');
  decrypted += cipher.final('utf8');
  return decrypted;
}


/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/

