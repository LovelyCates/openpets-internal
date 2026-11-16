import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import * as moduleApi from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import sharp from "sharp";

function storedZip(files: readonly { name: string; contents: Buffer }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    let crc = 0xffffffff;
    for (const byte of file.contents) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const checksum = (crc ^ 0xffffffff) >>> 0;
    const name = Buffer.from(file.name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(file.contents.length, 18);
    header.writeUInt32LE(file.contents.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, file.contents);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(file.contents.length, 20);
    entry.writeUInt32LE(file.contents.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += header.length + name.length + file.contents.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

test("local provenance preserves folders and both-source V1/V2 ZIP installation contracts", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "openpets-codex-origin-")));
  const userData = join(root, "user-data");
  const petsRoot = join(userData, "pets");
  const paths = `data:text/javascript,${encodeURIComponent(`
    import { join, resolve, sep } from "node:path";
    export function getPetsRoot() { return ${JSON.stringify(petsRoot)}; }
    export function getPetDir(id, source) { return join(${JSON.stringify(userData)}, source === "team" ? "team-pets" : "pets", id); }
    export function getInstalledPetDir(id) { return getPetDir(id, "personal"); }
    export function getTeamPetDir(id) { return getPetDir(id, "team"); }
    export function assertSafePetId(id) { if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) || id === "builtin") throw new Error("Invalid pet id"); }
    export function assertInsideRoot(root, target) { if (resolve(target) !== resolve(root) && !resolve(target).startsWith(resolve(root) + sep)) throw new Error("Outside root"); }
  `)}`;
  const electron = `data:text/javascript,${encodeURIComponent(`
    export const app = { getPath: () => ${JSON.stringify(userData)}, getVersion: () => "4.1.0" };
    export const net = {};
    export const powerMonitor = { on() {}, getSystemIdleTime: () => 0 };
    export const screen = { on() {}, getAllDisplays: () => [] };
    export const shell = { openPath: async () => "" };
    export default { app, net, powerMonitor, screen, shell };
  `)}`;
  const hooks = typeof moduleApi.registerHooks === "function" ? moduleApi.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "electron") return { url: electron, shortCircuit: true };
      if (specifier === "./pet-paths.js") return { url: paths, shortCircuit: true };
      return nextResolve(specifier, context);
    },
  }) : undefined;
  if (!hooks) {
    moduleApi.register(`data:text/javascript,${encodeURIComponent(`
      export async function resolve(specifier, context, nextResolve) {
        if (specifier === "electron") return { url: ${JSON.stringify(electron)}, shortCircuit: true };
        if (specifier === "./pet-paths.js") return { url: ${JSON.stringify(paths)}, shortCircuit: true };
        return nextResolve(specifier, context);
      }
    `)}`, import.meta.url);
  }
  let release = (): void => {};
  try {
    const state = await import("../src/app-state.js");
    const { installPetFromFolderWithResult, installPetFromZipFile, installPetFromZipFileWithResult } = await import("../src/pet-installation.js");
    release = state.releaseStartupInstallLock;
    state.initializeAppState();
    const folder = join(root, "download-cache");
    await mkdir(folder);
    const manifest = {
      id: "codex-download", displayName: "Downloaded pet", description: "Local source fixture",
      spritesheetPath: "spritesheet.webp", spriteVersionNumber: 2,
    };
    const bytes = await sharp({ create: {
      width: 1536, height: 2288, channels: 4, background: { r: 10, g: 40, b: 70, alpha: 0.5 },
    } }).webp().toBuffer();
    await writeFile(join(folder, "pet.json"), JSON.stringify(manifest));
    await writeFile(join(folder, "spritesheet.webp"), bytes);

    const ordinary = await installPetFromFolderWithResult(folder);
    assert.equal(ordinary.state.pets.installed.find(pet => pet.id === manifest.id)?.source, undefined,
      "ordinary local folders retain their existing source semantics");
    state.setDefaultPet(manifest.id);
    const preferences = state.getAppStateSnapshot().preferences;
    const libraryMetadata = {
      sourceSite: "codex-pets.net", sourcePetId: "original-pet-id", kind: "animal",
      tags: ["cat", "white"], creatorName: "Uploader", creatorHandle: "uploader",
    } as const;
    const imported = await installPetFromFolderWithResult(folder, { origin: "codex", libraryMetadata });
    assert.deepEqual(imported.state.pets.installed.find(pet => pet.id === manifest.id)?.source,
      { kind: "codex", path: folder }, "a downloaded folder can be classified without writing to the native Codex pet directory");
    assert.deepEqual(imported.state.preferences, preferences);
    assert.deepEqual(imported.state.pets.installed.find(pet => pet.id === manifest.id)?.libraryMetadata, libraryMetadata);
    assert.equal(JSON.parse((await readFile(join(petsRoot, manifest.id, "pet.json"))).toString()).libraryMetadata, undefined,
      "source-catalog labels stay outside the artwork manifest");
    assert.deepEqual(await readFile(join(petsRoot, manifest.id, "spritesheet.webp")), bytes);

    await writeFile(join(folder, "pet.json"), JSON.stringify({ ...manifest, displayName: "Revised pet" }));
    const replaced = await installPetFromFolderWithResult(folder, { origin: "codex", libraryMetadata });
    assert.equal(replaced.state.pets.installed.filter(pet => pet.id === manifest.id).length, 1);
    assert.equal(replaced.state.pets.installed.find(pet => pet.id === manifest.id)?.displayName, "Revised pet");
    assert.deepEqual(replaced.state.preferences, preferences);
    assert.deepEqual(replaced.state.pets.installed.find(pet => pet.id === manifest.id)?.source, { kind: "codex", path: folder });
    assert.deepEqual(replaced.state.pets.installed.find(pet => pet.id === manifest.id)?.libraryMetadata, libraryMetadata);
    const before = await readFile(join(userData, "openpets-state.json"));
    const installedManifest = await readFile(join(petsRoot, manifest.id, "pet.json"));
    await writeFile(join(folder, "spritesheet.webp"), "invalid atlas bytes");
    await assert.rejects(installPetFromFolderWithResult(folder, { origin: "codex" }));
    assert.deepEqual(await readFile(join(userData, "openpets-state.json")), before,
      "provenance cannot bypass validation or partially update installed state");
    assert.deepEqual(await readFile(join(petsRoot, manifest.id, "pet.json")), installedManifest);
    assert.deepEqual(await readFile(join(petsRoot, manifest.id, "spritesheet.webp")), bytes);

    const installUnknown = installPetFromFolderWithResult as (path: string, options: unknown) => Promise<unknown>;
    await assert.rejects(installUnknown(join(root, "nonexistent"), { origin: "catalog" }), /origin/,
      "unknown origins are rejected by the owner before reading a source folder");
    await assert.rejects(installUnknown(join(root, "nonexistent"), { libraryMetadata }), /Codex-origin/);
    await assert.rejects(installUnknown(join(root, "nonexistent"), {
      origin: "codex", libraryMetadata: { ...libraryMetadata, sourceSite: "untrusted.example" },
    }), /library/, "the installer revalidates source labels even without the IPC adapter");

    const v1 = await sharp({ create: {
      width: 1536, height: 1872, channels: 4, background: { r: 40, g: 20, b: 80, alpha: 0.5 },
    } }).webp().toBuffer();
    for (const origin of ["openpets", "codex"] as const) {
      for (const version of [1, 2] as const) {
        await t.test(`${origin} V${version} ZIP preserves artwork, source and rollback`, async () => {
          const id = `${origin}-zip-v${version}`;
          const archive = join(root, `${id}.zip`);
          const sprite = version === 1 ? v1 : bytes;
          const petJson = { ...manifest, id, displayName: id, spriteVersionNumber: version };
          // Existing OpenPets packages may wrap their files in a folder;
          // Codex Pets ZIPs also use the supported flat package layout.
          const prefix = origin === "openpets" ? `${id}/` : "";
          const makeArchive = (image: Buffer) => storedZip([
            { name: `${prefix}pet.json`, contents: Buffer.from(JSON.stringify(petJson)) },
            { name: `${prefix}spritesheet.webp`, contents: image },
          ]);
          await writeFile(archive, makeArchive(sprite));
          const labels = { ...libraryMetadata, sourcePetId: id };
          const options = origin === "codex" ? {
            origin: "codex" as const,
            ...(version === 2 ? { libraryMetadata: labels } : {}),
          } : {};
          // Exercise both the UI convenience wrapper and IPC result entry.
          const installedState = version === 1
            ? await installPetFromZipFile(archive, options)
            : (await installPetFromZipFileWithResult(archive, options)).state;
          const installed = installedState.pets.installed.find(pet => pet.id === id)!;
          assert.deepEqual(installed.source, origin === "codex" ? { kind: "codex", path: archive } : undefined);
          assert.deepEqual(installed.libraryMetadata, origin === "codex" && version === 2 ? labels : undefined);
          assert.deepEqual(installedState.preferences, preferences);
          assert.deepEqual(await readFile(join(petsRoot, id, "spritesheet.webp")), sprite, "the import source never changes the artwork bytes");
          const savedManifest = await readFile(join(petsRoot, id, "pet.json"));
          assert.equal(JSON.parse(savedManifest.toString()).spriteVersionNumber, version === 2 ? 2 : undefined,
            "both ZIP sources use the same V1 normalization and V2 layout marker");
          const savedState = await readFile(join(userData, "openpets-state.json"));
          await writeFile(archive, makeArchive(Buffer.alloc(0)));
          await assert.rejects(installPetFromZipFileWithResult(archive, options));
          assert.deepEqual(await readFile(join(userData, "openpets-state.json")), savedState);
          assert.deepEqual(await readFile(join(petsRoot, id, "pet.json")), savedManifest);
          assert.deepEqual(await readFile(join(petsRoot, id, "spritesheet.webp")), sprite, "invalid ZIP replacement leaves the existing resource intact");
          if (origin === "codex" && version === 1) {
            const { migrateLegacyCodexV2Imports } = await import("../src/codex-pet-migration.js");
            const migration = await migrateLegacyCodexV2Imports([{ id, source: { kind: "codex", path: archive } }], {
              codexPetsRoot: join(root, "native-codex-pets"), installedPetsRoot: petsRoot,
            });
            assert.deepEqual(migration.entries, [{ id, status: "skipped", reason: "source-path-mismatch" }],
              "archive provenance is never treated as a native Codex source folder for legacy repair");
            assert.deepEqual(await readFile(join(petsRoot, id, "pet.json")), savedManifest);
          }
        });
      }
    }
  } finally {
    release();
    hooks?.deregister();
    await rm(root, { recursive: true, force: true });
  }
});
