import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { PetRenderPreferences } from "../src/app-state.js";

const directory = await mkdtemp(join(tmpdir(), "openpets-render-preferences-"));
await writeFile(join(directory, "spritesheet.webp"), "stat-only atlas fixture");
await writeFile(join(directory, "pet.json"), JSON.stringify({ id: "snapshot-cat" }));
const initialPreferences: PetRenderPreferences = {
  defaultPetId: "snapshot-cat",
  openDefaultPetOnLaunch: true,
  speechBubblesEnabled: true,
  petScale: 1,
  hudScale: 1,
  bubbleScale: 1,
  bubbleDurationScale: 1,
  bubbleTheme: "system",
  waitingAnimationDurationMs: 1010,
  reactionAnimationOverrides: { testing: "waiting" },
  showChatButton: false,
  showTalkButton: false,
  petButtonsPosition: "right",
  petButtonsSize: "small",
  petName: "Before manifest read",
};
const host = {
  preferences: initialPreferences,
  manifestGate: Promise.resolve(),
};
const testGlobal = globalThis as typeof globalThis & { __petRenderPreferencesTest?: typeof host };
testGlobal.__petRenderPreferencesTest = host;
const mock = (source: string): string => `data:text/javascript,${encodeURIComponent(source)}`;
const mocks = {
  electron: mock(`export const app = { getAppPath: () => ${JSON.stringify(directory)} };`),
  "./app-state.js": mock(`
    const host = () => globalThis.__petRenderPreferencesTest;
    export function getPetRenderPreferences() {
      const preferences = host().preferences;
      return Object.freeze({ ...preferences, reactionAnimationOverrides: Object.freeze({ ...preferences.reactionAnimationOverrides }) });
    }
    export function getInstalledPetState(id) {
      return id === "snapshot-cat" ? { id, displayName: "Snapshot cat", installed: true } : undefined;
    }
    export function getAppStateSnapshot() {
      const preferences = host().preferences;
      return { preferences: { ...preferences, personality: { petName: preferences.petName } }, pets: { installed: [getInstalledPetState("snapshot-cat")] } };
    }
    export const isPetFlippedHorizontally = () => false;
    export const markPetBroken = () => { throw Error("Unexpected render fallback"); };
    export const resolveCompanionDisplayName = (name, fallback) => name || fallback;
  `),
  "./pet-paths.js": mock(`export const getPetDir = () => ${JSON.stringify(directory)};`),
  "./installed-pet-layout.js": mock(`
    export async function readInstalledPetPackage(id) {
      await globalThis.__petRenderPreferencesTest.manifestGate;
      return { format: "classic", metadata: { id, displayName: "Snapshot cat", description: "Snapshot fixture", spritesheetPath: "spritesheet.webp" } };
    }
  `),
  "./pet-wardrobe.js": mock('export const resolveRenderedPetOutfit = () => "default";'),
  "./pet-motion-snapshot.js": mock('export const prepareInstalledMotionSnapshot = () => { throw Error("Not a Motion fixture"); };'),
  "./logger.js": mock("export const warn = () => {};"),
};
register(mock(`
  const mocks = ${JSON.stringify(mocks)};
  export async function resolve(specifier, context, nextResolve) {
    if (mocks[specifier]) return { url: mocks[specifier], shortCircuit: true };
    return nextResolve(specifier, context);
  }
`), import.meta.url);

const { createDefaultPetRenderContent } = await import("../src/pet-window-render.js");
after(async () => {
  delete testGlobal.__petRenderPreferencesTest;
  await rm(directory, { recursive: true, force: true });
});

test("a render keeps one preference revision across asynchronous manifest IO", async () => {
  let finishManifest!: () => void;
  host.manifestGate = new Promise<void>((resolve) => { finishManifest = resolve; });
  const display = { reaction: "testing", suppressReactionMessage: true } as const;
  const pending = createDefaultPetRenderContent(false, display, "testing");
  host.preferences = {
    ...initialPreferences,
    petName: "After manifest read",
    reactionAnimationOverrides: { testing: "jumping" },
    showChatButton: true,
  };
  finishManifest();
  const original = await pending;
  assert.equal(original.displayName, "Before manifest read");
  assert.equal(original.reactionState, "waiting");
  assert.equal(original.bodyHtml.includes("data-openpets-companion-launcher"), false);

  const next = await createDefaultPetRenderContent(false, display, "testing");
  assert.equal(next.displayName, "After manifest read");
  assert.equal(next.reactionState, "jumping");
  assert.equal(next.bodyHtml.includes("data-openpets-companion-launcher"), true);
  assert.equal(next.renderedPetId, "snapshot-cat");
  assert.equal(next.codexSpriteVersion, 1);
});
