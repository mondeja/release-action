const core = require("@actions/core");
const github = require("@actions/github");
const alphaSort = require("alpha-sort");
const moment = require("moment");
const semverInc = require("semver/functions/inc");

const BASE64 = "base64";
const UTF8 = "utf-8";

const SI_DATA_FILE = "_data/simple-icons.json";
const PACKAGE_FILE = "package.json";
const PACKAGE_LOCK_FILE = "package-lock.json";

const STATUS_ADDED = "added";
const STATUS_MODIFIED = "modified";
const STATUS_REMOVED = "removed";

const CHANGE_TYPE_ADD = "new";
const CHANGE_TYPE_UPDATE = "update";
const CHANGE_TYPE_REMOVED = "removed";
const CHANGE_TYPE_IRRELEVANT = "irrelevant";

const RELEASE_PATCH = "patch";
const RELEASE_MINOR = "minor";
const RELEASE_MAJOR = "major";

const BRANCH_DEVELOP = "develop";
const BRANCH_MASTER = "master";
const REF_DEVELOP = "develop";
const REF_MASTER = "master";

const RELEASE_LABEL = "release";

const COMMIT_MODE_FILE = "100644";
const COMMIT_TYPE_BLOB = "blob";

const SVG_TITLE_EXPR = /<title>(.*) icon<\/title>/;
const JSON_CHANGE_EXPR = /{\s*"title":\s*"(.*)",((?:\s-.*\s.*)|(?:\s.*\s-.*))/g;
const JSON_REMOVE_EXPR = /-\s+"title":\s*"(.*)"/g;


// Helper functions
function encode(data, encoding) {
  if (encoding === BASE64) {
    const dataBuffer = Buffer.from(data, UTF8);
    return dataBuffer.toString(BASE64);
  } else {
    throw Error(`Unknown encoding ${encoding}`);
  }
}

function decode(data, encoding) {
  if (encoding === BASE64) {
    const dataBuffer = Buffer.from(data, BASE64);
    return dataBuffer.toString(UTF8);
  } else {
    throw Error(`Unknown encoding ${encoding}`);
  }
}

function existingFiles(fileInfo) {
  return fileInfo.status === STATUS_ADDED || fileInfo.status === STATUS_MODIFIED;
}

function removedFiles(fileInfo) {
  return fileInfo.status === STATUS_REMOVED;
}

function iconFiles(fileInfo) {
  return isIconFile(fileInfo.filename);
}

function isMerged(pr) {
  return pr.merged_at !== null;
}

function isIconFile(path) {
  return path.startsWith("icons") && path.endsWith(".svg");
}

function isReleasePr(pr) {
  return pr.base.ref === BRANCH_MASTER;
}

function isSimpleIconsDataFile(path) {
  return path === SI_DATA_FILE;
}

function prNumbersToString(prNumbers) {
  return prNumbers.map(prNumber => `#${prNumber}`).join(", ")
}


// GitHub API
async function addLabels(client, issueNumber, labels) {
  await client.issues.addLabels({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    issue_number: issueNumber,
    labels: labels,
  });
}

async function commitFiles(client, commitMessage, files) {
  core.debug("commitFiles - getRef");
  const { data: refData } = await client.git.getRef({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    ref: `heads/${REF_DEVELOP}`,
  });

  core.debug("commitFiles - getCommit");
  const { data: previousCommit } = await client.git.getCommit({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    commit_sha: refData.object.sha,
  });

  core.debug("commitFiles - createBlobs");
  const blobs = []
  for (let file of files) {
    core.debug("commitFiles - encoding");
    const encodedFileData = encode(file.data, BASE64);

    core.debug("commitFiles - createBlob");
    const { data: fileBlob } = await client.git.createBlob({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      content: encodedFileData,
      encoding: BASE64,
    });

    blobs.push({
      mode: COMMIT_MODE_FILE,
      path: file.path,
      sha: fileBlob.sha,
      type: COMMIT_TYPE_BLOB,
    });
  }

  core.debug("commitFiles - createTree");
  const { data: newTree } = await client.git.createTree({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    base_tree: previousCommit.tree.sha,
    tree: blobs,
  });

  core.debug("commitFiles - createCommit");
  const { data: newCommit } = await client.git.createCommit({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    message: commitMessage,
    tree: newTree.sha,
    parents: [previousCommit.sha],
  });

  core.debug("commitFiles - updateRef");
  await client.git.updateRef({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    ref: `heads/${REF_DEVELOP}`,
    sha: newCommit.sha,
  });
}

async function createPullRequest(client, title, body, head, base) {
  const { data } = await client.pulls.create({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    title: title,
    body: body,
    head: head,
    base: base,
  });

  return data.number;
}

const _ghFileCache = {};
async function getPrFile(client, path, ref) {
  if (_ghFileCache[path + ref] === undefined) {
    const fileContents = await client.repos.getContents({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      path: path,
      ref: ref,
    });

    const fileDetails = fileContents.data[0] || fileContents.data;
    _ghFileCache[path + ref] = decode(fileDetails.content, fileDetails.encoding);
  }

  return _ghFileCache[path + ref];
}

async function* getPrFiles(client, prNumber) {
  const { data: files } = await client.pulls.listFiles({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    pull_number: prNumber,
  });

  for (let fileInfo of files.filter(iconFiles).filter(existingFiles)) {
    try {
      yield {
        content: await getPrFile(client, fileInfo.filename, REF_DEVELOP),
        patch: fileInfo.patch,
        path: fileInfo.filename,
        status: fileInfo.status,
      };
    } catch (err) {
      core.warning(`${fileInfo.status} file not found on ${REF_DEVELOP} ('${fileInfo.filename}'): ${err}`);
    }
  }

  for (let fileInfo of files.filter(iconFiles).filter(removedFiles)) {
    try {
      yield {
        content: await getPrFile(client, fileInfo.filename, REF_MASTER),
        patch: fileInfo.patch,
        path: fileInfo.filename,
        status: fileInfo.status,
      };
    } catch (err) {
      core.warning(`removed file not found on ${REF_MASTER} ('${fileInfo.filename}'): ${err}`);
    }
  }

  const dataFile = files.find(file => isSimpleIconsDataFile(file.filename));
  if (dataFile !== undefined) {
    yield {
      content: await getPrFile(client, dataFile.filename, REF_DEVELOP),
      patch: dataFile.patch,
      path: dataFile.filename,
      status: dataFile.status,
    };
  }
}

async function getFilesSinceLastRelease(client) {
  const perPage = 10;

  let files = [], page = 1;
  while (true) {
    const { data: prs } = await client.pulls.list({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      state: "closed",
      sort: "updated",
      direction: "desc",
      per_page: perPage,
      page: page,
    });

    core.info(`on page ${page} there are ${prs.length} PRs`);
    for (let pr of prs) {
      core.info(`processing PR #${pr.number}`);
      if (isMerged(pr) === false) {
        // If the PR is not merged the changes won't be included in this release
        continue;
      }

      if (isReleasePr(pr)) {
        // Previous release, earlier changes definitely already released
        core.info(`found previous release, PR #${pr.number}`);
        return files.filter(file => moment(file.merged_at).isAfter(pr.merged_at));
      }

      for await (let file of getPrFiles(client, pr.number)) {
        core.info(`found '${file.path}' in PR #${pr.number}`);
        file.prNumber = pr.number;
        file.merged_at = pr.merged_at;
        files.push(file);
      }
    }

    if (prs.length < perPage) {
      // No Pull Requests left, break endless loop
      return files;
    }

    page += 1;
  }
}


// Logic determining changes
function getChangesFromFile(file, id) {
  if (isIconFile(file.path) && file.status === STATUS_ADDED) {
    core.info(`Detected an icon was added ('${file.path}')`);

    const svgTitleMatch = file.content.match(SVG_TITLE_EXPR);
    return [{
      id: id,
      changeType: CHANGE_TYPE_ADD,
      name: svgTitleMatch[1],
      path: file.path,
      prNumbers: [file.prNumber],
    }];
  } else if (isIconFile(file.path) && file.status === STATUS_MODIFIED) {
    core.info(`Detected an icon was modified ('${file.path}')`);

    // before and after
    const svgTitleMatch = file.content.match(SVG_TITLE_EXPR);
    return [{
      id: id,
      changeType: CHANGE_TYPE_UPDATE,
      name: svgTitleMatch[1],
      path: file.path,
      prNumbers: [file.prNumber],
    }];
  } else if (isIconFile(file.path) && file.status === STATUS_REMOVED) {
    core.info(`Detected an icon was removed ('${file.path}')`);

    const svgTitleMatch = file.content.match(SVG_TITLE_EXPR) || "FALLBACK";
    return [{
      id: id,
      changeType: CHANGE_TYPE_REMOVED,
      name: svgTitleMatch[1],
      path: file.path,
      prNumbers: [file.prNumber],
    }];
  } else if (isSimpleIconsDataFile(file.path)) {
    core.info(`Detected a change to the data file`);
    const changes = [];

    const sourceChanges = [...file.patch.matchAll(JSON_CHANGE_EXPR)];
    for (let sourceChange of sourceChanges) {
      const name = sourceChange[1];
      changes.push({
        id: id + name,
        changeType: CHANGE_TYPE_UPDATE,
        name: name,
        prNumbers: [file.prNumber],
      });
    }

    const sourceRemovals = [...file.patch.matchAll(JSON_REMOVE_EXPR)];
    for (let sourceRemoval of sourceRemovals) {
      const name = sourceRemoval[1];
      changes.push({
        id: id + name,
        changeType: CHANGE_TYPE_REMOVED,
        name: name,
        prNumbers: [file.prNumber],
      });
    }

    return changes;
  } else {
    core.debug(`Ignoring '${file.path}'`);
    return [{ id: id, changeType: CHANGE_TYPE_IRRELEVANT }];
  }
}

function filterDuplicates(newIcons, updatedIcons, removedIcons) {
  // An added icon was update before the release
  let removeFromUpdated = [];
  for (let newIcon of newIcons) {
    for (let updatedIcon of updatedIcons) {
      if (updatedIcon.name === newIcon.name) {
        newIcon.prNumbers.push(...updatedIcon.prNumbers);
        removeFromUpdated.push(updatedIcon);
      }
    }
  }
  updatedIcons = updatedIcons.filter(a => !removeFromUpdated.some(b => a.id === b.id));

  // An added icon was removed before the release
  let removeFromAdded = [], removeFromRemoved = [];
  for (let newIcon of newIcons) {
    for (let removedIcon of removedIcons) {
      if (removedIcon.name === newIcon.name) {
        removeFromAdded.push(newIcon);
        removeFromRemoved.push(removedIcon);
      }
    }
  }
  newIcons = newIcons.filter(a => !removeFromAdded.some(b => a.id === b.id));
  removedIcons = removedIcons.filter(a => !removeFromRemoved.some(b => a.id === b.id));

  // An updated icon was removed before the release
  removeFromUpdated = [];
  for (let updatedIcon of updatedIcons) {
    for (let removedIcon of removedIcons) {
      if (removedIcon.name === updatedIcon.name) {
        removeFromUpdated.push(updatedIcon);
      }
    }
  }
  updatedIcons = updatedIcons.filter(a => !removeFromUpdated.some(b => a.id === b.id));

  // An updated icon was updated multiple times
  removeFromUpdated = [];
  for (let i = 0; i < updatedIcons.length; i++) {
    for (let j = i; j < updatedIcons.length; j++) {
      const updatedIcon = updatedIcons[i], otherIcon = updatedIcons[j];
      if (otherIcon.id === updatedIcon.id) {
        continue;
      }

      if (otherIcon.name === updatedIcon.name) {
        const otherPrNumbers = otherIcon.prNumbers.filter(prNumber => !updatedIcon.prNumbers.includes(prNumber));
        updatedIcon.prNumbers.push(...otherPrNumbers);
        removeFromUpdated.push(otherIcon);
      }
    }
  }
  updatedIcons = updatedIcons.filter(a => !removeFromUpdated.some(b => a.id === b.id));

  return [newIcons, updatedIcons, removedIcons];
}


// Release logic
async function getNextVersionNumber(client, changes) {
  let releaseType = RELEASE_PATCH;
  if (changes.added.length > 0) {
    releaseType = RELEASE_MINOR;
  }
  if (changes.removed.length > 0) {
    releaseType = RELEASE_MAJOR;
  }

  const packageJsonFile = await getPrFile(client, PACKAGE_FILE, REF_MASTER);
  const packageJson = JSON.parse(packageJsonFile);

  const newVersion = semverInc(packageJson.version, releaseType);
  return newVersion;
}

function createReleaseTitle(newIcons, updatedIcons, removedIcons) {
  let releaseTitle = "Publish";

  if (newIcons.length === 1) {
    releaseTitle += " 1 new icon";
  } else if (newIcons.length > 1) {
    releaseTitle += ` ${newIcons.length} new icons`
  }

  if (updatedIcons.length > 0 && newIcons.length > 0) {
    releaseTitle += " and";
  }

  if (updatedIcons.length === 1) {
    releaseTitle += " 1 updated icon";
  } else if (updatedIcons.length > 1) {
    releaseTitle += ` ${updatedIcons.length} updated icons`
  }

  if (removedIcons.length > 0 && (newIcons.length + updatedIcons.length) > 0) {
    releaseTitle += " and";
  }

  if (removedIcons.length === 1) {
    releaseTitle += " 1 removed icon";
  } else if (removedIcons.length > 1) {
    releaseTitle += ` ${removedIcons.length} removed icons`
  }

  return releaseTitle;
}

function createReleaseNotes(newVersion, newIcons, updatedIcons, removedIcons) {
  const sortAlphabetically = (a, b) => alphaSort.caseInsensitiveAscending(a.name, b.name);

  let releaseHeader = "_this Pull Request was automatically generated_\n\n";
  releaseHeader += `The new version will be: **v${newVersion}**\n`;

  releaseNotes = '';
  if (newIcons.length > 0) {
    releaseNotes += "\n# New Icons\n\n";
    for (let newIcon of newIcons.sort(sortAlphabetically)) {
      const prs = prNumbersToString(newIcon.prNumbers);
      releaseNotes += `- ${newIcon.name} (${prs})\n`;
    }
  }

  if (updatedIcons.length > 0) {
    releaseNotes += "\n# Updated Icons\n\n";
    for (let updatedIcon of updatedIcons.sort(sortAlphabetically)) {
      const prs = prNumbersToString(updatedIcon.prNumbers);
      releaseNotes += `- ${updatedIcon.name} (${prs})\n`;
    }
  }

  if (removedIcons.length > 0) {
    releaseNotes += "\n# Removed Icons\n\n";
    for (let removedIcon of removedIcons.sort(sortAlphabetically)) {
      const prs = prNumbersToString(removedIcon.prNumbers);
      releaseNotes += `- ${removedIcon.name} (${prs})\n`;
    }
  }

  return releaseHeader + releaseNotes;
}

async function createReleasePr(client, title, body) {
  core.info("\n Creating PR for release:");
  core.info("PR title:");
  core.info(`   ${title}`);
  core.debug("\nPR body:");
  core.debug(body);

  const prNumber = await createPullRequest(client, title, body, BRANCH_DEVELOP, BRANCH_MASTER);
  core.info(`\nNew release PR is: ${prNumber}`);

  core.info(`Adding label '${RELEASE_LABEL}' to PR ${prNumber}`);
  await addLabels(client, prNumber, [RELEASE_LABEL]);
  core.info(`Added the '${RELEASE_LABEL}' label to PR ${prNumber}`);
}

async function versionBump(client, newVersion) {
  const packageJsonFile = await getPrFile(client, PACKAGE_FILE, REF_DEVELOP);
  const packageJson = JSON.parse(packageJsonFile);
  if (packageJson.version === newVersion) {
    core.debug(`version in package.json already updated`);
    return;
  }

  core.info(`bumping version in ${PACKAGE_FILE}`);
  packageJson.version = newVersion;
  const updatedPackageJson = JSON.stringify(packageJson, null, 2);

  core.info(`bumping version in ${PACKAGE_LOCK_FILE}`);
  const packageLockJsonFile = await getPrFile(client, PACKAGE_LOCK_FILE, REF_DEVELOP);
  const packageLockJson = JSON.parse(packageLockJsonFile);
  packageLockJson.version = newVersion;
  const updatedPackageLockJson = JSON.stringify(packageLockJson, null, 2);

  core.info("Committing version bump...");
  await commitFiles(client, "version bump", [
    { path: PACKAGE_FILE, data: updatedPackageJson },
    { path: PACKAGE_LOCK_FILE, data: updatedPackageLockJson },
  ]);
  core.info("Version bump committed.");
}

async function getChanges(client) {
  let newIcons = [], updatedIcons = [], removedIcons = [], i = 0;

  const files = await getFilesSinceLastRelease(client);
  for (let file of files) {
    i = i + 1;

    const items = getChangesFromFile(file, i);
    for (let item of items) {
      if (item.changeType === CHANGE_TYPE_ADD) {
        newIcons.push(item);
      } else if (item.changeType === CHANGE_TYPE_UPDATE) {
        updatedIcons.push(item);
      } else if (item.changeType === CHANGE_TYPE_REMOVED) {
        removedIcons.push(item);
      }
    }
  }

  return filterDuplicates(newIcons, updatedIcons, removedIcons);
}

async function makeRelease(client) {
  const [newIcons, updatedIcons, removedIcons] = await getChanges(client);
  if (newIcons.length === 0 && updatedIcons.length === 0 && removedIcons.length === 0) {
    core.info("No notable changes detected");
    return;
  }

  const newVersion = await getNextVersionNumber(client, { added: newIcons, modified: updatedIcons, removed: removedIcons });
  const releaseTitle = createReleaseTitle(newIcons, updatedIcons, removedIcons);
  const releaseNotes = createReleaseNotes(newVersion, newIcons, updatedIcons, removedIcons);

  await createReleasePr(client, releaseTitle, releaseNotes);
  await versionBump(client, newVersion);
}

makeRelease.getChanges = getChanges;
makeRelease.getNextVersionNumber = getNextVersionNumber;
makeRelease.createReleaseTitle = createReleaseTitle;
makeRelease.createReleaseNotes = createReleaseNotes;

module.exports = makeRelease;