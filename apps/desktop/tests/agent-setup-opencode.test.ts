import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getOpenCodeSetup, installOpenCodeGlobal } from "../src/agent-setup-opencode.js";

// The internal build keeps a read-only preview but refuses public npm setup.
const configDir = mkdtempSync(join(realpathSync(tmpdir()), "openpets-agent-setup-opencode-"));
const formatUserPath = (path: string | undefined) => path;
const dependencies = {
  configDir,
  cliVersion: "3.5.0",
  pluginVersion: "3.5.0",
  commandMode: "published" as const,
  detected: true,
  preferredCommandIsDefault: true,
  formatUserPath,
};

try {
  const initial = getOpenCodeSetup(dependencies);
  assert.equal(initial.status.state, "needs_setup");
  assert.ok(initial.preview.configPath);
  assert.equal(initial.status.canInstall, false);
  assert.match(initial.status.details, /reviewed local installer/);

  const installed = installOpenCodeGlobal(dependencies);
  assert.equal(installed.action, "opencode-install");
  assert.equal(installed.ok, false);
  assert.equal(installed.changed, false);
  assert.equal(existsSync(initial.preview.configPath), false);
} finally {
  rmSync(configDir, { recursive: true, force: true });
}
