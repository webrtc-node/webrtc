"use strict";

const crypto = require("node:crypto");

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

function assignWptSpecGroups(groups, shardCount, initialLoads = []) {
  if (!Array.isArray(groups)) {
    throw new Error("WPT spec groups must be an array");
  }
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error("WPT shard count must be a positive integer");
  }
  if (
    !Array.isArray(initialLoads) ||
    initialLoads.length > shardCount ||
    initialLoads.some((load) => !Number.isInteger(load) || load < 0)
  ) {
    throw new Error("WPT initial shard loads must be non-negative integers");
  }

  const loads = Array.from({ length: shardCount }, (_, index) => initialLoads[index] || 0);
  const assignments = new Map();
  const seenKeys = new Set();
  const orderedGroups = groups
    .map((group) => {
      if (
        !group ||
        typeof group.key !== "string" ||
        group.key.length === 0 ||
        !Number.isInteger(group.weight) ||
        group.weight < 0
      ) {
        throw new Error("WPT spec groups require a non-empty key and non-negative weight");
      }
      if (seenKeys.has(group.key)) {
        throw new Error(`duplicate WPT spec group ${group.key}`);
      }
      seenKeys.add(group.key);
      return group;
    })
    .sort((left, right) => right.weight - left.weight || left.key.localeCompare(right.key));

  for (const group of orderedGroups) {
    let target = 0;
    for (let index = 1; index < shardCount; ++index) {
      if (loads[index] < loads[target]) target = index;
    }
    assignments.set(group.key, target);
    loads[target] += group.weight;
  }

  return { assignments, loads };
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

function validateWptSelectionTotal(total, expectedTotal = null) {
  if (!Number.isInteger(total) || total < 0) {
    throw new Error("WPT selected subtest total must be a non-negative integer");
  }
  if (total === 0) {
    throw new Error("WPT run selected no subtests");
  }
  if (expectedTotal !== null && total !== expectedTotal) {
    throw new Error(`WPT run selected ${total} subtests, expected ${expectedTotal}`);
  }
}

function wptSelectionDigest(identities) {
  const sorted = [...identities].sort();
  if (sorted.some((identity) => typeof identity !== "string" || identity.length === 0)) {
    throw new Error("WPT selection identities must be non-empty strings");
  }
  return crypto.createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

module.exports = {
  assignWptSpecGroups,
  mergeWptSummaries,
  shardForTest,
  testIdentity,
  validateWptSelectionTotal,
  wptSelectionDigest,
};
