import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import sharp from "sharp";

import type { InstalledPetState } from "../src/app-state.js";

interface TestEnvironment {
  readonly userData: string;
  manifestReads: number;
  renameFailuresRemaining: number;
}

const testGlobal = globalThis as typeof globalThis & {
  __openPetsInstalledStateTest?: TestEnvironment;
};
const petPathsUrl = new URL("../src/pet-paths.js", import.meta.url).href;
const electronMock = `data:text/javascript,${encodeURIComponent(`
  export const app = {
    getVersion: () => "4.1.0",
    getPath: () => globalThis.__openPetsInstalledStateTest.userData,
    isReady: () => true,
  };
  export const net = {};
  export const powerMonitor = { on: () => {}, getSystemIdleTime: () => 0 };
  export const screen = { on: () => {}, getAllDisplays: () => [] };
  export const shell = { openPath: async () => "" };
  export default { app, net, powerMonitor, screen, shell };
`)}`;
const petPathsMock = `data:text/javascript,${encodeURIComponent(`
  import { join } from "node:path";
  import { assertSafePetId } from ${JSON.stringify(petPathsUrl)};
  export { assertSafePetId };
  export function getInstalledPetDir(id) {
    assertSafePetId(id);
    return join(globalThis.__openPetsInstalledStateTest.userData, "pets", id);
  }
  export function getTeamPetDir(id) {
    assertSafePetId(id);
    return join(globalThis.__openPetsInstalledStateTest.userData, "team-pets", id);
  }
`)}`;
const fsMock = `data:text/javascript,${encodeURIComponent(`
  export * from "node:fs";
  import { openSync as realOpenSync, renameSync as realRenameSync } from "node:fs";
  export function openSync(file, ...args) {
    if (String(file).endsWith("pet.json")) {
      globalThis.__openPetsInstalledStateTest.manifestReads += 1;
    }
    return realOpenSync(file, ...args);
  }
  export function renameSync(from, to) {
    const environment = globalThis.__openPetsInstalledStateTest;
    if (String(to).endsWith("openpets-state.json") && environment.renameFailuresRemaining > 0) {
      environment.renameFailuresRemaining -= 1;
      const error = new Error("State file is temporarily locked.");
      error.code = "EPERM";
      throw error;
    }
    return realRenameSync(from, to);
  }
`)}`;

