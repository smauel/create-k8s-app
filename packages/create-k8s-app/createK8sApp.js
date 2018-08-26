const chalk = require('chalk');
const commander = require('commander');
const path = require('path');
const fs = require('fs-extra');
const spawn = require('cross-spawn');
const os = require('os');
const semver = require('semver');
const hyperquest = require('hyperquest');
const tmp = require('tmp');
const { unpack } = require('tar-pack');
const ownPackageJson = require('./package.json');

// These files should be allowed to remain on a failed install,
// but then silently removed during the next create.
const errorLogFilePatterns = [
  'npm-debug.log',
];

let projectName;

const program = new commander.Command(ownPackageJson.name)
  .version(ownPackageJson.version)
  .arguments('<project-directory>')
  .usage(`${chalk.green('<project-directory>')} [options]`)
  .action((name) => {
    projectName = name;
  })
  .option('--verbose', 'print additional logs')
  .option(
    '--scripts-version <alternative-package>',
    'use a non-standard version of k8s-scripts',
  )
  .on('--help', () => {
    console.log(`    Only ${chalk.green('<project-directory>')} is required.`);
    console.log();
    console.log(
      `    A custom ${chalk.cyan('--scripts-version')} can be one of:`,
    );
    console.log(`      - a specific npm version: ${chalk.green('0.8.2')}`);
    console.log(`      - a specific npm tag: ${chalk.green('@next')}`);
    console.log(
      `      - a custom fork published on npm: ${chalk.green(
        'my-k8s-scripts',
      )}`,
    );
    console.log(
      `      - a local path relative to the current working directory: ${chalk.green(
        'file:../my-k8s-scripts',
      )}`,
    );
    console.log(
      `      - a .tgz archive: ${chalk.green(
        'https://mysite.com/my-k8s-scripts-0.8.2.tgz',
      )}`,
    );
    console.log(
      `      - a .tar.gz archive: ${chalk.green(
        'https://mysite.com/my-k8s-scripts-0.8.2.tar.gz',
      )}`,
    );
    console.log(
      '    It is not needed unless you specifically want to use a fork.',
    );
    console.log();
  })
  .parse(process.argv);

if (typeof projectName === 'undefined') {
  console.error('Please specify the project directory:');
  console.log(
    `  ${chalk.cyan(program.name())} ${chalk.green('<project-directory>')}`,
  );
  console.log();
  console.log('For example:');
  console.log(`  ${chalk.cyan(program.name())} ${chalk.green('my-k8s-app')}`);
  console.log();
  console.log(
    `Run ${chalk.cyan(`${program.name()} --help`)} to see all options.`,
  );
  process.exit(1);
}

createApp(
  projectName,
  program.verbose,
  program.scriptsVersion,
);

function createApp(name, verbose, version) {
  const root = path.resolve(name);
  const appName = path.basename(root);

  fs.ensureDirSync(name);
  if (!isSafeToCreateProjectIn(root, name)) {
    process.exit(1);
  }

  console.log(`Creating a new Kubernetes app in ${chalk.green(root)}.`);
  console.log();

  const packageJson = {
    name: appName,
    version: '0.1.0',
    private: true,
  };
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(packageJson, null, 2) + os.EOL,
  );

  const originalDirectory = process.cwd();
  process.chdir(root);

  run(root, appName, version, verbose, originalDirectory);
}

// If project only contains valid files, it’s safe.
// Also, if project contains remnant error logs from a previous
// installation, lets remove them now.
function isSafeToCreateProjectIn(root, name) {
  const validFiles = [
    '.DS_Store',
    'Thumbs.db',
    '.git',
    '.gitignore',
    'README.md',
    'LICENSE',
    '.npmignore',
    'docs',
    '.gitlab-ci.yml',
    '.gitattributes',
  ];
  console.log();

  const conflicts = fs
    .readdirSync(root)
    .filter(file => !validFiles.includes(file))
    // Don't treat log files from previous installation as conflicts
    .filter(
      file => !errorLogFilePatterns.some(pattern => file.indexOf(pattern) === 0),
    );

  if (conflicts.length > 0) {
    console.log(
      `The directory ${chalk.green(name)} contains files that could conflict:`,
    );
    console.log();
    for (let i = 0; i < conflicts.length; i += 1) {
      console.log(`  ${conflicts[i]}`);
    }
    console.log();
    console.log(
      'Either try using a new directory name, or remove the files listed above.',
    );

    return false;
  }

  // Remove any remnant files from a previous installation
  const currentFiles = fs.readdirSync(path.join(root));
  currentFiles.forEach((file) => {
    errorLogFilePatterns.forEach((errorLogFilePattern) => {
      // This will catch `npm-debug.log*` files
      if (file.indexOf(errorLogFilePattern) === 0) {
        fs.removeSync(path.join(root, file));
      }
    });
  });

  return true;
}

