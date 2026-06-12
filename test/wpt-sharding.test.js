"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { mergeWptSummaries, shardForTest } = require("../scripts/wpt-sharding");

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
