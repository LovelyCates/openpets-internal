#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire, isBuiltin } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repository = path.dirname(path.dirname(scriptPath));
const schemaVersion = 1;
const validatorVersion = 'openpets-offline-catalog-2';
const help = `Validate already-downloaded OpenPets packages without network access or installation.

Usage: node internal/validate-pet-catalog.mjs --catalog FILE --zip-dir DIR
       [--report-dir DIR] [--concurrency 1|2] [--progress-every 25|50] [--no-resume]

The catalog may be an array or an object containing entries[] or pets[].
ZIP files must be named <catalog id>.zip. Reports default to ../validation
beside the ZIP directory. Temporary extraction is removed after each package.
Successful reports resume only after checking the full ZIP hash, catalog entry,
report integrity and every validator implementation fingerprint again.
No packages are downloaded, installed, selected, pinned or opened.
`;

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function recordWithChecksum(value) {
  return { ...value, recordSha256: hash(canonical(value)) };
}

async function safePath(target, type, required = true) {
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  let current = root;
  for (const part of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT' && !required) return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not accepted: ${current}`);
    const expected = current === absolute ? type : 'directory';
    if (expected === 'file' ? !stat.isFile() : !stat.isDirectory()) {
      throw new Error(`Expected a regular ${expected}: ${current}`);
    }
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

function parseArgs(args) {
  const options = { concurrency: 2, progressEvery: 25, resume: true };
  const names = new Map([
    ['--catalog', 'catalog'], ['--zip-dir', 'zipDir'], ['--report-dir', 'reportDir'],
    ['--concurrency', 'concurrency'], ['--progress-every', 'progressEvery'],
  ]);
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--no-resume') { options.resume = false; continue; }
    const name = names.get(flag);
    const value = args[++index];
    if (!name || seen.has(flag) || !value || value.startsWith('--')) throw new Error(`Invalid argument: ${flag}`);
    seen.add(flag);
    options[name] = name === 'concurrency' || name === 'progressEvery' ? Number(value) : value;
  }
  if (!options.catalog || !options.zipDir) throw new Error('--catalog and --zip-dir are required.');
  if (![1, 2].includes(options.concurrency)) throw new Error('--concurrency must be 1 or 2.');
  if (![25, 50].includes(options.progressEvery)) throw new Error('--progress-every must be 25 or 50.');
  return options;
}

async function validatorFingerprint(roots, sharp) {
  const queue = [...roots, scriptPath];
  const seen = new Set();
  const files = [];
  while (queue.length > 0) {
    const target = await fs.realpath(queue.pop());
    if (seen.has(target)) continue;
    seen.add(target);
    const bytes = await fs.readFile(target);
    files.push({ path: target, bytes: bytes.length, sha256: hash(bytes) });
    if (!/\.[cm]?js$/.test(target)) continue;
    const require = createRequire(pathToFileURL(target));
    const source = bytes.toString('utf8');
    const imports = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)["']([^"']+)["']/g;
    for (const match of source.matchAll(imports)) {
      if (isBuiltin(match[1])) continue;
      try { queue.push(require.resolve(match[1])); }
      catch (error) {
        // Optional platform dependencies and example strings may not resolve;
        // actual loaded native libraries are fingerprinted below as well.
        if (error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
      }
    }
  }
  const nativeFiles = process.report?.getReport().sharedObjects ?? [];
  for (const target of nativeFiles.filter((file) => /sharp|vips/i.test(file))) {
    const actual = await fs.realpath(target);
    if (seen.has(actual)) continue;
    seen.add(actual);
    const bytes = await fs.readFile(actual);
    files.push({ path: actual, bytes: bytes.length, sha256: hash(bytes) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const details = { validatorVersion, node: process.version, platform: process.platform, arch: process.arch, sharp: sharp.versions, files };
  return { ...details, sha256: hash(canonical(details)) };
}

async function loadRuntime() {
  const require = createRequire(path.join(repository, 'apps/desktop/package.json'));
  const sharp = require('sharp');
  const roots = [
    path.join(repository, 'packages/pet-format/dist/node/archive.js'),
    path.join(repository, 'packages/pet-format/dist/node/files.js'),
    path.join(repository, 'packages/pet-format/dist/package.js'),
    path.join(repository, 'apps/desktop/dist/pet-atlas-validation.js'),
    require.resolve('sharp'),
  ];
  const fingerprint = await validatorFingerprint(roots, sharp);
  const [archive, files, metadata, desktop, spritesheet, limits] = await Promise.all([
    import(pathToFileURL(roots[0])), import(pathToFileURL(roots[1])), import(pathToFileURL(roots[2])),
    import(pathToFileURL(roots[3])), import(pathToFileURL(require.resolve('install-pet/spritesheet'))),
    import(pathToFileURL(path.join(repository, 'packages/pet-format/dist/metadata.js'))),
  ]);
  return { sharp, roots, fingerprint, ...archive, ...files, ...metadata, ...desktop, ...spritesheet, ...limits };
}

async function packageFileManifest(directory, runtime, prefix = '') {
  const files = [];
  for (const name of (await fs.readdir(directory)).sort()) {
    const target = path.join(directory, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = await fs.lstat(target);
    if (stat.isDirectory()) files.push(...await packageFileManifest(target, runtime, relative));
    else {
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular extracted file: ${relative}`);
      const bytes = await runtime.readBoundedRegularFile(target, runtime.defaultPetZipLimits.maxIndividualFileBytes, relative);
      files.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) });
    }
  }
  return files;
}

async function readCached(target, expected, runtime) {
  try {
    await safePath(target, 'file');
    const cached = JSON.parse((await runtime.readBoundedRegularFile(target, 2 * 1024 * 1024, 'validation report')).toString('utf8'));
    const { recordSha256, ...body } = cached;
    if (hash(canonical(body)) !== recordSha256 || cached.status !== 'validated' || cached.schemaVersion !== schemaVersion
      || cached.validatorFingerprint !== runtime.fingerprint.sha256 || cached.entrySha256 !== expected.entrySha256
      || canonical(cached.zip) !== canonical(expected.zip) || cached.id !== expected.id
      || !Array.isArray(cached.files) || cached.files.length < 2) return;
    const names = new Set();
    for (const file of cached.files) {
      if (typeof file.path !== 'string' || file.path.startsWith('/') || file.path.includes('\\')
        || file.path.split('/').some((part) => !part || part === '.' || part === '..')
        || names.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || !/^[a-f\d]{64}$/.test(file.sha256)) return;
      names.add(file.path);
    }
    if (!names.has('pet.json')) return;
    return cached;
  } catch (error) {
    if (error.code === 'EACCES' || error.code === 'EPERM') throw error;
    return undefined;
  }
}

async function validateOne(entry, options, runtime) {
  const zipPath = path.join(options.zipDir, `${entry.id}.zip`);
  const reportPath = path.join(options.resultsDir, `${entry.id}.json`);
  const base = {
    schemaVersion, id: entry.id, entrySha256: hash(canonical(entry)),
    sourceZipUrl: entry.wardrobeZip ?? entry.zip ?? null,
    validatorFingerprint: runtime.fingerprint.sha256,
  };
  let temporary;
  let zip;
  let stage = 'archive';
  try {
    await safePath(zipPath, 'file');
    const bytes = await runtime.readBoundedRegularFile(zipPath, runtime.defaultPetZipLimits.maxZipDownloadBytes, 'pet ZIP');
    zip = { path: zipPath, bytes: bytes.length, sha256: hash(bytes) };
    if (options.resume) {
      const cached = await readCached(reportPath, { ...base, zip }, runtime);
      if (cached) return { result: cached, resumed: true };
    }
    stage = 'extraction';
    const format = await runtime.detectPetZipFormat(bytes);
    temporary = await fs.mkdtemp(path.join(options.stagingDir, `${entry.id}-`));
    await runtime.extractPetZip(bytes, temporary, { format });
    stage = 'metadata';
    let parsed = JSON.parse((await runtime.readBoundedRegularFile(path.join(temporary, 'pet.json'), runtime.maxCodexPetJsonBytes, 'pet.json')).toString('utf8'));
    if (parsed?.format !== 'motion' && parsed?.spriteVersionNumber === 1) {
      const { spriteVersionNumber: _legacy, ...normalized } = parsed;
      parsed = normalized;
    }
    const petPackage = runtime.validatePetPackageMetadata(parsed, entry.id);
    stage = 'assets';
    await runtime.validateDesktopPetPackageAssets(temporary, petPackage, { exactPackage: true });
    let v1Atlas = null;
    if (petPackage.format === 'classic' && petPackage.metadata.spriteVersionNumber !== 2 && petPackage.metadata.spritesheetPath === 'spritesheet.webp') {
      // Legacy desktop V1 validation intentionally omits decoding. Bulk QA
      // additionally checks every page without flattening animated atlases or
      // imposing a single-image restriction absent from the V1 runtime.
      stage = 'v1-decode';
      const atlas = await runtime.readBoundedRegularFile(path.join(temporary, 'spritesheet.webp'), runtime.maxCodexSpritesheetBytes, 'V1 atlas');
      const decodeOptions = { page: 0, pages: 1, failOn: 'error', limitInputPixels: 50_000_000 };
      const image = runtime.sharp(atlas, decodeOptions);
      let facts;
      try {
        facts = await image.metadata();
      } finally {
        image.destroy();
      }
      const spec = runtime.getPetSpritesheetSpec(petPackage.metadata);
      const pages = facts.pages ?? 1;
      if (facts.format !== 'webp' || facts.width !== spec.width || facts.height !== spec.height
        || !Number.isSafeInteger(pages) || pages < 1) {
        throw new Error(`V1 atlas must have ${spec.width}x${spec.height} WebP pages.`);
      }
      for (let page = 0; page < pages; page += 1) {
        const decoder = runtime.sharp(atlas, { ...decodeOptions, page });
        try {
          // Retain only the small output facts; each raw page buffer is
          // released before the next decoder starts, never collected together.
          const { info } = await decoder.raw().toBuffer({ resolveWithObject: true });
          if (info.width !== spec.width || info.height !== spec.height) {
            throw new Error(`V1 atlas page ${page + 1} does not match ${spec.width}x${spec.height}.`);
          }
        } finally {
          decoder.destroy();
        }
      }
      v1Atlas = {
        width: facts.width, height: facts.height, hasAlpha: facts.hasAlpha,
        pages, animated: pages > 1, delay: facts.delay ?? [], fullyDecoded: true,
      };
    }
    stage = 'file-manifest';
    const files = await packageFileManifest(temporary, runtime);
    return { resumed: false, result: recordWithChecksum({
      ...base, zip, status: 'validated', validatedAt: new Date().toISOString(),
      format: petPackage.format,
      spriteVersionNumber: petPackage.format === 'classic' ? petPackage.metadata.spriteVersionNumber ?? 1 : null,
      metadata: petPackage.metadata, files, v1Atlas,
    }) };
  } catch (error) {
    return { resumed: false, result: recordWithChecksum({
      ...base, zip: zip ?? { path: zipPath }, status: 'failed', checkedAt: new Date().toISOString(), stage,
      error: error instanceof Error ? error.message : String(error),
    }) };
  } finally {
    if (temporary) await fs.rm(temporary, { recursive: true, force: true });
  }
}

export async function validatePetCatalog(input) {
  const catalogPath = path.resolve(input.catalog);
  const zipDir = path.resolve(input.zipDir);
  const reportDir = path.resolve(input.reportDir ?? path.join(zipDir, '..', 'validation'));
  const concurrency = input.concurrency ?? 2;
  const progressEvery = input.progressEvery ?? 25;
  if (![1, 2].includes(concurrency) || ![25, 50].includes(progressEvery)) throw new Error('Invalid concurrency or progress interval.');
  await safePath(catalogPath, 'file');
  await safePath(zipDir, 'directory');
  await safePath(reportDir, 'directory', false);
  const runtime = await loadRuntime();
  const catalogBytes = await runtime.readBoundedRegularFile(catalogPath, 32 * 1024 * 1024, 'catalog snapshot');
  const catalog = JSON.parse(catalogBytes.toString('utf8'));
  const entries = Array.isArray(catalog) ? catalog : catalog.entries ?? catalog.pets;
  if (!Array.isArray(entries) || entries.length > 10_000) throw new Error('Catalog must contain at most 10000 entries.');
  if (!Array.isArray(catalog) && catalog.total !== undefined && catalog.total !== entries.length) throw new Error('Catalog total does not match entry count.');
  const ids = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(entry.id) || entry.id === 'builtin' || ids.has(entry.id)) {
      throw new Error(`Invalid or duplicate catalog id: ${entry?.id}`);
    }
    ids.add(entry.id);
  }
  await fs.mkdir(reportDir, { recursive: true, mode: 0o700 });
  const resultsDir = path.join(reportDir, 'results');
  const stagingDir = path.join(reportDir, '.staging');
  for (const directory of [resultsDir, stagingDir]) {
    await safePath(directory, 'directory', false);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  }
  const options = { zipDir, resultsDir, stagingDir, resume: input.resume !== false };
  const results = new Map();
  const resumedIds = [];
  let next = 0;
  let failed = 0;
  const startedAt = new Date().toISOString();
  const log = input.log ?? ((message) => process.stdout.write(`${message}\n`));
  async function worker() {
    while (next < entries.length) {
      const entry = entries[next++];
      const { result, resumed } = await validateOne(entry, options, runtime);
      if (!resumed) await writeJson(path.join(resultsDir, `${entry.id}.json`), result);
      results.set(entry.id, result);
      if (resumed) resumedIds.push(entry.id);
      if (result.status === 'failed') failed += 1;
      if (results.size % progressEvery === 0 || results.size === entries.length) {
        log(`Validated ${results.size}/${entries.length}: passed=${results.size - failed}, failed=${failed}, reused=${resumedIds.length}`);
      }
    }
  }
  const workers = await Promise.allSettled(Array.from({ length: concurrency }, worker));
  const workerFailure = workers.find((result) => result.status === 'rejected');
  if (workerFailure) throw workerFailure.reason;
  const finalFingerprint = await validatorFingerprint(runtime.roots, runtime.sharp);
  if (finalFingerprint.sha256 !== runtime.fingerprint.sha256) throw new Error('Validator files changed during this run; rerun before trusting these reports.');
  const ordered = entries.map((entry) => results.get(entry.id));
  const summary = {
    total: entries.length, validated: ordered.length - failed, failed, reused: resumedIds.length,
    zipBytes: ordered.reduce((total, result) => total + (result.zip.bytes ?? 0), 0),
  };
  const header = { schemaVersion, startedAt, completedAt: new Date().toISOString(), catalog: { path: catalogPath, sha256: hash(catalogBytes) }, validator: runtime.fingerprint, summary };
  await writeJson(path.join(reportDir, 'report.json'), { ...header, resumedIds, results: ordered });
  await writeJson(path.join(reportDir, 'failures.json'), { ...header, results: ordered.filter((result) => result.status === 'failed') });
  await writeJson(path.join(reportDir, 'manifest.json'), {
    ...header, entries: ordered.filter((result) => result.status === 'validated').map((result) => ({
      id: result.id, zip: result.zip, sourceZipUrl: result.sourceZipUrl, entrySha256: result.entrySha256,
      validatorFingerprint: result.validatorFingerprint, format: result.format, spriteVersionNumber: result.spriteVersionNumber,
      files: result.files,
    })),
  });
  log(`Summary: ${JSON.stringify(summary)}; reports=${reportDir}`);
  return { summary, reportDir };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--help') || args.includes('-h')) process.stdout.write(help);
    else {
      const { summary } = await validatePetCatalog(parseArgs(args));
      if (summary.failed > 0) process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
