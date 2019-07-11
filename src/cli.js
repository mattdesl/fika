#!/usr/bin/env node

const fika = require('./fika');
const minimist = require('minimist');
const loudRejection = require('loud-rejection');

module.exports = cli;
async function cli (args = process.argv.slice(2)) {
  loudRejection();
  const opts = minimist(args);
  if (opts._.length === 0) {
    throw new Error(`Expected an input plugin src directory:\n\n  fika src/my-plugin`);
  }
  const result = await fika(opts._[0], opts);
  // assume parcel prints..
  // if (result.urls) {
  //   printLogMessage(result.urls);
  // }
  return result;
}

function printLogMessage (urls) {
  console.log(`\n  Development server bound to:

${urls.map(u => `    ${u}`).join('\n')}

  Enter Ctrl + C in your shell to stop the server.\n`);
}

if (!module.parent) {
  cli();
}
