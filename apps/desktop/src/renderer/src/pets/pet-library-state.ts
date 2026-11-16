import type { PetLibraryKind, PetLibraryMetadata } from "@open-pets/pet-format/library-metadata";

export const petLibraryFilters = ["all", "installed", "favorites", "codex", "v1", "v2", "motion", "outfits", "activities", "featured", "originals"] as const;
export type PetLibraryFilter = typeof petLibraryFilters[number];

export interface PetLibraryEntry {
  readonly id: string;
  readonly displayName: string;
  readonly description?: string;
  readonly searchText?: string;
  readonly installed?: boolean;
  readonly favorite?: boolean;
  readonly builtIn?: boolean;
  readonly original?: boolean;
  readonly featured?: boolean;
  readonly sourceKind?: "installed" | "catalog" | "codex";
  readonly importedFromCodex?: boolean;
  readonly catalogPage?: number;
  readonly format?: "classic" | "motion";
  readonly spriteLayout?: { readonly version: 1 | 2 };
  readonly capabilities?: { readonly outfits: boolean; readonly activities: boolean; readonly gaze: boolean };
  readonly libraryMetadata?: PetLibraryMetadata;
}

export interface PetLibraryFacets {
  readonly kind?: PetLibraryKind | "unclassified";
  readonly tag?: string;
  readonly uploader?: string;
}

export const petLibraryTagLabelKeys: Readonly<Record<string, string>> = Object.fromEntries([
  "cute", "animated", "anime", "pixel", "mascot", "game", "soft", "celeb", "retro", "robot", "weird",
  "hand-drawn", "minimal", "chaotic", "spooky", "utility", "animal", "nsfw", "clippy", "person", "creature", "object",
].map((tag) => [tag, `pets.tag.${tag}`]));

export interface PetLibraryPagination {
  readonly filter: PetLibraryFilter;
  readonly query: string;
  readonly page: number;
  readonly facetKey?: string;
}

/** Bound mounted atlases independently of the remote catalog's page size. */
export const petLibraryPageSize = 24;
export const initialPetLibraryPagination: PetLibraryPagination = { filter: "all", query: "", page: 0 };

function matchesFilter(pet: PetLibraryEntry, filter: PetLibraryFilter): boolean {
  if (filter === "installed") return pet.installed === true;
  if (filter === "favorites") return pet.favorite === true;
  if (filter === "codex") return pet.sourceKind === "codex" || pet.importedFromCodex === true;
  if (filter === "originals") return pet.original === true || pet.builtIn === true;
  if (filter === "featured") return pet.featured === true && !pet.original;
  if (filter === "motion") return pet.format === "motion";
  if (filter === "v1" || filter === "v2") return pet.format !== "motion" && pet.spriteLayout?.version === (filter === "v1" ? 1 : 2);
  if (filter === "outfits") return pet.capabilities?.outfits === true;
  if (filter === "activities") return pet.capabilities?.activities === true;
  return true;
}

function normalizeSearch(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[-_]+/g, " ");
}

function matchesSearch(pet: PetLibraryEntry, terms: readonly string[]): boolean {
  if (!terms.length) return true;
  // These labels describe verified source/layout/capabilities; artwork themes
  // and translated character aliases are never guessed from the image or ID.
  const labels = [
    pet.installed ? "installed 已安装 已安裝" : "",
    matchesFilter(pet, "codex") ? "codex" : "",
    matchesFilter(pet, "v1") ? "v1" : "",
    matchesFilter(pet, "v2") ? "v2" : "",
    matchesFilter(pet, "motion") ? "motion" : "",
    matchesFilter(pet, "outfits") ? "outfits wardrobe 装扮 裝扮" : "",
    matchesFilter(pet, "activities") ? "activities 动作 動作" : "",
  ];
  const metadata = pet.libraryMetadata;
  const text = normalizeSearch([pet.displayName, pet.description ?? "", pet.searchText ?? "", pet.id,
    metadata?.sourcePetId ?? "", metadata?.kind ?? "", ...(metadata?.tags ?? []), metadata?.creatorName ?? "", metadata?.creatorHandle ?? "", ...labels].join(" "));
  return terms.every((term) => text.includes(term));
}

function uploader(pet: PetLibraryEntry): string | undefined {
  return pet.libraryMetadata?.creatorHandle ?? pet.libraryMetadata?.creatorName;
}

