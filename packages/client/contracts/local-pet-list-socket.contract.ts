import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOpenPetsClient, type OpenPetsPetListItem } from "../src/index.js";
import { maxIpcMessageBytes, OpenPetsClientError } from "../src/protocol.js";

const pets: OpenPetsPetListItem[] = Array.from({ length: 1_336 }, (_, index) => ({
  id: `pet-${index}`,
  displayName: `桌宠 🐱 ${index} "friend"`,
  builtIn: index === 0,
  broken: index % 31 === 0,
}));
const root = await mkdtemp(join(process.platform === "win32" ? tmpdir() : "/tmp", "openpets-list-"));
const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\openpets-list-${randomUUID()}` : join(root, "openpets-list.sock");
const discoveryPath = join(root, "ipc.json");
const revision = "a".repeat(64);
const sockets = new Set<net.Socket>();
const offsets: number[] = [];
const installs: unknown[] = [];
const server = net.createServer((socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    assert.ok(Buffer.byteLength(buffer, "utf8") <= maxIpcMessageBytes);
    const request = JSON.parse(buffer.slice(0, newline)) as { id: string; method: string; params: { offset: number; revision?: string } };
    if (request.method === "pets.install-local") {
      installs.push(request.params);
      socket.end(`${JSON.stringify({ id: request.id, ok: true, result: {
        ok: true, petId: "local-pet", displayName: "Local pet", installed: true,
      } })}\n`);
      return;
    }
    assert.equal(request.method, "pets.list");
    const { offset } = request.params;
    offsets.push(offset);
    assert.equal(request.params.revision, offset === 0 ? undefined : revision);
    const page = pets.slice(offset, offset + 37);
    const nextOffset = offset + page.length;
    const response = `${JSON.stringify({ id: request.id, ok: true, result: {
      ok: true, pets: page, defaultPetId: "pet-777", total: pets.length, revision, nextOffset: nextOffset < pets.length ? nextOffset : null,
    } })}\n`;
    assert.ok(Buffer.byteLength(response, "utf8") <= maxIpcMessageBytes, "each complete wire response keeps the 16KiB cap");
    // Multiple writes also exercise the client's line framing.
    const frame = Buffer.from(response, "utf8");
    const split = Math.floor(frame.length / 2);
    socket.write(frame.subarray(0, split));
    socket.end(frame.subarray(split));
  });
});
try {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  await writeFile(discoveryPath, JSON.stringify({ protocol: "openpets-ipc", protocolVersion: 1, endpoint, token: "x".repeat(32), appVersion: "test", pid: process.pid, platform: process.platform }), { mode: 0o600 });
  const client = createOpenPetsClient({ remote: false, discoveryPath });
  const result = await client.listPets();
  assert.deepEqual(result, { ok: true, pets, defaultPetId: "pet-777" });
  assert.ok(offsets.length > 1);
  const folder = join(root, "source-pet");
  const zip = join(root, "source-pet.zip");
  await client.installLocalPet(folder, { kind: "folder" });
  await client.installLocalPet(zip, { kind: "zip" });
  const imported = await client.installLocalPet(folder, { kind: "folder", origin: "codex" });
  const libraryMetadata = {
    sourceSite: "codex-pets.net", sourcePetId: "source-pet-id", kind: "animal", tags: ["cat", "white"],
    creatorName: "Uploader", creatorHandle: "uploader",
  } as const;
  await client.installLocalPet(folder, { kind: "folder", origin: "codex", libraryMetadata });
  await client.installLocalPet(zip, { kind: "zip", origin: "codex" });
  await client.installLocalPet(zip, { kind: "zip", origin: "codex", libraryMetadata });
  assert.equal(imported.installed, true);
  assert.deepEqual(installs, [
    { path: folder, kind: "folder" },
    { path: zip, kind: "zip" },
    { path: folder, kind: "folder", origin: "codex" },
    { path: folder, kind: "folder", origin: "codex", libraryMetadata },
    { path: zip, kind: "zip", origin: "codex" },
    { path: zip, kind: "zip", origin: "codex", libraryMetadata },
  ], "plain imports preserve their wire shape; explicit Codex ZIP/folder provenance survives the client");
  const installUnknown = client.installLocalPet as (path: string, options: unknown) => Promise<unknown>;
  for (const options of [
    { kind: "zip", origin: "catalog" }, { kind: "folder", origin: "catalog" },
    { kind: "folder", origin: null }, { kind: "folder", origin: {} },
    { kind: "folder", libraryMetadata },
  ]) {
    await assert.rejects(installUnknown(folder, options), (error: unknown) => error instanceof OpenPetsClientError && error.code === "invalid_params");
  }
  assert.equal(installs.length, 6, "invalid provenance associations never reach the socket");
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
console.log("Local socket pet list pagination passed (1336 complete entries).");
