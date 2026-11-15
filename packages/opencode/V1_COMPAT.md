# OpenCode 1.x and 2.x adapters

OpenPets now has two independent OpenCode plugin entrypoints. They share the same reaction classifier and local IPC client in `opencode-plugin-runtime.ts`.

| OpenCode line | Plugin entrypoint | Configuration |
| --- | --- | --- |
| Public 1.x | `v1-package/index.js` after `build:v1` | `plugin` array with the internal `@open-pets-internal/opencode-v1` package, a `file://` URL, or copy the file to `.opencode/plugins/openpets-v1.js` |
| 2.x | `v2-package/index.js` after `build:v2`, or `dist/index.js` in `@open-pets/opencode` | Copy the local bundle to `.opencode/plugins/openpets-v2.js`, or use the pinned internal package. OpenPets' current setup writes a legacy `plugin` tuple that 2.x normalizes |

The V1 bundle exports one async function because the historical OpenCode 1.x loader calls every module export as a plugin. Its hooks map `chat.message` and busy status to thinking, edit/test tool starts to their reactions, permission requests to waiting, idle to success, and session errors to error. It does not inspect message text or send tool arguments to OpenPets.

The public OpenCode migration guide says a combined V1/V2 object entrypoint works only in OpenCode 1.18.29 and newer. An older or modified 1.x fork therefore needs the separate V1 entrypoint. The built V1 package has no runtime npm dependencies and can be served by an internal registry or placed on disk.

## Offline Windows configuration examples

For OpenCode 1.x, copy `v1-package/index.js` into the project's `.opencode/plugins/openpets-v1.js`. Public V1 discovers this directory without a `plugin` entry. Add an MCP server using a verified local CLI path with its runtime dependencies, not an `npx` command:

```jsonc
{
  "mcp": {
    "openpets": {
      "type": "local",
      "command": ["node", "C:/Company/OpenPets/cli/index.js", "mcp"],
      "enabled": true
    }
  }
}
```

Replace `C:/Company/OpenPets/cli/index.js` with the actual deployed absolute CLI entry path. `packages/cli/dist/index.js` imports other packages and cannot run if copied alone; use the installed desktop package's complete CLI dependency tree or a separately verified standalone CLI. Windows native OpenCode and the desktop app communicate through a local named pipe. If package installation is preferred, publish `v1-package/` to the internal npm registry and use a pinned `"plugin": ["@open-pets-internal/opencode-v1@4.1.0-internal.1"]` entry instead of the copied file. Do not configure both forms at once.

For OpenCode 2.x, copy `v2-package/index.js` into the project's `.opencode/plugins/openpets-v2.js`. Public V2 discovers this file without a `plugins` entry. The only required config is the local MCP command:

```jsonc
{
  "mcp": {
    "servers": {
      "openpets": {
        "type": "local",
        "command": ["node", "C:/Company/OpenPets/cli/index.js", "mcp"]
      }
    }
  }
}
```

The example command path is illustrative. Internal deployment should install the bundled CLI at a stable, audited path and replace this value. If package installation is preferred, publish `v2-package/` to the internal npm registry and use a pinned `"plugins": ["@open-pets-internal/opencode-v2@4.1.0-internal.1"]` entry instead of the copied file. Keep the registry internal-only and do not configure both plugin forms at once. Do not use the current published-mode `npx -y @open-pets/cli` command in an isolated runtime.

## Verification before internal deployment

1. Obtain the exact internal OpenCode commit and compare its plugin loader, hook signatures, and event payloads with the public V1 source. The public adapter cannot establish compatibility with a modified 1.6.x build by itself.
2. On a Windows test machine with public network access blocked, install the V1 package from the internal registry (or use its `file://` entry). Configure the OpenPets MCP server with a local Node command pointing to the bundled desktop CLI, then restart OpenCode.
3. Confirm the pet reacts to prompt, edit, test, permission, successful idle, and session error events. Call `openpets_status`, `openpets_react`, and `openpets_say` through MCP. Close the desktop pet and verify OpenCode still works.
4. Repeat with the V2 package and the exact OpenCode 2.x version planned for migration. Check the plugin list and MCP connection before accepting the upgrade.

The public V1 sources used for this adapter are `anomalyco/opencode` tag `v1.1.65`, `packages/plugin/src/index.ts` and `packages/opencode/src/plugin/index.ts`. The API transition and the 1.18.29 threshold are documented at https://opencode.ai/docs/build/plugins/migrate-v1/ .
