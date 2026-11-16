#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = join(repoRoot, "apps", "desktop");

function run(command, args, cwd = repoRoot) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${result.status ?? result.signal}.`);
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: node internal/build-macos.mjs [--arch arm64|x64] [--dir]\n\nBuilds the internal macOS app, validates its packaged runtime and ad-hoc signature,\nthen creates DMG/ZIP files and SHA-256 checksums. --dir stops after .app validation.\nBuild on a Mac with matching architecture and prepared workspace dependencies.\nNo tags, uploads, or releases are created.");
    return;
  }

  let arch = process.arch;
  let directoryOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--dir") {
      directoryOnly = true;
    } else if (args[index] === "--arch" && args[index + 1]) {
      arch = args[++index];
    } else {
      throw new Error(`Unknown argument: ${args[index]}. See --help.`);
    }
  }
  if (process.platform !== "darwin") throw new Error("Build this package on macOS.");
  if (arch !== "arm64" && arch !== "x64") throw new Error("Architecture must be arm64 or x64.");
  if (arch !== process.arch) {
    throw new Error("Build on the target Mac architecture so native helpers are prepared for the correct CPU.");
  }

  run("pnpm", ["--filter", "@open-pets/desktop", "build"]);
  run("pnpm", ["--filter", "@open-pets/opencode", "build:v1"]);
  run("pnpm", ["--filter", "@open-pets/opencode", "build:v2"]);
  run("pnpm", ["exec", "electron-builder", "--mac", `--${arch}`, "--dir", "--publish", "never"], desktopRoot);

  const outputDir = join(desktopRoot, "dist-electron");
  const platformDir = join(outputDir, arch === "arm64" ? "mac-arm64" : "mac");
  const appPath = join(platformDir, "OpenPets Internal.app");
  if (!existsSync(appPath)) throw new Error(`Packaged app is missing: ${appPath}`);
  run(process.execPath, [join(desktopRoot, "dist", "check-packaging-contract.js"), "--output", "--output-dir", platformDir, "--platform", "darwin", "--arch", arch]);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  run(process.execPath, [join(repoRoot, "internal", "validate-macos-runtime.mjs"), appPath]);

  if (!directoryOnly) {
    run("pnpm", ["exec", "electron-builder", "--mac", "dmg", "zip", `--${arch}`, "--prepackaged", appPath, "--publish", "never"], desktopRoot);
    const { version } = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));
    const artifactNames = ["dmg", "zip"].map((extension) => `OpenPets-Internal-${version}-mac-${arch}.${extension}`);
    run("hdiutil", ["verify", join(outputDir, artifactNames[0])]);
    run("unzip", ["-tq", join(outputDir, artifactNames[1])]);
    const checksums = artifactNames.map((name) => {
      const digest = createHash("sha256").update(readFileSync(join(outputDir, name))).digest("hex");
      return `${digest}  ${name}`;
    });
    writeFileSync(join(outputDir, `SHA256SUMS.mac-${arch}.txt`), `${checksums.join("\n")}\n`);
  }
  console.log(`\nValidated macOS ${arch} app: ${appPath}`);
  if (!directoryOnly) console.log(`DMG, ZIP and checksums: ${outputDir}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
