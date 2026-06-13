const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { testIdentity, wptSelectionDigest } = require("../scripts/wpt-sharding");

const root = path.resolve(__dirname, "..");
const repositoryManifest = JSON.parse(
  fs.readFileSync(path.join(root, "wpt-manifest.json"), "utf8"),
);
const requiredOs = ["Linux", "macOS", "Windows"];
const requiredNodeMajors = [20, 22, 24];
const github = {
  actions: true,
  workflow: "Conformance",
  job: "wpt-full",
  runId: "123456",
  runAttempt: "1",
  repository: "mertushka/webrtc-node",
  ref: "refs/heads/main",
  sha: "0123456789abcdef0123456789abcdef01234567",
};
const selectedResults = Array.from({ length: 4 }, (_, index) => ({
  file: "webrtc/fixture.html",
  name: `fixture ${index + 1}`,
  status: "PASS",
  retries: 0,
}));
const selectedSubtestsSha256 = wptSelectionDigest(
  selectedResults.map((result) => testIdentity(result.file, result.name)),
);
const manifest = {
  ...repositoryManifest,
  expectedSelectedSubtests: selectedResults.length,
  selectedSubtestsSha256,
};

function makeResults() {
  const results = selectedResults.map((result) => ({ ...result }));
  return {
    total: results.length,
    pass: results.length,
    fail: 0,
    results,
  };
}

function makeEvidence(osName, nodeMajor, results) {
  return {
    source: "write-ci-evidence.js",
    github: { ...github },
    runner: {
      os: osName,
      arch: "X64",
    },
    node: {
      version: `v${nodeMajor}.0.0`,
    },
    pins: {
      libdatachannel: manifest.libdatachannelCommit,
      wpt: manifest.wptCommit,
    },
    wpt: {
      expectedSelectedSubtests: manifest.expectedSelectedSubtests,
      total: results.total,
      pass: results.pass,
      fail: results.fail,
      retries: 0,
      resultFiles: new Set(results.results.map((result) => result.file)).size,
      selectedSubtestsSha256,
    },
  };
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeMatrixArtifact(artifactsRoot, osName, nodeMajor, mutate = () => {}) {
  const results = makeResults();
  const evidence = makeEvidence(osName, nodeMajor, results);
  mutate({ results, evidence });
  const artifactDir = path.join(artifactsRoot, `wpt-manifest-${osName}-node-${nodeMajor}`);
  fs.mkdirSync(artifactDir, { recursive: true });
  writeJson(path.join(artifactDir, "ci-evidence.json"), evidence);
  writeJson(path.join(artifactDir, "wpt-results.json"), results);
  writeJson(path.join(artifactDir, "wpt-manifest.json"), manifest);
  fs.writeFileSync(path.join(artifactDir, "wpt-report.md"), "# WPT Conformance Report\n");
  fs.writeFileSync(path.join(artifactDir, "wpt-manifest.txt"), "fixture manifest\n");
}

function runEvidenceCheck(artifactsRoot) {
  return spawnSync(
    process.execPath,
    [
      path.join("scripts", "check-ci-evidence.js"),
      "--artifacts",
      artifactsRoot,
      "--manifest",
      path.join(artifactsRoot, "expected-wpt-manifest.json"),
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_ACTIONS: "false",
      },
    },
  );
}

function withTempArtifacts(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "webrtc-node-ci-evidence-"));
  try {
    writeJson(path.join(dir, "expected-wpt-manifest.json"), manifest);
    return callback(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeCompleteMatrix(artifactsRoot, mutateByKey = new Map()) {
  for (const osName of requiredOs) {
    for (const nodeMajor of requiredNodeMajors) {
      writeMatrixArtifact(
        artifactsRoot,
        osName,
        nodeMajor,
        mutateByKey.get(`${osName}|${nodeMajor}`),
      );
    }
  }
}

test("CI evidence verifier accepts a complete strict-green matrix", () => {
  withTempArtifacts((artifactsRoot) => {
    writeCompleteMatrix(artifactsRoot);

    const result = runEvidenceCheck(artifactsRoot);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /9\/9 matrix jobs strict-green/);
  });
});

test("CI evidence verifier rejects forged strict-green result summaries", () => {
  withTempArtifacts((artifactsRoot) => {
    writeCompleteMatrix(
      artifactsRoot,
      new Map([
        [
          "Linux|20",
          ({ results }) => {
            results.results[0].status = "FAIL";
          },
        ],
      ]),
    );

    const result = runEvidenceCheck(artifactsRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /WPT pass summary mismatch/);
  });
});

test("CI evidence verifier rejects duplicate WPT result identities", () => {
  withTempArtifacts((artifactsRoot) => {
    writeCompleteMatrix(
      artifactsRoot,
      new Map([
        [
          "Linux|20",
          ({ results }) => {
            results.results[1] = { ...results.results[0] };
          },
        ],
      ]),
    );

    const result = runEvidenceCheck(artifactsRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /contains duplicate WPT result/);
  });
});

test("CI evidence verifier rejects inconsistent matrix result identities", () => {
  withTempArtifacts((artifactsRoot) => {
    writeCompleteMatrix(
      artifactsRoot,
      new Map([
        [
          "Windows|24",
          ({ results }) => {
            results.results[0].name = "different selected subtest";
          },
        ],
      ]),
    );

    const result = runEvidenceCheck(artifactsRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /WPT result identities do not match the manifest digest/);
  });
});

test("CI evidence verifier rejects artifacts from different workflow runs", () => {
  withTempArtifacts((artifactsRoot) => {
    writeCompleteMatrix(
      artifactsRoot,
      new Map([
        [
          "macOS|22",
          ({ evidence }) => {
            evidence.github.runId = "different-run";
          },
        ],
      ]),
    );

    const result = runEvidenceCheck(artifactsRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /GitHub runId does not match the matrix run/);
  });
});

test("CI evidence verifier rejects missing GitHub provenance", () => {
  withTempArtifacts((artifactsRoot) => {
    writeCompleteMatrix(
      artifactsRoot,
      new Map([
        [
          "Linux|24",
          ({ evidence }) => {
            evidence.github = null;
          },
        ],
      ]),
    );

    const result = runEvidenceCheck(artifactsRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /is not GitHub Actions evidence/);
  });
});

test("CI evidence verifier rejects empty required reports", () => {
  withTempArtifacts((artifactsRoot) => {
    writeCompleteMatrix(artifactsRoot);
    fs.writeFileSync(path.join(artifactsRoot, "wpt-manifest-Linux-node-20", "wpt-report.md"), "");

    const result = runEvidenceCheck(artifactsRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /wpt-report\.md is empty/);
  });
});

test("CI evidence verifier rejects missing matrix jobs", () => {
  withTempArtifacts((artifactsRoot) => {
    for (const osName of requiredOs) {
      for (const nodeMajor of requiredNodeMajors) {
        if (osName === "Windows" && nodeMajor === 24) continue;
        writeMatrixArtifact(artifactsRoot, osName, nodeMajor);
      }
    }

    const result = runEvidenceCheck(artifactsRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing matrix evidence: Windows Node 24/);
  });
});
