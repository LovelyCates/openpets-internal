# OpenPets adapter for OpenCode 1.x

This package contains a single exported plugin function for the public OpenCode 1.x plugin API. It sends only reaction states and fixed, validated speech to the OpenPets desktop app over local IPC. It does not read prompts, source contents, or tool output.

Build it from the OpenPets workspace with `pnpm build` followed by `pnpm --filter @open-pets/opencode build:v1`. Publish the resulting `v1-package/` to your internal npm registry, or copy its single `index.js` file into the target project's `.opencode/plugins/openpets-v1.js` directory. A `file://` URL pointing to `index.js` also works. Advance this internal package version with the desktop release.

The adapter was checked against the public OpenCode 1.x hook contract and historical source at `anomalyco/opencode` tag `v1.1.65`. It has not been verified against a modified OpenCode 1.6.x fork. Before deploying it there, compare the fork's plugin loader, hook types, and event payloads, then run the integration checks described in `../V1_COMPAT.md`.
