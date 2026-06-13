"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { testIdentity, wptSelectionDigest } = require("./wpt-sharding");

const root = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
const resultsIndex = args.indexOf("--results");
const outputPath =
  outputIndex === -1
    ? path.join(root, "ci-evidence.json")
    : path.resolve(root, args[outputIndex + 1] || "");
const resultsPath =
  resultsIndex === -1
    ? process.env.WPT_RESULTS || path.join(root, "wpt-results.json")
    : path.resolve(root, args[resultsIndex + 1] || "");
const manifestPath = path.join(root, "wpt-manifest.json");

function fail(message) {
  console.error(`CI evidence failed: ${message}`);
  process.exit(1);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`could not read ${file}: ${error.message}`);
  }
}

if (outputIndex !== -1 && !args[outputIndex + 1]) fail("--output requires a path");
if (resultsIndex !== -1 && !args[resultsIndex + 1]) fail("--results requires a path");
if (!fs.existsSync(resultsPath)) fail(`${resultsPath} does not exist`);
if (!fs.existsSync(manifestPath)) fail(`${manifestPath} does not exist`);

const manifest = readJson(manifestPath);
const results = readJson(resultsPath);

if (!Array.isArray(results.results)) fail(`${resultsPath} is not a WPT result artifact`);
if (results.results.length !== results.total) {
  fail(`result length ${results.results.length} does not match total ${results.total}`);
}

const pass = results.results.filter((result) => result.status === "PASS").length;
const failCount = results.results.filter((result) => result.status === "FAIL").length;
const retries = results.results.filter((result) => Number(result.retries) > 0).length;
const identities = results.results.map((result) => testIdentity(result.file, result.name));
const identitySet = new Set(identities);
const selectedSubtestsSha256 = wptSelectionDigest(identitySet);

if (pass !== results.pass) fail(`PASS count ${pass} does not match summary ${results.pass}`);
if (failCount !== results.fail)
  fail(`FAIL count ${failCount} does not match summary ${results.fail}`);
if (identitySet.size !== identities.length) fail("WPT results contain duplicate test identities");
if (manifest.expectedSelectedSubtests && results.total !== manifest.expectedSelectedSubtests) {
  fail(
    `result total ${results.total} does not match manifest ${manifest.expectedSelectedSubtests}`,
  );
}
if (selectedSubtestsSha256 !== manifest.selectedSubtestsSha256) {
  fail(
    `result identity digest ${selectedSubtestsSha256} does not match manifest ${manifest.selectedSubtestsSha256}`,
  );
}
if (results.fail !== 0 || retries !== 0 || pass !== results.total) {
  fail(
    `strict WPT evidence requires all pass and no retries; pass=${pass} total=${results.total} retries=${retries}`,
  );
}

const evidence = {
  generatedAt: new Date().toISOString(),
  source: "write-ci-evidence.js",
  github: {
    actions: process.env.GITHUB_ACTIONS === "true",
    workflow: process.env.GITHUB_WORKFLOW || null,
    job: process.env.GITHUB_JOB || null,
    runId: process.env.GITHUB_RUN_ID || null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
    repository: process.env.GITHUB_REPOSITORY || null,
    ref: process.env.GITHUB_REF || null,
    sha: process.env.GITHUB_SHA || null,
  },
  runner: {
    os: process.env.RUNNER_OS || process.platform,
    arch: process.env.RUNNER_ARCH || process.arch,
    imageOS: process.env.ImageOS || null,
    imageVersion: process.env.ImageVersion || null,
  },
  node: {
    version: process.version,
    napi: process.versions.napi || null,
    modules: process.versions.modules || null,
    platform: process.platform,
    arch: process.arch,
  },
  pins: {
    libdatachannel: manifest.libdatachannelCommit || null,
    wpt: manifest.wptCommit || null,
  },
  wpt: {
    expectedSelectedSubtests: manifest.expectedSelectedSubtests ?? null,
    total: results.total,
    pass,
    fail: failCount,
    retries,
    resultFiles: new Set(results.results.map((result) => result.file)).size,
    selectedSubtestsSha256,
  },
  gates: [
    "npm ci",
    "npm run native:check",
    "npm run build",
    "npm test",
    "npm run api:check",
    "npm run types:check",
    "npm run wpt:ensure",
    "npm run wpt:selection:check",
    "npm run wpt:test:sharded",
    "npm run wpt:check:strict",
    "npm run wpt:report",
  ],
};

fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`CI evidence written to ${path.relative(root, outputPath) || outputPath}`);
