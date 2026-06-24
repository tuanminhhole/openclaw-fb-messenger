#!/usr/bin/env node
/**
 * update / release — one command to ship fb-messenger.
 *   bump version → typecheck → build → test → git commit/tag/push → clawhub publish
 *
 * Usage:
 *   node scripts/update.mjs                 # patch bump
 *   node scripts/update.mjs minor|major|<x.y.z>
 *   node scripts/update.mjs --no-git        # skip git push
 *   node scripts/update.mjs --no-clawhub    # skip clawhub publish
 *   node scripts/update.mjs --dry           # show steps, change nothing
 *
 * @author tuanminhhole
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const DRY = flag("--dry");
const SKIP_GIT = flag("--no-git");
const SKIP_CLAWHUB = flag("--no-clawhub");
const bumpArg = args.find((a) => !a.startsWith("--")) || "patch";

const CLAWHUB_SPEC = "tuanminhhole/fb-messenger";

function sh(cmd, opts = {}) {
  console.log(`\x1b[36m$ ${cmd}\x1b[0m`);
  if (DRY) return "";
  return execSync(cmd, { cwd: ROOT, stdio: "inherit", ...opts });
}
function shOut(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: "utf8" }).trim();
}
function nextVersion(cur, kind) {
  if (/^\d+\.\d+\.\d+/.test(kind)) return kind;
  const [a, b, c] = cur.split(".").map((n) => parseInt(n, 10));
  if (kind === "major") return `${a + 1}.0.0`;
  if (kind === "minor") return `${a}.${b + 1}.0`;
  return `${a}.${b}.${c + 1}`;
}

const pkgPath = join(ROOT, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const from = pkg.version;
const to = nextVersion(from, bumpArg);
console.log(`\n📦 fb-messenger  ${from} → \x1b[32m${to}\x1b[0m${DRY ? "  (dry-run)" : ""}\n`);

// 1) verify
sh("npm run typecheck");
sh("npm run build");
sh("npm test");

// 2) bump version
if (!DRY) {
  pkg.version = to;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`✔ bumped package.json → ${to}`);
}

// 3) git commit + tag + push
if (!SKIP_GIT) {
  try {
    sh("git add -A");
    sh(`git commit -m "release: v${to}"`);
    sh(`git tag v${to}`);
    sh("git push");
    sh("git push --tags");
  } catch (e) {
    console.error("\x1b[33m⚠ git step failed (configure git/remote, then re-run with --no-clawhub if needed)\x1b[0m");
    throw e;
  }
} else {
  console.log("↷ skipped git");
}

// 4) clawhub publish
if (!SKIP_CLAWHUB) {
  let hasClawhub = true;
  try { shOut("clawhub --version"); } catch { hasClawhub = false; }
  const cli = hasClawhub ? "clawhub" : "npx -y clawhub";
  sh(`${cli} package publish ${CLAWHUB_SPEC} --dry-run`);
  if (!DRY) sh(`${cli} package publish ${CLAWHUB_SPEC}`);
} else {
  console.log("↷ skipped clawhub");
}

console.log(`\n✅ Done. fb-messenger v${to}\n`);
