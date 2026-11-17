import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";

import { getDiscoveryFilePath, getIpcEndpointConfig } from "../src/local-ipc-paths.js";

// Legacy public-profile and TCP settings must not redirect an internal native
// desktop's IPC token or expose a network listener.
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
assert.ok(platformDescriptor);
const nativePlatform = process.platform;
const previous = {
  bind: process.env.OPENPETS_IPC_BIND,
  endpoint: process.env.OPENPETS_IPC_ENDPOINT,
  discovery: process.env.OPENPETS_DISCOVERY_FILE,
};

try {
  process.env.OPENPETS_IPC_BIND = "tcp://0.0.0.0:37645";
  process.env.OPENPETS_IPC_ENDPOINT = "tcp://192.168.1.10:37645";
  process.env.OPENPETS_DISCOVERY_FILE = "/public-profile/ipc.json";

  for (const platform of ["darwin", "win32"] as const) {
    Object.defineProperty(process, "platform", { value: platform });
    assert.notEqual(getDiscoveryFilePath(), process.env.OPENPETS_DISCOVERY_FILE);
    // Named-pipe selection is pure on every host. Creating the Unix runtime
    // directory needs real POSIX ownership/modes, which platform spoofing
    // cannot give a Windows filesystem. Keep that behavior on POSIX hosts.
    if (platform === "win32" || nativePlatform !== "win32") {
      const config = getIpcEndpointConfig();
      assert.deepEqual(config.bindEndpoint, { kind: "path", path: config.advertisedEndpoint });
      if (platform === "win32") {
        assert.match(config.advertisedEndpoint, /^\\\\\.\\pipe\\openpets-[a-f0-9]{16}-\d+$/u);
      } else {
        assert.match(config.advertisedEndpoint, /^\/tmp\/openpets-[^/]+\/openpets-\d+\.sock$/u);
      }
    }
    if (platform === "win32") {
      assert.equal(getDiscoveryFilePath(), join(
        process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
        "OpenPets Internal", "runtime", "ipc.json",
      ));
    } else {
      assert.equal(getDiscoveryFilePath(), join(
        homedir(), "Library", "Application Support", "OpenPets Internal", "runtime", "ipc.json",
      ));
    }
  }

  // Linux keeps its existing explicit cross-platform transport behavior.
  Object.defineProperty(process, "platform", { value: "linux" });
  assert.deepEqual(getIpcEndpointConfig(), {
    bindEndpoint: { kind: "tcp", host: "0.0.0.0", port: 37645 },
    advertisedEndpoint: "tcp://192.168.1.10:37645",
  });
  assert.equal(getDiscoveryFilePath(), process.env.OPENPETS_DISCOVERY_FILE);
} finally {
  Object.defineProperty(process, "platform", platformDescriptor);
  restoreEnvironment("OPENPETS_IPC_BIND", previous.bind);
  restoreEnvironment("OPENPETS_IPC_ENDPOINT", previous.endpoint);
  restoreEnvironment("OPENPETS_DISCOVERY_FILE", previous.discovery);
}

console.log("Internal macOS/Windows IPC ignores legacy TCP and discovery overrides.");

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
