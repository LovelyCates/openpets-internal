#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

function commandOutput(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(`${basename(command)} failed (${result.status ?? result.signal})${detail ? `: ${detail}` : "."}`);
  }
  return result.stdout.trim();
}

function assertInside(root, path, label) {
  const resolvedPath = realpathSync(path);
  const rel = relative(root, resolvedPath);
  const escapesRoot = rel === ".." || rel.startsWith("../") || isAbsolute(rel);
  assert.ok(!escapesRoot, `${label} resolves outside the packaged app: ${path}`);
  return resolvedPath;
}

function assertExecutableArchitecture(path, expectedArchitecture, label) {
  const stat = statSync(path);
  assert.ok(stat.isFile() && stat.size > 0, `${label} is missing or empty: ${path}`);
  accessSync(path, constants.X_OK);
  const architectures = commandOutput("/usr/bin/lipo", ["-archs", path]).split(/\s+/u);
  assert.ok(architectures.includes(expectedArchitecture), `${label} lacks ${expectedArchitecture}; found ${architectures.join(", ")}.`);
  return architectures;
}

// This process is the packaged Electron executable in Node mode. Importing
// get-windows checks its JS dependency graph without calling either window API.
// Running its Swift helper would enumerate real windows even with permission
// prompts disabled, so the helper is checked statically by the parent instead.
const runtimeProbe = String.raw`
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

(async () => {
  assert.ok(process.versions.electron, "The packaged Electron Node runtime did not start.");
  const requirePackaged = createRequire(join(process.argv[1], "package.json"));
  const windows = await import(pathToFileURL(requirePackaged.resolve("get-windows")).href);
  assert.equal(typeof windows.activeWindow, "function");
  assert.equal(typeof windows.openWindows, "function");
  const sharp = requirePackaged("sharp");
  const image = await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).png().toBuffer();
  const metadata = await sharp(image).metadata();
  assert.equal(metadata.format, "png");
  assert.equal(metadata.width, 1);
  assert.equal(metadata.height, 1);
  console.log(JSON.stringify({
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
    sharp: sharp.versions.sharp,
  }));
})().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
`;

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log('Usage: node internal/validate-macos-runtime.mjs "/path/to/OpenPets Internal.app"\n\nChecks the packaged Mac helper\'s executable mode and CPU support, then imports\nget-windows and exercises Sharp through packaged Electron in Node mode.\nThe helper\'s window APIs and the desktop application are not started.');
    return;
  }
  assert.equal(args.length, 1, "Pass exactly one packaged .app path. See --help.");
  assert.equal(process.platform, "darwin", "Validate the package on macOS.");
  assert.ok(process.arch === "arm64" || process.arch === "x64", "Unsupported host architecture.");
  const appPath = realpathSync(resolve(args[0]));
  assert.ok(appPath.endsWith(".app") && statSync(appPath).isDirectory(), "Expected an existing .app directory.");
  const contentsPath = join(appPath, "Contents");
  const infoPath = join(contentsPath, "Info.plist");
  const executableName = commandOutput("/usr/bin/plutil", ["-extract", "CFBundleExecutable", "raw", "-o", "-", infoPath]);
  assert.equal(basename(executableName), executableName, "Invalid CFBundleExecutable path.");
  assert.ok(executableName.length > 0, "CFBundleExecutable is empty.");
  const executablePath = assertInside(appPath, join(contentsPath, "MacOS", executableName), "Electron executable");
  const unpackedPath = assertInside(appPath, join(contentsPath, "Resources", "app.asar.unpacked"), "Unpacked runtime");
  const requirePackaged = createRequire(join(unpackedPath, "package.json"));
  const windowsEntry = assertInside(unpackedPath, requirePackaged.resolve("get-windows"), "get-windows entry");
  assertInside(unpackedPath, requirePackaged.resolve("sharp"), "Sharp entry");
  const windowsRoot = dirname(windowsEntry);
  const windowsPackage = JSON.parse(readFileSync(join(windowsRoot, "package.json"), "utf8"));
  assert.equal(windowsPackage.name, "get-windows");
  const helperPath = assertInside(unpackedPath, join(windowsRoot, "main"), "get-windows helper");
  const expectedArchitecture = process.arch === "x64" ? "x86_64" : "arm64";
  assertExecutableArchitecture(executablePath, expectedArchitecture, "Electron executable");
  const helperArchitectures = assertExecutableArchitecture(helperPath, expectedArchitecture, "get-windows helper");
  const result = JSON.parse(commandOutput(executablePath, ["--eval", runtimeProbe, unpackedPath], {
    cwd: appPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  }));
  assert.equal(result.platform, "darwin");
  assert.equal(result.arch, process.arch);
  console.log(`get-windows ${windowsPackage.version} helper: executable, ${helperArchitectures.join(" + ")} (static validation).`);
  console.log(`Packaged Electron ${result.electron} / Node ${result.node}: get-windows imported; Sharp ${result.sharp} encoded and decoded a 1 × 1 PNG.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