function matchesFacets(pet: PetLibraryEntry, facets: PetLibraryFacets): boolean {
  return (!facets.kind || (facets.kind === "unclassified" ? !pet.libraryMetadata : pet.libraryMetadata?.kind === facets.kind))
    && (!facets.tag || pet.libraryMetadata?.tags.includes(facets.tag) === true)
    && (!facets.uploader || uploader(pet) === facets.uploader);
}

function countValues(values: readonly string[]): readonly { readonly value: string; readonly count: number }[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/** Installed cards use local artwork; only their selected detail needs catalog extras. */
export function getPetLibraryHydrationPages(
  visible: readonly PetLibraryEntry[],
  selected: PetLibraryEntry | null,
  loadedPages: Readonly<Record<number, unknown>>,
): readonly number[] {
  const pages = new Set<number>();
  const addPage = (pet: PetLibraryEntry): void => {
    const page = pet.catalogPage;
    if (typeof page === "number" && Number.isSafeInteger(page) && page >= 0 && loadedPages[page] === undefined) {
      pages.add(page);
    }
  };
  for (const pet of visible) {
    if (pet.sourceKind === "catalog") addPage(pet);
  }
  if (selected?.sourceKind === "catalog" || selected?.sourceKind === "installed") {
    addPage(selected);
  }
  return [...pages];
}

export function buildPetLibraryView<T extends PetLibraryEntry>(
  entries: readonly T[],
  filter: PetLibraryFilter,
  query: string,
  requested: PetLibraryPagination,
  selectedId: string,
  facets: PetLibraryFacets = {},
): {
  readonly items: readonly T[];
  readonly total: number;
  readonly pageCount: number;
  readonly pagination: PetLibraryPagination;
  readonly selected: T | null;
  readonly counts: Readonly<Record<PetLibraryFilter, number>>;
  readonly facets: {
    readonly kinds: readonly { readonly value: string; readonly count: number }[];
    readonly tags: readonly { readonly value: string; readonly count: number }[];
    readonly uploaders: readonly { readonly value: string; readonly count: number }[];
  };
} {
  const terms = normalizeSearch(query).trim().split(/\s+/).filter(Boolean);
  const searched = entries.filter((pet) => matchesSearch(pet, terms));
  const qualified = searched.filter((pet) => matchesFacets(pet, facets));
  const counts = Object.fromEntries(petLibraryFilters.map((value) => [value, qualified.filter((pet) => matchesFilter(pet, value)).length])) as Record<PetLibraryFilter, number>;
  const matches = qualified.filter((pet) => matchesFilter(pet, filter));
  const sourceMatches = searched.filter((pet) => matchesFilter(pet, filter));
  const kindRows = sourceMatches.filter((pet) => matchesFacets(pet, { ...facets, kind: undefined }));
  const tagRows = sourceMatches.filter((pet) => matchesFacets(pet, { ...facets, tag: undefined }));
  const uploaderRows = sourceMatches.filter((pet) => matchesFacets(pet, { ...facets, uploader: undefined }));
  const facetKey = JSON.stringify([facets.kind ?? "", facets.tag ?? "", facets.uploader ?? ""]);
  const pageCount = Math.max(1, Math.ceil(matches.length / petLibraryPageSize));
  const sameSearch = requested.filter === filter && requested.query === query && (requested.facetKey ?? '["","",""]') === facetKey;
  const requestedPage = sameSearch && Number.isFinite(requested.page) ? Math.trunc(requested.page) : 0;
  const page = Math.max(0, Math.min(requestedPage, pageCount - 1));
  return {
    items: matches.slice(page * petLibraryPageSize, (page + 1) * petLibraryPageSize),
    total: matches.length,
    counts,
    facets: {
      kinds: countValues(kindRows.map((pet) => pet.libraryMetadata?.kind ?? "unclassified")),
      tags: countValues(tagRows.flatMap((pet) => [...new Set(pet.libraryMetadata?.tags ?? [])])),
      uploaders: countValues(uploaderRows.flatMap((pet) => uploader(pet) ? [uploader(pet)!] : [])),
    },
    pageCount,
    pagination: { filter, query, page, facetKey },
    // Detail ownership is independent of the current page and active filters.
    selected: selectedId ? entries.find((pet) => pet.id === selectedId) ?? null : null,
  };
}