function run(root, appName, version, verbose, originalDirectory) {
  const packageToInstall = getInstallPackage(version, originalDirectory);
  const allDependencies = [packageToInstall];

  console.log('Installing packages. This might take a couple of minutes.');
  getPackageName(packageToInstall)
    .then(packageName => install(root, allDependencies, verbose)
      .then(() => packageName))
    .then((packageName) => {
      const scriptsPath = path.resolve(
        process.cwd(),
        'node_modules',
        packageName,
        'scripts',
        'init.js',
      );
      /* eslint-disable-next-line global-require, import/no-dynamic-require */
      const init = require(scriptsPath);
      init(root, appName, verbose, originalDirectory);
    })
    .catch((reason) => {
      console.log();
      console.log('Aborting installation.');
      if (reason.command) {
        console.log(`  ${chalk.cyan(reason.command)} has failed.`);
      } else {
        console.log(chalk.red('Unexpected error. Please report it as a bug:'));
        console.log(reason);
      }
      console.log();

      // On 'exit' we will delete these files from target directory.
      const knownGeneratedFiles = ['package.json', 'node_modules'];
      const currentFiles = fs.readdirSync(path.join(root));
      currentFiles.forEach((file) => {
        knownGeneratedFiles.forEach((fileToMatch) => {
        // This remove all of knownGeneratedFiles.
          if (file === fileToMatch) {
            console.log(`Deleting generated file... ${chalk.cyan(file)}`);
            fs.removeSync(path.join(root, file));
          }
        });
      });
      const remainingFiles = fs.readdirSync(path.join(root));
      if (!remainingFiles.length) {
      // Delete target folder if empty
        console.log(
          `Deleting ${chalk.cyan(`${appName}/`)} from ${chalk.cyan(
            path.resolve(root, '..'),
          )}`,
        );
        process.chdir(path.resolve(root, '..'));
        fs.removeSync(path.join(root));
      }
      console.log('Done.');
      process.exit(1);
    });
}

function getInstallPackage(version, originalDirectory) {
  let packageToInstall = 'k8s-scripts';
  const validSemver = semver.valid(version);
  if (validSemver) {
    packageToInstall += `@${validSemver}`;
  } else if (version) {
    if (version[0] === '@' && version.indexOf('/') === -1) {
      packageToInstall += version;
    } else if (version.match(/^file:/)) {
      packageToInstall = `file:${path.resolve(
        originalDirectory,
        version.match(/^file:(.*)?$/)[1],
      )}`;
    } else {
      // for tar.gz or alternative paths
      packageToInstall = version;
    }
  }
  return packageToInstall;
}

// Extract package name from tarball url or path.
function getPackageName(installPackage) {
  if (installPackage.match(/^.+\.(tgz|tar\.gz)$/)) {
    return getTemporaryDirectory()
      .then((obj) => {
        let stream;
        if (/^http/.test(installPackage)) {
          stream = hyperquest(installPackage);
        } else {
          stream = fs.createReadStream(installPackage);
        }
        return extractStream(stream, obj.tmpdir).then(() => obj);
      })
      .then((obj) => {
        /* eslint-disable-next-line global-require, import/no-dynamic-require */
        const packageName = require(path.join(obj.tmpdir, 'package.json')).name;
        obj.cleanup();
        return packageName;
      })
      .catch((err) => {
        // The package name could be with or without semver version,
        // e.g. k8s-scripts-0.2.0-alpha.1.tgz. However, this function
        // returns package name only without semver version.
        console.log(
          `Could not extract the package name from the archive: ${err.message}`,
        );
        const assumedProjectName = installPackage.match(
          /^.+\/(.+?)(?:-\d+.+)?\.(tgz|tar\.gz)$/,
        )[1];
        console.log(
          `Based on the filename, assuming it is "${chalk.cyan(
            assumedProjectName,
          )}"`,
        );
        return Promise.resolve(assumedProjectName);
      });
  } if (installPackage.indexOf('git+') === 0) {
    // Pull package name out of git urls e.g:
    // git+https://github.com/mycompany/k8s-scripts.git
    // git+ssh://github.com/mycompany/k8s-scripts.git#v1.2.3
    return Promise.resolve(installPackage.match(/([^/]+)\.git(#.*)?$/)[1]);
  } if (installPackage.match(/.+@/)) {
    // Do not match @scope/ when stripping off @version or @tag
    return Promise.resolve(
      installPackage.charAt(0) + installPackage.substr(1).split('@')[0],
    );
  } if (installPackage.match(/^file:/)) {
    const installPackagePath = installPackage.match(/^file:(.*)?$/)[1];
    /* eslint-disable-next-line global-require, import/no-dynamic-require */
    const installPackageJson = require(path.join(
      installPackagePath,
      'package.json',
    ));
    return Promise.resolve(installPackageJson.name);
  }
  return Promise.resolve(installPackage);
}

function getTemporaryDirectory() {
  return new Promise((resolve, reject) => {
    // Unsafe cleanup lets us recursively delete the directory if it contains
    // contents; by default it only allows removal if it's empty
    tmp.dir({ unsafeCleanup: true }, (err, tmpdir, callback) => {
      if (err) {
        reject(err);
      } else {
        resolve({
          tmpdir,
          cleanup: () => {
            try {
              callback();
            } catch (ignored) {
              // Callback might throw and fail, since it's a temp directory the
              // OS will clean it up eventually...
            }
          },
        });
      }
    });
  });
}

function extractStream(stream, dest) {
  return new Promise((resolve, reject) => {
    stream.pipe(
      unpack(dest, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve(dest);
        }
      }),
    );
  });
}

function install(root, dependencies, verbose) {
  return new Promise((resolve, reject) => {
    const command = 'npm';
    const args = [
      'install',
      '--save',
      '--save-exact',
      '--loglevel',
      'error',
    ].concat(dependencies);

    if (verbose) {
      args.push('--verbose');
    }

    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('close', (code) => {
      if (code !== 0) {
        /* eslint-disable-next-line prefer-promise-reject-errors */
        reject({
          command: `${command} ${args.join(' ')}`,
        });
        return;
      }
      resolve();
    });
  });
}
