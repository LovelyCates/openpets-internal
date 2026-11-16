import { createHash } from "node:crypto";

import { IpcProtocolError, isRecord, maxIpcMessageBytes, okResponse } from "./local-ipc-protocol.js";

const maxPetListItems = 100_000;

interface PetListItem {
  readonly id: string;
  readonly displayName: string;
  readonly builtIn: boolean;
  readonly broken?: boolean;
}

/** Stateless pages are bound to the installed metadata, without retaining snapshots. */
export function createPetListResult(
  requestId: string,
  params: unknown,
  installed: readonly PetListItem[],
  defaultPetId: string,
): unknown {
  if (installed.length > maxPetListItems) {
    throw new IpcProtocolError("list_too_large", "The installed pet list exceeds the supported size.");
  }
  const pets = installed.map((pet) => ({
    id: pet.id,
    displayName: pet.displayName,
    builtIn: pet.builtIn,
    broken: pet.broken === true,
  }));
  const pageParams = isRecord(params) ? params : {};
  if (pageParams.offset === undefined) {
    if (pageParams.revision !== undefined) {
      throw new IpcProtocolError("invalid_params", "A pet list revision requires an offset.");
    }
    const result = { ok: true, pets, defaultPetId };
    if (responseBytes(requestId, result) > maxIpcMessageBytes) {
      throw new IpcProtocolError("pagination_required", "The installed pet list requires pagination; request pets.list with offset 0.");
    }
    return result;
  }

  const offset = pageParams.offset;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset > pets.length) {
    throw new IpcProtocolError("invalid_params", "Pet list offset is invalid.");
  }
  if (pageParams.revision !== undefined && (typeof pageParams.revision !== "string" || !/^[a-f0-9]{64}$/.test(pageParams.revision))) {
    throw new IpcProtocolError("invalid_params", "Pet list revision is invalid.");
  }
  if (offset > 0 && pageParams.revision === undefined) {
    throw new IpcProtocolError("invalid_params", "Continuing a pet list requires its revision.");
  }

  const hash = createHash("sha256").update(JSON.stringify(defaultPetId));
  const serializedPets = pets.map((pet) => JSON.stringify(pet));
  for (const pet of serializedPets) hash.update("\n").update(pet);
  const revision = hash.digest("hex");
  if (pageParams.revision !== undefined && pageParams.revision !== revision) {
    throw new IpcProtocolError("list_changed", "The installed pet list changed; restart pets.list at offset 0.");
  }

  const page: typeof pets = [];
  const result = { ok: true, pets: page, defaultPetId, total: pets.length, revision, nextOffset: null as number | null };
  // Include the complete envelope, escaped request ID and terminating newline.
  // Reserve the larger of the final null and any possible continuation offset.
  let bytes = Math.max(
    responseBytes(requestId, result),
    responseBytes(requestId, { ...result, nextOffset: pets.length }),
  );
  if (bytes > maxIpcMessageBytes) {
    throw new IpcProtocolError("list_too_large", "The pet list metadata cannot fit in an IPC list page.");
  }
  for (let index = offset; index < pets.length; index += 1) {
    const itemBytes = Buffer.byteLength(serializedPets[index]!, "utf8") + (page.length > 0 ? 1 : 0);
    if (bytes + itemBytes > maxIpcMessageBytes) {
      if (page.length === 0) {
        throw new IpcProtocolError("pet_list_item_too_large", "An installed pet cannot fit in an IPC list page.");
      }
      break;
    }
    page.push(pets[index]!);
    bytes += itemBytes;
  }
  const nextOffset = offset + page.length;
  result.nextOffset = nextOffset < pets.length ? nextOffset : null;
  return result;
}

function responseBytes(requestId: string, result: unknown): number {
  return Buffer.byteLength(`${JSON.stringify(okResponse(requestId, result))}\n`, "utf8");
}
