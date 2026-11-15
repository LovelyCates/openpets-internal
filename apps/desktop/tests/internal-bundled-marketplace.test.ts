import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PluginService } from "../src/plugin-service.js";

const userDataPath = mkdtempSync(join(tmpdir(), "openpets-internal-marketplace-"));
const officialRoot = join(userDataPath, "official");
const pluginDir = join(officialRoot, "openpets.reminders");
mkdirSync(pluginDir, { recursive: true });
writeFileSync(join(pluginDir, "openpets.plugin.json"), JSON.stringify({
  manifestVersion: 2,
  id: "openpets.reminders",
  name: "Quick Reminders",
  description: "Remind me to take a break",
  version: "1.0.0",
  runtime: "javascript",
  sdkVersion: "1.0.0",
  entry: "index.js",
  permissions: ["pet:speak"],
}), "utf8");
writeFileSync(join(pluginDir, "index.js"), "OpenPetsPlugin.register({ start() {} });\n", "utf8");

const service = new PluginService({
  userDataPath,
  bundledPluginSourceDirs: [officialRoot],
  runtime: { async start() {}, async stop() {}, async reloadPlugin() {} } as never,
});
try {
  await service.start();
  const page = await service.getMarketplacePlugins({ q: "quick", category: "utility", limit: 1 });
  assert.equal(page.total, 1);
  assert.equal(page.plugins[0]?.id, "openpets.reminders");
  assert.equal(page.plugins[0]?.source, "bundled");
  assert.equal("downloadUrl" in page.plugins[0], false);
  assert.equal((await service.getMarketplacePlugins({ q: "missing" })).total, 0);
  assert.equal((await service.getMarketplacePlugins({ offset: 1, limit: 1 })).plugins.length, 0);
  await assert.rejects(() => service.getMarketplacePlugins({ limit: 0 }));

  const detail = await service.getMarketplacePlugin("openpets.reminders");
  assert.equal(detail.readme, "Remind me to take a break");
  assert.equal(detail.releases[0]?.source, "bundled");
  assert.equal("downloadUrl" in detail.releases[0], false);
  await assert.rejects(() => service.getMarketplacePlugin("other.plugin"), /Bundled plugin is unavailable/);
  const install = await service.installCatalog("openpets.reminders");
  assert.equal(install.ok, false);
  assert.match(install.error, /delivered with the OpenPets desktop app/);
  console.log("internal bundled marketplace passed");
} finally {
  await service.stop();
  rmSync(userDataPath, { recursive: true, force: true });
}
