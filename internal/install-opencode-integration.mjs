#!/usr/bin/env node
import * as fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const help = `Install a local OpenPets integration without downloading packages.

Usage:
  node internal/install-opencode-integration.mjs \\
    --major-version 1|2 --project-root ABS --cli-path ABS \\
    [--bundle-path ABS] [--node-path ABS]

--project-root  Existing project directory (absolute path).
--cli-path      Deployed CLI .js entry with its complete dependency tree.
--bundle-path   Local plugin bundle; defaults to packages/opencode/vN-package/index.js.
               A LICENSE file must exist beside the bundle.
--node-path     Local executable; defaults to the Node running this installer.
--help, -h      Show this help without changing any files.

Existing unmanaged files or modified managed files are never overwritten.
Managed updates preserve the previous files as .bak-<installation id>.
Symbolic links in project, input, or destination paths are rejected.
`;

function optionsFrom(args) {
  const supported = new Set([
    '--major-version', '--project-root', '--cli-path', '--bundle-path', '--node-path',
  ]);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!supported.has(name) || name in options || !value || value.startsWith('--')) {
      throw new Error(`无效或重复的参数：${name}。使用 --help 查看用法。`);
    }
    options[name] = value;
  }
  if (!['1', '2'].includes(options['--major-version'])) {
    throw new Error('--major-version 必须为 1 或 2。');
  }
  for (const name of ['--project-root', '--cli-path']) {
    if (!options[name]) throw new Error(`缺少参数：${name}。`);
  }
  return options;
}

function absolutePath(value, label) {
  if (!path.isAbsolute(value)) throw new Error(`${label} 必须为绝对路径：${value}`);
  return path.resolve(value);
}

