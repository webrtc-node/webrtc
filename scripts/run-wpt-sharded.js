"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { mergeWptSummaries, validateWptSelectionTotal } = require("./wpt-sharding");

const root = path.resolve(__dirname, "..");
const manifest = require("../wpt-manifest.json");
const args = process.argv.slice(2);
const shardArgument = args.find((value) => value.startsWith("--shards="));
const selectors = args.filter((value) => !value.startsWith("--shards="));
const shardCount = Number(
  shardArgument?.slice("--shards=".length) || process.env.WPT_SHARD_COUNT || 3,
);
const outputPath = path.resolve(process.env.WPT_RESULTS || path.join(root, "wpt-results.json"));
const runnerPath = path.resolve(
  process.env.WPT_SHARD_RUNNER || path.join(__dirname, "run-wpt-subset.js"),
);
const expectedTotal = process.env.WPT_EXPECTED_TOTAL
  ? Number(process.env.WPT_EXPECTED_TOTAL)
  : selectors.length === 0
    ? manifest.expectedSelectedSubtests
    : null;

function fail(message) {
  console.error(`WPT sharded run failed: ${message}`);
  process.exit(1);
}

if (!Number.isInteger(shardCount) || shardCount < 2) {
  fail("--shards must be an integer greater than one");
}
if (expectedTotal !== null && (!Number.isInteger(expectedTotal) || expectedTotal < 1)) {
  fail("WPT_EXPECTED_TOTAL must be a positive integer");
}

function tempResultsPath(index) {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return path.join(os.tmpdir(), `webrtc-node-wpt-shard-${index}-${unique}.json`);
}

function runShard(index, resultsPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--expose-gc", runnerPath, ...selectors], {
      cwd: root,
      env: {
        ...process.env,
        WPT_LOG_PREFIX: `[shard ${index + 1}/${shardCount}] `,
        WPT_SHARD_COUNT: String(shardCount),
        WPT_SHARD_INDEX: String(index),
        WPT_WORKER_RESULTS: resultsPath,
      },
      stdio: "inherit",
    });

    child.on("error", (error) => resolve({ index, error, code: null, signal: null }));
    child.on("exit", (code, signal) => resolve({ index, error: null, code, signal }));
  });
}

function readShardSummary(resultsPath, outcome) {
  if (!fs.existsSync(resultsPath)) {
    return {
      total: 1,
      pass: 0,
      fail: 1,
      results: [
        {
          file: `wpt-shard-${outcome.index + 1}`,
          name: "shard process",
          status: "FAIL",
          message:
            outcome.error?.message ||
            (outcome.signal
              ? `shard terminated by ${outcome.signal}`
              : `shard exited with status ${outcome.code}`),
        },
      ],
    };
  }

  try {
    const summary = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
    if (
      (outcome.code !== 0 || outcome.signal || outcome.error) &&
      Array.isArray(summary.results) &&
      !summary.results.some((result) => result.status === "FAIL")
    ) {
      summary.results.push({
        file: `wpt-shard-${outcome.index + 1}`,
        name: "shard process",
        status: "FAIL",
        message:
          outcome.error?.message ||
          (outcome.signal
            ? `shard terminated by ${outcome.signal}`
            : `shard exited with status ${outcome.code}`),
      });
      summary.total = summary.results.length;
      summary.fail = summary.results.filter((result) => result.status === "FAIL").length;
    }
    return summary;
  } catch (error) {
    return {
      total: 1,
      pass: 0,
      fail: 1,
      results: [
        {
          file: `wpt-shard-${outcome.index + 1}`,
          name: "shard result artifact",
          status: "FAIL",
          message: error.message,
        },
      ],
    };
  }
}

async function main() {
  const resultPaths = Array.from({ length: shardCount }, (_, index) => tempResultsPath(index));

  try {
    const outcomes = await Promise.all(
      resultPaths.map((resultsPath, index) => runShard(index, resultsPath)),
    );
    let summary;
    try {
      summary = mergeWptSummaries(
        resultPaths.map((resultsPath, index) => readShardSummary(resultsPath, outcomes[index])),
      );
    } catch (error) {
      summary = {
        total: 1,
        pass: 0,
        fail: 1,
        shardCount,
        results: [
          {
            file: "wpt-shards",
            name: "merge result artifacts",
            status: "FAIL",
            message: error.message,
          },
        ],
      };
    }

    fs.writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`WPT shards: ${summary.pass}/${summary.total} passed across ${shardCount} shards`);

    if (summary.fail > 0) process.exitCode = 1;
    try {
      validateWptSelectionTotal(summary.total, expectedTotal);
    } catch (error) {
      console.error(`WPT sharded run failed: ${error.message}`);
      process.exitCode = 1;
    }
  } finally {
    for (const resultsPath of resultPaths) {
      fs.rmSync(resultsPath, { force: true });
    }
  }
}

main().catch((error) => fail(error.message || String(error)));
