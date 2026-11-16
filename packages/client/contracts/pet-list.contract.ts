import assert from "node:assert/strict";

import { readPetList, type OpenPetsPetListItem } from "../src/pet-list.js";
import { OpenPetsClientError } from "../src/protocol.js";

const pets: OpenPetsPetListItem[] = Array.from({ length: 1_336 }, (_, index) => ({
  id: `pet-${index}`,
  displayName: `猫咪 🐱 ${index} "friend"`,
  builtIn: index === 0,
  broken: index % 17 === 0,
}));
const revision = "a".repeat(64);
const offsets: number[] = [];
const complete = await readPetList(async (params) => {
  offsets.push(params.offset);
  assert.equal(params.revision, params.offset === 0 ? undefined : revision);
  const page = pets.slice(params.offset, params.offset + 37);
  const nextOffset = params.offset + page.length;
  return { ok: true, pets: page, defaultPetId: "pet-777", total: pets.length, revision, nextOffset: nextOffset < pets.length ? nextOffset : null };
});
assert.deepEqual(complete, { ok: true, pets, defaultPetId: "pet-777" });
assert.ok(offsets.length > 1, "large libraries must be fetched completely across pages");

const legacy = { ok: true, pets: pets.slice(0, 2), defaultPetId: "pet-0" };
assert.deepEqual(await readPetList(async () => legacy), legacy, "released small-list servers remain usable");
assert.deepEqual(await readPetList(async () => ({ ok: true, pets: [], defaultPetId: "builtin", total: 0, revision, nextOffset: null })), {
  ok: true, pets: [], defaultPetId: "builtin",
});

async function rejectsPages(pages: readonly unknown[]): Promise<void> {
  let calls = 0;
  await assert.rejects(readPetList(async () => {
    assert.ok(calls < pages.length, "invalid pages must fail without an unbounded request loop");
    return pages[calls++];
  }), (error: unknown) => error instanceof OpenPetsClientError && error.code === "invalid_response");
}

const first = { ok: true, pets: pets.slice(0, 1), defaultPetId: "pet-0", total: 2, revision, nextOffset: 1 };
const last = { ...first, pets: pets.slice(1, 2), nextOffset: null };
await rejectsPages([{ ...first, pets: [], nextOffset: 0 }]);
await rejectsPages([{ ...first, nextOffset: 0 }]);
await rejectsPages([{ ...first, nextOffset: 2 }]);
await rejectsPages([{ ...first, nextOffset: null }]);
await rejectsPages([{ ...first, total: 100_001 }]);
await rejectsPages([{ ...first, nextOffset: 1.5 }]);
await rejectsPages([{ ...first, revision: "invalid" }]);
await rejectsPages([first, { ...last, pets: first.pets }]);
await rejectsPages([first, { ...last, total: 3 }]);
await rejectsPages([first, { ...last, revision: "b".repeat(64) }]);
await rejectsPages([first, { ...last, defaultPetId: "changed" }]);
await rejectsPages([first, legacy]);
await rejectsPages([{ ...first, pets: [{ ...pets[0], displayName: "猫".repeat(6_000) }] }]);

console.log("Pet list pagination contracts passed (1336 complete entries and malformed-page bounds).");
