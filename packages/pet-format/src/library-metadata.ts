/** Verified source-catalog labels, kept outside the artwork package manifest. */
export type PetLibraryKind = "animal" | "person" | "creature" | "object";
export interface PetLibraryMetadata {
  readonly sourceSite: "codex-pets.net";
  readonly sourcePetId: string;
  readonly kind: PetLibraryKind;
  readonly tags: readonly string[];
  /** Source-site uploader labels; these do not assert ownership of the depicted IP. */
  readonly creatorName?: string;
  readonly creatorHandle?: string;
}

const fields = new Set(["sourceSite", "sourcePetId", "kind", "tags", "creatorName", "creatorHandle"]);
const kinds = new Set<PetLibraryKind>(["animal", "person", "creature", "object"]);
function text(value: unknown, limit: number, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > limit || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`Invalid pet library ${label}.`);
  }
  return value.trim();
}

export function validatePetLibraryMetadata(value: unknown): PetLibraryMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid pet library metadata.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !fields.has(key)) || record.sourceSite !== "codex-pets.net"
    || !kinds.has(record.kind as PetLibraryKind) || !Array.isArray(record.tags) || record.tags.length > 64) {
    throw new Error("Invalid pet library metadata.");
  }
  const sourcePetId = text(record.sourcePetId, 256, "source ID");
  const tags = Object.freeze([...new Set(record.tags.map((tag) => text(tag, 80, "tag")))]);
  const creatorName = record.creatorName == null ? undefined : text(record.creatorName, 160, "uploader name");
  const creatorHandle = record.creatorHandle == null ? undefined : text(record.creatorHandle, 160, "uploader handle");
  return Object.freeze({ sourceSite: "codex-pets.net", sourcePetId, kind: record.kind as PetLibraryKind, tags,
    ...(creatorName ? { creatorName } : {}), ...(creatorHandle ? { creatorHandle } : {}) });
}

/** Persisted recovery drops malformed optional labels without breaking the artwork. */
export function normalizePetLibraryMetadata(value: unknown): PetLibraryMetadata | undefined {
  if (value === undefined) return undefined;
  try { return validatePetLibraryMetadata(value); } catch { return undefined; }
}
