#!/usr/bin/env node
/**
 * Build a self-contained release archive you can copy to the server (no GitHub, no npm needed there).
 *
 *   node deploy/make-release.mjs                 → release/iran-camping-hub-<version>.tar.gz
 *   node deploy/make-release.mjs --wheels 3.12,3.13,3.14   also bundle Linux Python wheels for ig-bridge (needs pip + internet here)
 *   node deploy/make-release.mjs --node          also bundle Node 22 for linux-x64 (for servers that cannot reach nodejs.org)
 *
 * Works on Windows 10+, macOS and Linux (uses the system `tar`). node_modules are installed with --ignore-scripts so
 * no native build is attempted — the dependencies are pure JavaScript at runtime (ssh2 falls back to its JS crypto).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const flag = (n) => process.argv.includes(`--${n}`);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const sh = (cmd, args, cwd = root) => {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" && cmd.endsWith(".cmd") });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status})`);
};

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const name = `iran-camping-hub-${pkg.version}`;
const outDir = join(root, "release");
const stage = join(outDir, "stage", "iran-camping-hub");
rmSync(join(outDir, "stage"), { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

console.log("1/5 build");
if (!existsSync(join(root, "node_modules"))) sh(npm, ["ci"]);
sh(npm, ["run", "build"]);

console.log("2/5 copy files");
const skip = (p) => /(^|[\\/])(node_modules|\.git|data|\.venv|__pycache__|\.pytest_cache|release|registry)([\\/]|$)/.test(p) || /\.(pyc|sqlite)$/.test(p) || /[\\/]\.env($|\.)/.test(p) && !p.endsWith(".env.example");
for (const f of ["dist", "deploy", "docs", "ig-bridge", "tools", "package.json", "package-lock.json", "agents.example.json", ".env.example", "README.md"]) {
  if (existsSync(join(root, f))) cpSync(join(root, f), join(stage, f), { recursive: true, filter: (src) => !skip(src.slice(root.length)) });
}
writeFileSync(join(stage, "VERSION"), `${pkg.version}\n${new Date().toISOString()}\n`);

console.log("3/5 production dependencies (no scripts)");
sh(npm, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stage);

if (arg("wheels")) {
  console.log("3b/5 Python wheels for linux x86_64");
  mkdirSync(join(stage, "ig-bridge", "wheels"), { recursive: true });
  for (const v of arg("wheels").split(",")) {
    const r = spawnSync("python", ["-m", "pip", "download", "-q", "-r", join(root, "ig-bridge", "requirements.txt"), "-d", join(stage, "ig-bridge", "wheels"), "--platform", "manylinux2014_x86_64", "--platform", "manylinux_2_28_x86_64", "--platform", "any", "--python-version", v, "--only-binary=:all:"], { stdio: "inherit" });
    if (r.status !== 0) console.warn(`  ! wheels for Python ${v} could not be downloaded (continuing)`);
  }
}
if (flag("node")) {
  console.log("3c/5 bundling Node 22 (linux-x64)");
  const base = "https://nodejs.org/dist/latest-v22.x";
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const line = sums.split("\n").find((l) => l.endsWith("linux-x64.tar.xz"));
  const [sum, file] = line.split(/\s+/);
  const buf = Buffer.from(await (await fetch(`${base}/${file}`)).arrayBuffer());
  if (createHash("sha256").update(buf).digest("hex") !== sum) throw new Error("Node checksum mismatch");
  writeFileSync(join(outDir, file), buf);
  mkdirSync(join(stage, "vendor", "node"), { recursive: true });
  execFileSync("tar", ["-xJf", join(outDir, file), "-C", join(stage, "vendor", "node"), "--strip-components=1"]);
}

console.log("4/5 archive");
const archive = join(outDir, `${name}.tar.gz`);
rmSync(archive, { force: true });
execFileSync("tar", ["-czf", archive, "-C", join(outDir, "stage", "iran-camping-hub"), "."]);
rmSync(join(outDir, "stage"), { recursive: true, force: true });

console.log("5/5 checksum");
const hash = createHash("sha256");
await new Promise((res, rej) => createReadStream(archive).on("data", (d) => hash.update(d)).on("end", res).on("error", rej));
const sum = hash.digest("hex");
writeFileSync(`${archive}.sha256`, `${sum}  ${name}.tar.gz\n`);
console.log(`\nRelease: ${archive}\nSize:    ${(statSync(archive).size / 1048576).toFixed(1)} MB\nSHA-256: ${sum}`);
console.log(`\nCopy to the server and install:\n  scp -P <port> ${archive} <user>@<server>:/tmp/\n  ssh -p <port> <user>@<server> 'mkdir -p /tmp/ich && tar -xzf /tmp/${name}.tar.gz -C /tmp/ich && sudo bash /tmp/ich/deploy/install.sh --domain <domain> --vps-local'`);
