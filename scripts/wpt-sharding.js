"use strict";

function testIdentity(file, name) {
  if (typeof file !== "string" || file.length === 0) {
    throw new Error("WPT result file must be a non-empty string");
  }
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("WPT result name must be a non-empty string");
  }
  return `${file}\0${name}`;
}

function shardForTest(file, name, shardCount) {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error("WPT shard count must be a positive integer");
  }

  const identity = testIdentity(file, name);
  let hash = 0x811c9dc5;
  for (let index = 0; index < identity.length; ++index) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % shardCount;
}

function mergeWptSummaries(summaries) {
  if (!Array.isArray(summaries) || summaries.length < 1) {
    throw new Error("at least one WPT shard summary is required");
  }

  const identities = new Set();
  const results = [];

  for (const [index, summary] of summaries.entries()) {
    if (!summary || !Array.isArray(summary.results)) {
      throw new Error(`WPT shard ${index + 1} is not a result artifact`);
    }
    if (summary.results.length !== summary.total) {
      throw new Error(`WPT shard ${index + 1} result length does not match its total`);
    }

    for (const result of summary.results) {
      const identity = testIdentity(result.file, result.name);
      if (identities.has(identity)) {
        throw new Error(`duplicate WPT result ${result.file} :: ${result.name}`);
      }
      identities.add(identity);
      results.push(result);
    }
  }

  results.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.name.localeCompare(right.name) ||
      left.status.localeCompare(right.status),
  );

  return {
    total: results.length,
    pass: results.filter((result) => result.status === "PASS").length,
    fail: results.filter((result) => result.status === "FAIL").length,
    shardCount: summaries.length,
    results,
  };
}

module.exports = {
  mergeWptSummaries,
  shardForTest,
  testIdentity,
};
