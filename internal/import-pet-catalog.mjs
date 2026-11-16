#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const schemaVersion = 1;
const maxManifestBytes = 32 * 1024 * 1024;
const maxZipBytes = 1024 * 1024 * 1024;
const shaPattern = /^[a-f0-9]{64}$/;
const idPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const help = `Import an offline-validated pet collection through a running local OpenPets app.

Usage: node internal/import-pet-catalog.mjs --ready-manifest ABS --zip-dir ABS
       --report-dir ABS [--limit COUNT]

The ready manifest must be the schemaVersion 1 manifest.json produced by
validate-pet-catalog.mjs, with no failed or missing entries. Each selected ZIP
is checked against its recorded full-file SHA-256 and byte count again.
ZIP paths come from the manifest and must remain inside --zip-dir.
Existing pet IDs are skipped, including custom or broken installations.
Installations run serially through local IPC; no app state is written directly.
Reports/checkpoints are updated after each item. Repeating the command resumes
from the app's current installed IDs rather than trusting previous successes.
--limit imports only the first COUNT manifest entries for a sample run.
No default pet, pinned pet, lease or public-network setting is changed.
Local discovery honors OPENPETS_DISCOVERY_FILE; otherwise this branch uses the
OpenPets Internal profile on macOS and Windows. Use a separate import report
directory so the validator's reports remain intact.
`;

export function parseImportArgs(args) {
  const names = new Map([
    ['--ready-manifest', 'readyManifest'], ['--zip-dir', 'zipDir'],
    ['--report-dir', 'reportDir'], ['--limit', 'limit'],
  ]);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const name = names.get(flag);
    const value = args[index + 1];
    if (!name || name in options || !value || value.startsWith('--')) throw new Error(`Invalid argument: ${flag}`);
    options[name] = name === 'limit' ? Number(value) : value;
  }
  return validateOptions(options);
}

