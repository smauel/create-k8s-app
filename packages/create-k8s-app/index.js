#!/usr/bin/env node
/* eslint-disable no-console */
const chalk = require('chalk');

const currentNodeVersion = process.versions.node;
const semver = currentNodeVersion.split('.');
const major = semver[0];

if (major < 8) {
  console.error(
    chalk.red(
      `You are running Node ${
        currentNodeVersion
      }.\n`
        + 'create-k8s-app requires Node 8 or higher. \n'
        + 'Please update your version of Node.',
    ),
  );
  process.exit(1);
}

require('./createK8sApp');
