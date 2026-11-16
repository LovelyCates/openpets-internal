import { maxIpcMessageBytes, OpenPetsClientError } from "./protocol.js";

const maxPetListItems = 100_000;
const maxPetListPages = 4_096;
const maxPetListBytes = 64 * 1024 * 1024;

export interface OpenPetsPetListResult {
  readonly ok: true;
  readonly pets: readonly OpenPetsPetListItem[];
  readonly defaultPetId: string;
}

export interface OpenPetsPetListItem {
  readonly id: string;
  readonly displayName: string;
  readonly builtIn: boolean;
  readonly broken: boolean;
}

interface PetListPageParams {
  readonly offset: number;
  readonly revision?: string;
}

/** Keeps the public listPets() result complete while each IPC response stays small. */
export async function readPetList(fetchPage: (params: PetListPageParams) => Promise<unknown>): Promise<OpenPetsPetListResult> {
  const pets: OpenPetsPetListItem[] = [];
  const seenIds = new Set<string>();
  let revision: string | undefined;
  let total: number | undefined;
  let defaultPetId: string | undefined;
  let bytes = 0;

  for (let pageNumber = 0; pageNumber < maxPetListPages; pageNumber += 1) {
    const value = await fetchPage({ offset: pets.length, ...(revision === undefined ? {} : { revision }) });
    const pageBytes = Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
    bytes += pageBytes;
    if (pageBytes > maxIpcMessageBytes || bytes > maxPetListBytes) invalidList("OpenPets pet list exceeds supported bounds.");
    const page = parsePetListResult(value);
    if (!isRecord(value)) invalidList();
    const paginated = value.total !== undefined || value.revision !== undefined || value.nextOffset !== undefined;
    if (!paginated) {
      // Released servers ignore offset and return their complete small list.
      if (pageNumber !== 0 || page.pets.length > maxPetListItems) invalidList();
      return page;
    }
    if (typeof value.total !== "number" || !Number.isSafeInteger(value.total) || value.total < 0 || value.total > maxPetListItems
      || typeof value.revision !== "string" || !/^[a-f0-9]{64}$/.test(value.revision)
      || (value.nextOffset !== null && (typeof value.nextOffset !== "number" || !Number.isSafeInteger(value.nextOffset)))) {
      invalidList();
    }
    if (revision !== undefined && (revision !== value.revision || total !== value.total || defaultPetId !== page.defaultPetId)) {
      invalidList("OpenPets pet list changed while being read; retry listPets().");
    }
    revision = value.revision;
    total = value.total;
    defaultPetId = page.defaultPetId;
    const nextOffset = pets.length + page.pets.length;
    if (nextOffset > total || (page.pets.length === 0 && total !== 0)) invalidList();
    for (const pet of page.pets) {
      if (seenIds.has(pet.id)) invalidList("OpenPets pet list contains duplicate entries.");
      seenIds.add(pet.id);
      pets.push(pet);
    }
    if (value.nextOffset === null) {
      if (pets.length !== total) invalidList();
      return { ok: true, pets, defaultPetId };
    }
    if (value.nextOffset !== nextOffset || nextOffset >= total) invalidList();
  }
  return invalidList("OpenPets pet list requires too many pages.");
}

export function parsePetListResult(value: unknown): OpenPetsPetListResult {
  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.pets) || typeof value.defaultPetId !== "string") invalidList();
  return { ok: true, defaultPetId: value.defaultPetId, pets: value.pets.map(parsePetListItem) };
}

function parsePetListItem(value: unknown): OpenPetsPetListItem {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.displayName !== "string" || typeof value.builtIn !== "boolean" || typeof value.broken !== "boolean") {
    invalidList("OpenPets pet list item is invalid.");
  }
  return { id: value.id, displayName: value.displayName, builtIn: value.builtIn, broken: value.broken };
}

function invalidList(message = "OpenPets pet list response is invalid."): never {
  throw new OpenPetsClientError("invalid_response", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
