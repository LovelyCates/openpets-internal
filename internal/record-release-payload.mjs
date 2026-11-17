#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requireDesktop = createRequire(join(repository, "apps", "desktop", "package.json"));
const asar = requireDesktop("@electron/asar");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function git(...args) {
  const result = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || "Git inspection failed.");
  return result.stdout.trim();
}

function lockedSource() {
  const lock = spawnSync("git", ["show", "HEAD:pnpm-lock.yaml"], { cwd: repository });
  if (lock.error) throw lock.error;
  assert.equal(lock.status, 0, "Committed pnpm-lock.yaml is missing.");
  const submodules = {};
  for (const line of git("ls-tree", "-r", "--full-tree", "HEAD").split("\n")) {
    const match = /^160000 commit ([a-f0-9]{40,64})\t(.+)$/u.exec(line);
    if (!match) continue;
    const [, commit, path] = match;
    assert.equal(git("-C", path, "rev-parse", "HEAD"), commit, `Submodule is not at its committed revision: ${path}`);
    submodules[path] = commit;
  }
  return { lockfileSha256: sha256(lock.stdout), submodules };
}

function options() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log("Usage: node internal/record-release-payload.mjs --resources-dir PATH --platform darwin|win32 --arch arm64|x64 --output REPORT.json\n\nReads a packaged app without launching or changing it. Records exact-byte hashes\nof common app/runtime/plugin payloads for cross-platform comparison; native\nbinaries, declarations and source maps are excluded. The explicit output parent\nmust already exist. gitCommit identifies the inspected checkout; invoke directly\nafter its build so this is also the build commit. No signing or GUI claim is made.");
    return null;
  }
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    assert.ok(["--resources-dir", "--platform", "--arch", "--output"].includes(key), `Unknown argument: ${key}`);
    assert.ok(args[index + 1] && !args[index + 1].startsWith("--"), `Missing value for ${key}`);
    assert.equal(parsed[key], undefined, `Repeated argument: ${key}`);
    parsed[key] = args[index + 1];
  }
  assert.ok(parsed["--resources-dir"] && parsed["--output"], "Pass --resources-dir and --output. See --help.");
  assert.ok(["darwin", "win32"].includes(parsed["--platform"]), "Platform must be darwin or win32.");
  assert.ok(["arm64", "x64"].includes(parsed["--arch"]), "Architecture must be arm64 or x64.");
  return {
    resources: resolve(parsed["--resources-dir"]),
    output: resolve(parsed["--output"]),
    platform: parsed["--platform"],
    arch: parsed["--arch"],
  };
}

async function fileHash(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

async function regularFiles(root, prefix = "") {
  const result = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (entry.name === ".DS_Store" || entry.name === "Thumbs.db") continue;
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert.ok(!entry.isSymbolicLink(), `Common payload contains a symbolic link: ${name}`);
    if (entry.isDirectory()) {
      result.push(...await regularFiles(root, name));
    } else {
      assert.ok(entry.isFile(), `Common payload is not a regular file: ${name}`);
      result.push(name);
    }
  }
  return result.sort();
}

function isRuntimeFile(name) {
  return /\.(?:js|cjs|mjs|json)$/u.test(name);
}