// lstat each ancestor as well as the leaf so a symlinked directory cannot
// redirect installation or hide a dangling link from an existence check.
function safeStat(target, expectedType, required = false) {
  const root = path.parse(target).root;
  const parts = path.relative(root, target).split(path.sep).filter(Boolean);
  let current = root;
  let stat = fs.lstatSync(root);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (required) throw new Error(`找不到本地${expectedType === 'directory' ? '目录' : '文件'}：${target}`);
      return undefined;
    }
    if (stat.isSymbolicLink()) throw new Error(`拒绝跟随符号链接：${current}`);
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw new Error(`路径的父级不是目录：${current}`);
    }
  }
  if (expectedType === 'file' && !stat.isFile()) throw new Error(`不是普通文件：${target}`);
  if (expectedType === 'directory' && !stat.isDirectory()) throw new Error(`不是目录：${target}`);
  return stat;
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function readRegularFile(target) {
  safeStat(target, 'file', true);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`不是普通文件：${target}`);
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function install(options) {
  const majorVersion = Number(options['--major-version']);
  const project = absolutePath(options['--project-root'], '--project-root');
  const cli = absolutePath(options['--cli-path'], '--cli-path');
  const node = absolutePath(options['--node-path'] || process.execPath, '--node-path');
  const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const bundle = absolutePath(
    options['--bundle-path'] || path.join(repository, `packages/opencode/v${majorVersion}-package/index.js`),
    '--bundle-path',
  );
  const license = path.join(path.dirname(bundle), 'LICENSE');
  safeStat(project, 'directory', true);
  safeStat(cli, 'file', true);
  if (path.extname(cli) !== '.js') throw new Error('--cli-path 必须指向本地 .js 入口，不接受 npx 或公网包名。');
  safeStat(node, 'file', true);
  fs.accessSync(node, fs.constants.X_OK);
  const bundleBytes = readRegularFile(bundle);
  const licenseBytes = readRegularFile(license);

  const opencodeDirectory = path.join(project, '.opencode');
  const pluginsDirectory = path.join(opencodeDirectory, 'plugins');
  const manifestTarget = path.join(opencodeDirectory, 'openpets-internal-install.json');
  const otherPlugin = path.join(pluginsDirectory, `openpets-v${majorVersion === 1 ? 2 : 1}.js`);
  safeStat(opencodeDirectory, 'directory');
  safeStat(pluginsDirectory, 'directory');
  if (safeStat(otherPlugin)) throw new Error(`发现另一主版本的 OpenPets 插件：${otherPlugin}。请先人工核对并移除。`);

  const mcpEntry = { type: 'local', command: [node, cli, 'mcp'] };
  if (majorVersion === 1) mcpEntry.enabled = true;
  const config = majorVersion === 1
    ? { mcp: { openpets: mcpEntry } }
    : { mcp: { servers: { openpets: mcpEntry } } };
  const configBytes = jsonBytes(config);
  const manualMerge = `请人工合并下面的本地 MCP 片段并复制插件 bundle 与 LICENSE：\n${configBytes.toString('utf8')}`;

  for (const relative of [
    'opencode.json', 'opencode.jsonc', '.opencode/opencode.json',
    '.opencode/config.json', '.opencode/config.jsonc',
  ]) {
    const target = path.join(project, relative);
    if (safeStat(target)) throw new Error(`发现其他 OpenCode 配置：${target}。拒绝猜测配置优先级。${manualMerge}`);
  }

  const files = [
    { field: 'bundle', relative: `.opencode/plugins/openpets-v${majorVersion}.js`, bytes: bundleBytes },
    { field: 'license', relative: '.opencode/plugins/openpets-LICENSE.txt', bytes: licenseBytes },
    { field: 'config', relative: '.opencode/opencode.jsonc', bytes: configBytes },
  ].map((file) => ({ ...file, target: path.join(project, file.relative) }));
  for (const file of files) safeStat(file.target, 'file');
  const managed = Boolean(safeStat(manifestTarget, 'file'));
  const originalManifest = managed ? readRegularFile(manifestTarget) : undefined;
  if (managed) {
    try {
      const record = JSON.parse(originalManifest.toString('utf8').replace(/^\uFEFF/, ''));
      if (!record || record.schemaVersion !== 1 || record.majorVersion !== majorVersion) {
        throw new Error('安装记录的主版本或格式不匹配。');
      }
      for (const file of files) {
        const entry = record[file.field];
        if (!entry || entry.path !== file.relative || !/^[a-f\d]{64}$/i.test(entry.sha256)) {
          throw new Error(`${file.field} 文件位置或哈希与安装记录不符。`);
        }
        file.original = readRegularFile(file.target);
        if (digest(file.original) !== entry.sha256.toLowerCase()) {
          throw new Error(`${file.field} 文件已被修改，拒绝覆盖。`);
        }
      }
    } catch (error) {
      throw new Error(`已有安装记录无法安全更新：${error.message} ${manualMerge}`);
    }
  } else {
    for (const file of files) {
      if (safeStat(file.target)) throw new Error(`已有文件没有本安装器记录：${file.target}。拒绝覆盖。${manualMerge}`);
    }
  }

  const manifest = { schemaVersion: 1, majorVersion, sourceBundle: bundle, cliPath: cli };
  for (const file of files) manifest[file.field] = { path: file.relative, sha256: digest(file.bytes) };
  files.push({ target: manifestTarget, bytes: jsonBytes(manifest), original: originalManifest });
  const id = randomUUID().replaceAll('-', '');
  const completed = [];
  const temporary = new Set();
  try {
    for (const directory of [opencodeDirectory, pluginsDirectory]) {
      if (!safeStat(directory, 'directory')) fs.mkdirSync(directory, { mode: 0o700 });
      safeStat(directory, 'directory', true);
    }
    for (const file of files) {
      file.staged = path.join(path.dirname(file.target), `.openpets-${path.basename(file.target)}-${id}.tmp`);
      safeStat(path.dirname(file.staged), 'directory', true);
      fs.writeFileSync(file.staged, file.bytes, { flag: 'wx', mode: 0o600 });
      temporary.add(file.staged);
    }
    // Recheck every destination before publishing any file. New installations
    // use an exclusive hard link so a concurrently created file is not replaced.
    for (const file of files) {
      const existing = safeStat(file.target, 'file');
      if (file.original) {
        if (!existing || digest(readRegularFile(file.target)) !== digest(file.original)) {
          throw new Error(`文件在安装期间发生变化，拒绝覆盖：${file.target}`);
        }
        file.backup = `${file.target}.bak-${id}`;
        fs.writeFileSync(file.backup, file.original, { flag: 'wx', mode: 0o600 });
      } else if (existing) {
        throw new Error(`文件在安装期间已被创建，拒绝覆盖：${file.target}`);
      }
    }
    for (const file of files) {
      safeStat(path.dirname(file.target), 'directory', true);
      if (file.original) {
        if (digest(readRegularFile(file.target)) !== digest(file.original)) {
          throw new Error(`文件在安装期间发生变化，拒绝覆盖：${file.target}`);
        }
        fs.renameSync(file.staged, file.target);
      } else {
        fs.linkSync(file.staged, file.target);
      }
      completed.push(file);
    }
  } catch (error) {
    for (const file of completed.reverse()) {
      try {
        if (digest(readRegularFile(file.target)) !== digest(file.bytes)) {
          throw new Error('安装后文件又发生变化，保留现场。');
        }
        if (file.original) {
          const recovery = `${file.staged}.rollback`;
          safeStat(path.dirname(recovery), 'directory', true);
          fs.writeFileSync(recovery, file.original, { flag: 'wx', mode: 0o600 });
          temporary.add(recovery);
          fs.renameSync(recovery, file.target);
        } else {
          fs.unlinkSync(file.target);
        }
      } catch (rollbackError) {
        process.stderr.write(`回滚失败，请从备份恢复：${file.target}；${rollbackError.message}\n`);
      }
    }
    throw new Error(`OpenCode 集成安装失败并已尝试回滚：${error.message}`);
  } finally {
    for (const target of temporary) {
      try {
        if (safeStat(target, 'file')) fs.unlinkSync(target);
      } catch (error) {
        process.stderr.write(`临时文件清理失败：${target}；${error.message}\n`);
      }
    }
  }
  process.stdout.write(`OpenCode ${majorVersion}.x 集成已安装到：${project}\n`);
  process.stdout.write(`插件：${files[0].target}\nMCP 配置：${files[2].target}\n本地 CLI：${cli}\n`);
  if (managed) process.stdout.write(`旧文件备份后缀：.bak-${id}\n`);
  process.stdout.write('请重启 OpenCode，并在无公网出口的测试机验证插件事件与 MCP 工具。\n');
}

try {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) process.stdout.write(help);
  else install(optionsFrom(args));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
