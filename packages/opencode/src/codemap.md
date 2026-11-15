# packages/opencode/src/

## Files

- **index.ts**: Barrel export. Re-exports all public modules including path-safety helpers.
- **plugin.ts**: OpenCode 2.0 V2 `Plugin.define({ id, setup })` entry point. Owns event subscription, prompt/tool hook registration, option validation, and teardown (abort, dispose, drain, lease release).
- **opencode-plugin-runtime.ts**: `createOpenPetsOpenCodeRuntime()`, V2 event classification, tool reaction mapping, serialized lease acquisition, token-rate IPC dispatch, success/error reaction cooldown exemptions, and unload cleanup.
- **opencode-token-rate.ts**: Pure V1/V2 usage-event parser and bounded rolling token/s estimator. Sends only validated session IDs and derived numbers; never forwards stream text.
- **opencode-plugin-v1-runtime.ts**: Maps V1 hooks to shared reactions and forwards V1 part/message usage events to the token-rate tracker.
- **opencode-config.ts**: Config file management. Path resolution, JSONC parsing, safe file operations, atomic writes with backups, actionable symlink/parent diagnostics.
- **opencode-path-safety.ts**: Shared safety message builders. Symlink target display, scope-aware (`global`/`project`) config/instruction/parent/directory error formatters, lstat-based existence helpers, and full-ancestor symlink rejection for global roots.
- **opencode-project-setup.ts**: Project-level setup. `prepareOpenCodeProjectSetup()`, `writePreparedOpenCodeProjectSetup()`, instruction block management with path-aware safety errors.
- **opencode-global-setup.ts**: Global setup management. `prepareOpenCodeGlobalSetup()`, `prepareOpenCodeGlobalRemove()`, cleanup writes, doctor command, config precedence handling, global state classification with actionable safety errors.
- **opencode-status.ts**: Status classification (147 lines). `classifyOpenCodeMcpStatus()`, `classifyOpenCodeInstructionsStatus()`, `classifyOpenCodePluginStatus()`, managed MCP/plugin/instruction detection helpers, OpenPets-like entry detection.
- **opencode-previews.ts**: Config entry builders (55 lines). `buildOpenCodeMcpEntry()`, `buildOpenCodePluginPreview()`, `buildOpenCodeInstructionPath()`, `formatOpenCodeMcpConfig()`, `validateOpenPetsPetArg()`.
- **check-opencode-foundation.ts**: Contract validation (excluded from detailed documentation).
- **check-opencode-plugin.ts**: Plugin contract validation (excluded from detailed documentation).
