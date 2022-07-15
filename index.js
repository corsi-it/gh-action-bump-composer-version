// test
const { execSync, spawn } = require('child_process');
const { existsSync, writeFileSync } = require('fs');
const { EOL } = require('os');
const path = require('path');


// Change working directory if user defined COMPOSERJSON_DIR
if (process.env.COMPOSERJSON_DIR) {
  process.env.GITHUB_WORKSPACE = `${process.env.GITHUB_WORKSPACE}/${process.env.COMPOSERJSON_DIR}`;
  process.chdir(process.env.GITHUB_WORKSPACE);
}

const workspace = process.env.GITHUB_WORKSPACE;

(async () => {
  const pkg = getComposerJson();
  const event = process.env.GITHUB_EVENT_PATH ? require(process.env.GITHUB_EVENT_PATH) : {};

  if (!event.commits) {
    console.log("Couldn't find any commits in this event, incrementing patch version...");
  }

  const tagPrefix = process.env['INPUT_TAG-PREFIX'] || '';
  const messages = event.commits ? event.commits.map((commit) => commit.message + '\n' + commit.body) : [];

  let commitMessage = process.env['INPUT_COMMIT-MESSAGE'] || 'ci: version bump to {{version}}';
  commitMessage += " [skip ci]";
  console.log('commit messages:', messages);

  const bumpPolicy = process.env['INPUT_BUMP-POLICY'] || 'all';
  const commitMessageRegex = new RegExp(commitMessage.replace(/{{version}}/g, `${tagPrefix}\\d+\\.\\d+\\.\\d+`), 'ig');

  let isVersionBump = false;

  if (bumpPolicy === 'all') {
    isVersionBump = messages.find((message) => commitMessageRegex.test(message)) !== undefined;
  } else if (bumpPolicy === 'last-commit') {
    isVersionBump = messages.length > 0 && commitMessageRegex.test(messages[messages.length - 1]);
  } else if (bumpPolicy === 'ignore') {
    console.log('Ignoring any version bumps in commits...');
  } else {
    console.warn(`Unknown bump policy: ${bumpPolicy}`);
  }

  if (isVersionBump) {
    exitSuccess('No action necessary because we found a previous bump!');
    return;
  }

  // input wordings for MAJOR, MINOR, PATCH, PRE-RELEASE
  const majorWords = process.env['INPUT_MAJOR-WORDING'].split(',');
  const minorWords = process.env['INPUT_MINOR-WORDING'].split(',');
  // patch is by default empty, and '' would always be true in the includes(''), thats why we handle it separately
  const patchWords = process.env['INPUT_PATCH-WORDING'] ? process.env['INPUT_PATCH-WORDING'].split(',') : null;
  const preReleaseWords = process.env['INPUT_RC-WORDING'] ? process.env['INPUT_RC-WORDING'].split(',') : null;

  console.log('config words:', { majorWords, minorWords, patchWords, preReleaseWords });

  // get default version bump
  let version = process.env.INPUT_DEFAULT;
  let foundWord = null;
  // get the pre-release prefix specified in action
  let preid = process.env.INPUT_PREID;

  // case: if wording for MAJOR found
  if (
    messages.some(
      (message) => /^([a-zA-Z]+)(\(.+\))?(\!)\:/.test(message) || majorWords.some((word) => message.includes(word)),
    )
  ) {
    version = 'major';
  }
  // case: if wording for MINOR found
  else if (messages.some((message) => minorWords.some((word) => message.includes(word)))) {
    version = 'minor';
  }
  // case: if wording for PATCH found
  else if (patchWords && messages.some((message) => patchWords.some((word) => message.includes(word)))) {
    version = 'patch';
  }
  // case: if wording for PRE-RELEASE found
  else if (
    preReleaseWords &&
    messages.some((message) =>
      preReleaseWords.some((word) => {
        if (message.includes(word)) {
          foundWord = word;
          return true;
        } else {
          return false;
        }
      }),
    )
  ) {
    preid = foundWord.split('-')[1];
    version = 'prerelease';
  }

  console.log('version action after first waterfall:', version);

  // case: if default=prerelease,
  // rc-wording is also set
  // and does not include any of rc-wording
  // then unset it and do not run
  if (
    version === 'prerelease' &&
    preReleaseWords &&
    !messages.some((message) => preReleaseWords.some((word) => message.includes(word)))
  ) {
    version = null;
  }

  // case: if default=prerelease, but rc-wording is NOT set
  if (version === 'prerelease' && preid) {
    version = 'prerelease';
    version = `${version} --preid=${preid}`;
  }

  console.log('version action after final decision:', version);

  // case: if nothing of the above matches
  if (!version) {
    exitSuccess('No version keywords found, skipping bump.');
    return;
  }

  // case: if not [patch, minor, major]
  if (!['patch', 'minor', 'major'].includes(version)) {
    exitSuccess('only patch, minor, major supported so far, skipping bump');
    return;
  }

  // case: if user sets push to false, to skip pushing new tag/composer.json
  const push = process.env['INPUT_PUSH'];
  if (push === 'false' || push === false) {
    exitSuccess('User requested to skip pushing new tag and composer.json. Finished.');
    return;
  }

  // GIT logic
  try {
    const current = pkg.version.toString().trim().replace(/^v/, '');
    // set git user
    await runInWorkspace('git', ['config', 'user.name', `"${process.env.GITHUB_USER || 'Automated Version Bump'}"`]);
    await runInWorkspace('git', [
      'config',
      'user.email',
      `"${process.env.GITHUB_EMAIL || 'gh-action-bump-version@users.noreply.github.com'}"`,
    ]);
    await runInWorkspace('git', ['config', 'pull.rebase', 'false']);

    console.log(process.env.GITHUB_REF)
    let currentBranch = /refs\/[a-zA-Z]+\/(.*)/.exec(process.env.GITHUB_REF)[1];
    let isPullRequest = false;
    if (process.env.GITHUB_HEAD_REF) {
      // Comes from a pull request
      currentBranch = process.env.GITHUB_HEAD_REF;
      isPullRequest = true;
    }
    if (process.env['INPUT_TARGET-BRANCH']) {
      // We want to override the branch that we are pulling / pushing to
      currentBranch = process.env['INPUT_TARGET-BRANCH'];
    }
    console.log('currentBranch:', currentBranch);
    // do it in the current checked out github branch (DETACHED HEAD)
    // important for further usage of the composer.json version
    // await runInWorkspace('npm', ['version', '--allow-same-version=true', '--git-tag-version=false', current]);
    console.log('current:', current, '/', 'version:', version);
    // let newVersion = execSync(`npm version --git-tag-version=false ${version}`).toString().trim().replace(/^v/, '');
    let newVersion = getNextVersion(current, version);
    writeVersionToFile(newVersion, pkg, path)
    newVersion = `${tagPrefix}${newVersion}`;
    if (process.env['INPUT_SKIP-COMMIT'] !== 'true') {
      await runInWorkspace('git', ['commit', '-a', '-m', commitMessage.replace(/{{version}}/g, newVersion)]);
    }

    // now go to the actual branch to perform the same versioning
    if (isPullRequest) {
      // First fetch to get updated local version of branch
      await runInWorkspace('git', ['fetch']);
    }
    await runInWorkspace('git', ['checkout', currentBranch]);
    // await runInWorkspace('npm', ['version', '--allow-same-version=true', '--git-tag-version=false', current]);
    console.log('current:', current, '/', 'version:', version);
    // newVersion = execSync(`npm version --git-tag-version=false ${version}`).toString().trim().replace(/^v/, '');
    newVersion = getNextVersion(current, version);
    writeVersionToFile(newVersion, pkg, path)
    newVersion = `${tagPrefix}${newVersion}`;
    console.log(`::set-output name=newTag::${newVersion}`);
    try {
      // to support "actions/checkout@v1"
      if (process.env['INPUT_SKIP-COMMIT'] !== 'true') {
        await runInWorkspace('git', ['commit', '-a', '-m', commitMessage.replace(/{{version}}/g, newVersion)]);
      }
    } catch (e) {
      console.warn(
        'git commit failed because you are using "actions/checkout@v2"; ' +
          'but that doesnt matter because you dont need that git commit, thats only for "actions/checkout@v1"',
      );
      console.warn(e);
    }

    const remoteRepo = `https://${process.env.GITHUB_ACTOR}:${process.env.GITHUB_TOKEN}@github.com/${process.env.GITHUB_REPOSITORY}.git`;
    if (process.env['INPUT_SKIP-TAG'] !== 'true') {
      console.log('pull+tag');
      await runInWorkspace('git', ['pull', remoteRepo, '--allow-unrelated-histories']);
      await runInWorkspace('git', ['tag', newVersion]);
      if (process.env['INPUT_SKIP-PUSH'] !== 'true') {
        console.log('push');
        await runInWorkspace('git', ['push', remoteRepo, '-f', '--follow-tags']);
        await runInWorkspace('git', ['push', remoteRepo, '-f', '--tags']);
      }
    } else {
      if (process.env['INPUT_SKIP-PUSH'] !== 'true') {
        console.log('skipped tag');
        console.log('pull+push');
        await runInWorkspace('git', ['pull', remoteRepo, '--allow-unrelated-histories']);
        await runInWorkspace('git', ['push', remoteRepo]);
      }
    }
  } catch (e) {
    logError(e);
    exitFailure('Failed to bump version');
    return;
  }
  exitSuccess('Version bumped!');
})();

