const { createHash } = require("node:crypto");
const { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require("node:fs");
const { homedir, tmpdir } = require("node:os");
const { basename, dirname, join, resolve } = require("node:path");

if (process.platform !== "win32") process.exit(0);

// app-builder-bin 5.0.0-alpha.12 uses the legacy winCodeSign cache for native
// Windows rcedit, even when electron-builder's newer toolset is configured.
const requiredTools = new Map([
  ["rcedit-x64.exe", "ab53500d556fd824636621bca7dbecd8583ba181891c3e9efdcf16b72a28b0cd"],
  ["rcedit-ia32.exe", "8d7f9e4cdbffadf53806ea0646a6cf5a67244f16dda3cabb7b3f00dc0cddb552"],
  ["windows-10/x64/signtool.exe", "e472ab54601f9da46915a68da4d93b6d6cc61502e6bf18d5a53c0a70176119a4"],
  ["windows-10/ia32/signtool.exe", "a13bfd50668b2acb91b0334d36dce7e04d6fc2e3a122f9c9c145d3659fd0cd84"],
]);
const cacheRoot = resolve(process.env.ELECTRON_BUILDER_CACHE || join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "electron-builder", "Cache"));
const toolDir = join(cacheRoot, "winCodeSign", "winCodeSign-2.6.0");

function validatePreparedCache() {
  const folder = lstatSync(toolDir);
  if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error(`Invalid code-sign tool directory: ${toolDir}`);
  for (const [name, expectedHash] of requiredTools) {
    const path = join(toolDir, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error(`Invalid code-sign tool: ${path}`);
    const actualHash = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (actualHash !== expectedHash) throw new Error(`Code-sign tool hash mismatch: ${path}`);
  }
}

if (existsSync(toolDir)) {
  try {
    validatePreparedCache();
    console.log("Verified Windows code-sign tool cache is ready for packaging.");
    process.exit(0);
  } catch (error) {
    console.error(`Prepared Windows code-sign cache is invalid: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const tempRoot = resolve(tmpdir());
const dir = mkdtempSync(join(tempRoot, "openpets-symlink-check-"));
try {
  const target = join(dir, "target.txt");
  const link = join(dir, "link.txt");
  writeFileSync(target, "ok", "utf8");
  symlinkSync(target, link, "file");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error("Windows packaging needs symlink privilege or a verified prepared winCodeSign cache.");
  console.error("Run internal/Prepare-WindowsCodeSignCache.ps1 with the approved archive, or use an elevated build account.");
  console.error(`Symlink check failed: ${message}`);
  process.exitCode = 1;
} finally {
  const resolvedDir = resolve(dir);
  if (dirname(resolvedDir).toLowerCase() !== tempRoot.toLowerCase() || !basename(resolvedDir).startsWith("openpets-symlink-check-")) {
    throw new Error(`Refusing to remove an unexpected symlink check directory: ${resolvedDir}`);
  }
  rmSync(resolvedDir, { recursive: true, force: true });
}
