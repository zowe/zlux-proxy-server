

/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/

const readline = require('readline');

function Reader() {
  this.readlineReader = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
}
Reader.prototype = {
  constructor: Reader,
  readlineReader: null,

  readPassword(question) {
    return new Promise((resolve, reject) => {

      const stdin = process.openStdin();
      // The below logic only works in hiding the password for non-mingw terminals
      // aka: for when the terminal is in raw mode
      if (process.stdout.isTTY) { 
        stdin.on('data', function(c) {
          c+='';
          switch (c) {
          case '\n':
          case '\r':
            stdin.pause();
            break;
          default:
            readline.clearLine(process.stdout);
          }
        });
        this.readlineReader.question(question + "\n", (answer) => {
          resolve(answer);
          //do not retain the history of the password for future questions
          if (this.readlineReader.history)
          this.readlineReader.history = this.readlineReader.history.slice(1); 
        });
      }
      // The below logic works in hiding the password for mingw terminals where setRawMode() is unavailable
      // and the input is always cooked (for ex: Git Bash only processes input after a line break and has
      // no detection of keypress to mututate chars into '*' for example)
      else {
        let waiting = false;
        process.stdin.on("data", function(data) {
          waiting = true;
        })
        process.stdout.write(question + "\n");
        var i = setInterval(function(){
            readline.cursorTo(process.stdout, 0);
            readline.clearLine(process.stdout);
            if(waiting == true) {
                clearInterval(i);
            }
        }, 0);
        this.readlineReader.question(question, (answer) => {
          resolve(answer);
          //do not retain the history of the password for future questions
          if (this.readlineReader.history)
          this.readlineReader.history = this.readlineReader.history.slice(1); 
        });
      }
    })
  },

  close() {
    this.readlineReader.close();
  }, 
};


module.exports = Reader;


_unitTest = false;
if (_unitTest) {
  const Promise = require('bluebird');
  unitTest = Promise.coroutine(function* (app) {
    let password;
    const r1 = makeReader();
    try {
      password = yield r1.readPassword("Enter password (should not be displayed): ");
      console.log("password is: ", password);
    } finally {
      r1.close();
    }
    const r2 = makeReader();
    try {
      password = yield r2.readPassword("One more time: ");
      console.log("password is: ", password);
    } finally {
      r2.close();
    }
  });
  unitTest();
};



/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/

