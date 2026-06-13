"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const { wptSelectionDigest } = require("./wpt-sharding");

const root = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const artifactsIndex = args.indexOf("--artifacts");
const manifestIndex = args.indexOf("--manifest");
const artifactsRoot =
  artifactsIndex === -1
    ? path.join(root, "ci-artifacts")
    : path.resolve(root, args[artifactsIndex + 1] || "");
const manifestPath =
  manifestIndex === -1
    ? path.join(root, "wpt-manifest.json")
    : path.resolve(root, args[manifestIndex + 1] || "");
const requiredOs = ["Linux", "macOS", "Windows"];
const requiredNodeMajors = [20, 22, 24];
const requiredGithubFields = ["workflow", "job", "runId", "runAttempt", "repository", "ref", "sha"];
const currentGithub = {
  workflow: process.env.GITHUB_WORKFLOW,
  runId: process.env.GITHUB_RUN_ID,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  repository: process.env.GITHUB_REPOSITORY,
  ref: process.env.GITHUB_REF,
  sha: process.env.GITHUB_SHA,
};

function fail(message) {
  console.error(`CI evidence check failed: ${message}`);
  process.exit(1);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`could not read ${file}: ${error.message}`);
  }
}

function walk(dir, matches = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(fullPath, matches);
    else if (entry.isFile() && entry.name === "ci-evidence.json") matches.push(fullPath);
  }
  return matches;
}

function nodeMajor(version) {
  const match = /^v?(\d+)\./.exec(String(version || ""));
  return match ? Number(match[1]) : null;
}

function validateResults(results, key) {
  if (!Array.isArray(results.results)) fail(`${key} WPT result artifact is invalid`);
  if (!Number.isInteger(results.total) || results.total < 1) {
    fail(`${key} WPT total is invalid`);
  }
  if (!Number.isInteger(results.pass) || results.pass < 0) {
    fail(`${key} WPT pass count is invalid`);
  }
  if (!Number.isInteger(results.fail) || results.fail < 0) {
    fail(`${key} WPT fail count is invalid`);
  }
  if (results.results.length !== results.total) fail(`${key} result length mismatch`);
  if (results.total !== manifest.expectedSelectedSubtests) fail(`${key} WPT total mismatch`);

  let pass = 0;
  let failCount = 0;
  let retries = 0;
  const identities = new Set();
  const files = new Set();

  for (const result of results.results) {
    if (
      !result ||
      typeof result.file !== "string" ||
      result.file.length === 0 ||
      typeof result.name !== "string" ||
      result.name.length === 0
    ) {
      fail(`${key} contains an invalid WPT result identity`);
    }

    const identity = `${result.file}\0${result.name}`;
    if (identities.has(identity))
      fail(`${key} contains duplicate WPT result ${result.file}#${result.name}`);
    identities.add(identity);
    files.add(result.file);

    if (result.status === "PASS") pass += 1;
    else if (result.status === "FAIL") failCount += 1;
    else fail(`${key} contains unexpected WPT status ${result.status}`);

    const retryCount = result.retries === undefined ? 0 : result.retries;
    if (!Number.isInteger(retryCount) || retryCount < 0) {
      fail(`${key} contains an invalid retry count for ${result.file}#${result.name}`);
    }
    if (retryCount > 0) retries += 1;
  }

  if (results.pass !== pass) fail(`${key} WPT pass summary mismatch`);
  if (results.fail !== failCount) fail(`${key} WPT fail summary mismatch`);
  if (failCount !== 0 || pass !== results.total || retries !== 0) {
    fail(
      `${key} WPT is not strict-green: pass=${pass} total=${results.total} fail=${failCount} retries=${retries}`,
    );
  }

  const selectedSubtestsSha256 = wptSelectionDigest(identities);
  if (selectedSubtestsSha256 !== manifest.selectedSubtestsSha256) {
    fail(`${key} WPT result identities do not match the manifest digest`);
  }

  return {
    pass,
    failCount,
    retries,
    identities,
    fileCount: files.size,
    selectedSubtestsSha256,
  };
}

