# OpenCode 1.x and 2.x adapters

OpenPets now has two independent OpenCode plugin entrypoints. They share the same reaction classifier and local IPC client in `opencode-plugin-runtime.ts`.

| OpenCode line | Plugin entrypoint | Configuration |
| --- | --- | --- |
| Public 1.x | `v1-package/index.js` after `build:v1` | `plugin` array with the internal `@open-pets-internal/opencode-v1` package, a `file://` URL, or copy the file to `.opencode/plugins/openpets-v1.js` |
| 2.x | `v2-package/index.js` after `build:v2`, or `dist/index.js` in `@open-pets/opencode` | Copy the local bundle to `.opencode/plugins/openpets-v2.js`, or use the pinned internal package. OpenPets' current setup writes a legacy `plugin` tuple that 2.x normalizes |

The V1 bundle exports one async function because the historical OpenCode 1.x loader calls every module export as a plugin. Its hooks map `chat.message` and busy status to thinking, edit/test tool starts to their reactions, permission requests to waiting, idle to success, and session errors to error. Public V1 `tool.execute.before` / `tool.execute.after` carry `callID` and `sessionID`; a successful result object resumes thinking immediately after the last known parallel tool completes. An absent failure result is not treated as success, and unpaired legacy completions do not infer a state. No prompt text or tool arguments are forwarded to OpenPets. Streaming text is counted locally for approximate token/s; historical full-text snapshots count only observed growth of the same unfinished identified part, and never the first or completed snapshot.

OpenCode 1.2.27 publishes `permission.asked` through its generic event hook;
its permission service does not invoke the still-declared `permission.ask`
hook. The adapter maps the bus request's `sessionID` and `permission` into the
shared waiting event. It discards `patterns`, `metadata`, `always`, and the
`tool` object's message/call IDs; that object contains no tool name. MCP
permission names are the actual tool keys, so OpenPets' own MCP permissions are
ignored. The legacy hook still handles `status: "ask"` with its session ID and
permission type. Generic `permission.replied` forwards only a bounded session
ID so a matching current wait can resume the still-running tool, or thinking
when no tool is tracked. Missing-session replies are ignored, and another
session's reply cannot dismiss the current wait. `allow`, `deny`, replies, and
the unsupported old `permission.updated` envelope do not create waiting feedback. In 1.2.27,
`permission.updated` remains in an old generated SDK type but is not published
by the permission service.

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

Permission event behavior was additionally checked against tag `v1.2.27`
(`4ee426ba549131c4903a71dfb6259200467aca81`),
`packages/opencode/src/permission/next.ts`, `permission/service.ts`, and
`session/prompt.ts`.

State transitions and queue coalescing are shared by the Windows and macOS adapters. Continuous same-state feedback refreshes every ten seconds with a five-second keepalive for quiet tools; speech remains independently throttled. A modified internal 1.x fork must retain the documented session/call IDs and after-hook result shape for immediate tool-completion tracking; otherwise scoped stream/status events remain the fallback.
