"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  assignWptSpecGroups,
  mergeWptSummaries,
  shardForTest,
  validateWptSelectionTotal,
  wptSelectionDigest,
} = require("../scripts/wpt-sharding");

const root = path.resolve(__dirname, "..");
const shardRunner = path.join(__dirname, "fixtures", "wpt-shard-runner.js");

function runSelectionFixture(file, script, selector, expectedTotal) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "webrtc-node-wpt-selection-"));
  try {
    for (const child of ["common", "resources", "webrtc"])
      fs.mkdirSync(path.join(directory, child));
    fs.writeFileSync(path.join(directory, "common", "gc.js"), "");
    fs.writeFileSync(path.join(directory, "resources", "testharness.js"), "");
    fs.writeFileSync(path.join(directory, "webrtc", file), `<script>${script}</script>`);
    const results = path.join(directory, "results.json");
    const child = spawnSync(
      process.execPath,
      [path.join(root, "scripts", "run-wpt-subset.js"), selector],
      {
        cwd: root,
        env: {
          ...process.env,
          WPT_DIR: directory,
          WPT_WORKER_RESULTS: results,
          WPT_IN_PROCESS: "1",
          WPT_CLEANUP_DELAY_MS: "1",
          WPT_EXPECTED_TOTAL: String(expectedTotal),
        },
        encoding: "utf8",
        timeout: 10000,
        windowsHide: true,
      },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stdout + child.stderr);
    return JSON.parse(fs.readFileSync(results, "utf8"));
  } finally {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("webrtc-node-wpt-selection-"));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("bare WPT file targets preserve query variants and media exclusions", () => {
  const summary = runSelectionFixture(
    "RTCConfiguration-iceTransportPolicy.html",
    `
    test(() => assert_true(['?rest', '?interop-2026'].includes(location.search)), 'selected configuration check');
    if (location.search !== '?interop-2026') {
      test(() => assert_unreached('media test must be excluded'), 'iceTransportPolicy relay should prevent candidate gathering');
    }
  `,
    "webrtc/RTCConfiguration-iceTransportPolicy.html",
    2,
  );
  assert.equal(summary.pass, 2);
  assert.deepEqual(summary.results.map(({ file }) => file).sort(), [
    "webrtc/RTCConfiguration-iceTransportPolicy.html?interop-2026",
    "webrtc/RTCConfiguration-iceTransportPolicy.html?rest",
  ]);
});

test("bare WPT file targets retain separate include lists for each selected variant", () => {
  const summary = runSelectionFixture(
    "RTCPeerConnection-operations.https.html",
    `
    test(() => assert_equals(location.search, '?interop-2026'), 'createAnswer uses operations chain');
    test(() => assert_equals(location.search, '?rest'), 'createOffer uses operations chain');
    test(() => assert_unreached('unselected test must not run'), 'replaceTrack uses operations chain');
  `,
    "webrtc/RTCPeerConnection-operations.https.html",
    2,
  );
  assert.equal(summary.pass, 2);
});

test("explicit WPT subtest targets do not include tests with longer matching names", () => {
  const summary = runSelectionFixture(
    "selection.html",
    `
    test(() => {}, 'target');
    test(() => assert_unreached('prefix match must not run'), 'target with a longer name');
  `,
    "webrtc/selection.html#target",
    1,
  );
  assert.equal(summary.pass, 1);
});

