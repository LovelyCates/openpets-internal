import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPetLibraryView,
  getPetLibraryHydrationPages,
  initialPetLibraryPagination,
  petLibraryPageSize,
  type PetLibraryEntry,
} from "../src/renderer/src/pets/pet-library-state.js";

const installed = Array.from({ length: 1_336 }, (_, index) => ({
  id: `pet-${index}`,
  displayName: index === 1_335 ? "Last Needle Cat" : `Pet ${index}`,
  description: index === 900 ? "A hidden description match" : "Local pet",
  installed: true,
  sourceKind: "installed" as const,
  spritesheet: `openpets-installed://spritesheet/pet-${index}`,
}));

test("a large local library exposes only one page of atlas cards", () => {
  const first = buildPetLibraryView(installed, "all", "", initialPetLibraryPagination, "");
  assert.equal(first.total, 1_336);
  assert.equal(first.items.length, petLibraryPageSize);
  assert.equal(first.items[0]?.id, "pet-0");

  const second = buildPetLibraryView(installed, "all", "", { ...first.pagination, page: 1 }, "");
  assert.equal(second.items.length, petLibraryPageSize);
  assert.equal(second.items[0]?.id, `pet-${petLibraryPageSize}`);
  assert.equal(second.items.some((pet) => first.items.includes(pet)), false, "the next page replaces, rather than accumulates, mounted atlas entries");

  const last = buildPetLibraryView(installed, "all", "", { ...first.pagination, page: 999 }, "");
  assert.equal(last.pagination.page, last.pageCount - 1);
  assert.equal(last.items.at(-1)?.id, "pet-1335");
  assert.ok(last.items.length <= petLibraryPageSize);
});

test("search covers the entire local library and starts at the first result page", () => {
  const previous = { filter: "all" as const, query: "", page: 50 };
  const byName = buildPetLibraryView(installed, "all", " NEEDLE ", previous, "");
  assert.equal(byName.pagination.page, 0);
  assert.deepEqual(byName.items.map((pet) => pet.id), ["pet-1335"]);
  const byDescription = buildPetLibraryView(installed, "installed", "hidden description", previous, "");
  assert.deepEqual(byDescription.items.map((pet) => pet.id), ["pet-900"]);
  const byId = buildPetLibraryView(installed, "all", "pet-1334", previous, "");
  assert.deepEqual(byId.items.map((pet) => pet.id), ["pet-1334"]);
});

test("filters cover all sources and reset pagination without losing the selected detail", () => {
  const entries: PetLibraryEntry[] = [
    ...installed,
    { id: "builtin", displayName: "Built-in", installed: true, builtIn: true },
    { id: "featured", displayName: "Featured", sourceKind: "catalog", featured: true },
    { id: "original", displayName: "Original", sourceKind: "catalog", original: true, featured: true },
    { id: "codex-source", displayName: "Codex", sourceKind: "codex" },
    { id: "codex-installed", displayName: "Imported", sourceKind: "installed", installed: true, importedFromCodex: true },
  ];
  const previous = { filter: "all" as const, query: "", page: 40 };
  const local = buildPetLibraryView(entries, "installed", "", previous, "pet-1335");
  assert.equal(local.pagination.page, 0);
  assert.equal(local.total, installed.length + 2);
  assert.equal(local.selected?.id, "pet-1335", "a detail remains open even when its card is on another page");
  const featured = buildPetLibraryView(entries, "featured", "", previous, "pet-1335");
  assert.deepEqual(featured.items.map((pet) => pet.id), ["featured"]);
  assert.equal(featured.selected?.id, "pet-1335", "changing a filter does not discard the selected pet");
  assert.deepEqual(buildPetLibraryView(entries, "originals", "", previous, "").items.map((pet) => pet.id), ["builtin", "original"]);
  assert.deepEqual(buildPetLibraryView(entries, "codex", "", previous, "").items.map((pet) => pet.id), ["codex-source", "codex-installed"]);
});

test("data shrink clamps the current page and empty results have a valid pager", () => {
  const requested = { filter: "installed" as const, query: "", page: 55 };
  const smaller = buildPetLibraryView(installed.slice(0, 50), "installed", "", requested, "pet-49");
  assert.equal(smaller.pagination.page, 2);
  assert.deepEqual(smaller.items.map((pet) => pet.id), ["pet-48", "pet-49"]);
  const removedLastPage = buildPetLibraryView(installed.slice(0, 48), "installed", "", smaller.pagination, "pet-49");
  assert.equal(removedLastPage.pagination.page, 1);
  assert.equal(removedLastPage.selected, null, "removed pets cannot keep a stale detail record");

  const empty = buildPetLibraryView([], "installed", "", requested, "");
  assert.equal(empty.total, 0);
  assert.equal(empty.pagination.page, 0);
  assert.equal(empty.pageCount, 1);
  assert.deepEqual(empty.items, []);
});

test("catalog search entries participate before their artwork page is loaded", () => {
  const entries: PetLibraryEntry[] = [
    ...installed,
    { id: "unloaded", displayName: "Cloud Cat", searchText: "astronaut space", sourceKind: "catalog", featured: true },
  ];
  const result = buildPetLibraryView(entries, "all", "astronaut", initialPetLibraryPagination, "pet-1335");
  assert.deepEqual(result.items.map((pet) => pet.id), ["unloaded"]);
  assert.equal(result.selected?.id, "pet-1335");
  const internal = buildPetLibraryView(installed, "installed", "", initialPetLibraryPagination, "");
  assert.equal(internal.total, installed.length, "a disabled public catalog does not limit the local installed library");
});

