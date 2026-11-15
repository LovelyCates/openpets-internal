import { createOpenPetsOpenCodeV1Hooks } from "./opencode-plugin-v1-runtime.js";

// OpenCode 1.x calls every runtime export as a plugin function. Keep this entrypoint to one export.
export default async function openPetsOpenCodeV1() {
  return createOpenPetsOpenCodeV1Hooks();
}
