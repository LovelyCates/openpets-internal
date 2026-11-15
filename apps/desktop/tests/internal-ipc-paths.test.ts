import assert from "node:assert/strict";

import { getDiscoveryFilePath, getIpcEndpointConfig } from "../src/local-ipc-paths.js";

if (process.platform === "win32") {
  const previousBind = process.env.OPENPETS_IPC_BIND;
  const previousEndpoint = process.env.OPENPETS_IPC_ENDPOINT;
  const previousDiscovery = process.env.OPENPETS_DISCOVERY_FILE;

  try {
    process.env.OPENPETS_IPC_BIND = "tcp://0.0.0.0:37645";
    process.env.OPENPETS_IPC_ENDPOINT = "tcp://192.168.1.10:37645";
    process.env.OPENPETS_DISCOVERY_FILE = "C:\\public\\ipc.json";

    const config = getIpcEndpointConfig();
    assert.deepEqual(config.bindEndpoint, { kind: "path", path: config.advertisedEndpoint });
    assert.match(config.advertisedEndpoint, /^\\\\\.\\pipe\\openpets-[a-f0-9]{16}-\d+$/u);
    assert.notEqual(getDiscoveryFilePath(), process.env.OPENPETS_DISCOVERY_FILE);
    assert.match(getDiscoveryFilePath(), /OpenPets Internal[\\/]runtime[\\/]ipc\.json$/u);
  } finally {
    if (previousBind === undefined) delete process.env.OPENPETS_IPC_BIND;
    else process.env.OPENPETS_IPC_BIND = previousBind;
    if (previousEndpoint === undefined) delete process.env.OPENPETS_IPC_ENDPOINT;
    else process.env.OPENPETS_IPC_ENDPOINT = previousEndpoint;
    if (previousDiscovery === undefined) delete process.env.OPENPETS_DISCOVERY_FILE;
    else process.env.OPENPETS_DISCOVERY_FILE = previousDiscovery;
  }
}

console.log("Internal Windows IPC ignores legacy TCP and discovery overrides.");