register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "electron") return { url: ${JSON.stringify(electronMock)}, shortCircuit: true };
    if (context.parentURL.endsWith("/src/app-state.js")) {
      if (specifier === "./pet-paths.js") return { url: ${JSON.stringify(petPathsMock)}, shortCircuit: true };
      if (specifier === "node:fs") return { url: ${JSON.stringify(fsMock)}, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
`)}`, import.meta.url);

const appState = await import("../src/app-state.js");
const spritesheet = await sharp({
  create: {
    width: 1536,
    height: 1872,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
}).webp().toBuffer();

function writePet(userData: string, id: string, options: { readonly team?: boolean; readonly missingAtlas?: boolean } = {}): void {
  const directory = join(userData, options.team ? "team-pets" : "pets", id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "pet.json"), JSON.stringify({
    id,
    displayName: id,
    spritesheetPath: "spritesheet.webp",
  }));
  if (!options.missingAtlas) {
    writeFileSync(join(directory, "spritesheet.webp"), spritesheet);
  }
}

function withState(
  prepare: (userData: string) => unknown,
  run: (environment: TestEnvironment) => void,
): void {
  const userData = realpathSync(mkdtempSync(join(tmpdir(), "openpets-installed-state-")));
  const environment = { userData, manifestReads: 0, renameFailuresRemaining: 0 };
  testGlobal.__openPetsInstalledStateTest = environment;
  try {
    const seed = prepare(userData);
    if (seed !== undefined) {
      writeFileSync(join(userData, "openpets-state.json"), JSON.stringify(seed));
    }
    appState.initializeAppState();
    run(environment);
  } finally {
    appState.releaseStartupInstallLock();
    rmSync(userData, { recursive: true, force: true });
  }
}

function installed(id: string): InstalledPetState {
  const pet = appState.getAppStateSnapshot().pets.installed.find((candidate) => candidate.id === id);
  assert.ok(pet, `${id} must remain installed`);
  return pet;
}

test("token dock visibility defaults on for existing profiles and survives preference saves and restart", () => {
  withState(() => ({ preferences: { petScale: 1 } }), ({ userData }) => {
    assert.equal(appState.getPetRenderPreferences().showOpenCodeTokenRate, true);
    appState.updatePreferences({ showOpenCodeTokenRate: false });
    assert.equal(appState.isOpenCodeTokenRateDisplayEnabled(), false);
    appState.updatePreferences({ openDefaultPetOnLaunch: false });
    const saved = JSON.parse(readFileSync(join(userData, "openpets-state.json"), "utf8"));
    assert.equal(saved.preferences.showOpenCodeTokenRate, false);
    appState.releaseStartupInstallLock();
    appState.initializeAppState();
    assert.equal(appState.getPetRenderPreferences().showOpenCodeTokenRate, false);
    appState.updatePreferences({ showOpenCodeTokenRate: true });
    assert.equal(appState.isOpenCodeTokenRateDisplayEnabled(), true);
  });
});

test("library favorites persist independently of installation, desktop pins and pools", () => {
  withState((userData) => {
    writePet(userData, "bookmark-cat");
    return { pets: { installed: [{ id: "bookmark-cat", displayName: "Bookmark Cat" }] } };
  }, ({ userData }) => {
    const next = appState.updatePreferences({ favoritePetIds: ["bookmark-cat", "builtin", "not-installed"] });
    assert.deepEqual(next.preferences.favoritePetIds, ["bookmark-cat", "builtin", "not-installed"]);
    assert.equal(next.preferences.pinnedPets, undefined);
    assert.equal(next.preferences.petPoolOrder, undefined);
    appState.removePetState("bookmark-cat");
    const persisted = JSON.parse(readFileSync(join(userData, "openpets-state.json"), "utf8"));
    assert.deepEqual(persisted.preferences.favoritePetIds, ["bookmark-cat", "builtin", "not-installed"]);
    appState.releaseStartupInstallLock();
    appState.initializeAppState();
    assert.deepEqual(appState.getAppStateSnapshot().preferences.favoritePetIds, persisted.preferences.favoritePetIds);
  });
});

test("favorite and general preference updates retain validated pets without rereading their manifests", () => {
  withState((userData) => {
    writePet(userData, "favorite-cat");
    writePet(userData, "pinned-cat");
    return {
      preferences: { defaultPetId: "favorite-cat", pinnedPets: ["pinned-cat"], petPoolOrder: ["favorite-cat"] },
      pets: { installed: [
        { id: "favorite-cat", displayName: "Favorite cat" },
        { id: "pinned-cat", displayName: "Pinned cat" },
      ] },
    };
  }, (environment) => {
    const before = appState.getAppStateSnapshot();
    const readsBefore = environment.manifestReads;
    // Preferences must not become a health sweep or observe an unrelated
    // install's temporary filesystem promotion gap. Startup still checks disk.
    rmSync(join(environment.userData, "pets/favorite-cat/spritesheet.webp"));
    appState.updatePreferences({ favoritePetIds: ["favorite-cat"] });
    const next = appState.updatePreferences({ waitingAnimationDurationMs: 2200 });
    assert.equal(environment.manifestReads, readsBefore, "unchanged installed metadata is not reread for preference-only changes");
    assert.equal(next.preferences.defaultPetId, before.preferences.defaultPetId);
    assert.deepEqual(next.preferences.pinnedPets, before.preferences.pinnedPets);
    assert.deepEqual(next.preferences.petPoolOrder, before.preferences.petPoolOrder);
    assert.notEqual(installed("favorite-cat").broken, true);
    const persisted = JSON.parse(readFileSync(join(environment.userData, "openpets-state.json"), "utf8"));
    assert.deepEqual(persisted.preferences.favoritePetIds, ["favorite-cat"]);
    assert.equal(persisted.preferences.waitingAnimationDurationMs, 2200);

    appState.releaseStartupInstallLock();
    appState.initializeAppState();
    assert.ok(environment.manifestReads > readsBefore, "a fresh startup still validates installed manifests");
    assert.equal(installed("favorite-cat").broken, true);
    assert.equal(appState.getAppStateSnapshot().preferences.defaultPetId, "builtin");
    assert.deepEqual(appState.getAppStateSnapshot().preferences.favoritePetIds, ["favorite-cat"]);
  });
});

test("verified Codex library labels survive state persistence and detached pet reads", () => {
  withState((userData) => {
    writePet(userData, "metadata-cat");
    return undefined;
  }, ({ userData }) => {
    const metadata = { sourceSite: "codex-pets.net" as const, sourcePetId: "source-cat", kind: "animal" as const, tags: ["cute"], creatorName: "Uploader" };
    appState.upsertPetState({ id: "metadata-cat", displayName: "Cat", source: { kind: "codex", path: join(userData, "source") }, libraryMetadata: metadata });
    metadata.tags.push("not-stored");
    const pet = appState.getInstalledPetState("metadata-cat");
    assert.deepEqual(pet?.libraryMetadata?.tags, ["cute"]);
    assert.ok(Object.isFrozen(pet?.libraryMetadata) && Object.isFrozen(pet?.libraryMetadata?.tags));
    appState.releaseStartupInstallLock();
    appState.initializeAppState();
    assert.deepEqual(installed("metadata-cat").libraryMetadata?.tags, ["cute"]);
    appState.upsertPetState({ id: "metadata-cat", displayName: "Ordinary import", libraryMetadata: metadata });
    assert.equal(installed("metadata-cat").libraryMetadata, undefined, "ordinary imports cannot acquire a Codex classification by name or side data");
  });
});

test("startup checks every disk-loaded pet and falls back from a missing default atlas", () => {
  withState((userData) => {
    writePet(userData, "bad-default", { missingAtlas: true });
    return {
      preferences: { defaultPetId: "bad-default" },
      pets: { installed: [{ id: "bad-default", displayName: "Bad default" }] },
    };
  }, (environment) => {
    assert.equal(installed("bad-default").broken, true);
    assert.equal(appState.getAppStateSnapshot().preferences.defaultPetId, "builtin");
    assert.equal(environment.manifestReads, 1);
  });
});

test("install and activity preserve unchanged health until restart rechecks the library", () => {
  withState((userData) => {
    writePet(userData, "unchanged");
    return {
      preferences: { defaultPetId: "unchanged" },
      pets: { installed: [{ id: "unchanged", displayName: "Unchanged" }] },
    };
  }, (environment) => {
    assert.notEqual(installed("unchanged").broken, true);
    rmSync(join(environment.userData, "pets/unchanged/spritesheet.webp"));
    writePet(environment.userData, "added");
    writePet(environment.userData, "upserted");
    appState.installPetState({ id: "added", displayName: "Added" });
    appState.upsertPetState({ id: "upserted", displayName: "Upserted" });
    appState.recordOpenPetsActivity({ kind: "react", reaction: "thinking", petId: "unchanged" }, 123);
    assert.notEqual(installed("unchanged").broken, true);
    assert.equal(appState.getAppStateSnapshot().activity.reactionCounts.thinking, 1);
    assert.equal(environment.manifestReads, 3, "only startup and the two newly installed pets read metadata");

    appState.releaseStartupInstallLock();
    appState.initializeAppState();
    assert.equal(installed("unchanged").broken, true);
    assert.equal(appState.getAppStateSnapshot().preferences.defaultPetId, "builtin");
  });
});

test("new and replaced rows are validated, while unrelated changes retain broken records", () => {
  withState(() => undefined, (environment) => {
    writePet(environment.userData, "missing-new", { missingAtlas: true });
    appState.installPetState({ id: "missing-new", displayName: "Missing new" });
    assert.equal(installed("missing-new").broken, true);

    writePet(environment.userData, "replaced");
    appState.upsertPetState({ id: "replaced", displayName: "Replaced" });
    const previous = installed("replaced");
    rmSync(join(environment.userData, "pets/replaced/spritesheet.webp"));
    appState.upsertPetState(previous);
    assert.equal(installed("replaced").broken, true, "a cloned row with the same id is still a replacement");

    writePet(environment.userData, "marked");
    appState.upsertPetState({ id: "marked", displayName: "Marked" });
    appState.markPetBroken("marked", "Rendering failed");
    writePet(environment.userData, "unrelated");
    appState.upsertPetState({ id: "unrelated", displayName: "Unrelated" });
    appState.recordOpenPetsActivity({ kind: "say", petId: "marked" });
    assert.equal(installed("marked").broken, true);
    assert.equal(installed("marked").brokenReason, "Rendering failed");
  });
});

test("source changes validate the new ownership root and selecting defaults still rescans", () => {
  withState(() => undefined, (environment) => {
    writePet(environment.userData, "source-cat");
    appState.upsertPetState({ id: "source-cat", displayName: "Source cat" });
    writePet(environment.userData, "source-cat", { team: true, missingAtlas: true });
    appState.upsertPetState({
      id: "source-cat",
      displayName: "Source cat",
      source: {
        kind: "team",
        organizationId: "org",
        itemId: "item",
        artifactVersionId: "artifact",
        releaseId: "release",
      },
    });
    assert.equal(installed("source-cat").broken, true);
    assert.equal(installed("source-cat").source?.kind, "team");

    writePet(environment.userData, "choose-me");
    appState.installPetState({ id: "choose-me", displayName: "Choose me" });
    rmSync(join(environment.userData, "pets/choose-me/spritesheet.webp"));
    appState.setDefaultPet("choose-me");
    assert.equal(installed("choose-me").broken, true);
    assert.equal(appState.getAppStateSnapshot().preferences.defaultPetId, "builtin");
  });
});

test("render preferences and one-pet reads are immutable and stay detached across updates", () => {
  withState((userData) => {
    writePet(userData, "render-cat");
    writePet(userData, "other-cat");
    return {
      preferences: {
        defaultPetId: "render-cat",
        waitingAnimationDurationMs: 1010,
        reactionAnimationOverrides: { thinking: "waiting" },
        personality: { petName: "First name" },
      },
      pets: {
        installed: [
          { id: "render-cat", displayName: "Render cat", source: { kind: "codex", path: "/detached/source" } },
          { id: "other-cat", displayName: "Other cat" },
        ],
      },
    };
  }, () => {
    const preferences = appState.getPetRenderPreferences();
    const pet = appState.getInstalledPetState("render-cat");
    assert.ok(pet?.source);
    assert.equal(preferences.petName, "First name");
    assert.equal(preferences.reactionAnimationOverrides?.thinking, "waiting");
    assert.equal(Reflect.set(preferences, "petName", "Caller mutation"), false);
    assert.equal(Reflect.set(preferences.reactionAnimationOverrides!, "thinking", "jumping"), false);
    assert.equal(Reflect.set(pet, "displayName", "Caller mutation"), false);
    assert.equal(Reflect.set(pet.source, "path", "/caller/mutation"), false);
    assert.equal(appState.getInstalledPetState("missing"), undefined);
    assert.equal(appState.getInstalledPetState("other-cat")?.displayName, "Other cat");

    appState.updatePreferences({
      waitingAnimationDurationMs: 2200,
      reactionAnimationOverrides: { thinking: "jumping" },
      personality: { petName: "Next name" },
    });
    appState.upsertPetState({ id: "render-cat", displayName: "Replacement cat" });
    assert.equal(preferences.petName, "First name");
    assert.equal(preferences.waitingAnimationDurationMs, 1010);
    assert.equal(preferences.reactionAnimationOverrides?.thinking, "waiting");
    assert.equal(pet.displayName, "Render cat");
    assert.equal(pet.source.kind, "codex");
    assert.equal(appState.getPetRenderPreferences().petName, "Next name");
    assert.equal(appState.getPetRenderPreferences().waitingAnimationDurationMs, 2200);
    assert.equal(appState.getInstalledPetState("render-cat")?.displayName, "Replacement cat");
    assert.equal(appState.getInstalledPetState("render-cat")?.source, undefined);
  });
});

test("activity counters persist immediately without changing preferences or installed records", () => {
  withState((userData) => {
    writePet(userData, "activity-cat");
    return {
      preferences: { defaultPetId: "activity-cat", waitingAnimationDurationMs: 2200 },
      pets: { installed: [{ id: "activity-cat", displayName: "Activity cat" }] },
    };
  }, (environment) => {
    const before = appState.getAppStateSnapshot();
    rmSync(join(environment.userData, "pets/activity-cat/spritesheet.webp"));
    const readsBefore = environment.manifestReads;
    appState.recordOpenPetsActivity({ kind: "say", reaction: "testing", petId: "activity-cat" }, 456);
    const persisted = JSON.parse(readFileSync(join(environment.userData, "openpets-state.json"), "utf8"));
    assert.equal(persisted.activity.messagesSent, 1);
    assert.equal(persisted.activity.reactionsSent, 1);
    assert.equal(persisted.activity.reactionCounts.testing, 1);
    assert.equal(persisted.activity.perPetActivityCounts["activity-cat"], 1);
    assert.equal(persisted.activity.lastActivityAt, 456);
    assert.deepEqual(persisted.preferences, JSON.parse(JSON.stringify(before.preferences)));
    assert.deepEqual(persisted.pets, JSON.parse(JSON.stringify(before.pets)));
    assert.equal(environment.manifestReads, readsBefore);
    assert.equal(appState.getInstalledPetState("activity-cat")?.broken, before.pets.installed[1]?.broken);
  });
});

test("Windows state saves survive brief rename contention and preserve the previous state on lasting failure", { skip: process.platform !== "win32" }, () => {
  withState(() => undefined, (environment) => {
    const stateFile = join(environment.userData, "openpets-state.json");
    environment.renameFailuresRemaining = 2;
    appState.updatePreferences({ showOpenCodeTokenRate: false });
    const committed = readFileSync(stateFile);
    assert.equal(JSON.parse(committed.toString("utf8")).preferences.showOpenCodeTokenRate, false);

    environment.renameFailuresRemaining = 6;
    assert.throws(() => appState.updatePreferences({ showOpenCodeTokenRate: true }), { code: "EPERM" });
    assert.deepEqual(readFileSync(stateFile), committed);
    assert.equal(appState.isOpenCodeTokenRateDisplayEnabled(), false);
    assert.equal(existsSync(`${stateFile}.${process.pid}.tmp`), false);
  });
});

test("a catalog-sized import validates each new manifest once and activity adds no library reads", () => {
  withState(() => undefined, (environment) => {
    const count = 1336;
    for (let index = 0; index < count; index += 1) {
      const id = `catalog-${index}`;
      writePet(environment.userData, id);
      appState.upsertPetState({ id, displayName: `Catalog ${index}` });
    }
    assert.equal(environment.manifestReads, count);
    for (let index = 0; index < 10; index += 1) {
      appState.recordOpenPetsActivity({ kind: "react", reaction: "thinking", petId: "catalog-0" });
    }
    assert.equal(environment.manifestReads, count);
    const persisted = JSON.parse(readFileSync(join(environment.userData, "openpets-state.json"), "utf8"));
    assert.equal(persisted.pets.installed.length, count + 1);
    assert.equal(persisted.activity.reactionCounts.thinking, 10);
  });
});