test("WPT sandbox initializes the Window message handler for strict-mode tests", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "webrtc-node-wpt-sandbox-"));
  try {
    for (const child of ["common", "resources", "webrtc"]) {
      fs.mkdirSync(path.join(directory, child));
    }
    fs.writeFileSync(path.join(directory, "common", "gc.js"), "");
    fs.writeFileSync(path.join(directory, "resources", "testharness.js"), "");
    fs.writeFileSync(
      path.join(directory, "webrtc", "RTCDataChannel-send.html"),
      `<script>
        'use strict';
        test(() => {
          assert_equals(window.onmessage, null);
          const handler = () => {};
          onmessage = handler;
          assert_equals(window.onmessage, handler);
        }, 'Sending in ondatachannel should work');
      </script>`,
    );
    const results = path.join(directory, "results.json");
    const child = spawnSync(
      process.execPath,
      [
        path.join(root, "scripts", "run-wpt-subset.js"),
        "webrtc/RTCDataChannel-send.html#Sending in ondatachannel should work",
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          WPT_DIR: directory,
          WPT_WORKER_RESULTS: results,
          WPT_IN_PROCESS: "1",
          WPT_CLEANUP_DELAY_MS: "1",
          WPT_EXPECTED_TOTAL: "1",
        },
        encoding: "utf8",
        timeout: 10000,
        windowsHide: true,
      },
    );
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.equal(JSON.parse(fs.readFileSync(results, "utf8")).pass, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function runShardedFixture(mode) {
  const output = path.join(
    os.tmpdir(),
    `webrtc-node-wpt-sharding-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  try {
    return spawnSync(
      process.execPath,
      [path.join(root, "scripts", "run-wpt-sharded.js"), "--shards=3", mode],
      {
        cwd: root,
        env: {
          ...process.env,
          WPT_RESULTS: output,
          WPT_SHARD_RUNNER: shardRunner,
        },
        encoding: "utf8",
      },
    );
  } finally {
    fs.rmSync(output, { force: true });
  }
}

test("WPT shard assignment is deterministic and exhaustive", () => {
  const shardCount = 3;
  const assignments = Array.from({ length: shardCount }, () => 0);

  for (let index = 0; index < 620; ++index) {
    const file = `webrtc/fixture-${index % 23}.html`;
    const name = `selected subtest ${index}`;
    const first = shardForTest(file, name, shardCount);
    const second = shardForTest(file, name, shardCount);
    assert.equal(first, second);
    assert.ok(first >= 0 && first < shardCount);
    assignments[first] += 1;
  }

  assert.equal(
    assignments.reduce((sum, count) => sum + count, 0),
    620,
  );
  assert.ok(Math.max(...assignments) - Math.min(...assignments) < 40);
});

test("WPT spec groups stay intact and are assigned by weight", () => {
  const groups = [
    { key: "dependent-file", weight: 7 },
    { key: "large-file", weight: 12 },
    { key: "small-file-a", weight: 3 },
    { key: "small-file-b", weight: 2 },
  ];
  const first = assignWptSpecGroups(groups, 3, [2, 1, 1]);
  const second = assignWptSpecGroups(groups, 3, [2, 1, 1]);

  assert.deepEqual([...first.assignments], [...second.assignments]);
  assert.equal(first.assignments.size, groups.length);
  assert.ok(first.assignments.has("dependent-file"));
  assert.equal(
    first.loads.reduce((sum, load) => sum + load, 0),
    28,
  );
});

test("WPT shard merger creates one strict result set", () => {
  const merged = mergeWptSummaries([
    {
      total: 2,
      pass: 2,
      fail: 0,
      results: [
        { file: "webrtc/b.html", name: "second", status: "PASS" },
        { file: "webrtc/a.html", name: "first", status: "PASS" },
      ],
    },
    {
      total: 1,
      pass: 1,
      fail: 0,
      results: [{ file: "webrtc/c.html", name: "third", status: "PASS" }],
    },
  ]);

  assert.equal(merged.total, 3);
  assert.equal(merged.pass, 3);
  assert.equal(merged.fail, 0);
  assert.equal(merged.shardCount, 2);
  assert.deepEqual(
    merged.results.map((result) => `${result.file}#${result.name}`),
    ["webrtc/a.html#first", "webrtc/b.html#second", "webrtc/c.html#third"],
  );
});

test("WPT shard merger rejects overlapping results", () => {
  const result = { file: "webrtc/a.html", name: "same", status: "PASS" };
  assert.throws(
    () =>
      mergeWptSummaries([
        { total: 1, pass: 1, fail: 0, results: [result] },
        { total: 1, pass: 1, fail: 0, results: [result] },
      ]),
    /duplicate WPT result/,
  );
});

test("WPT selection validation rejects an empty targeted run", () => {
  assert.throws(() => validateWptSelectionTotal(0), /selected no subtests/);
  assert.doesNotThrow(() => validateWptSelectionTotal(1));
});

test("WPT selection validation enforces an expected total", () => {
  assert.throws(() => validateWptSelectionTotal(3, 4), /selected 3 subtests, expected 4/);
  assert.doesNotThrow(() => validateWptSelectionTotal(4, 4));
});

test("WPT selection digest is deterministic and identity-sensitive", () => {
  const first = wptSelectionDigest(["b\0second", "a\0first"]);
  const second = wptSelectionDigest(["a\0first", "b\0second"]);
  assert.equal(first, second);
  assert.notEqual(first, wptSelectionDigest(["a\0first", "b\0changed"]));
});

test("sharded WPT runner rejects an empty merged selection", () => {
  const result = runShardedFixture("empty");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /selected no subtests/);
});

test("sharded WPT runner permits empty shards when the merged selection is nonempty", () => {
  const result = runShardedFixture("single");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /WPT shards: 1\/1 passed across 3 shards/);
});
