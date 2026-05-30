"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
const resultsIndex = args.indexOf("--results");
const expectedTotalIndex = args.indexOf("--expected-total");
const outputPath =
  outputIndex === -1
    ? path.join(root, "wpt-report.md")
    : path.resolve(root, args[outputIndex + 1] || "");
const resultsPath =
  resultsIndex === -1
    ? process.env.WPT_RESULTS || path.join(root, "wpt-results.json")
    : path.resolve(root, args[resultsIndex + 1] || "");
const manifestPath = path.join(root, "wpt-manifest.json");

function fail(message) {
  console.error(`WPT report failed: ${message}`);
  process.exit(1);
}

if (outputIndex !== -1 && !args[outputIndex + 1]) fail("--output requires a path");
if (resultsIndex !== -1 && !args[resultsIndex + 1]) fail("--results requires a path");
if (expectedTotalIndex !== -1 && !args[expectedTotalIndex + 1]) {
  fail("--expected-total requires a positive integer");
}
if (!fs.existsSync(resultsPath)) fail(`${resultsPath} does not exist`);
if (!fs.existsSync(manifestPath)) fail(`${manifestPath} does not exist`);

const results = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const expectedTotal = process.env.WPT_EXPECTED_TOTAL
  ? Number(process.env.WPT_EXPECTED_TOTAL)
  : expectedTotalIndex === -1
    ? (manifest.expectedSelectedSubtests ?? null)
    : Number(args[expectedTotalIndex + 1]);

if (!Array.isArray(results.results)) fail(`${resultsPath} is not a WPT result artifact`);
if (!Number.isInteger(results.total)) fail("WPT result total is missing");
if (results.results.length !== results.total) {
  fail(`result length ${results.results.length} does not match total ${results.total}`);
}
if (expectedTotal !== null) {
  if (!Number.isInteger(expectedTotal) || expectedTotal < 1) {
    fail("expected total must be a positive integer");
  }
  if (results.total !== expectedTotal) {
    fail(`result total ${results.total} does not match expected total ${expectedTotal}`);
  }
}

const pass = results.results.filter((result) => result.status === "PASS").length;
const failCount = results.results.filter((result) => result.status === "FAIL").length;
const retried = results.results.filter((result) => Number(result.retries) > 0);
const files = new Set(results.results.map((result) => result.file));
const generatedAt = new Date().toISOString();

if (pass !== results.pass) fail(`PASS count ${pass} does not match summary ${results.pass}`);
if (failCount !== results.fail)
  fail(`FAIL count ${failCount} does not match summary ${results.fail}`);

const lines = [];
lines.push("# WPT Conformance Report");
lines.push("");
lines.push(`Generated: ${generatedAt}`);
lines.push("");
lines.push("## Summary");
lines.push("");
lines.push("| Metric | Value |");
lines.push("| --- | ---: |");
lines.push(`| Selected subtests | ${results.total} |`);
lines.push(`| Passing subtests | ${pass} |`);
lines.push(`| Failing subtests | ${failCount} |`);
lines.push(`| Retried subtests | ${retried.length} |`);
lines.push(`| Result files | ${files.size} |`);
lines.push(`| Expected subtests | ${expectedTotal ?? "n/a"} |`);
lines.push("");
lines.push("## Pins");
lines.push("");
lines.push("| Dependency | Commit |");
lines.push("| --- | --- |");
lines.push(`| libdatachannel | \`${manifest.libdatachannelCommit || "n/a"}\` |`);
lines.push(`| web-platform-tests | \`${manifest.wptCommit || "n/a"}\` |`);
lines.push("");
lines.push("## Manifest Groups");
lines.push("");
lines.push("| Group | Entries |");
lines.push("| --- | ---: |");
for (const [group, entries] of Object.entries(manifest)) {
  if (Array.isArray(entries)) lines.push(`| ${group} | ${entries.length} |`);
}
lines.push("");

if (failCount > 0) {
  lines.push("## Failures");
  lines.push("");
  for (const result of results.results.filter((entry) => entry.status === "FAIL")) {
    lines.push(`- ${result.file} :: ${result.name}${result.message ? ` - ${result.message}` : ""}`);
  }
  lines.push("");
}

if (retried.length > 0) {
  lines.push("## Retries");
  lines.push("");
  for (const result of retried) {
    lines.push(`- ${result.file} :: ${result.name} (${result.retries})`);
    if (Array.isArray(result.retryAttempts)) {
      for (const [index, attempt] of result.retryAttempts.entries()) {
        const reason =
          attempt.output ||
          attempt.error ||
          attempt.failures
            ?.map((failure) => failure.message)
            .filter(Boolean)
            .join("; ") ||
          `exitCode=${attempt.exitCode ?? "null"} signal=${attempt.signal ?? "null"}`;
        lines.push(`  - attempt ${index + 1}: ${String(reason).split(/\r?\n/)[0]}`);
      }
    }
  }
  lines.push("");
}

lines.push("## Expected-Pass Selection");
lines.push("");
for (const entry of manifest.expectedPass || []) {
  lines.push(`- ${entry}`);
}
lines.push("");

const report = `${lines.join("\n")}\n`;
fs.writeFileSync(outputPath, report);

if (process.env.GITHUB_STEP_SUMMARY && process.env.WPT_REPORT_STEP_SUMMARY !== "0") {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
}

console.log(`WPT report written to ${path.relative(root, outputPath) || outputPath}`);