test("only a selected installed detail hydrates its catalog extras page", () => {
  const entries = installed.map((pet, index) => ({ ...pet, catalogPage: Math.floor(index / 24) }));
  const view = buildPetLibraryView(entries, "installed", "", initialPetLibraryPagination, "pet-1335");
  assert.deepEqual(getPetLibraryHydrationPages(view.items, null, {}), [], "the visible installed cards do not hydrate their catalog pages");
  const requested = getPetLibraryHydrationPages(view.items, view.selected, {});
  assert.deepEqual(requested, [55], "an installed detail outside the visible page loads its one extras page");
  assert.deepEqual(getPetLibraryHydrationPages(view.items, view.selected, { 55: [] }), [], "a loaded page is not requested again");
  const offline = buildPetLibraryView(installed, "installed", "", initialPetLibraryPagination, "pet-1335");
  assert.deepEqual(getPetLibraryHydrationPages(offline.items, offline.selected, {}), [], "offline installed details with no catalog page make no network request");
});

test("visible catalog cards and selected details share one bounded page request", () => {
  const catalog = { id: "catalog-pet", displayName: "Catalog", sourceKind: "catalog" as const, catalogPage: 7 };
  const selected = { id: "installed-pet", displayName: "Installed", sourceKind: "installed" as const, catalogPage: 7 };
  assert.deepEqual(getPetLibraryHydrationPages([catalog, { ...catalog, id: "another" }], selected, {}), [7]);
  assert.deepEqual(getPetLibraryHydrationPages([catalog], { ...selected, catalogPage: 8 }, { 7: [] }), [8]);
  assert.deepEqual(getPetLibraryHydrationPages([], { ...selected, catalogPage: -1 }, {}), []);
});

test("multi-term search combines Unicode names, IDs and verified capability labels", () => {
  const pets: PetLibraryEntry[] = [
    { id: "denia-codex-v1", displayName: "达妮娅 Denia", installed: true, importedFromCodex: true, spriteLayout: { version: 1 } },
    { id: "hoodie-cat", displayName: "Hoodie Cat", installed: true, spriteLayout: { version: 2 }, capabilities: { outfits: true, activities: false, gaze: true } },
  ];
  const search = (query: string) => buildPetLibraryView(pets, "all", query, initialPetLibraryPagination, "").items.map((pet) => pet.id);
  assert.deepEqual(search("达妮娅 V1"), ["denia-codex-v1"]);
  assert.deepEqual(search("ＣＯＤＥＸ denia"), ["denia-codex-v1"]);
  assert.deepEqual(search("hoodie_cat 装扮"), ["hoodie-cat"]);
  assert.deepEqual(search("Denia 装扮"), [], "a character never gets an invented capability tag");
});

test("metadata filters and counts distinguish source, sprite layout and optional capabilities", () => {
  const pets: PetLibraryEntry[] = [
    { id: "local-v1", displayName: "Cat", installed: true, spriteLayout: { version: 1 } },
    { id: "from-codex", displayName: "Cat", installed: true, importedFromCodex: true, spriteLayout: { version: 2 }, capabilities: { outfits: true, activities: true, gaze: true } },
    { id: "motion", displayName: "Cat", format: "motion", spriteLayout: { version: 1 } },
    { id: "unknown", displayName: "Dog", installed: true },
  ];
  const view = buildPetLibraryView(pets, "codex", "Cat", initialPetLibraryPagination, "");
  assert.deepEqual(view.items.map((pet) => pet.id), ["from-codex"]);
  assert.deepEqual(view.counts, { all: 3, installed: 2, favorites: 0, codex: 1, v1: 1, v2: 1, motion: 1, outfits: 1, activities: 1, featured: 0, originals: 0 });
  assert.deepEqual(buildPetLibraryView(pets, "v1", "", initialPetLibraryPagination, "").items.map((pet) => pet.id), ["local-v1"], "Motion and unknown layouts are not guessed to be V1");
  assert.equal(buildPetLibraryView(pets, "all", "", initialPetLibraryPagination, "").counts.codex, 1, "generic local imports are not guessed to come from Codex");
});

test("verified source facets combine and reset pagination while preserving favorite identity", () => {
  const metadata = { sourceSite: "codex-pets.net" as const, sourcePetId: "original-source-id", kind: "animal" as const, tags: ["cute", "anime"], creatorName: "Uploader", creatorHandle: "one" };
  const pets: PetLibraryEntry[] = [
    { id: "import-a", displayName: "Cat", favorite: true, installed: true, importedFromCodex: true, libraryMetadata: metadata },
    { id: "import-b", displayName: "Dog", installed: true, importedFromCodex: true, libraryMetadata: { ...metadata, sourcePetId: "other", kind: "person", tags: ["anime"], creatorHandle: "two" } },
    { id: "unknown", displayName: "Cat", favorite: true, installed: true },
  ];
  const view = buildPetLibraryView(pets, "codex", "", { filter: "codex", query: "", page: 20 }, "", { kind: "animal", tag: "anime" });
  assert.deepEqual(view.items.map((pet) => pet.id), ["import-a"]);
  assert.equal(view.pagination.page, 0);
  assert.deepEqual(view.facets.kinds, [{ value: "animal", count: 1 }, { value: "person", count: 1 }]);
  assert.deepEqual(view.facets.tags, [{ value: "anime", count: 1 }, { value: "cute", count: 1 }]);
  assert.deepEqual(view.facets.uploaders, [{ value: "one", count: 1 }]);
  assert.deepEqual(buildPetLibraryView(pets, "favorites", "", initialPetLibraryPagination, "").items.map((pet) => pet.id), ["import-a", "unknown"]);
  assert.deepEqual(buildPetLibraryView(pets, "all", "original source id Uploader", initialPetLibraryPagination, "").items.map((pet) => pet.id), ["import-a"], "search uses the actual source ID and uploader, independent of import ID");
});
