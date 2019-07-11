#!/usr/bin/env node

const fika = require('./fika');
const minimist = require('minimist');
const loudRejection = require('loud-rejection');
const logger = require('@parcel/logger');

module.exports = cli;
async function cli (args = process.argv.slice(2)) {
  const opts = minimist(args);
  loudRejection();

  if (opts._.length === 0) {
    throw new Error(`Expected an input plugin src directory:\n\n  fika src/my-plugin`);
  }

  const result = await fika(opts._[0], opts);
  return result;
}

if (!module.parent) {
  (async () => {
    try {
      await cli();
    } catch (err) {
      logger.error(err);
    }
  })();
}
