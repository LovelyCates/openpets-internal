import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { importPetCatalog, parseImportArgs } from './import-pet-catalog.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, count = 3) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'openpets-catalog-import-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const zipDir = path.join(root, 'reviewed ZIPs');
  const reportDir = path.join(root, 'import reports');
  const readyManifest = path.join(root, 'ready.json');
  await fs.mkdir(zipDir);
  const fingerprint = sha('validator');
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const bytes = Buffer.from(`reviewed archive ${index}`);
    const zipPath = path.join(zipDir, `approved archive ${index}.zip`);
    await fs.writeFile(zipPath, bytes);
    entries.push({
      id: `pet-${index}`, zip: { path: zipPath, bytes: bytes.length, sha256: sha(bytes) },
      validatorFingerprint: fingerprint, entrySha256: sha(`catalog-${index}`),
      format: index === 2 ? 'motion' : 'classic',
      spriteVersionNumber: index === 2 ? null : index % 2 + 1,
      files: [{ path: 'pet.json', bytes: 42, sha256: sha(`metadata-${index}`) }],
    });
  }
  const manifest = {
    schemaVersion: 1,
    validator: { validatorVersion: 'openpets-offline-catalog-1', sha256: fingerprint },
    summary: { total: count, validated: count, failed: 0, reused: 0, zipBytes: entries.reduce((sum, entry) => sum + entry.zip.bytes, 0) },
    entries,
  };
  const server = {
    pets: new Map([['builtin', { id: 'builtin', displayName: 'Built-in', builtIn: true, broken: false }]]),
    calls: [],
    lists: 0,
    handshakes: 0,
    active: 0,
    maxActive: 0,
    factoryOptions: [],
    failures: new Set(),
    omitted: new Set(),
    beforeInstall: null,
    finalListError: null,
  };
  const logs = [];
  const client = {
    async hello() {
      server.handshakes += 1;
      return { ok: true, protocol: 'openpets-ipc', protocolVersion: 1, appVersion: '4.1.0-internal.6' };
    },
    async listPets() {
      server.lists += 1;
      if (server.lists === 2 && server.finalListError) throw server.finalListError;
      return { ok: true, defaultPetId: 'builtin', pets: [...server.pets.values()] };
    },
    async installLocalPet(zipPath, options) {
      assert.deepEqual(options, { kind: 'zip' });
      const entry = entries.find((candidate) => candidate.zip.path === zipPath);
      assert.ok(entry, 'the installer receives the exact manifest ZIP path, not an ID-derived filename');
      server.calls.push(entry.id);
      server.active += 1;
      server.maxActive = Math.max(server.maxActive, server.active);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        await server.beforeInstall?.(entry);
        if (server.failures.has(entry.id)) throw new Error(`Mock install failed: ${entry.id}`);
        if (!server.omitted.has(entry.id)) server.pets.set(entry.id, { id: entry.id, displayName: entry.id, builtIn: false, broken: false });
        return { ok: true, installed: true, petId: entry.id, displayName: entry.id };
      } finally {
        server.active -= 1;
      }
    },
  };
  const options = {
    readyManifest, zipDir, reportDir,
    createClient(input) { server.factoryOptions.push(input); return client; },
    log(message) { logs.push(message); },
  };
  const writeManifest = () => fs.writeFile(readyManifest, JSON.stringify(manifest));
  await writeManifest();
  return {
    root, zipDir, reportDir, readyManifest, entries, manifest, server, logs, options, writeManifest,
    run(extra = {}) { return importPetCatalog({ ...options, ...extra }); },
    async json(name) { return JSON.parse(await fs.readFile(path.join(reportDir, name), 'utf8')); },
  };
}

test('imports are local, serial, checkpointed, skip existing IDs and continue after one failure', async (t) => {
  const f = await fixture(t, 27);
  f.server.pets.set('pet-0', { id: 'pet-0', displayName: 'My custom cat', builtIn: false, broken: false });
  f.server.failures.add('pet-2');
  f.server.beforeInstall = async (entry) => {
    if (entry.id === 'pet-2') {
      assert.equal((await f.json('results/pet-pet-1.json')).status, 'installed');
      assert.equal((await f.json('checkpoint.json')).summary.processed, 2, 'each result is durable before the next install begins');
    }
  };
  const report = await f.run();
  assert.equal(f.server.maxActive, 1);
  assert.equal(f.server.lists, 2, 'only one initial and one final complete-list call');
  assert.equal(f.server.handshakes, 1);
  assert.equal(f.server.factoryOptions[0].remote, false);
  assert.equal(f.server.calls.includes('pet-0'), false);
  assert.equal(f.server.pets.get('pet-0').displayName, 'My custom cat');
  assert.equal(f.server.calls.at(-1), 'pet-26', 'a rejected install does not stop later entries');
  assert.deepEqual(report.summary, { total: 27, processed: 27, installed: 25, skipped: 1, failed: 1 });
  assert.equal(report.complete, false);
  assert.deepEqual(report.verification.missingIds, ['pet-2']);
  assert.equal(report.verification.defaultUnchanged, true);
  assert.ok(f.logs.some((message) => message.startsWith('Imported 25/27:')));
  assert.equal((await f.json('checkpoint.json')).status, 'incomplete');
});

