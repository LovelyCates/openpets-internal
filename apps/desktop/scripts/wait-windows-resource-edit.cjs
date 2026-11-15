const { existsSync } = require("node:fs");
const { join } = require("node:path");

// Windows security scanners can briefly retain the freshly written executable.
// Let the ASAR integrity update settle before electron-builder invokes rcedit.
module.exports = async function waitForWindowsResourceEdit(context) {
  if (context.electronPlatformName !== "win32") return;

  const executable = join(context.appOutDir, "openpets-internal.exe");
  if (!existsSync(executable)) {
    throw new Error(`Expected packaged executable is missing: ${executable}`);
  }

  await new Promise((resolve) => setTimeout(resolve, 30_000));
};
