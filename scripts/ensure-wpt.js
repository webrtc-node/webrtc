const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const manifest = require("../wpt-manifest.json");

const wptDir = path.resolve(process.env.WPT_DIR || path.join(root, "wpt"));
const wptRepository = process.env.WPT_REPOSITORY || "https://github.com/web-platform-tests/wpt.git";
const wptCommit = process.env.WPT_COMMIT || manifest.wptCommit;
const sparsePaths = ["common", "mediacapture-streams", "resources", "webrtc"];

function runGit(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: options.cwd || root,
    encoding: "utf8",
    stdio: options.stdio || "pipe",
  });
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.trim() : "";
    const stdout = result.stdout ? result.stdout.trim() : "";
    const detail = stderr || stdout || `git exited with status ${result.status}`;
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return (result.stdout || "").trim();
}

function hasWptFiles() {
  return (
    fs.existsSync(path.join(wptDir, "resources", "testharness.js")) &&
    fs.existsSync(path.join(wptDir, "common", "gc.js")) &&
    fs.existsSync(path.join(wptDir, "mediacapture-streams", "permission-helper.js")) &&
    fs.existsSync(path.join(wptDir, "webrtc"))
  );
}

function currentWptCommit() {
  if (!fs.existsSync(path.join(wptDir, ".git"))) return null;
  try {
    return runGit(["rev-parse", "HEAD"], { cwd: wptDir });
  } catch {
    return null;
  }
}

function ensureCleanCheckout() {
  const status = runGit(["status", "--porcelain"], { cwd: wptDir });
  if (status) {
    throw new Error(
      `wpt checkout at ${wptDir} has local changes. ` +
        "Commit, stash, or remove them before changing the pinned WPT checkout.",
    );
  }
}

function checkoutPinnedCommit() {
  runGit(["sparse-checkout", "init", "--cone"], { cwd: wptDir });
  runGit(["sparse-checkout", "set", ...sparsePaths], { cwd: wptDir });
  runGit(["fetch", "--depth", "1", "origin", wptCommit], { cwd: wptDir, stdio: "inherit" });
  runGit(["checkout", "--detach", "FETCH_HEAD"], { cwd: wptDir, stdio: "inherit" });
}

function clonePinnedWpt() {
  fs.mkdirSync(wptDir, { recursive: true });
  runGit(["init"], { cwd: wptDir });
  runGit(["remote", "add", "origin", wptRepository], { cwd: wptDir });
  checkoutPinnedCommit();
}

function ensureWpt(options = {}) {
  const quiet = Boolean(options.quiet);
  if (!wptCommit) throw new Error("wptCommit is missing from wpt-manifest.json");

  if (!fs.existsSync(wptDir)) {
    if (!quiet) console.log(`Fetching WPT ${wptCommit} into ${wptDir}`);
    clonePinnedWpt();
  } else {
    const actualCommit = currentWptCommit();
    if (actualCommit === wptCommit && hasWptFiles()) {
      if (!quiet) console.log(`WPT checkout is pinned at ${wptCommit}`);
      return;
    }

    if (actualCommit === null) {
      if (hasWptFiles()) {
        if (!quiet) {
          console.warn(
            `Using existing non-git WPT tree at ${wptDir}; commit pin cannot be verified.`,
          );
        }
        return;
      }
      throw new Error(`WPT directory exists at ${wptDir}, but it is not a usable git checkout.`);
    }

    ensureCleanCheckout();
    if (!quiet) console.log(`Updating WPT from ${actualCommit} to ${wptCommit}`);
    checkoutPinnedCommit();
  }

  const actualCommit = currentWptCommit();
  if (actualCommit !== wptCommit) {
    throw new Error(`WPT checkout is ${actualCommit || "unknown"}, expected ${wptCommit}`);
  }
  if (!hasWptFiles()) {
    throw new Error(`WPT checkout at ${wptDir} is missing required common/resources/webrtc files.`);
  }
}

if (require.main === module) {
  try {
    ensureWpt();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { ensureWpt };