function validateOptions(options) {
  for (const name of ['readyManifest', 'zipDir', 'reportDir']) {
    if (typeof options[name] !== 'string' || !path.isAbsolute(options[name])) {
      throw new Error(`${name} must be an absolute path.`);
    }
  }
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit <= 0)) {
    throw new Error('--limit must be a positive integer.');
  }
  return options;
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function safePath(target, type, required = true) {
  const absolute = path.resolve(target);
  let current = path.parse(absolute).root;
  for (const part of path.relative(current, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let facts;
    try {
      facts = await fs.lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT' && !required) return;
      throw error;
    }
    if (facts.isSymbolicLink()) throw new Error(`Symbolic links are not accepted: ${current}`);
    const expected = current === absolute ? type : 'directory';
    if (expected === 'file' ? !facts.isFile() : !facts.isDirectory()) throw new Error(`Expected a regular ${expected}: ${current}`);
  }
}

async function readJson(target, maxBytes = maxManifestBytes) {
  await safePath(target, 'file');
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const facts = await handle.stat();
    if (!facts.isFile() || facts.size <= 0 || facts.size > maxBytes) throw new Error(`JSON file is empty or exceeds its size limit: ${target}`);
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) throw new Error(`JSON file exceeds its size limit: ${target}`);
    return { value: JSON.parse(bytes.toString('utf8')), sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally {
    await handle.close();
  }
}

async function writeJson(target, value) {
  await safePath(path.dirname(target), 'directory');
  await safePath(target, 'file', false);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function validateManifest(manifest, zipDir) {
  if (!record(manifest) || manifest.schemaVersion !== schemaVersion || !Array.isArray(manifest.entries)
    || manifest.entries.length === 0 || manifest.entries.length > 10_000 || !record(manifest.summary)
    || manifest.summary.total !== manifest.entries.length || manifest.summary.validated !== manifest.entries.length
    || manifest.summary.failed !== 0 || !record(manifest.validator) || !shaPattern.test(manifest.validator.sha256)) {
    throw new Error('Ready manifest must be a complete schemaVersion 1 validation with zero failures.');
  }
  const ids = new Set();
  for (const entry of manifest.entries) {
    if (!record(entry) || typeof entry.id !== 'string' || !idPattern.test(entry.id) || entry.id === 'builtin' || ids.has(entry.id)) {
      throw new Error(`Invalid or duplicate manifest pet ID: ${entry?.id}`);
    }
    ids.add(entry.id);
    if (!record(entry.zip) || typeof entry.zip.path !== 'string' || !path.isAbsolute(entry.zip.path)
      || !Number.isSafeInteger(entry.zip.bytes) || entry.zip.bytes <= 0 || entry.zip.bytes > maxZipBytes
      || typeof entry.zip.sha256 !== 'string' || !shaPattern.test(entry.zip.sha256)
      || entry.validatorFingerprint !== manifest.validator.sha256
      || !['classic', 'motion'].includes(entry.format)
      || (entry.format === 'classic' ? ![1, 2].includes(entry.spriteVersionNumber) : entry.spriteVersionNumber !== null)) {
      throw new Error(`Invalid ready-manifest integrity metadata: ${entry.id}`);
    }
    const relative = path.relative(zipDir, entry.zip.path);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Manifest ZIP is outside --zip-dir: ${entry.id}`);
    }
  }
  return manifest.entries;
}

async function verifyZip(entry) {
  await safePath(entry.zip.path, 'file');
  const handle = await fs.open(entry.zip.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const initial = await handle.stat();
    if (!initial.isFile() || initial.size !== entry.zip.bytes) throw new Error('ZIP byte count changed after validation.');
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > entry.zip.bytes) throw new Error('ZIP byte count changed after validation.');
      hash.update(chunk);
    }
    const final = await handle.stat();
    const current = await fs.lstat(entry.zip.path);
    if (bytes !== entry.zip.bytes || hash.digest('hex') !== entry.zip.sha256) throw new Error('ZIP SHA-256 or byte count changed after validation.');
    if (initial.dev !== current.dev || initial.ino !== current.ino || current.isSymbolicLink()
      || initial.size !== final.size || initial.mtimeMs !== final.mtimeMs || initial.ctimeMs !== final.ctimeMs) {
      throw new Error('ZIP changed while its integrity was being checked.');
    }
  } finally {
    await handle.close();
  }
}

function petList(value) {
  if (!record(value) || value.ok !== true || !Array.isArray(value.pets) || typeof value.defaultPetId !== 'string') throw new Error('Invalid local pet list.');
  const ids = new Set();
  for (const pet of value.pets) {
    if (!record(pet) || typeof pet.id !== 'string' || !idPattern.test(pet.id) || ids.has(pet.id)) throw new Error('Local pet list contains an invalid or duplicate ID.');
    ids.add(pet.id);
  }
  return value;
}

function versionCounts(entries) {
  const counts = { classicV1: 0, classicV2: 0, motion: 0 };
  for (const entry of entries) counts[entry.format === 'motion' ? 'motion' : entry.spriteVersionNumber === 2 ? 'classicV2' : 'classicV1'] += 1;
  return counts;
}

async function previousJson(target) {
  try {
    return (await readJson(target)).value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function importPetCatalog(input) {
  validateOptions(input);
  const readyManifest = path.resolve(input.readyManifest);
  const zipDir = path.resolve(input.zipDir);
  const reportDir = path.resolve(input.reportDir);
  if (reportDir === path.dirname(readyManifest)) throw new Error('Use a separate import report directory, not the validator report directory.');
  await safePath(zipDir, 'directory');
  const { value: manifest, sha256: manifestSha256 } = await readJson(readyManifest);
  const targets = validateManifest(manifest, zipDir);
  const entries = targets.slice(0, input.limit ?? targets.length);
  await safePath(reportDir, 'directory', false);
  await fs.mkdir(reportDir, { recursive: true, mode: 0o700 });
  await safePath(reportDir, 'directory');
  const resultsDir = path.join(reportDir, 'results');
  await safePath(resultsDir, 'directory', false);
  await fs.mkdir(resultsDir, { mode: 0o700, recursive: true });
  const checkpointPath = path.join(reportDir, 'checkpoint.json');
  const previous = await previousJson(checkpointPath);
  if (previous && (previous.schemaVersion !== schemaVersion || previous.manifestSha256 !== manifestSha256 || previous.zipDir !== zipDir)) {
    throw new Error('Report directory belongs to a different ready manifest or ZIP directory.');
  }
  const createClient = input.createClient ?? (await import(new URL('../packages/client/dist/index.js', import.meta.url).href)).createOpenPetsClient;
  const client = createClient({ remote: false, responseTimeoutMs: 180_000 });
  const hello = await client.hello();
  if (!record(hello) || hello.ok !== true || hello.protocol !== 'openpets-ipc' || hello.protocolVersion !== 1 || typeof hello.appVersion !== 'string' || !hello.appVersion) {
    throw new Error('The running local app did not return a valid OpenPets protocol handshake.');
  }
  const initial = petList(await client.listPets());
  const installedIds = new Set(initial.pets.map((pet) => pet.id));
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const log = input.log ?? ((message) => process.stdout.write(`${message}\n`));
  const summary = { total: entries.length, processed: 0, installed: 0, skipped: 0, failed: 0 };
  const header = {
    schemaVersion, runId, startedAt, resumedFrom: previous?.runId ?? null,
    readyManifest, manifestSha256, zipDir, appVersion: hello.appVersion,
    validatorFingerprint: manifest.validator.sha256, targetTotal: targets.length,
    selectedTotal: entries.length, limit: input.limit ?? null,
    validatedVersionCounts: versionCounts(targets),
  };
  const results = [];
  await writeJson(checkpointPath, { ...header, summary, status: 'running' });
  for (const entry of entries) {
    // A prefix also avoids Windows device basenames such as CON or AUX.
    const resultPath = path.join(resultsDir, `pet-${entry.id}.json`);
    const prior = await previousJson(resultPath);
    if (prior && (prior.schemaVersion !== schemaVersion || prior.id !== entry.id
      || prior.manifestSha256 !== manifestSha256 || prior.zip?.sha256 !== entry.zip.sha256
      || !Number.isSafeInteger(prior.attempt) || prior.attempt <= 0)) {
      throw new Error(`Existing item report does not match the ready manifest: ${entry.id}`);
    }
    const result = {
      schemaVersion, runId, manifestSha256, id: entry.id, zip: entry.zip,
      attempt: (prior?.attempt ?? 0) + 1, previousStatus: prior?.status ?? null,
      startedAt: new Date().toISOString(),
    };
    try {
      await verifyZip(entry);
      if (installedIds.has(entry.id)) {
        result.status = 'skipped-existing';
        summary.skipped += 1;
      } else {
        const installed = await client.installLocalPet(entry.zip.path, { kind: 'zip' });
        if (!record(installed) || installed.ok !== true || installed.installed !== true || installed.petId !== entry.id) throw new Error('Local installer returned an unexpected pet ID or incomplete result.');
        installedIds.add(entry.id);
        result.status = 'installed';
        summary.installed += 1;
      }
    } catch (error) {
      result.status = 'failed';
      result.error = error instanceof Error ? error.message : String(error);
      summary.failed += 1;
    }
    result.completedAt = new Date().toISOString();
    summary.processed += 1;
    results.push(result);
    await writeJson(resultPath, result);
    await writeJson(checkpointPath, { ...header, summary, status: 'running', lastPetId: entry.id });
    if (summary.processed % 25 === 0 || summary.processed === entries.length) {
      log(`Imported ${summary.processed}/${summary.total}: installed=${summary.installed}, skipped=${summary.skipped}, failed=${summary.failed}`);
    }
  }
  let verification;
  try {
    const final = petList(await client.listPets());
    const finalById = new Map(final.pets.map((pet) => [pet.id, pet]));
    const missingIds = targets.filter((entry) => !finalById.has(entry.id)).map((entry) => entry.id);
    const selectedMissingIds = entries.filter((entry) => !finalById.has(entry.id)).map((entry) => entry.id);
    const brokenIds = targets.filter((entry) => finalById.get(entry.id)?.broken === true).map((entry) => entry.id);
    const selectedBrokenIds = entries.filter((entry) => finalById.get(entry.id)?.broken === true).map((entry) => entry.id);
    verification = {
      initialInstalledCount: initial.pets.length, finalInstalledCount: final.pets.length,
      targetTotal: targets.length, presentTargetCount: targets.length - missingIds.length,
      selectedTotal: entries.length, presentSelectedCount: entries.length - selectedMissingIds.length,
      missingIds, selectedMissingIds, brokenIds, selectedBrokenIds,
      defaultPetIdBefore: initial.defaultPetId, defaultPetIdAfter: final.defaultPetId,
      defaultUnchanged: initial.defaultPetId === final.defaultPetId,
    };
  } catch (error) {
    verification = { error: error instanceof Error ? error.message : String(error) };
  }
  const verified = !Object.hasOwn(verification, 'error');
  const complete = summary.failed === 0 && verified && verification.selectedMissingIds.length === 0
    && verification.selectedBrokenIds.length === 0 && verification.defaultUnchanged;
  const report = {
    ...header, completedAt: new Date().toISOString(), summary, verification, complete,
    allTargetsPresent: verified && verification.missingIds.length === 0,
    results,
  };
  await writeJson(path.join(reportDir, 'report.json'), report);
  await writeJson(checkpointPath, { ...header, summary, status: complete ? 'complete' : 'incomplete', completedAt: report.completedAt, verification });
  log(`Summary: ${JSON.stringify({ ...summary, complete, presentTargets: verification.presentTargetCount ?? null, targetTotal: targets.length })}; reports=${reportDir}`);
  return report;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) process.stdout.write(help);
    else {
      const report = await importPetCatalog(parseImportArgs(args));
      if (!report.complete) process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
