"use strict";

const assert = require("node:assert/strict");
const packageJson = require("../package.json");

async function main() {
  const commonJs = require(packageJson.name);
  const esModule = await import(packageJson.name);
  const metadata = require(`${packageJson.name}/package.json`);
  const commonJsExports = Object.keys(commonJs).sort();
  const esModuleExports = Object.keys(esModule)
    .filter((name) => name !== "default")
    .sort();

  assert.deepEqual(esModuleExports, commonJsExports);
  assert.strictEqual(esModule.default, commonJs);
  for (const name of commonJsExports) {
    assert.strictEqual(esModule[name], commonJs[name], `${name} differs between module formats`);
  }
  assert.equal(metadata.name, packageJson.name);
  assert.equal(metadata.version, packageJson.version);

  console.log(
    `Module formats verified: ${commonJsExports.length} shared exports with one runtime identity`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
