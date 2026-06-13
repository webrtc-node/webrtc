"use strict";

const fs = require("node:fs");

const mode = process.argv[2];
const shardIndex = Number(process.env.WPT_SHARD_INDEX);
const results =
  mode === "single" && shardIndex === 0
    ? [{ file: "webrtc/fixture.html", name: "selected subtest", status: "PASS" }]
    : [];

fs.writeFileSync(
  process.env.WPT_WORKER_RESULTS,
  `${JSON.stringify({
    total: results.length,
    pass: results.length,
    fail: 0,
    results,
  })}\n`,
);
