import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const installer = fileURLToPath(new URL('./install-opencode-integration.mjs', import.meta.url));

function fixture(t) {
  // macOS /tmp and /var are symlinks; use a physical path to test the same
  // strict ancestor-link policy that protects real project installations.
  const root = fs.mkdtempSync('/private/tmp/openpets mac installer ');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project with spaces');
  const source = path.join(root, 'local deployment with spaces');
  fs.mkdirSync(project);
  fs.mkdirSync(source);
  const cli = path.join(source, 'index.js');
  const bundle = path.join(source, 'plugin.js');
  const license = path.join(source, 'LICENSE');
  fs.writeFileSync(cli, 'throw new Error("installer must not execute the CLI");\n');
  fs.writeFileSync(bundle, 'export default async () => ({});\n');
  fs.writeFileSync(license, 'MIT License\nCopyright Test\n');
  return { root, project, source, cli, bundle, license };
}

function run(f, major = 1, extra = []) {
  return spawnSync(process.execPath, [installer,
    '--major-version', String(major), '--project-root', f.project,
    '--cli-path', f.cli, '--bundle-path', f.bundle, ...extra,
  ], { cwd: f.root, encoding: 'utf8' });
}

function installedFiles(f, major = 1) {
  return {
    bundle: path.join(f.project, `.opencode/plugins/openpets-v${major}.js`),
    license: path.join(f.project, '.opencode/plugins/openpets-LICENSE.txt'),
    config: path.join(f.project, '.opencode/opencode.jsonc'),
    manifest: path.join(f.project, '.opencode/openpets-internal-install.json'),
  };
}

function snapshot(directory) {
  const entries = {};
  for (const name of fs.readdirSync(directory).sort()) {
    const target = path.join(directory, name);
    const stat = fs.lstatSync(target);
    entries[name] = stat.isSymbolicLink()
      ? { symlink: fs.readlinkSync(target) }
      : stat.isDirectory() ? snapshot(target) : fs.readFileSync(target).toString('base64');
  }
  return entries;
}

for (const major of [1, 2]) {
  test(`V${major} installs local bundle, license and absolute MCP commands in paths with spaces`, (t) => {
    const f = fixture(t);
    const result = run(f, major);
    assert.equal(result.status, 0, result.stderr);
    const targets = installedFiles(f, major);
    assert.deepEqual(fs.readFileSync(targets.bundle), fs.readFileSync(f.bundle));
    assert.deepEqual(fs.readFileSync(targets.license), fs.readFileSync(f.license));
    const config = JSON.parse(fs.readFileSync(targets.config, 'utf8'));
    const entry = major === 1 ? config.mcp.openpets : config.mcp.servers.openpets;
    assert.deepEqual(entry.command, [process.execPath, f.cli, 'mcp']);
    assert.equal(entry.type, 'local');
    assert.equal(entry.enabled, major === 1 ? true : undefined);
    const record = JSON.parse(fs.readFileSync(targets.manifest, 'utf8'));
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.majorVersion, major);
    for (const field of ['bundle', 'license', 'config']) {
      const bytes = fs.readFileSync(targets[field]);
      assert.equal(record[field].path, path.relative(f.project, targets[field]));
      assert.equal(record[field].sha256, createHash('sha256').update(bytes).digest('hex'));
    }
  });

  test(`V${major} updates only verified managed files and retains all original bytes in backups`, (t) => {
    const f = fixture(t);
    assert.equal(run(f, major).status, 0);
    const targets = installedFiles(f, major);
    const before = Object.fromEntries(Object.entries(targets).map(([name, target]) => [name, fs.readFileSync(target)]));
    fs.appendFileSync(f.bundle, '// updated plugin\n');
    fs.appendFileSync(f.license, 'Updated license\n');
    const nextCli = path.join(f.source, 'updated cli.js');
    fs.copyFileSync(f.cli, nextCli);
    f.cli = nextCli;
    const result = run(f, major, ['--node-path', process.execPath]);
    assert.equal(result.status, 0, result.stderr);
    const suffix = result.stdout.match(/\.bak-[a-f\d]{32}/)?.[0];
    assert.ok(suffix, result.stdout);
    for (const [field, target] of Object.entries(targets)) {
      assert.deepEqual(fs.readFileSync(`${target}${suffix}`), before[field]);
    }
    assert.deepEqual(fs.readFileSync(targets.bundle), fs.readFileSync(f.bundle));
    const config = JSON.parse(fs.readFileSync(targets.config, 'utf8'));
    const entry = major === 1 ? config.mcp.openpets : config.mcp.servers.openpets;
    assert.equal(entry.command[1], nextCli);
    assert.ok(fs.readdirSync(path.dirname(targets.manifest)).every((name) => !name.endsWith('.tmp')));
    assert.ok(fs.readdirSync(path.dirname(targets.bundle)).every((name) => !name.endsWith('.tmp')));
  });
}

