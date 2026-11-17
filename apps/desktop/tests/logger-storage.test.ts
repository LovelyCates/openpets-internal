import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import * as moduleApi from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// A long-running app must retain bounded diagnostics without retaining API keys
// or allowing a logging burst to create an unbounded file/write backlog.
test("logs remain bounded, private and ordered through live rotation and shutdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpets-logs-"));
  const logs = join(root, "logs");
  await mkdir(logs);
  await writeFile(join(logs, "openpets.log"), Buffer.alloc(3 * 1024 * 1024, 32));
  const electronUrl = `data:text/javascript,${encodeURIComponent(`
    export default { app: { isPackaged: true, getPath: () => ${JSON.stringify(root)} }, shell: { openPath: async () => "" } };
  `)}`;
  const hooks = moduleApi.registerHooks({
    resolve(specifier, context, nextResolve) {
      return specifier === "electron"
        ? { url: electronUrl, shortCircuit: true }
        : nextResolve(specifier, context);
    },
  });
  try {
    const logger = await import("../src/logger.js");
    logger.initializeLogger();
    await logger.flushLogs();
    for (let batch = 0; batch < 6; batch++) {
      for (let index = 0; index < 100; index++) {
        logger.info("app", `batch ${batch} entry ${index}`, { payload: "sample ".repeat(1400) });
      }
      await logger.flushLogs();
    }
    logger.info("provider", "credentials must be omitted", { apiKey: "short-private-key", nested: { "X-Api-Key": "nested-private-key" } });
    logger.info("app", "oversized entry", {
      payload: "word ".repeat(100_000),
      second: "second ".repeat(2500),
      third: "third ".repeat(3200),
      fourth: "fourth ".repeat(3200),
      fifth: "fifth ".repeat(4000),
    });
    const boundaryToken = "a".repeat(43);
    logger.info("app", "boundary redaction", { value: "word ".repeat(3273) + boundaryToken });
    let shared: unknown = { apiKey: "tree-private-key" };
    for (let depth = 0; depth < 12; depth++) shared = Array(20).fill(shared);
    logger.info("app", "shared nested value", { payload: shared });
    await logger.flushLogs();
    // Saturate the queue while its first asynchronous file write is pending.
    for (let index = 0; index < 700; index++) {
      logger.info("app", "burst", { payload: "example ".repeat(1200) });
    }
    await logger.flushLogs();
    logger.info("app", "shutdown marker one");
    logger.info("app", "shutdown marker two");
    await logger.flushLogs();
    const names = await readdir(logs);
    assert.equal(names.length, 3, "only the current log and two retained logs should remain");
    const contents: string[] = [];
    for (const name of names) {
      const file = join(logs, name);
      const metadata = await stat(file);
      assert.ok(metadata.size <= 2 * 1024 * 1024, "no retained log may exceed the documented 2 MiB limit");
      if (process.platform !== "win32") assert.equal(metadata.mode & 0o777, 0o600);
      contents.push(await readFile(file, "utf8"));
    }
    const allLogs = contents.join("\n");
    assert.equal(allLogs.includes("short-private-key"), false);
    assert.equal(allLogs.includes("nested-private-key"), false);
    assert.equal(allLogs.includes("tree-private-key"), false);
    assert.ok(allLogs.includes("[repeated log value]"));
    assert.ok(allLogs.includes("[log line truncated]"));
    assert.equal(allLogs.includes("a".repeat(19)), false, "truncation must not expose a credential prefix");
    const current = await readFile(join(logs, "openpets.log"), "utf8");
    assert.ok(current.includes("log backlog limited"));
    assert.ok(current.includes("shutdown marker one"));
    assert.ok(current.includes("shutdown marker two"));
    assert.ok(current.indexOf("shutdown marker one") < current.indexOf("shutdown marker two"));
    assert.ok(current.endsWith("shutdown marker two\n"), "flush must persist accepted shutdown diagnostics");
    if (process.platform !== "win32") assert.equal((await stat(logs)).mode & 0o777, 0o700);
  } finally {
    hooks.deregister();
    await rm(root, { recursive: true, force: true });
  }
});

// Startup cleanup must never follow a diagnostic filename into an unrelated file.
for (const dangling of [false, true]) {
  test(`logger refuses ${dangling ? "dangling" : "existing"} linked storage without modifying the target`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "openpets-linked-log-"));
    const logs = join(root, "logs");
    const target = join(root, "unrelated.txt");
    await mkdir(logs);
    if (!dangling) {
      await writeFile(target, Buffer.alloc(3 * 1024 * 1024, 32));
      if (process.platform !== "win32") await chmod(target, 0o644);
    }
    const electronUrl = `data:text/javascript,${encodeURIComponent(`
      export default { app: { isPackaged: true, getPath: () => ${JSON.stringify(root)} }, shell: {} };
    `)}`;
    const hooks = moduleApi.registerHooks({
      resolve(specifier, context, nextResolve) {
        return specifier === "electron" ? { url: electronUrl, shortCircuit: true } : nextResolve(specifier, context);
      },
    });
    try {
      try {
        await symlink(target, join(logs, dangling ? "openpets.log" : "openpets.previous.log"));
      } catch (error) {
        if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
          t.skip("Windows host does not grant symbolic-link creation");
          return;
        }
        throw error;
      }
      const guarded: typeof import("../src/logger.js") = await import(new URL(`../src/logger.js?linked-storage=${dangling}`, import.meta.url).href);
      guarded.initializeLogger();
      assert.equal(guarded.getLogFilePath(), null);
      if (dangling) {
        await assert.rejects(stat(target), { code: "ENOENT" });
      } else {
        assert.equal((await stat(target)).size, 3 * 1024 * 1024);
        if (process.platform !== "win32") assert.equal((await stat(target)).mode & 0o777, 0o644);
      }
    } finally {
      hooks.deregister();
      await rm(root, { force: true, recursive: true });
    }
  });
}
