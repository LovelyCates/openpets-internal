import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { validatePetCatalog } from './validate-pet-catalog.mjs';

const installer = fileURLToPath(new URL('./validate-pet-catalog.mjs', import.meta.url));
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const sharp = require('sharp');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};

// Minimal stored ZIP fixture, including correct CRCs and central-directory
// offsets, exercises the shipped archive reader rather than a fake extractor.
function storedZip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [fileName, content] of Object.entries(files)) {
    const name = Buffer.from(fileName);
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    let checksum = 0xffffffff;
    for (const byte of bytes) {
      checksum ^= byte;
      for (let bit = 0; bit < 8; bit += 1) checksum = (checksum >>> 1) ^ ((checksum & 1) ? 0xedb88320 : 0);
    }
    checksum = (checksum ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, bytes);
    const index = Buffer.alloc(46);
    index.writeUInt32LE(0x02014b50, 0);
    index.writeUInt16LE(20, 4);
    index.writeUInt16LE(20, 6);
    index.writeUInt32LE(checksum, 16);
    index.writeUInt32LE(bytes.length, 20);
    index.writeUInt32LE(bytes.length, 24);
    index.writeUInt16LE(name.length, 28);
    index.writeUInt32LE(offset, 42);
    central.push(index, name);
    offset += header.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

const atlas = (version) => sharp({ create: {
  width: 1536, height: version === 2 ? 2288 : 1872, channels: 4,
  background: { r: 20, g: 40, b: 60, alpha: 0.5 },
} }).webp().toBuffer();

async function fixture(t, entries) {
  const root = await fs.mkdtemp('/private/tmp/openpets offline validation ');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const zipDir = path.join(root, 'ZIP files with spaces');
  const reportDir = path.join(root, 'validation reports');
  const catalog = path.join(root, 'catalog.entries.json');
  await fs.mkdir(zipDir);
  await fs.writeFile(catalog, JSON.stringify({ total: entries.length, entries }));
  const options = { catalog, zipDir, reportDir, log() {} };
  return {
    root, options, zipDir, reportDir, catalog,
    async write(id, version = 1, overrides = {}, image) {
      const metadata = { id, displayName: id, description: 'Fixture package', spritesheetPath: 'spritesheet.webp', spriteVersionNumber: version, ...overrides };
      const bytes = storedZip({ 'pet.json': JSON.stringify(metadata), 'spritesheet.webp': image ?? await atlas(version) });
      await fs.writeFile(path.join(zipDir, `${id}.zip`), bytes);
      return bytes;
    },
    async json(name) { return JSON.parse(await fs.readFile(path.join(reportDir, name), 'utf8')); },
  };
}

const entry = (id) => ({ id, zip: `https://zip.openpets.dev/pets/${id}/${id}.zip` });

test('mixed V1 and V2 packages get full ZIP/file hashes, metadata and clean staging', async (t) => {
  const f = await fixture(t, [entry('v1-cat'), entry('v2-cat')]);
  const first = await f.write('v1-cat');
  await f.write('v2-cat', 2);
  const { summary } = await validatePetCatalog(f.options);
  assert.equal(summary.validated, 2);
  assert.equal(summary.failed, 0);
  const report = await f.json('report.json');
  const v1 = report.results.find((result) => result.id === 'v1-cat');
  assert.equal(v1.zip.sha256, sha(first));
  assert.equal(v1.zip.bytes, first.length);
  assert.equal(v1.metadata.id, 'v1-cat');
  assert.equal(v1.metadata.spriteVersionNumber, undefined, 'legacy marker is normalized like the real installer');
  assert.deepEqual(v1.v1Atlas, {
    width: 1536, height: 1872, hasAlpha: true,
    pages: 1, animated: false, delay: [], fullyDecoded: true,
  });
  assert.ok(v1.files.some((file) => file.path === 'pet.json' && file.bytes > 0 && /^[a-f\d]{64}$/.test(file.sha256)));
  assert.equal(report.results.find((result) => result.id === 'v2-cat').spriteVersionNumber, 2);
  assert.equal((await f.json('manifest.json')).entries.length, 2);
  assert.deepEqual(await fs.readdir(path.join(f.reportDir, '.staging')), []);
  assert.ok(report.validator.files.some((file) => file.path.endsWith('node/archive.js')));
  assert.ok(report.validator.files.some((file) => file.path.endsWith('pet-atlas-validation.js')));
});

test('animated V1 atlases keep their pages and timing while every page is decoded', async (t) => {
  const f = await fixture(t, [entry('animated-v1')]);
  const frameBytes = 1536 * 1872 * 4;
  const animation = await sharp(Buffer.concat([
    Buffer.alloc(frameBytes, Buffer.from([255, 0, 0, 255])),
    Buffer.alloc(frameBytes, Buffer.from([0, 0, 255, 255])),
  ]), {
    raw: { width: 1536, height: 1872 * 2, channels: 4, pageHeight: 1872 },
  }).webp({ lossless: true, delay: [100, 250], loop: 0 }).toBuffer();
  const original = await f.write('animated-v1', 1, {}, animation);
  const { summary } = await validatePetCatalog(f.options);
  assert.equal(summary.validated, 1);
  assert.equal(summary.failed, 0);
  const result = (await f.json('report.json')).results[0];
  assert.deepEqual(result.v1Atlas, {
    width: 1536, height: 1872, hasAlpha: false,
    pages: 2, animated: true, delay: [100, 250], fullyDecoded: true,
  });
  assert.equal(result.files.find((file) => file.path === 'spritesheet.webp').sha256, sha(animation));
  assert.deepEqual(await fs.readFile(path.join(f.zipDir, 'animated-v1.zip')), original);
  assert.deepEqual(await fs.readdir(path.join(f.reportDir, '.staging')), []);
});

test('bad archives, mismatched IDs, missing files and corrupt V1 images are isolated while other pets pass', async (t) => {
  const f = await fixture(t, ['good', 'bad-zip', 'wrong-id', 'bad-v1', 'missing'].map(entry));
  await f.write('good');
  await fs.writeFile(path.join(f.zipDir, 'bad-zip.zip'), 'not a ZIP');
  await f.write('wrong-id', 1, { id: 'other-pet' });
  await f.write('bad-v1', 1, {}, Buffer.from('not a decodable WebP'));
  const { summary } = await validatePetCatalog(f.options);
  assert.equal(summary.validated, 1);
  assert.equal(summary.failed, 4);
  const failures = await f.json('failures.json');
  assert.deepEqual(new Set(failures.results.map((result) => result.id)), new Set(['bad-zip', 'wrong-id', 'bad-v1', 'missing']));
  assert.ok(failures.results.every((result) => result.status === 'failed' && result.error));
  assert.deepEqual((await f.json('manifest.json')).entries.map((result) => result.id), ['good']);
  assert.deepEqual(await fs.readdir(path.join(f.reportDir, '.staging')), []);
});

test('resumption checks archive bytes, catalog entry and validation implementation identity', async (t) => {
  const f = await fixture(t, [entry('resume-cat')]);
  await f.write('resume-cat');
  assert.equal((await validatePetCatalog(f.options)).summary.reused, 0);
  assert.equal((await validatePetCatalog(f.options)).summary.reused, 1);
  await f.write('resume-cat', 1, { description: 'Changed archive bytes' });
  assert.equal((await validatePetCatalog(f.options)).summary.reused, 0);
  await fs.writeFile(f.catalog, JSON.stringify([ { ...entry('resume-cat'), displayName: 'Changed catalog identity' } ]));
  assert.equal((await validatePetCatalog(f.options)).summary.reused, 0);
  const resultPath = path.join(f.reportDir, 'results/resume-cat.json');
  const previous = JSON.parse(await fs.readFile(resultPath, 'utf8'));
  const { recordSha256: _checksum, ...body } = previous;
  body.validatorFingerprint = '0'.repeat(64);
  await fs.writeFile(resultPath, JSON.stringify({ ...body, recordSha256: sha(canonical(body)) }));
  assert.equal((await validatePetCatalog(f.options)).summary.reused, 0, 'a structurally intact report from different validator code cannot resume');
  const tampered = JSON.parse(await fs.readFile(resultPath, 'utf8'));
  tampered.files[0].sha256 = 'f'.repeat(64);
  await fs.writeFile(resultPath, JSON.stringify(tampered));
  assert.equal((await validatePetCatalog(f.options)).summary.reused, 0, 'modified per-file reports are regenerated');
});

test('ZIP symlinks are rejected and duplicate or unsafe IDs fail before creating reports', async (t) => {
  const f = await fixture(t, [entry('linked')]);
  const bytes = await f.write('linked');
  const outside = path.join(f.root, 'outside.zip');
  await fs.writeFile(outside, bytes);
  await fs.unlink(path.join(f.zipDir, 'linked.zip'));
  await fs.symlink(outside, path.join(f.zipDir, 'linked.zip'));
  assert.equal((await validatePetCatalog(f.options)).summary.failed, 1);
  assert.deepEqual(await fs.readFile(outside), bytes);
  const invalid = await fixture(t, [entry('same'), entry('same')]);
  await assert.rejects(() => validatePetCatalog(invalid.options), /duplicate/);
  await assert.rejects(() => fs.stat(invalid.reportDir), { code: 'ENOENT' });
  await fs.writeFile(invalid.catalog, JSON.stringify([entry('../escape')]));
  await assert.rejects(() => validatePetCatalog(invalid.options), /Invalid/);
  await assert.rejects(() => validatePetCatalog({ ...invalid.options, concurrency: 3 }), /concurrency/);
});

test('help is side-effect free, and a completed validation with failed pets exits nonzero with a report', async (t) => {
  const f = await fixture(t, [entry('missing')]);
  const before = await fs.readdir(f.root);
  const helpResult = spawnSync(process.execPath, [installer, '--help'], { cwd: f.root, encoding: 'utf8' });
  assert.equal(helpResult.status, 0, helpResult.stderr);
  assert.deepEqual(await fs.readdir(f.root), before);
  const result = spawnSync(process.execPath, [installer, '--catalog', f.catalog, '--zip-dir', f.zipDir, '--report-dir', f.reportDir], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /Summary:/);
  assert.equal((await f.json('report.json')).summary.failed, 1);
});
