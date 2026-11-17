import { spawn } from "node:child_process";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRootGroups = {
  official: ["plugins/official", "plugins/dev"],
  "third-parties": ["third-parties"],
};

const group = process.argv[2];
if (process.argv.length !== 3 || !Object.hasOwn(pluginRootGroups, group)) {
  console.error("Usage: node scripts/dev-desktop-plugin-roots.mjs <official|third-parties>");
  process.exitCode = 2;
} else {
  const pluginRoots = pluginRootGroups[group].map((relativePath) => join(repoRoot, relativePath));
  const env = {
    ...process.env,
    OPENPETS_DISABLE_PLUGIN_CATALOG: "1",
    OPENPETS_DEV_PLUGIN_ROOTS: pluginRoots.join(delimiter),
  };
  // The command is fixed; cmd.exe resolves the pnpm.cmd shim on Windows.
  const command = process.platform === "win32" ? "cmd.exe" : "pnpm";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", "pnpm dev:desktop"] : ["dev:desktop"];
  const child = spawn(command, args, { cwd: repoRoot, env, stdio: "inherit" });
  child.on("error", (error) => {
    console.error("Could not start desktop development:", error);
    process.exitCode = 1;
  });
  child.on("close", (code) => {
    process.exitCode = code ?? 1;
  });
}
