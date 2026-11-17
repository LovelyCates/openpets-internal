#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

function inside(root, target) {
  const path = realpathSync(target);
  const rel = relative(root, path);
  assert.ok(rel !== ".." && !rel.startsWith("..\\") && !isAbsolute(rel), `Packaged path escapes its app: ${target}`);
  return path;
}

function assertWindowsX64Executable(path) {
  const bytes = readFileSync(path);
  assert.ok(bytes.length > 64, `Missing or empty Windows executable: ${path}`);
  assert.equal(bytes.toString("ascii", 0, 2), "MZ", "Expected a Windows PE executable.");
  const peOffset = bytes.readUInt32LE(0x3c);
  assert.ok(peOffset + 6 <= bytes.length, "Truncated PE header.");
  assert.equal(bytes.readUInt32LE(peOffset), 0x00004550, "Invalid PE signature.");
  assert.equal(bytes.readUInt16LE(peOffset + 4), 0x8664, "Expected an x64 PE executable.");
}

// Loading get-windows alone is insufficient: it silently falls back to empty
// functions when its addon is absent. Resolve and load the addon explicitly,
// without enumerating the runner's windows or calling either window API.
const runtimeProbe = String.raw`
const assert = require("node:assert/strict");
const { existsSync } = require("node:fs");
const { createRequire } = require("node:module");
const { dirname, join } = require("node:path");
const { pathToFileURL } = require("node:url");
(async () => {
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "x64");
  assert.ok(process.versions.electron, "Expected the packaged Electron runtime.");
  const requirePackaged = createRequire(join(process.argv[1], "package.json"));
  const windowsEntry = requirePackaged.resolve("get-windows");
  const windows = await import(pathToFileURL(windowsEntry).href);
  assert.equal(typeof windows.activeWindow, "function");
  assert.equal(typeof windows.openWindows, "function");
  const requireWindows = createRequire(windowsEntry);
  const bindingPath = requireWindows("@mapbox/node-pre-gyp").find(join(dirname(windowsEntry), "package.json"));
  assert.ok(existsSync(bindingPath), "The packaged get-windows addon is missing.");
  const addon = requireWindows(bindingPath);
  assert.equal(typeof addon.getActiveWindow, "function");
  assert.equal(typeof addon.getOpenWindows, "function");
  const sharp = requirePackaged("sharp");
  const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.format, "png");
  assert.equal(metadata.width, 1);
  assert.equal(metadata.height, 1);
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, electron: process.versions.electron, node: process.versions.node, sharp: sharp.versions.sharp, nativeWindowAddonLoaded: true }));
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("Usage: node internal/validate-windows-runtime.mjs <packaged-app-directory>\n\nOn Windows x64, checks the packaged PE executable and loads the native window\naddon plus Sharp using that executable in Electron Node mode. No window APIs\nare called and the desktop application is not started.");
    return;
  }
  assert.equal(process.platform, "win32", "Validate this package on Windows.");
  assert.equal(process.arch, "x64", "Validate this package on Windows x64.");
  assert.equal(args.length, 1, "Pass exactly one packaged app directory. See --help.");
  const appPath = realpathSync(resolve(args[0]));
  assert.ok(statSync(appPath).isDirectory(), "Expected an app directory.");
  const executable = inside(appPath, join(appPath, "openpets-internal.exe"));
  const unpacked = inside(appPath, join(appPath, "resources", "app.asar.unpacked"));
  assertWindowsX64Executable(executable);
  const result = spawnSync(executable, ["--eval", runtimeProbe, unpacked], {
    cwd: appPath,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Packaged Windows runtime failed: ${result.stderr || result.stdout}`);
  const facts = JSON.parse(result.stdout.trim());
  assert.equal(facts.nativeWindowAddonLoaded, true);
  console.log(JSON.stringify(facts, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
