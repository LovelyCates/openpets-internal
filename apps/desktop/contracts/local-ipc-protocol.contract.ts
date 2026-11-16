import assert from "node:assert/strict";

import { errorResponse, maxIpcMessageBytes, parseIpcRequest, validateReaction, validateSayMessage, validateInstallLocalKind, validateInstallLocalOrigin, validateInstallLocalPath, validateMediaClickUrl, validateMediaDurationMs, validateMediaPath, validateTokenRateParams } from "../src/local-ipc-protocol.js";

const token = "test-token";
const valid = {
  id: "1",
  version: 1,
  token,
  method: "status",
  params: {},
};

parseIpcRequest(JSON.stringify(valid), token);
parseIpcRequest(JSON.stringify({ ...valid, method: "pets.list" }), token);
parseIpcRequest(JSON.stringify({ ...valid, method: "pets.install-local" }), token);
assert.equal(validateInstallLocalOrigin(undefined), undefined);
assert.equal(validateInstallLocalOrigin("codex"), "codex");
for (const origin of ["catalog", "Codex", "", null, 0, {}, ["codex"]]) {
  assert.throws(() => validateInstallLocalOrigin(origin));
}
assert.throws(() => parseIpcRequest(JSON.stringify({ ...valid, token: "bad" }), token));
assert.throws(() => parseIpcRequest(JSON.stringify({ ...valid, version: 2 }), token));
assert.throws(() => parseIpcRequest(JSON.stringify({ ...valid, method: "pet.install" }), token));
assert.throws(() => parseIpcRequest("not json", token));

const legacyRate = { sessionId: "session-legacy", tokensPerSecond: 52.4, source: "estimated" } as const;
assert.deepEqual(validateTokenRateParams(legacyRate), legacyRate, "omitting AVG preserves the original payload shape");
for (const averageTokensPerSecond of [0, 24.7, 10_000]) {
  const rate = { ...legacyRate, averageTokensPerSecond };
  assert.deepEqual(validateTokenRateParams(rate), rate, "bounded AVG values survive server validation");
}
const finalRate = { sessionId: "session-final", tokensPerSecond: null, averageTokensPerSecond: 24.7, outputTokens: 123, source: "reported" } as const;
assert.deepEqual(validateTokenRateParams(finalRate), finalRate, "reported counts can include the source-computed estimate");
for (const averageTokensPerSecond of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.1, 10_000.1, null, "24.7"]) {
  assert.throws(() => validateTokenRateParams({ ...legacyRate, averageTokensPerSecond }));
}
for (const source of ["estimated", "reported"]) {
  assert.throws(() => validateTokenRateParams({ sessionId: "session-clear", tokensPerSecond: null, averageTokensPerSecond: 0, source }), "a session clear cannot retain an average");
}

validateReaction("testing");
validateReaction("waving");
assert.throws(() => validateReaction("bad"));

validateSayMessage("Working on it");
for (const unsafe of [
  "",
  "a".repeat(141),
  "line one\nline two",
  "```code```",
  "const secret = 1",
  "https://example.com",
  "/Users/alvin/project/file.ts",
  "api_key=abc123",
]) {
  assert.throws(() => validateSayMessage(unsafe));
}

if (Buffer.byteLength(JSON.stringify({ message: "x".repeat(maxIpcMessageBytes) }), "utf8") <= maxIpcMessageBytes) {
  throw new Error("Oversized fixture was not oversized.");
}

parseIpcRequest(JSON.stringify({ ...valid, method: "pet.showMedia" }), token);
validateMediaPath("/tmp/generation.png");
validateMediaPath("/tmp/generation.WEBP");
for (const badMediaPath of ["", "./relative.png", "/tmp/no-extension", "/tmp/script.js", "/tmp/movie.mp4", "\x00"]) {
  assert.throws(() => validateMediaPath(badMediaPath));
}
assert.equal(validateMediaDurationMs(undefined), undefined);
assert.equal(validateMediaDurationMs(8_000), 8_000);
for (const badDuration of [0, 999, 30_001, Number.NaN, "5000"]) {
  assert.throws(() => validateMediaDurationMs(badDuration));
}

assert.equal(validateMediaClickUrl(undefined), undefined);
validateMediaClickUrl("https://example.com/result?id=1");
validateMediaClickUrl("myapp://focus-something");
for (const badClickUrl of [
  "",
  "not-a-url",
  "http://example.com",
  "file:///C:/secret.txt",
  "javascript:alert(1)",
  "data:text/html,x",
  "https://example.com/with space",
  "shell:startup",
]) {
  assert.throws(() => validateMediaClickUrl(badClickUrl));
}

validateInstallLocalPath("/tmp/my-pet.zip");
assert.throws(() => validateInstallLocalPath(""));
assert.throws(() => validateInstallLocalPath("./my-pet"));
assert.throws(() => validateInstallLocalPath("\x00"));
assert.throws(() => validateInstallLocalPath("a".repeat(2049)));
assert.equal(validateInstallLocalKind("zip"), "zip");
assert.equal(validateInstallLocalKind("folder"), "folder");
assert.throws(() => validateInstallLocalKind("file"));

const response = errorResponse("1", new Error("boom"));
if (response.ok || response.error?.code !== "internal_error") {
  throw new Error("Failed to create structured error response.");
}

console.log("Local IPC protocol validation passed.");
