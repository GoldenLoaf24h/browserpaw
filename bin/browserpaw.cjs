#!/usr/bin/env node

const path = require('node:path');
const { runBrowserCli } = require('../app/native-server/src/cli-client.cjs');

void runBrowserCli(process.argv.slice(2), {
  nativeCli: path.resolve(__dirname, '../app/native-server/dist/cli.js'),
});