test('changed archive hashes or byte counts are rejected before IPC installation', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.entries[0].zip.path, Buffer.alloc(f.entries[0].zip.bytes, 0x61));
  await fs.appendFile(f.entries[1].zip.path, 'changed');
  const report = await f.run();
  assert.deepEqual(f.server.calls, ['pet-2']);
  assert.equal(report.summary.failed, 2);
  assert.match(report.results[0].error, /SHA-256/);
  assert.match(report.results[1].error, /byte count/);
  assert.equal(report.complete, false);
});

test('resumption uses the current installed list and retries missing IDs instead of trusting old checkpoints', async (t) => {
  const f = await fixture(t, 2);
  f.server.failures.add('pet-0');
  const first = await f.run();
  f.server.failures.clear();
  const second = await f.run();
  assert.equal(second.resumedFrom, first.runId);
  assert.deepEqual(f.server.calls, ['pet-0', 'pet-1', 'pet-0']);
  assert.equal(second.results[1].status, 'skipped-existing');
  assert.equal(second.complete, true);
  f.server.pets.delete('pet-1');
  const third = await f.run();
  assert.equal(third.results[1].status, 'installed', 'a prior successful report cannot suppress reinstalling a now-missing pet');
  assert.equal(third.results[1].attempt, 3);
  assert.equal(third.results[1].previousStatus, 'skipped-existing');
  assert.deepEqual(f.server.calls, ['pet-0', 'pet-1', 'pet-0', 'pet-1']);
  assert.equal(f.server.lists, 6);
});

test('duplicate IDs, incomplete validation and paths outside the ZIP directory fail before contacting the app', async (t) => {
  const f = await fixture(t, 2);
  f.entries[1].id = f.entries[0].id;
  await f.writeManifest();
  await assert.rejects(() => f.run(), /duplicate/);
  f.entries[1].id = 'pet-1';
  f.manifest.summary.failed = 1;
  await f.writeManifest();
  await assert.rejects(() => f.run(), /zero failures/);
  f.manifest.summary.failed = 0;
  f.entries[1].zip.path = path.join(f.root, 'outside.zip');
  await f.writeManifest();
  await assert.rejects(() => f.run(), /outside --zip-dir/);
  assert.equal(f.server.factoryOptions.length, 0);
});

test('a symlinked ZIP cannot use an approved path to install a different file', async (t) => {
  const f = await fixture(t, 1);
  const original = path.join(f.root, 'elsewhere.zip');
  await fs.rename(f.entries[0].zip.path, original);
  await fs.symlink(original, f.entries[0].zip.path);
  const report = await f.run();
  assert.equal(report.summary.failed, 1);
  assert.match(report.results[0].error, /Symbolic links/);
  assert.deepEqual(f.server.calls, []);
});

test('final verification checks all target IDs, app version, counts and rejected success claims', async (t) => {
  const f = await fixture(t);
  f.server.omitted.add('pet-1');
  const report = await f.run();
  assert.equal(report.summary.installed, 3);
  assert.equal(report.complete, false, 'an install response is insufficient when the final app list does not contain the ID');
  assert.deepEqual(report.verification.selectedMissingIds, ['pet-1']);
  assert.equal(report.verification.presentTargetCount, 2);
  assert.equal(report.verification.finalInstalledCount, 3);
  assert.equal(report.appVersion, '4.1.0-internal.6');
  assert.deepEqual(report.validatedVersionCounts, { classicV1: 1, classicV2: 1, motion: 1 });
  assert.deepEqual((await f.json('report.json')).verification, report.verification);
});

test('limit runs verify their sample while preserving the full-catalog missing-ID report', async (t) => {
  const f = await fixture(t);
  const report = await f.run({ limit: 1 });
  assert.deepEqual(f.server.calls, ['pet-0']);
  assert.equal(report.complete, true);
  assert.equal(report.allTargetsPresent, false);
  assert.equal(report.targetTotal, 3);
  assert.equal(report.selectedTotal, 1);
  assert.deepEqual(report.verification.missingIds, ['pet-1', 'pet-2']);
  assert.deepEqual(report.verification.selectedMissingIds, []);
});

test('an existing broken pet is reported but never overwritten', async (t) => {
  const f = await fixture(t, 1);
  f.server.pets.set('pet-0', { id: 'pet-0', displayName: 'Custom broken cat', builtIn: false, broken: true });
  const report = await f.run();
  assert.deepEqual(f.server.calls, []);
  assert.equal(report.results[0].status, 'skipped-existing');
  assert.deepEqual(report.verification.selectedBrokenIds, ['pet-0']);
  assert.equal(report.complete, false);
});

test('a failed final list leaves a durable incomplete report even without an error message', async (t) => {
  const f = await fixture(t, 1);
  f.server.finalListError = new Error('');
  const report = await f.run();
  assert.equal(report.complete, false);
  assert.equal(report.verification.error, '');
  assert.equal((await f.json('checkpoint.json')).status, 'incomplete');
  assert.equal((await f.json('report.json')).summary.installed, 1);
});

test('CLI requires absolute inputs and help has no installation side effects', () => {
  assert.throws(() => parseImportArgs(['--ready-manifest', 'relative.json']), /absolute/);
  assert.throws(() => parseImportArgs(['--ready-manifest', '/ready.json', '--zip-dir', '/zips', '--report-dir', '/reports', '--limit', '0']), /positive integer/);
  assert.throws(() => parseImportArgs(['--ready-manifest', '/ready.json', '--ready-manifest', '/other.json']), /Invalid argument/);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./import-pet-catalog.mjs', import.meta.url)), '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--ready-manifest/);
  assert.equal(result.stderr, '');
});
