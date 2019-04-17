var path = require('path');
var webpack = require('webpack');


module.exports = {  
  entry: { 
    index: "./src/index.ts"
  },
  target: 'node',
  module: {
    rules: [
      { test: /\.ts(x?)$/, loader: 'ts-loader' }      
      // { test: /\.json$/, loader: 'json-loader' }
    ]
  },
  plugins: [
    new webpack.DefinePlugin({'process.env.NODE_ENV': '"production"'})
    ],
  resolve: {
    extensions: ['.ts', '.js', '.json']
  },
  output: {
    libraryTarget: 'commonjs',
    path: path.join(__dirname, 'libtest'),
    filename: '[name].js'
  },
};