async function main() {
  const settings = options();
  if (!settings) return;
  const resources = await realpath(settings.resources);
  const outputParent = await realpath(dirname(settings.output));
  const outputRelative = relative(resources, join(outputParent, basename(settings.output)));
  const outsideResources = outputRelative === ".." || outputRelative.startsWith(`..${sep}`) || isAbsolute(outputRelative);
  assert.ok(outsideResources, "The report must be outside the inspected resources directory.");
  try {
    const outputStat = await lstat(settings.output);
    assert.ok(outputStat.isFile() && !outputStat.isSymbolicLink(), "The output must be a regular JSON file.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const archive = join(resources, "app.asar");
  assert.ok((await lstat(archive)).isFile(), "app.asar is missing.");
  const entries = asar.listPackage(archive, { isPack: false }).map((name) => name.replaceAll("\\", "/").replace(/^\//u, ""));
  const commonFiles = [];
  const add = (path, bytes) => commonFiles.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
  for (const entry of entries) {
    const included = entry.startsWith("assets/")
      || (entry.startsWith("dist/") && !/\.(?:map|ts)$/u.test(entry))
      || /^[^/]+\.cjs$/u.test(entry);
    if (!included) continue;
    const facts = asar.statFile(archive, entry);
    assert.ok(!facts.link, `Common ASAR payload contains a symbolic link: ${entry}`);
    if (facts.files) continue;
    add(`app/${entry}`, asar.extractFile(archive, entry));
  }
  const appPackage = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8"));
  assert.equal(appPackage.name, "@open-pets/desktop", "Unexpected packaged application.");
  assert.equal(typeof appPackage.version, "string", "Packaged version is missing.");
  const sourcePackage = JSON.parse(await readFile(join(repository, "apps", "desktop", "package.json"), "utf8"));
  assert.equal(appPackage.version, sourcePackage.version, "Packaged version differs from the source checkout.");
  const unpackedModules = join(resources, "app.asar.unpacked", "node_modules");
  const workspacePackages = {};
  const scopeRoot = join(unpackedModules, "@open-pets");
  const packageNames = (await readdir(scopeRoot)).map((name) => `@open-pets/${name}`);
  packageNames.push("install-pet");
  for (const packageName of packageNames.sort()) {
    const packageRoot = join(unpackedModules, ...packageName.split("/"));
    const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    assert.equal(metadata.name, packageName, `Unexpected workspace package: ${packageName}`);
    workspacePackages[packageName] = metadata.version;
    for (const entry of await regularFiles(join(packageRoot, "dist"))) {
      if (isRuntimeFile(entry)) add(`workspace/${packageName}/dist/${entry}`, await readFile(join(packageRoot, "dist", entry)));
    }
    if (packageName === "@open-pets/opencode") {
      for (const major of [1, 2]) {
        const entry = `v${major}-package/index.js`;
        add(`workspace/${packageName}/${entry}`, await readFile(join(packageRoot, entry)));
      }
    }
  }
  const pluginsRoot = join(resources, "plugins", "official");
  for (const entry of await regularFiles(pluginsRoot)) {
    add(`plugins/official/${entry}`, await readFile(join(pluginsRoot, entry)));
  }
  commonFiles.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  assert.equal(new Set(commonFiles.map((entry) => entry.path)).size, commonFiles.length, "Duplicate common payload paths.");
  for (const required of [
    "app/dist/pet-preload.cjs",
    "app/dist/pet-installation.js",
    "app/dist/opencode-token-rate.js",
    "app/dist/control-center-pet-management-ipc.js",
    "app/dist/renderer/index.html",
    "workspace/@open-pets/client/dist/index.js",
    "workspace/@open-pets/pet-format/dist/library-metadata.js",
    "workspace/@open-pets/opencode/v1-package/index.js",
    "workspace/@open-pets/opencode/v2-package/index.js",
  ]) {
    assert.ok(commonFiles.some((entry) => entry.path === required), `Required common payload is missing: ${required}`);
  }
  assert.ok(commonFiles.some((entry) => /^app\/dist\/renderer\/assets\/.*\.js$/u.test(entry.path)), "Control Center JS bundle is missing.");
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    gitCommit: git("rev-parse", "--verify", "HEAD"),
    gitDirty: git("status", "--porcelain").length > 0,
    version: appPackage.version,
    platform: settings.platform,
    arch: settings.arch,
    appAsarSha256: await fileHash(archive),
    ...lockedSource(),
    workspacePackages,
    commonPayloadSha256: sha256(Buffer.from(JSON.stringify(commonFiles))),
    commonFiles,
    scope: "Exact bytes of app dist (excluding source maps/declarations), root preloads, assets, workspace dist runtime JS/JSON plus V1/V2 bundles, and bundled official plugins. Native dependencies and executables are excluded; this is not a native runtime, signature, GUI or performance test.",
  };
  await writeFile(settings.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output: settings.output, gitCommit: report.gitCommit, version: report.version, commonFiles: commonFiles.length, commonPayloadSha256: report.commonPayloadSha256 }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
