import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import * as moduleApi from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

const root = await realpath(await mkdtemp(join(tmpdir(), "openpets-codex-previews-")));
const petsRoot = join(root, ".codex", "pets");
const mock = (source: string): string => `data:text/javascript,${encodeURIComponent(source)}`;
const mocks: Record<string, string> = {
  "node:os": mock(`export const homedir = () => ${JSON.stringify(root)};`),
  "./app-state.js": mock("export function getAppStateSnapshot() {} export function installPetState() {}"),
  "./codex-pet-migration.js": mock("export function migrateLegacyCodexV2Imports() {}"),
  "./pet-install-transaction.js": mock(`
    export function assertNoUnresolvedPetInstallTransaction() {}
    export function createPetInstallCandidate() {}
    export function runPetInstallTransaction() {}
  `),
  "./pet-paths.js": mock(`
    export function assertSafePetId(id) {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new Error("Invalid pet id.");
    }
    export const getPetsRoot = () => ${JSON.stringify(join(root, "installed"))};
  `),
};
const hooks = typeof moduleApi.registerHooks === "function" ? moduleApi.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith("/codex-pets.js") && mocks[specifier]) {
      return { url: mocks[specifier], shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
}) : undefined;
if (!hooks) {
  moduleApi.register(mock(`
    const mocks = ${JSON.stringify(mocks)};
    export async function resolve(specifier, context, nextResolve) {
      if (context.parentURL?.endsWith("/codex-pets.js") && mocks[specifier]) return { url: mocks[specifier], shortCircuit: true };
      return nextResolve(specifier, context);
    }
  `), import.meta.url);
}

async function writePet(id: string, bytes: Buffer): Promise<void> {
  const directory = join(petsRoot, id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "pet.json"), JSON.stringify({
    id,
    displayName: id,
    description: "Local preview fixture",
    spritesheetPath: "spritesheet.webp",
  }));
  await writeFile(join(directory, "spritesheet.webp"), bytes);
}

try {
  const { getCodexPetsUiState, readCodexPetSpritesheet } = await import("../src/codex-pets.js");
  const first = await sharp({
    create: {
      width: 1536,
      height: 1872,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 0.5 },
    },
  }).webp().toBuffer();
  const second = await sharp(first).negate().webp().toBuffer();
  const animation = await sharp([first, second], { join: { animated: true } }).webp({ delay: [100, 100] }).toBuffer();
  await writePet("animated", animation);
  await writePet("renamed-tiff", await sharp(first).tiff().toBuffer());
  await writePet("renamed-svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1536" height="1872"><rect width="1536" height="1872" fill="red"/></svg>'));

  const state = await getCodexPetsUiState();
  assert.equal(state.error, undefined);
  assert.deepEqual(state.pets.map((pet) => pet.id), ["animated"], "renamed foreign images never become local Codex previews");
  const preview = state.pets[0]!.preview;
  assert.ok(preview.startsWith("data:image/png;base64,"));
  const previewBytes = Buffer.from(preview.slice("data:image/png;base64,".length), "base64");
  const facts = await sharp(previewBytes).metadata();
  assert.equal(facts.width, 54);
  assert.equal(facts.height, 58);
  const pixels = await sharp(previewBytes).raw().toBuffer();
  assert.ok(pixels[0]! > 200 && pixels[1]! < 50, "the thumbnail uses the first red frame, before the cyan frame");
  assert.deepEqual((await readCodexPetSpritesheet("animated")).bytes, animation, "validated animated V1 bytes remain unchanged");
  await assert.rejects(readCodexPetSpritesheet("renamed-tiff"));
  await assert.rejects(readCodexPetSpritesheet("renamed-svg"));
  console.log("Local Codex V1 previews reject renamed formats and retain bounded animation.");
} finally {
  hooks?.deregister();
  await rm(root, { recursive: true, force: true });
}