for (const field of ['bundle', 'license', 'config']) {
  test(`a user-modified managed ${field} is preserved and blocks every installation write`, (t) => {
    const f = fixture(t);
    assert.equal(run(f).status, 0);
    const target = installedFiles(f)[field];
    fs.appendFileSync(target, '\nUser modification\n');
    const before = snapshot(f.project);
    const result = run(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /已被修改/);
    assert.deepEqual(snapshot(f.project), before);
  });
}

test('a PowerShell-style BOM manifest with uppercase hashes can be safely updated', (t) => {
  const f = fixture(t);
  assert.equal(run(f).status, 0);
  const target = installedFiles(f).manifest;
  const record = JSON.parse(fs.readFileSync(target, 'utf8'));
  for (const field of ['bundle', 'license', 'config']) record[field].sha256 = record[field].sha256.toUpperCase();
  fs.writeFileSync(target, `\uFEFF${JSON.stringify(record, null, 2).replaceAll('\n', '\r\n')}\r\n`);
  const before = fs.readFileSync(target);
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  const suffix = result.stdout.match(/\.bak-[a-f\d]{32}/)[0];
  assert.deepEqual(fs.readFileSync(`${target}${suffix}`), before);
});

test('an invalid or mismatched managed record blocks updates without changing files', (t) => {
  const f = fixture(t);
  assert.equal(run(f).status, 0);
  fs.writeFileSync(installedFiles(f).manifest, '{broken json');
  const before = snapshot(f.project);
  assert.notEqual(run(f).status, 0);
  assert.deepEqual(snapshot(f.project), before);
});

for (const relative of [
  '.opencode/opencode.jsonc', '.opencode/plugins/openpets-v1.js',
  '.opencode/plugins/openpets-LICENSE.txt', 'opencode.json',
  'opencode.jsonc', '.opencode/opencode.json', '.opencode/config.json', '.opencode/config.jsonc',
]) {
  test(`existing unmanaged ${relative} is preserved without creating an installation`, (t) => {
    const f = fixture(t);
    const target = path.join(f.project, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'Existing user content\n');
    const before = snapshot(f.project);
    const result = run(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /拒绝/);
    assert.deepEqual(snapshot(f.project), before);
  });
}

test('major-version changes cannot install two adapters into the same project', (t) => {
  const f = fixture(t);
  assert.equal(run(f, 1).status, 0);
  const before = snapshot(f.project);
  const result = run(f, 2);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /另一主版本/);
  assert.deepEqual(snapshot(f.project), before);
});

for (const linked of ['project parent', 'plugin directory', 'managed file', 'dangling file', 'bundle', 'node']) {
  test(`a symbolic link in the ${linked} path blocks writes`, (t) => {
    const f = fixture(t);
    const outside = path.join(f.root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'precious'), 'Do not change\n');
    const extra = [];
    if (linked === 'project parent') {
      fs.symlinkSync(f.project, path.join(outside, 'project alias'));
      f.project = path.join(outside, 'project alias');
    } else if (linked === 'plugin directory') {
      fs.mkdirSync(path.join(f.project, '.opencode'));
      fs.symlinkSync(outside, path.join(f.project, '.opencode/plugins'));
    } else if (linked === 'managed file') {
      assert.equal(run(f).status, 0);
      const target = installedFiles(f).config;
      fs.unlinkSync(target);
      fs.symlinkSync(path.join(outside, 'precious'), target);
    } else if (linked === 'dangling file') {
      fs.mkdirSync(path.join(f.project, '.opencode'));
      fs.symlinkSync(path.join(outside, 'absent'), installedFiles(f).manifest);
    } else if (linked === 'bundle') {
      const alias = path.join(f.source, 'alias.js');
      fs.symlinkSync(f.bundle, alias);
      f.bundle = alias;
    } else {
      const alias = path.join(f.source, 'node');
      fs.symlinkSync(process.execPath, alias);
      extra.push('--node-path', alias);
    }
    const before = snapshot(f.root);
    const result = run(f, 1, extra);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /符号链接/);
    assert.deepEqual(snapshot(f.root), before);
  });
}

test('help has no side effects even with nonexistent installation paths', (t) => {
  const f = fixture(t);
  const before = snapshot(f.root);
  const result = spawnSync(process.execPath, [installer, '--help', '--project-root', '/does/not/exist'], {
    cwd: f.root, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--major-version/);
  assert.deepEqual(snapshot(f.root), before);
});

test('relative deployment paths and missing licenses fail before creating project files', (t) => {
  const f = fixture(t);
  const before = snapshot(f.project);
  const relative = { ...f, cli: 'local/index.js' };
  assert.notEqual(run(relative).status, 0);
  fs.unlinkSync(f.license);
  assert.notEqual(run(f).status, 0);
  assert.deepEqual(snapshot(f.project), before);
});
