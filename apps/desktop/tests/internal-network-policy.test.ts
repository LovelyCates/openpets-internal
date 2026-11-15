import assert from "node:assert/strict";

import { getPluginCatalog } from "../src/plugin-catalog.js";
import { getMarketplacePlugin, getMarketplacePlugins } from "../src/plugin-marketplace.js";
import { downloadCatalogPluginZip } from "../src/plugin-package.js";
import { ProviderTransport } from "../src/provider-transport.js";
import { TeamApiClient } from "../src/team-api-client.js";

let requests = 0;
const fakeFetch: typeof fetch = async () => {
  requests += 1;
  throw new Error("network request reached the transport");
};

await assert.rejects(
  () => new ProviderTransport(fakeFetch).request("https://provider.example/v1/chat", { method: "POST" }),
  /Public network services are disabled/,
);
await assert.rejects(
  () => new ProviderTransport((...args) => fakeFetch(...args)).request("https://provider.example/v1/chat", { method: "POST" }),
  /Public network services are disabled/,
);
const teams = new TeamApiClient({ fetchImpl: fakeFetch });
await assert.rejects(() => teams.getTeamPack("test-credential"), /Public network services are disabled/);

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = fakeFetch;
  assert.deepEqual((await getPluginCatalog()).plugins, []);
  assert.deepEqual((await getMarketplacePlugins()).plugins, []);
  await assert.rejects(() => getMarketplacePlugin("example.plugin"), /Public network services are disabled/);
  const plugin = {
    id: "example.plugin",
    name: "Example",
    version: "1.0.0",
    description: "Network boundary fixture",
    runtime: "declarative" as const,
    permissions: [],
    downloadUrl: "https://studio-api.openpets.dev/package.zip",
    sha256: "0".repeat(64),
  };
  await assert.rejects(
    () => downloadCatalogPluginZip(plugin),
    /Public network services are disabled/,
  );
} finally {
  globalThis.fetch = originalFetch;
}

assert.equal(requests, 0);
console.log("Internal network transports reject requests before dispatch.");