function getComposerJson() {
  const pathToComposer = path.join(workspace, 'composer.json');
  if (!existsSync(pathToComposer)) throw new Error("composer.json could not be found in your project's root.");
  return require(pathToComposer);
}

function writeVersionToFile(version, pkg, path) {
  const pathToComposer = path.join(workspace, 'composer.json');
  pkg.version = version;
  writeFileSync(pathToComposer, JSON.stringify(pkg, null, '\t'));
}

function exitSuccess(message) {
  console.info(`✔  success   ${message}`);
  process.exit(0);
}

function exitFailure(message) {
  logError(message);
  process.exit(1);
}

function logError(error) {
  console.error(`✖  fatal     ${error.stack || error}`);
}

function runInWorkspace(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: workspace });
    let isDone = false;
    const errorMessages = [];
    child.on('error', (error) => {
      if (!isDone) {
        isDone = true;
        reject(error);
      }
    });
    child.stderr.on('data', (chunk) => errorMessages.push(chunk));
    child.on('exit', (code) => {
      if (!isDone) {
        if (code === 0) {
          resolve();
        } else {
          reject(`${errorMessages.join('')}${EOL}${command} exited with code ${code}`);
        }
      }
    });
  });
  //return execa(command, args, { cwd: workspace });
}

/**
 * Get the next version
 *
 * @param {String} version - The current version
 * @param {String} type - The type of increment (major, minor, patch)
 */
const getNextVersion = (version, type) => {
  if (!version) return '0.0.0';
  const v = version.split('.');
  let nextMajor = parseInt(v[0], 10);
  let nextMinor = parseInt(v[1], 10);
  let nextPatch = parseInt(v[2], 10);
  const bumpType = type ? type.toLowerCase() : '';
  switch (bumpType) {
    case 'major':
      nextMajor += 1;
      nextMinor = 0;
      nextPatch = 0;
      break;
    case 'minor':
      nextMinor += 1;
      nextPatch = 0;
      break;
    case 'patch':
      nextPatch += 1;
      break;
    default:
      throw new Error('Invalid version.');
  }
  return [nextMajor, nextMinor, nextPatch].join('.');
};