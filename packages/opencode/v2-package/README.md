# Standalone OpenCode 2.x adapter

Run `pnpm build` and then `pnpm --filter @open-pets/opencode build:v2` from the OpenPets workspace. The generated `index.js` includes the fork's OpenPets client. Copy it into the target project's `.opencode/plugins/openpets-v2.js`, or deploy this directory as a local plugin package. Do not also enable the published `@open-pets/opencode` package for that project.

The OpenCode 2.x plugin definition is the same one used by the main `@open-pets/opencode` package. Its default IPC client is local-only even when `OPENPETS_REMOTE_*` environment variables are present. Confirm the exact internal OpenCode 2.x version accepts this plugin before rollout.
