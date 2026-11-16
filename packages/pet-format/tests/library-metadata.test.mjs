import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizePetLibraryMetadata, validatePetLibraryMetadata } from '../dist/library-metadata.js';

const source = { sourceSite: 'codex-pets.net', sourcePetId: 'pet-6afb1cdc9dc08191bc7354ebc3ee3d1e', kind: 'person', tags: ['anime', 'cute'], creatorName: 'Uploader', creatorHandle: 'uploader' };
test('verified source labels are detached, bounded and immutable', () => {
  const input = { ...source, tags: [' anime ', 'cute', 'anime'] };
  const metadata = validatePetLibraryMetadata(input);
  input.tags.push('unknown');
  assert.deepEqual(metadata.tags, ['anime', 'cute']);
  assert.ok(Object.isFrozen(metadata) && Object.isFrozen(metadata.tags));
  assert.equal(metadata.sourcePetId, source.sourcePetId);
});
test('invalid provenance and malformed optional labels cannot become classifications', () => {
  for (const patch of [{ sourceSite: 'elsewhere.invalid' }, { kind: 'anime' }, { tags: [42] }, { tags: ['x'.repeat(81)] }, { tags: Array(65).fill('x') }, { sourcePetId: '' }, { creatorName: 'bad\nname' }, { unknownField: true }]) {
    assert.throws(() => validatePetLibraryMetadata({ ...source, ...patch }));
    assert.equal(normalizePetLibraryMetadata({ ...source, ...patch }), undefined);
  }
  assert.equal(normalizePetLibraryMetadata(undefined), undefined);
  assert.deepEqual(validatePetLibraryMetadata({ ...source, creatorName: null, creatorHandle: null }).tags, source.tags);
});