function validateGithubEvidence(evidence, key, baseline) {
  if (evidence.source !== "write-ci-evidence.js") fail(`${key} evidence source is invalid`);
  if (evidence.github?.actions !== true) fail(`${key} is not GitHub Actions evidence`);

  for (const field of requiredGithubFields) {
    if (typeof evidence.github[field] !== "string" || evidence.github[field].length === 0) {
      fail(`${key} evidence GitHub ${field} is missing`);
    }
  }

  if (baseline) {
    for (const field of requiredGithubFields) {
      if (evidence.github[field] !== baseline[field]) {
        fail(`${key} evidence GitHub ${field} does not match the matrix run`);
      }
    }
  }

  if (process.env.GITHUB_ACTIONS === "true") {
    for (const [field, expected] of Object.entries(currentGithub)) {
      if (!expected || evidence.github[field] !== expected) {
        fail(`${key} evidence GitHub ${field} does not match the current workflow run`);
      }
    }
  }

  return evidence.github;
}

function sameSet(left, right) {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

if (artifactsIndex !== -1 && !args[artifactsIndex + 1]) fail("--artifacts requires a directory");
if (manifestIndex !== -1 && !args[manifestIndex + 1]) fail("--manifest requires a file");
if (!fs.existsSync(artifactsRoot)) {
  fail(`${artifactsRoot} does not exist; download CI artifacts there or pass --artifacts <dir>`);
}
if (!fs.statSync(artifactsRoot).isDirectory()) fail(`${artifactsRoot} is not a directory`);
if (!fs.existsSync(manifestPath)) fail(`${manifestPath} does not exist`);

const manifest = readJson(manifestPath);
const evidenceFiles = walk(artifactsRoot);
if (!evidenceFiles.length) fail(`no ci-evidence.json files found under ${artifactsRoot}`);

const byMatrix = new Map();
let githubBaseline = null;
let identityBaseline = null;

for (const evidencePath of evidenceFiles) {
  const evidence = readJson(evidencePath);
  const dir = path.dirname(evidencePath);
  const os = evidence.runner?.os;
  const major = nodeMajor(evidence.node?.version);
  const key = `${os}|${major}`;

  if (!requiredOs.includes(os) || !requiredNodeMajors.includes(major)) continue;
  if (byMatrix.has(key)) fail(`duplicate evidence for ${os} Node ${major}`);

  const resultsPath = path.join(dir, "wpt-results.json");
  const reportPath = path.join(dir, "wpt-report.md");
  const artifactManifestPath = path.join(dir, "wpt-manifest.json");
  const manifestTextPath = path.join(dir, "wpt-manifest.txt");

  for (const requiredPath of [resultsPath, reportPath, artifactManifestPath, manifestTextPath]) {
    if (!fs.existsSync(requiredPath)) fail(`${path.relative(root, requiredPath)} is missing`);
  }
  for (const requiredPath of [reportPath, manifestTextPath]) {
    if (fs.statSync(requiredPath).size === 0) {
      fail(`${path.relative(root, requiredPath)} is empty`);
    }
  }

  const artifactManifest = readJson(artifactManifestPath);
  const results = readJson(resultsPath);

  if (!isDeepStrictEqual(artifactManifest, manifest)) {
    fail(`${key} WPT manifest does not match the repository manifest`);
  }

  const validated = validateResults(results, key);
  if (identityBaseline && !sameSet(validated.identities, identityBaseline)) {
    fail(`${key} WPT result identities do not match the matrix run`);
  }
  identityBaseline ??= validated.identities;

  const github = validateGithubEvidence(evidence, key, githubBaseline);
  githubBaseline ??= github;

  if (evidence.pins?.libdatachannel !== manifest.libdatachannelCommit) {
    fail(`${key} evidence libdatachannel pin mismatch`);
  }
  if (evidence.pins?.wpt !== manifest.wptCommit) fail(`${key} evidence WPT pin mismatch`);
  if (
    evidence.wpt?.expectedSelectedSubtests !== manifest.expectedSelectedSubtests ||
    evidence.wpt?.total !== manifest.expectedSelectedSubtests ||
    evidence.wpt?.pass !== validated.pass ||
    evidence.wpt?.fail !== validated.failCount ||
    evidence.wpt?.retries !== validated.retries ||
    evidence.wpt?.resultFiles !== validated.fileCount ||
    evidence.wpt?.selectedSubtestsSha256 !== validated.selectedSubtestsSha256
  ) {
    fail(`${key} evidence WPT summary does not match the result artifact`);
  }

  byMatrix.set(key, { os, major, evidencePath });
}

const missing = [];
for (const os of requiredOs) {
  for (const major of requiredNodeMajors) {
    if (!byMatrix.has(`${os}|${major}`)) missing.push(`${os} Node ${major}`);
  }
}

if (missing.length) fail(`missing matrix evidence: ${missing.join(", ")}`);

console.log(
  `CI evidence verified: ${byMatrix.size}/${requiredOs.length * requiredNodeMajors.length} matrix jobs strict-green`,
);
