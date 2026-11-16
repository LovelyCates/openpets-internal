// src/opencode-plugin-runtime.ts
import { homedir as homedir2, tmpdir, userInfo } from "node:os";
import { dirname as dirname2, join as join2 } from "node:path";
import { mkdirSync, readFileSync as readFileSync2, renameSync, writeFileSync } from "node:fs";

// ../client/dist/index.js
import net from "node:net";
import { randomUUID } from "node:crypto";
import { posix, win32 } from "node:path";

// ../client/dist/discovery.js
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

// ../client/dist/protocol.js
var openPetsIpcProtocol = "openpets-ipc";
var openPetsIpcVersion = 1;
var maxIpcMessageBytes = 16 * 1024;
var connectTimeoutMs = 2e3;
var responseTimeoutMs = 3e3;
var allowedReactions = [
  "idle",
  "thinking",
  "working",
  "editing",
  "running",
  "testing",
  "waiting",
  "waving",
  "success",
  "error",
  "celebrating"
];
function parseIpcResponse(value) {
  if (!isRecord(value))
    throw new OpenPetsClientError("invalid_response", "IPC response must be an object.");
  if (typeof value.id !== "string" && value.id !== null)
    throw new OpenPetsClientError("invalid_response", "IPC response id is invalid.");
  if (value.ok === true) {
    return { id: value.id, ok: true, result: value.result };
  }
  if (value.ok === false && isRecord(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string") {
    return { id: value.id, ok: false, error: { code: value.error.code, message: value.error.message } };
  }
  throw new OpenPetsClientError("invalid_response", "IPC response shape is invalid.");
}
function validateReaction(value) {
  if (!allowedReactions.includes(value)) {
    throw new OpenPetsClientError("invalid_reaction", "Invalid OpenPets reaction.");
  }
  return value;
}
var OpenPetsClientError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
  }
};
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

// ../client/dist/discovery.js
function getDiscoveryFilePath() {
  if (process.env.OPENPETS_DISCOVERY_FILE) {
    return process.env.OPENPETS_DISCOVERY_FILE;
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "OpenPets Internal", "runtime", "ipc.json");
  }
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "OpenPets Internal", "runtime", "ipc.json");
  }
  const xdg = getSecureXdgRuntimeDir();
  if (xdg) {
    return join(xdg, "openpets", "ipc.json");
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "OpenPets", "runtime", "ipc.json");
}
function readDiscoveryFile(path = getDiscoveryFilePath()) {
  let raw;
  try {
    const stat = statSync(path);
    if (!stat.isFile())
      throw new OpenPetsClientError("invalid_discovery", "OpenPets discovery path is not a file.");
    if (stat.size > maxIpcMessageBytes)
      throw new OpenPetsClientError("invalid_discovery", "OpenPets discovery file is too large.");
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof OpenPetsClientError)
      throw error;
    throw new OpenPetsClientError("unavailable", `OpenPets discovery file is unavailable: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  if (Buffer.byteLength(raw, "utf8") > maxIpcMessageBytes) {
    throw new OpenPetsClientError("invalid_discovery", "OpenPets discovery file is too large.");
  }
  try {
    return validateDiscovery(JSON.parse(raw));
  } catch (error) {
    if (error instanceof OpenPetsClientError)
      throw error;
    throw new OpenPetsClientError("invalid_discovery", "OpenPets discovery file is malformed JSON.");
  }
}
function validateDiscovery(value) {
  if (!isRecord(value))
    throw new OpenPetsClientError("invalid_discovery", "Discovery must be an object.");
  if (value.protocol !== openPetsIpcProtocol)
    throw new OpenPetsClientError("invalid_discovery", "Discovery protocol is invalid.");
  if (value.protocolVersion !== openPetsIpcVersion)
    throw new OpenPetsClientError("invalid_discovery", "Discovery protocol version is invalid.");
  if (typeof value.endpoint !== "string")
    throw new OpenPetsClientError("invalid_discovery", "Discovery endpoint is invalid.");
  if (typeof value.token !== "string" || value.token.length < 16 || value.token.length > 256)
    throw new OpenPetsClientError("invalid_discovery", "Discovery token is invalid.");
  if (typeof value.appVersion !== "string")
    throw new OpenPetsClientError("invalid_discovery", "Discovery app version is invalid.");
  if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0)
    throw new OpenPetsClientError("invalid_discovery", "Discovery pid is invalid.");
  if (value.platform !== "darwin" && value.platform !== "linux" && value.platform !== "win32")
    throw new OpenPetsClientError("invalid_discovery", "Discovery platform is invalid.");
  const endpoint = parseIpcEndpoint(value.endpoint);
  if (process.platform === "win32" && endpoint.kind === "tcp") {
    throw new OpenPetsClientError("invalid_discovery", "Windows local discovery must use an OpenPets named pipe.");
  }
  if (process.platform === "darwin" && endpoint.kind === "tcp") {
    throw new OpenPetsClientError("invalid_discovery", "macOS local discovery must use an OpenPets Unix socket.");
  }
  if (value.platform !== process.platform && !allowsCrossPlatformDiscovery(value.platform, endpoint)) {
    throw new OpenPetsClientError("invalid_discovery", "Discovery platform does not match this client.");
  }
  return {
    protocolVersion: openPetsIpcVersion,
    protocol: openPetsIpcProtocol,
    endpoint: value.endpoint,
    token: value.token,
    appVersion: value.appVersion,
    pid: value.pid,
    platform: value.platform
  };
}
function parseIpcEndpoint(endpoint) {
  if (endpoint.length < 1 || endpoint.length > 240)
    throw new OpenPetsClientError("invalid_discovery", "Discovery endpoint length is invalid.");
  if (endpoint.includes("\0"))
    throw new OpenPetsClientError("invalid_discovery", "Discovery endpoint contains NUL.");
  if (endpoint.startsWith("tcp://")) {
    return parseTcpEndpoint(endpoint);
  }
  if (process.platform === "win32") {
    if (!endpoint.startsWith("\\\\.\\pipe\\openpets-") || endpoint.includes("/")) {
      throw new OpenPetsClientError("invalid_discovery", "Discovery endpoint is not an OpenPets named pipe.");
    }
    return { kind: "path", path: endpoint };
  }
  if (!endpoint.startsWith("/") || endpoint.includes("://") || endpoint.includes("..")) {
    throw new OpenPetsClientError("invalid_discovery", "Discovery endpoint is not an absolute Unix socket path.");
  }
  if (!basename(endpoint).startsWith("openpets-") || !basename(endpoint).endsWith(".sock")) {
    throw new OpenPetsClientError("invalid_discovery", "Discovery endpoint filename is not an OpenPets socket.");
  }
  const parent = dirname(endpoint);
  const parentName = basename(parent);
  const isTmpRuntime = parent.startsWith("/tmp/") && parentName.startsWith("openpets-");
  const isXdgRuntime = parentName === "openpets";
  if (!isTmpRuntime && !isXdgRuntime) {
    throw new OpenPetsClientError("invalid_discovery", "Discovery endpoint is outside an expected OpenPets runtime directory.");
  }
  return { kind: "path", path: endpoint };
}
function parseTcpEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new OpenPetsClientError("invalid_discovery", "Discovery TCP endpoint is invalid.");
  }
  if (url.protocol !== "tcp:" || url.username || url.password || url.pathname !== "" && url.pathname !== "/" || url.search || url.hash) {
    throw new OpenPetsClientError("invalid_discovery", "Discovery TCP endpoint must be tcp://<host>:<port> with no credentials, path, query, or fragment.");
  }
  const host = url.hostname;
  if (host === "0.0.0.0") {
    throw new OpenPetsClientError("invalid_discovery", "Discovery TCP endpoint cannot use 0.0.0.0 as target host.");
  }
  if (!isValidIpv4(host)) {
    throw new OpenPetsClientError("invalid_discovery", "Discovery TCP endpoint host must be a valid IPv4 address.");
  }
  if (/[a-zA-Z]/.test(host)) {
    throw new OpenPetsClientError("invalid_discovery", "Discovery TCP endpoint host must be an IPv4 address, not a hostname.");
  }
  if (!isPrivateOrLocalIpv4(host)) {
    throw new OpenPetsClientError("invalid_discovery", `Discovery TCP endpoint host ${host} is not a private/local IPv4 address. Only loopback (127.0.0.1), private (10.x.x.x, 172.16-31.x.x, 192.168.x.x), or link-local (169.254.x.x) addresses are allowed.`);
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== url.port) {
    throw new OpenPetsClientError("invalid_discovery", "Discovery TCP endpoint port is invalid.");
  }
  return { kind: "tcp", host, port };
}
function isValidIpv4(host) {
  const parts = host.split(".");
  if (parts.length !== 4)
    return false;
  return parts.every((part) => {
    const num = Number(part);
    return String(num) === part && num >= 0 && num <= 255;
  });
}
function isPrivateOrLocalIpv4(host) {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4)
    return false;
  if (parts[0] === 127)
    return true;
  if (parts[0] === 10)
    return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    return true;
  if (parts[0] === 192 && parts[1] === 168)
    return true;
  if (parts[0] === 169 && parts[1] === 254)
    return true;
  return false;
}
function allowsCrossPlatformDiscovery(platform, endpoint) {
  if (endpoint.kind !== "tcp" || platform !== "win32" || process.platform !== "linux") {
    return false;
  }
  return isPrivateOrLocalIpv4(endpoint.host);
}
function getSecureXdgRuntimeDir() {
  const dir = process.env.XDG_RUNTIME_DIR;
  if (!dir || !existsSync(dir))
    return null;
  try {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      return null;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid())
      return null;
    if ((stat.mode & 511) !== 448)
      return null;
    return dir;
  } catch {
    return null;
  }
}

// ../client/dist/pet-list.js
var maxPetListItems = 1e5;
var maxPetListPages = 4096;
var maxPetListBytes = 64 * 1024 * 1024;
async function readPetList(fetchPage) {
  const pets = [];
  const seenIds = /* @__PURE__ */ new Set();
  let revision;
  let total;
  let defaultPetId;
  let bytes = 0;
  for (let pageNumber = 0; pageNumber < maxPetListPages; pageNumber += 1) {
    const value = await fetchPage({ offset: pets.length, ...revision === void 0 ? {} : { revision } });
    const pageBytes = Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
    bytes += pageBytes;
    if (pageBytes > maxIpcMessageBytes || bytes > maxPetListBytes)
      invalidList("OpenPets pet list exceeds supported bounds.");
    const page = parsePetListResult(value);
    if (!isRecord2(value))
      invalidList();
    const paginated = value.total !== void 0 || value.revision !== void 0 || value.nextOffset !== void 0;
    if (!paginated) {
      if (pageNumber !== 0 || page.pets.length > maxPetListItems)
        invalidList();
      return page;
    }
    if (typeof value.total !== "number" || !Number.isSafeInteger(value.total) || value.total < 0 || value.total > maxPetListItems || typeof value.revision !== "string" || !/^[a-f0-9]{64}$/.test(value.revision) || value.nextOffset !== null && (typeof value.nextOffset !== "number" || !Number.isSafeInteger(value.nextOffset))) {
      invalidList();
    }
    if (revision !== void 0 && (revision !== value.revision || total !== value.total || defaultPetId !== page.defaultPetId)) {
      invalidList("OpenPets pet list changed while being read; retry listPets().");
    }
    revision = value.revision;
    total = value.total;
    defaultPetId = page.defaultPetId;
    const nextOffset = pets.length + page.pets.length;
    if (nextOffset > total || page.pets.length === 0 && total !== 0)
      invalidList();
    for (const pet of page.pets) {
      if (seenIds.has(pet.id))
        invalidList("OpenPets pet list contains duplicate entries.");
      seenIds.add(pet.id);
      pets.push(pet);
    }
    if (value.nextOffset === null) {
      if (pets.length !== total)
        invalidList();
      return { ok: true, pets, defaultPetId };
    }
    if (value.nextOffset !== nextOffset || nextOffset >= total)
      invalidList();
  }
  return invalidList("OpenPets pet list requires too many pages.");
}
function parsePetListResult(value) {
  if (!isRecord2(value) || value.ok !== true || !Array.isArray(value.pets) || typeof value.defaultPetId !== "string")
    invalidList();
  return { ok: true, defaultPetId: value.defaultPetId, pets: value.pets.map(parsePetListItem) };
}
function parsePetListItem(value) {
  if (!isRecord2(value) || typeof value.id !== "string" || typeof value.displayName !== "string" || typeof value.builtIn !== "boolean" || typeof value.broken !== "boolean") {
    invalidList("OpenPets pet list item is invalid.");
  }
  return { id: value.id, displayName: value.displayName, builtIn: value.builtIn, broken: value.broken };
}
function invalidList(message = "OpenPets pet list response is invalid.") {
  throw new OpenPetsClientError("invalid_response", message);
}
function isRecord2(value) {
  return typeof value === "object" && value !== null;
}

// ../client/dist/remote-protocol.js
import { isIPv4 } from "node:net";
var openPetsRemoteProtocol = "openpets-remote";
var openPetsRemoteVersion = 1;
var maxRemoteMessageBytes = 4 * 1024;
var remoteConnectTimeoutMs = 2e3;
var remoteResponseTimeoutMs = 3e3;
function parseRemoteEndpoint(endpoint) {
  if (typeof endpoint !== "string" || endpoint.length < 1 || endpoint.length > 120 || !endpoint.startsWith("tcp://")) {
    throw new OpenPetsClientError("invalid_remote_endpoint", "Remote endpoint is invalid.");
  }
  const match = /^tcp:\/\/([^:\/?#]+):(\d+)\/?$/.exec(endpoint);
  if (!match) {
    throw new OpenPetsClientError("invalid_remote_endpoint", "Remote endpoint is invalid.");
  }
  const host = match[1];
  if (!isCanonicalIpv4(host) || !isPrivateIpv4(host)) {
    throw new OpenPetsClientError("invalid_remote_endpoint", "Remote endpoint is invalid.");
  }
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== match[2]) {
    throw new OpenPetsClientError("invalid_remote_endpoint", "Remote endpoint is invalid.");
  }
  return { kind: "tcp", host, port };
}
function validateRemoteToken(value) {
  if (typeof value !== "string" || value.length < 43 || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new OpenPetsClientError("invalid_remote_token", "Remote token is invalid.");
  }
  return value;
}
function validateRemoteClientId(value) {
  if (value === void 0)
    return void 0;
  if (typeof value !== "string" || value.length < 1 || value.length > 120 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new OpenPetsClientError("invalid_remote_client", "Remote client id is invalid.");
  }
  return value;
}
function validateRemoteMessage(value) {
  if (typeof value !== "string")
    throw new OpenPetsClientError("invalid_remote_message", "Remote message is invalid.");
  const message = value.trim();
  if (message.length < 1 || message.length > 140 || Buffer.byteLength(message, "utf8") > 560 || /[\0\r\n]/.test(message) || /```|<script|function\s+\w+|=>|\b(class|import|export|const|let|var)\b/.test(message) || /https?:\/\/|www\.|\/[\w.-]+\/[\w./-]+|[A-Za-z]:\\/.test(message) || /(api[_-]?key|secret|token|password|passwd|BEGIN [A-Z ]+PRIVATE KEY)/i.test(message)) {
    throw new OpenPetsClientError("invalid_remote_message", "Remote message is invalid.");
  }
  return message;
}
function validateRemoteReaction(value) {
  if (!allowedReactions.includes(value)) {
    throw new OpenPetsClientError("invalid_reaction", "Invalid OpenPets reaction.");
  }
  return value;
}
function parseRemoteResponse(value) {
  if (!isRecord3(value) || typeof value.id !== "string" && value.id !== null) {
    throw new OpenPetsClientError("invalid_remote_response", "Remote response is invalid.");
  }
  if (value.ok === true)
    return { id: value.id, ok: true, result: value.result };
  if (value.ok === false && isRecord3(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string") {
    return { id: value.id, ok: false, error: { code: value.error.code, message: value.error.message } };
  }
  throw new OpenPetsClientError("invalid_remote_response", "Remote response is invalid.");
}
function isCanonicalIpv4(value) {
  if (!isIPv4(value))
    return false;
  return value.split(".").every((part) => String(Number(part)) === part);
}
function isPrivateIpv4(value) {
  const parts = value.split(".").map(Number);
  if (parts[0] === 127 || parts[0] === 10)
    return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    return true;
  if (parts[0] === 192 && parts[1] === 168)
    return true;
  if (parts[0] === 169 && parts[1] === 254)
    return true;
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ../client/dist/index.js
var SESSION_NONCE = randomUUID();
function createOpenPetsClient(options = {}) {
  const remote = resolveRemoteOptions(options);
  const unsupportedRemote = () => Promise.reject(new OpenPetsClientError("remote_method_not_supported", "This operation is not available in remote mode."));
  return {
    transport: remote ? "remote" : "local",
    hello: () => remote ? sendRemoteRequest(remote.endpoint, remote.token, remote.clientId, "status", {}, options) : sendDiscoveredRequest("hello", {}, options),
    status: async (statusOptions) => {
      try {
        if (remote)
          return await sendRemoteRequest(remote.endpoint, remote.token, remote.clientId, "status", {}, options);
        return await sendDiscoveredRequest("status", { leaseId: statusOptions?.leaseId }, options);
      } catch (error) {
        return {
          ok: false,
          appRunning: false,
          unavailableReason: remote ? "Remote OpenPets is unavailable." : error instanceof Error ? error.message : "OpenPets is unavailable."
        };
      }
    },
    listPets: async () => remote ? unsupportedRemote() : readPetList((params) => sendDiscoveredRequest("pets.list", params, options)),
    installPet: async (petId) => remote ? unsupportedRemote() : parsePetInstallResult(await sendDiscoveredRequest("pets.install", { petId: validatePetId(petId) }, { ...options, responseTimeoutMs: options.responseTimeoutMs ?? 6e4 })),
    installLocalPet: async (path, installOptions) => {
      if (remote)
        return unsupportedRemote();
      if (typeof path !== "string" || path.trim().length === 0) {
        throw new OpenPetsClientError("invalid_params", "Path must be a non-empty string.");
      }
      const trimmedPath = path.trim();
      if (!isLocalInstallAbsolutePath(trimmedPath)) {
        throw new OpenPetsClientError("invalid_params", "Path must be absolute.");
      }
      if (!installOptions || installOptions.kind !== "zip" && installOptions.kind !== "folder") {
        throw new OpenPetsClientError("invalid_params", "Local install kind must be zip or folder.");
      }
      const origin = installOptions.origin;
      if (origin !== void 0 && origin !== "codex") {
        throw new OpenPetsClientError("invalid_params", "Local install origin must be codex when specified.");
      }
      const libraryMetadata = installOptions.libraryMetadata;
      if (libraryMetadata !== void 0 && origin !== "codex") {
        throw new OpenPetsClientError("invalid_params", "Pet library metadata requires a Codex-origin local import.");
      }
      return parsePetInstallResult(await sendDiscoveredRequest("pets.install-local", {
        path: trimmedPath,
        kind: installOptions.kind,
        ...origin === void 0 ? {} : { origin },
        ...libraryMetadata === void 0 ? {} : { libraryMetadata }
      }, { ...options, responseTimeoutMs: options.responseTimeoutMs ?? 6e4 }));
    },
    acquireLease: (leaseOptions) => remote ? unsupportedRemote() : sendDiscoveredRequest("lease.acquire", { requestedPetId: leaseOptions?.requestedPetId, clientPid: process.pid, sessionNonce: SESSION_NONCE }, options),
    heartbeatLease: (leaseId) => remote ? unsupportedRemote() : sendDiscoveredRequest("lease.heartbeat", { leaseId }, options),
    releaseLease: (leaseId) => remote ? unsupportedRemote() : sendDiscoveredRequest("lease.release", { leaseId }, options),
    react: (reaction, reactOptions) => remote ? sendRemoteRequest(remote.endpoint, remote.token, remote.clientId, "pet.react", { reaction: validateRemoteReaction(reaction) }, options) : sendDiscoveredRequest("pet.react", { reaction: validateReaction(reaction), leaseId: reactOptions?.leaseId }, options),
    say: (message, sayOptions) => remote ? sendRemoteRequest(remote.endpoint, remote.token, remote.clientId, "pet.say", { message: validateRemoteMessage(message), ...sayOptions?.reaction === void 0 ? {} : { reaction: validateRemoteReaction(sayOptions.reaction) } }, options) : sendDiscoveredRequest("pet.say", { message, reaction: sayOptions?.reaction, leaseId: sayOptions?.leaseId }, options),
    showMedia: (path, mediaOptions) => {
      if (remote)
        return unsupportedRemote();
      if (typeof path !== "string" || path.trim().length === 0) {
        throw new OpenPetsClientError("invalid_params", "Media path must be a non-empty string.");
      }
      const trimmedPath = path.trim();
      if (!isLocalInstallAbsolutePath(trimmedPath)) {
        throw new OpenPetsClientError("invalid_params", "Media path must be absolute.");
      }
      return sendDiscoveredRequest("pet.showMedia", { path: trimmedPath, message: mediaOptions?.message, reaction: mediaOptions?.reaction === void 0 ? void 0 : validateReaction(mediaOptions.reaction), durationMs: mediaOptions?.durationMs, clickUrl: mediaOptions?.clickUrl, leaseId: mediaOptions?.leaseId }, options);
    },
    tokenRate: async (update) => {
      if (remote)
        return unsupportedRemote();
      return sendDiscoveredRequest("pet.tokenRate", validateTokenRateUpdate(update), options);
    }
  };
}
function validateTokenRateUpdate(value) {
  if (!value || typeof value !== "object") {
    throw new OpenPetsClientError("invalid_params", "Token rate update is invalid.");
  }
  if (typeof value.sessionId !== "string" || !/^[A-Za-z0-9._:-]{1,80}$/.test(value.sessionId)) {
    throw new OpenPetsClientError("invalid_params", "Token rate session id is invalid.");
  }
  if (value.tokensPerSecond !== null && (typeof value.tokensPerSecond !== "number" || !Number.isFinite(value.tokensPerSecond) || value.tokensPerSecond < 0 || value.tokensPerSecond > 1e4)) {
    throw new OpenPetsClientError("invalid_params", "Token rate is outside supported bounds.");
  }
  if (value.outputTokens !== void 0 && (!Number.isSafeInteger(value.outputTokens) || value.outputTokens < 0 || value.outputTokens > 1e9)) {
    throw new OpenPetsClientError("invalid_params", "Output token count is outside supported bounds.");
  }
  if (value.averageTokensPerSecond !== void 0 && (typeof value.averageTokensPerSecond !== "number" || !Number.isFinite(value.averageTokensPerSecond) || value.averageTokensPerSecond < 0 || value.averageTokensPerSecond > 1e4)) {
    throw new OpenPetsClientError("invalid_params", "Average token rate is outside supported bounds.");
  }
  if (value.tokensPerSecond === null && value.outputTokens === void 0 && value.averageTokensPerSecond !== void 0) {
    throw new OpenPetsClientError("invalid_params", "A cleared token rate cannot include an average.");
  }
  if (value.source !== "estimated" && value.source !== "reported") {
    throw new OpenPetsClientError("invalid_params", "Token rate source is invalid.");
  }
  if (value.tokensPerSecond === null && value.outputTokens !== void 0 && value.source !== "reported") {
    throw new OpenPetsClientError("invalid_params", "Final output token count must be reported.");
  }
  if (value.leaseId !== void 0 && (typeof value.leaseId !== "string" || value.leaseId.length < 1 || value.leaseId.length > 120 || /[\x00-\x1F\x7F]/.test(value.leaseId))) {
    throw new OpenPetsClientError("invalid_params", "Token rate lease id is invalid.");
  }
  return {
    sessionId: value.sessionId,
    tokensPerSecond: value.tokensPerSecond,
    ...value.averageTokensPerSecond === void 0 ? {} : { averageTokensPerSecond: value.averageTokensPerSecond },
    source: value.source,
    ...value.outputTokens === void 0 ? {} : { outputTokens: value.outputTokens },
    ...value.leaseId === void 0 ? {} : { leaseId: value.leaseId }
  };
}
function parsePetInstallResult(value) {
  if (!isRecord4(value) || value.ok !== true || typeof value.petId !== "string" || typeof value.displayName !== "string" || value.installed !== true) {
    throw new OpenPetsClientError("invalid_response", "OpenPets pet install response is invalid.");
  }
  return { ok: true, petId: value.petId, displayName: value.displayName, installed: true };
}
function validatePetId(value) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value) || value === "builtin") {
    throw new OpenPetsClientError("invalid_pet_id", "Invalid OpenPets pet id.");
  }
  return value;
}
function isLocalInstallAbsolutePath(value) {
  return posix.isAbsolute(value) || win32.isAbsolute(value);
}
function isRecord4(value) {
  return typeof value === "object" && value !== null;
}
async function sendDiscoveredRequest(method, params, options) {
  const discovery = readDiscoveryFile(options.discoveryPath);
  return sendRequest(discovery, method, params, options);
}
function resolveRemoteOptions(options) {
  if (options.remote === false)
    return null;
  const explicit = options.remote;
  const hasFlatRemote = options.remoteEndpoint !== void 0 || options.remoteToken !== void 0 || options.remoteClientId !== void 0;
  const hasEnvironmentRemote = process.env.OPENPETS_REMOTE_ENDPOINT !== void 0 || process.env.OPENPETS_REMOTE_TOKEN !== void 0 || process.env.OPENPETS_REMOTE_CLIENT_ID !== void 0;
  if (!explicit && !hasFlatRemote && !hasEnvironmentRemote)
    return null;
  const endpoint = explicit?.endpoint ?? options.remoteEndpoint ?? process.env.OPENPETS_REMOTE_ENDPOINT;
  const token = explicit?.token ?? options.remoteToken ?? process.env.OPENPETS_REMOTE_TOKEN;
  const clientId = explicit?.clientId ?? options.remoteClientId ?? process.env.OPENPETS_REMOTE_CLIENT_ID;
  if (endpoint === void 0 || token === void 0) {
    throw new OpenPetsClientError("invalid_remote_configuration", "Remote configuration is incomplete.");
  }
  const validatedClientId = validateRemoteClientId(clientId);
  return {
    endpoint: parseRemoteEndpoint(endpoint),
    token: validateRemoteToken(token),
    ...validatedClientId === void 0 ? {} : { clientId: validatedClientId }
  };
}
function sendRemoteRequest(endpoint, token, clientId, method, params, options = {}) {
  const parsedEndpoint = typeof endpoint === "string" ? parseRemoteEndpoint(endpoint) : parseRemoteEndpoint(`tcp://${endpoint.host}:${endpoint.port}`);
  const validToken = validateRemoteToken(token);
  const validClientId = validateRemoteClientId(clientId);
  const request = {
    id: randomUUID(),
    protocol: openPetsRemoteProtocol,
    version: openPetsRemoteVersion,
    ...validClientId === void 0 ? {} : { clientId: validClientId },
    token: validToken,
    method,
    params
  };
  const requestLine = `${JSON.stringify(request)}
`;
  if (Buffer.byteLength(requestLine, "utf8") > maxRemoteMessageBytes) {
    return Promise.reject(new OpenPetsClientError("request_too_large", "Remote request is too large."));
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: parsedEndpoint.host, port: parsedEndpoint.port });
    let buffer = "";
    let settled = false;
    let connectTimer = setTimeout(() => finish(new OpenPetsClientError("connect_timeout", "Timed out connecting to remote OpenPets.")), options.connectTimeoutMs ?? remoteConnectTimeoutMs);
    let responseTimer = null;
    const finish = (error, result) => {
      if (settled)
        return;
      settled = true;
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      if (responseTimer) {
        clearTimeout(responseTimer);
        responseTimer = null;
      }
      socket.destroy();
      if (error)
        reject(error);
      else
        resolve(result);
    };
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      responseTimer = setTimeout(() => finish(new OpenPetsClientError("response_timeout", "Timed out waiting for remote OpenPets response.")), options.responseTimeoutMs ?? remoteResponseTimeoutMs);
      socket.write(requestLine);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > maxRemoteMessageBytes) {
        finish(new OpenPetsClientError("response_too_large", "Remote response is too large."));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0)
        return;
      try {
        const parsed = parseRemoteResponse(JSON.parse(buffer.slice(0, newline)));
        if (parsed.id !== request.id)
          throw new OpenPetsClientError("invalid_remote_response", "Remote response is invalid.");
        if (parsed.ok)
          finish(void 0, parsed.result);
        else
          finish(new OpenPetsClientError(parsed.error?.code ?? "remote_request_failed", "Remote request failed."));
      } catch (error) {
        finish(error);
      }
    });
    socket.once("error", () => finish(new OpenPetsClientError("unavailable", "Remote OpenPets is unavailable.")));
    socket.once("end", () => {
      if (!settled)
        finish(new OpenPetsClientError("connection_closed", "Remote OpenPets closed the connection."));
    });
  });
}
function sendRequest(discovery, method, params, options = {}) {
  const request = {
    id: randomUUID(),
    version: openPetsIpcVersion,
    token: discovery.token,
    method,
    params
  };
  const requestLine = `${JSON.stringify(request)}
`;
  if (Buffer.byteLength(requestLine, "utf8") > maxIpcMessageBytes) {
    return Promise.reject(new OpenPetsClientError("request_too_large", "OpenPets IPC request is too large."));
  }
  return new Promise((resolve, reject) => {
    const endpoint = parseIpcEndpoint(discovery.endpoint);
    const socket = endpoint.kind === "tcp" ? net.createConnection({ host: endpoint.host, port: endpoint.port }) : net.createConnection(endpoint.path);
    let buffer = "";
    let settled = false;
    const connectTimer = setTimeout(() => finish(new OpenPetsClientError("connect_timeout", "Timed out connecting to OpenPets.")), options.connectTimeoutMs ?? connectTimeoutMs);
    const responseTimer = setTimeout(() => finish(new OpenPetsClientError("response_timeout", "Timed out waiting for OpenPets response.")), options.responseTimeoutMs ?? responseTimeoutMs);
    const finish = (error, result) => {
      if (settled)
        return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(responseTimer);
      socket.destroy();
      if (error)
        reject(error);
      else
        resolve(result);
    };
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      clearTimeout(connectTimer);
      socket.write(requestLine);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > maxIpcMessageBytes) {
        finish(new OpenPetsClientError("response_too_large", "OpenPets IPC response is too large."));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1)
        return;
      try {
        const parsed = parseIpcResponse(JSON.parse(buffer.slice(0, newline)));
        if (parsed.ok)
          finish(void 0, parsed.result);
        else
          finish(new OpenPetsClientError(parsed.error.code, parsed.error.message));
      } catch (error) {
        finish(error);
      }
    });
    socket.once("error", (error) => finish(new OpenPetsClientError("unavailable", error.message)));
    socket.once("end", () => {
      if (!settled)
        finish(new OpenPetsClientError("connection_closed", "OpenPets closed the IPC connection before responding."));
    });
  });
}

// ../agent-events/dist/index.js
var hookSpeechPools = {
  thinking: ["Thinking it through", "Let me check", "On it", "Working it out"],
  success: ["Done", "That worked", "All set", "Nice, finished"],
  error: ["Something failed", "Needs another look", "Hit a snag", "Not quite there"],
  permission: ["Approval needed"],
  question: ["Question for you", "Quick question", "Need your input"]
};
function pickHookSpeech(category, random = Math.random) {
  const pool = hookSpeechPools[category];
  return pool[Math.max(0, Math.min(pool.length - 1, Math.floor(random() * pool.length)))] ?? pool[0] ?? "Working";
}
function validateHookSpeech(message) {
  if (message.length < 1 || message.length > 140)
    throw new Error("Hook speech length is invalid.");
  if (/\r|\n/.test(message))
    throw new Error("Hook speech must be single line.");
  if (/```|\b(function|const|let|var|class|import|export)\b|[{};]/.test(message))
    throw new Error("Hook speech looks code-like.");
  if (/https?:\/\/|www\./i.test(message))
    throw new Error("Hook speech must not contain URLs.");
  if (/(^|\s)(?:~|\.{1,2}|[A-Za-z]:)?[\\/][^\s]+/.test(message))
    throw new Error("Hook speech must not contain paths.");
  if (/\b(api[_-]?key|secret|password|token)\s*[:=]/i.test(message))
    throw new Error("Hook speech must not contain secrets.");
  return message;
}

// src/opencode-previews.ts
function validateOpenPetsPetArg(value) {
  const trimmed = value.trim();
  if (trimmed !== value || trimmed.length < 1) throw new Error("Invalid OpenPets pet id.");
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(trimmed)) throw new Error("Invalid OpenPets pet id.");
  return trimmed;
}
function sanitizeOpenCodeExcludedReactions(excludeReactions) {
  if (!excludeReactions) return [];
  const recognized = excludeReactions.filter((reaction) => {
    return typeof reaction === "string" && allowedReactions.includes(reaction);
  });
  return [...new Set(recognized)];
}

// src/opencode-token-rate.ts
var sessionIdPattern = /^[A-Za-z0-9._:-]{1,80}$/;
var estimateWindowMs = 3e3;
var minEstimateDurationMs = 1e3;
var usageDuringStreamGraceMs = 1500;
var reportedDisplayMs = 8e3;
var maxDeltaChars = 32768;
var maxReportedTokens = 1e9;
var maxFallbackSessionIds = 16;
function createOpenCodeTokenRateTracker(now = Date.now) {
  let activeSessionId;
  let startedAt;
  let lastDeltaAt = 0;
  let lastEstimatedAt = 0;
  let reportedAt;
  let segmentTokens = 0;
  let reportedAverage;
  let samples = [];
  let streamActivity = false;
  const partLengths = /* @__PURE__ */ new Map();
  const fallbackSessionIds = /* @__PURE__ */ new Map();
  const fallbackPrefix = Math.floor(Math.random() * 4294967296).toString(36).padStart(7, "0");
  let fallbackSequence = 0;
  const readSessionId = (value) => {
    if (typeof value !== "string") return void 0;
    if (sessionIdPattern.test(value)) return value;
    if (!value || value.length > 256) return void 0;
    const existing = fallbackSessionIds.get(value);
    if (existing) return existing;
    const safeId = `oc-${fallbackPrefix}-${++fallbackSequence}`;
    fallbackSessionIds.set(value, safeId);
    if (fallbackSessionIds.size > maxFallbackSessionIds) {
      const oldest = fallbackSessionIds.keys().next().value;
      if (oldest !== void 0) fallbackSessionIds.delete(oldest);
    }
    return safeId;
  };
  const clear = () => {
    const sessionId = activeSessionId;
    activeSessionId = void 0;
    startedAt = void 0;
    lastDeltaAt = 0;
    lastEstimatedAt = 0;
    reportedAt = void 0;
    segmentTokens = 0;
    reportedAverage = void 0;
    samples = [];
    partLengths.clear();
    return sessionId ? { sessionId, tokensPerSecond: null, source: "estimated" } : void 0;
  };
  const average = () => {
    if (startedAt === void 0) return void 0;
    const durationMs = lastDeltaAt - startedAt;
    if (durationMs < minEstimateDurationMs) return void 0;
    return Math.round(Math.min(1e4, segmentTokens * 1e3 / durationMs) * 10) / 10;
  };
  const estimate = (sessionId, delta) => {
    if (!delta || delta.length > maxDeltaChars) return void 0;
    const at = now();
    if (!Number.isFinite(at)) return void 0;
    if (activeSessionId !== sessionId || startedAt === void 0) {
      activeSessionId = sessionId;
      startedAt = at;
      lastDeltaAt = 0;
      lastEstimatedAt = 0;
      reportedAt = void 0;
      segmentTokens = 0;
      reportedAverage = void 0;
      samples = [];
    }
    if (at < lastDeltaAt) return void 0;
    lastDeltaAt = at;
    segmentTokens += delta.length / 4;
    samples.push({ at, tokens: delta.length / 4 });
    const cutoff = Math.max(startedAt, at - estimateWindowMs);
    samples = samples.filter((sample) => sample.at >= cutoff);
    const durationMs = at - cutoff;
    if (durationMs < minEstimateDurationMs || lastEstimatedAt && at - lastEstimatedAt < minEstimateDurationMs) return void 0;
    const tokenCount = samples.reduce((sum, sample) => sum + sample.tokens, 0);
    lastEstimatedAt = at;
    return {
      sessionId,
      tokensPerSecond: Math.round(Math.min(1e4, tokenCount * 1e3 / durationMs) * 10) / 10,
      averageTokensPerSecond: average(),
      source: "estimated"
    };
  };
  const reported = (sessionId, outputTokens) => {
    const at = now();
    let averageTokensPerSecond;
    if (sessionId === activeSessionId) {
      averageTokensPerSecond = average();
      if (startedAt === void 0 && reportedAt !== void 0 && at >= reportedAt && at - reportedAt <= reportedDisplayMs) {
        averageTokensPerSecond = reportedAverage;
      }
    }
    activeSessionId = sessionId;
    startedAt = void 0;
    lastDeltaAt = 0;
    lastEstimatedAt = 0;
    reportedAt = at;
    segmentTokens = 0;
    reportedAverage = averageTokensPerSecond;
    samples = [];
    return {
      sessionId,
      tokensPerSecond: null,
      ...averageTokensPerSecond === void 0 ? {} : { averageTokensPerSecond },
      outputTokens,
      source: "reported"
    };
  };
  return {
    ingest(event) {
      streamActivity = false;
      const item = isRecord5(event) ? event : void 0;
      const type = typeof item?.type === "string" ? item.type : void 0;
      const data = isRecord5(item?.data) ? item.data : void 0;
      const properties = isRecord5(item?.properties) ? item.properties : void 0;
      if (type === "session.text.delta" || type === "session.reasoning.delta") {
        const sessionId = readSessionId(data?.sessionID);
        streamActivity = Boolean(sessionId && typeof data?.delta === "string" && data.delta.length > 0);
        return sessionId && typeof data?.delta === "string" ? estimate(sessionId, data.delta) : void 0;
      }
      if (type === "session.usage.updated" || type === "session.step.ended") {
        const sessionId = readSessionId(data?.sessionID);
        const outputTokens = readOutputTokens(data?.tokens);
        if (type === "session.usage.updated" && sessionId === activeSessionId && lastDeltaAt && now() - lastDeltaAt < usageDuringStreamGraceMs) {
          return void 0;
        }
        return sessionId && outputTokens !== void 0 ? reported(sessionId, outputTokens) : void 0;
      }
      if (type === "message.part.delta" && (properties?.field === "text" || properties?.field === "reasoning")) {
        const sessionId = readSessionId(properties.sessionID);
        streamActivity = Boolean(sessionId && typeof properties.delta === "string" && properties.delta.length > 0);
        return sessionId && typeof properties.delta === "string" ? estimate(sessionId, properties.delta) : void 0;
      }
      if (type === "message.part.updated") {
        const part = isRecord5(properties?.part) ? properties.part : void 0;
        const sessionId = readSessionId(part?.sessionID);
        if (part?.type !== "text" && part?.type !== "reasoning" || !sessionId) return void 0;
        if (typeof properties?.delta === "string") {
          streamActivity = properties.delta.length > 0;
          return estimate(sessionId, properties.delta);
        }
        const time = isRecord5(part.time) ? part.time : void 0;
        if (typeof part.id !== "string" || part.id.length > 256 || typeof part.text !== "string" || part.text.length > 1048576 || typeof time?.start !== "number" || time.end !== void 0) return void 0;
        const key = sessionId + "\0" + part.id;
        const previousLength = partLengths.get(key);
        partLengths.set(key, part.text.length);
        if (partLengths.size > 64) {
          const oldest = partLengths.keys().next().value;
          if (oldest !== void 0) partLengths.delete(oldest);
        }
        if (previousLength === void 0 || part.text.length <= previousLength) return void 0;
        const delta = part.text.slice(previousLength);
        streamActivity = delta.length > 0;
        return estimate(sessionId, delta);
      }
      if (type === "message.updated") {
        const info = isRecord5(properties?.info) ? properties.info : void 0;
        if (info?.role !== "assistant") return void 0;
        const sessionId = readSessionId(info.sessionID);
        const time = isRecord5(info.time) ? info.time : void 0;
        const metadata = isRecord5(info.metadata) ? info.metadata : void 0;
        const metadataTime = isRecord5(metadata?.time) ? metadata.time : void 0;
        if (typeof time?.completed !== "number" && typeof metadataTime?.completed !== "number" && typeof info.finish !== "string") return void 0;
        const assistant = isRecord5(metadata?.assistant) ? metadata.assistant : void 0;
        const outputTokens = readOutputTokens(info.tokens) ?? readOutputTokens(assistant?.tokens);
        return sessionId && outputTokens !== void 0 ? reported(sessionId, outputTokens) : void 0;
      }
      if (type === "session.idle" || type === "session.execution.succeeded" || type === "session.execution.failed" || type === "session.error") {
        const eventSessionId = readSessionId(data?.sessionID ?? properties?.sessionID);
        if (eventSessionId && eventSessionId !== activeSessionId) return void 0;
        if (type === "session.idle" || type === "session.execution.succeeded") {
          const age = reportedAt === void 0 ? void 0 : now() - reportedAt;
          if (age !== void 0 && age >= 0 && age <= reportedDisplayMs) {
            clear();
            return void 0;
          }
        }
        return clear();
      }
      return void 0;
    },
    clear,
    hadStreamActivity: () => streamActivity
  };
}
function readOutputTokens(value) {
  const tokens = isRecord5(value) ? value : void 0;
  const output = tokens?.output;
  return typeof output === "number" && Number.isSafeInteger(output) && output >= 0 && output <= maxReportedTokens ? output : void 0;
}
function isRecord5(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/opencode-plugin-runtime.ts
var speechCooldownMs = 2e4;
var permissionCooldownMs = 3e3;
var continuousReactionRefreshMs = 1e4;
function isReactionExcluded(reaction, excludedSet) {
  return excludedSet.has(reaction);
}
function createOpenPetsOpenCodeRuntime(options = {}) {
  const pet = options.pet === void 0 ? void 0 : validateOpenPetsPetArg(options.pet);
  const clientFactory = options.clientFactory ?? (() => createOpenPetsClient({ remote: false, connectTimeoutMs: 500, responseTimeoutMs: 500 }));
  const schedule = options.schedule ?? defaultSchedule;
  const debug = options.debug === true || process.env.OPENPETS_DEBUG === "1";
  const debugLog = options.debugLog ?? ((message) => {
    if (debug) process.stderr.write(`${message}
`);
  });
  const excludedReactions = buildExcludedReactionsSet(options.excludeReactions);
  const tokenRateTracker = createOpenCodeTokenRateTracker(options.now);
  let client;
  let lease;
  let tokenRateSessionToClear;
  let tokenRateFinalReported = false;
  let closed = false;
  let cleanupPromise;
  let dispatchTail = Promise.resolve();
  const activeWork = /* @__PURE__ */ new Set();
  let reactionGeneration = 0;
  let tokenRateGeneration = 0;
  let lastSentReaction;
  let lastSentAt;
  let activityGeneration = 0;
  let pendingPermissionResume;
  let lastSentActivity = -1;
  let activeSessionId;
  let executionActive = false;
  const completedSessions = /* @__PURE__ */ new Map();
  const activeTools = /* @__PURE__ */ new Map();
  let toolTrackingOverflow = false;
  const now = () => options.now?.() ?? Date.now();
  const timers = options.timers ?? {
    setInterval: (callback, delayMs) => setInterval(callback, delayMs),
    clearInterval: (handle) => clearInterval(handle)
  };
  let keepaliveTimer;
  let currentActivityReaction;
  const stopKeepalive = () => {
    if (keepaliveTimer === void 0) return;
    timers.clearInterval(keepaliveTimer);
    keepaliveTimer = void 0;
  };
  const beginActivity = (sessionId, explicitStart = false) => {
    const ownerFailed = completedSessions.get(activeSessionId) === "failed";
    const sessionFailed = completedSessions.get(sessionId ?? activeSessionId) === "failed";
    if (!explicitStart && (ownerFailed || sessionFailed)) return false;
    if (explicitStart) completedSessions.delete(void 0);
    if (!executionActive || sessionId && sessionId !== activeSessionId) {
      activityGeneration += 1;
      pendingPermissionResume = void 0;
      activeTools.clear();
      toolTrackingOverflow = false;
      currentActivityReaction = void 0;
    }
    executionActive = true;
    if (sessionId) activeSessionId = sessionId;
    completedSessions.delete(activeSessionId);
    if (keepaliveTimer === void 0 && !closed) {
      keepaliveTimer = timers.setInterval(() => {
        if (closed || !executionActive) return;
        if (currentActivityReaction && !excludedReactions.has(currentActivityReaction)) run({ reaction: currentActivityReaction });
        else if (pet && client && lease) {
          const activity = activityGeneration;
          const hit = client;
          const pending = enqueue(async () => {
            if (!closed && executionActive && activity === activityGeneration) {
              await getLeaseId(hit, pet, false, true);
            }
          });
          activeWork.add(pending);
          void pending.finally(() => activeWork.delete(pending));
        }
      }, 5e3);
      if (typeof keepaliveTimer === "object") keepaliveTimer.unref();
    }
    return true;
  };
  const completeSession = (sessionId, outcome) => {
    const completedId = sessionId ?? activeSessionId;
    if (completedSessions.get(completedId) === "failed" && outcome === "succeeded") return false;
    completedSessions.set(completedId, outcome);
    if (completedSessions.size > 64) {
      for (const candidate of completedSessions.keys()) {
        if (candidate === activeSessionId) continue;
        completedSessions.delete(candidate);
        break;
      }
    }
    if (sessionId && activeSessionId && sessionId !== activeSessionId) return false;
    executionActive = false;
    pendingPermissionResume = void 0;
    stopKeepalive();
    activeTools.clear();
    toolTrackingOverflow = false;
    return true;
  };
  const enqueue = (task) => {
    const run2 = dispatchTail.then(task, task);
    dispatchTail = run2.then(() => void 0, () => void 0);
    return run2;
  };
  const run = (decision) => {
    if (closed || !decision?.reaction) return;
    const reaction = decision.reaction;
    if (reaction === "waiting" || reaction === "success" || reaction === "error") {
      pendingPermissionResume = void 0;
    }
    if (reaction === "thinking" || reaction === "editing" || reaction === "testing" || reaction === "waiting") {
      currentActivityReaction = reaction;
    } else {
      currentActivityReaction = void 0;
    }
    const generation = ++reactionGeneration;
    const activity = activityGeneration;
    if (isReactionExcluded(reaction, excludedReactions)) return;
    try {
      schedule(() => {
        if (closed || generation !== reactionGeneration) return Promise.resolve();
        const pending = enqueue(() => dispatchReaction(decision, reaction, generation, activity));
        activeWork.add(pending);
        void pending.finally(() => activeWork.delete(pending));
        return pending;
      });
    } catch (error) {
      debugLog(`OpenPets OpenCode plugin scheduling ignored error: ${sanitizeDebugError(error)}`);
    }
  };
  const dispatchReaction = async (decision, reaction, generation, activity) => {
    if (closed || generation !== reactionGeneration) return;
    try {
      const permissionResume = pendingPermissionResume?.activity === activity ? pendingPermissionResume : void 0;
      const speechCategory = permissionResume ? "thinking" : decision.speechCategory;
      const shouldSpeak = speechCategory !== void 0 && (permissionResume !== void 0 || shouldSendSpeech(speechCategory, options));
      const shouldReact = reaction === "success" || reaction === "error" || reaction !== lastSentReaction || activity !== lastSentActivity || lastSentAt === void 0 || now() - lastSentAt >= continuousReactionRefreshMs;
      if (!shouldSpeak && !shouldReact) return;
      client ??= clientFactory();
      const leaseId = pet ? await getLeaseId(client, pet, false, true) : void 0;
      if (closed || generation !== reactionGeneration || pet && !leaseId) return;
      if (speechCategory && shouldSpeak) {
        await client.say(validateHookSpeech(pickHookSpeech(speechCategory, options.random)), { reaction, leaseId });
        recordSentSpeech(speechCategory, options);
        if (pendingPermissionResume === permissionResume) pendingPermissionResume = void 0;
        lastSentReaction = reaction;
        lastSentAt = now();
        lastSentActivity = activity;
        return;
      }
      await client.react(reaction, { leaseId });
      lastSentReaction = reaction;
      lastSentAt = now();
      lastSentActivity = activity;
    } catch (error) {
      debugLog(`OpenPets OpenCode plugin ignored error: ${sanitizeDebugError(error)}`);
    }
  };
  const dispatchTokenRate = async (update, generation, allowDuringCleanup = false) => {
    if (closed && !allowDuringCleanup || generation !== tokenRateGeneration) return;
    try {
      client ??= clientFactory();
      if (!client.tokenRate) return;
      const leaseId = pet ? await getLeaseId(client, pet, allowDuringCleanup) : void 0;
      if (closed && !allowDuringCleanup || generation !== tokenRateGeneration || pet && !leaseId) return;
      await client.tokenRate({ ...update, leaseId });
      if (generation !== tokenRateGeneration) return;
      tokenRateSessionToClear = update.tokensPerSecond === null && update.outputTokens === void 0 ? void 0 : update.sessionId;
      tokenRateFinalReported = update.source === "reported" && update.outputTokens !== void 0;
    } catch (error) {
      debugLog(`OpenPets OpenCode token rate ignored error: ${sanitizeDebugError(error)}`);
    }
  };
  const runTokenRate = (update) => {
    if (closed || !update) return;
    const generation = ++tokenRateGeneration;
    if (update.tokensPerSecond !== null || update.outputTokens !== void 0) {
      tokenRateSessionToClear = update.sessionId;
    }
    try {
      if (update.tokensPerSecond === null) {
        const pending = enqueue(() => dispatchTokenRate(update, generation, true));
        activeWork.add(pending);
        void pending.finally(() => activeWork.delete(pending));
        return;
      }
      schedule(() => {
        if (closed || generation !== tokenRateGeneration) return Promise.resolve();
        const pending = enqueue(() => dispatchTokenRate(update, generation));
        activeWork.add(pending);
        void pending.finally(() => activeWork.delete(pending));
        return pending;
      });
    } catch (error) {
      debugLog(`OpenPets OpenCode token rate scheduling ignored error: ${sanitizeDebugError(error)}`);
    }
  };
  const getLeaseId = async (hit, requestedPetId, allowDuringCleanup = false, coverActivityRefresh = false) => {
    if (closed && !allowDuringCleanup) return void 0;
    const renewalBuffer = coverActivityRefresh ? continuousReactionRefreshMs + 2e3 : 2e3;
    if (lease && (!lease.expiresAt || lease.expiresAt - now() > renewalBuffer)) return lease.leaseId;
    const previous = lease;
    let next;
    try {
      next = await hit.acquireLease({ requestedPetId });
    } catch (error) {
      debugLog(`OpenPets OpenCode lease unavailable: ${sanitizeDebugError(error)}`);
      return void 0;
    }
    lease = { leaseId: next.leaseId, expiresAt: next.expiresAt };
    if (previous && previous.leaseId !== next.leaseId) {
      await releaseLease(hit, previous.leaseId);
    }
    if (closed && !allowDuringCleanup) return void 0;
    return next.leaseId;
  };
  const releaseLease = async (hit, leaseId) => {
    try {
      await hit.releaseLease(leaseId);
    } catch (error) {
      debugLog(`OpenPets OpenCode lease release failed: ${sanitizeDebugError(error)}`);
    }
  };
  const finishCleanup = async () => {
    await Promise.allSettled([...activeWork]);
    await dispatchTail;
    const activeLease = lease;
    const activeClient = client;
    const displayedSession = tokenRateSessionToClear;
    const leaveFinalUntilExpiry = tokenRateFinalReported;
    lease = void 0;
    tokenRateSessionToClear = void 0;
    tokenRateFinalReported = false;
    if (displayedSession && !leaveFinalUntilExpiry && activeClient?.tokenRate) {
      try {
        await activeClient.tokenRate({ sessionId: displayedSession, tokensPerSecond: null, source: "estimated", leaseId: activeLease?.leaseId });
      } catch (error) {
        debugLog(`OpenPets OpenCode token rate cleanup ignored error: ${sanitizeDebugError(error)}`);
      }
    }
    if (!activeLease || !activeClient) return;
    await releaseLease(activeClient, activeLease.leaseId);
  };
  return {
    event(event) {
      try {
        const type = getEventType(event);
        const sessionId = getEventSessionId(event);
        const outcome = isFailureEvent(type) ? "failed" : "succeeded";
        const sessionFailed = completedSessions.get(sessionId ?? activeSessionId) === "failed";
        const anonymousOwnerFailed = !activeSessionId && completedSessions.get(void 0) === "failed";
        if (type !== "session.execution.started" && (sessionFailed || anonymousOwnerFailed)) return;
        if (isStreamEventType(type) && sessionId && completedSessions.has(sessionId)) return;
        if (activeSessionId && sessionId && sessionId !== activeSessionId) {
          if (isTokenRateEvent(type)) return;
          if (isTerminalEvent(type)) {
            completeSession(sessionId, outcome);
            return;
          }
        }
        if (isFailureEvent(type)) {
          tokenRateGeneration += 1;
          const clear = tokenRateTracker.clear() ?? (tokenRateSessionToClear ? { sessionId: tokenRateSessionToClear, tokensPerSecond: null, source: "estimated" } : void 0);
          runTokenRate(clear);
        } else {
          runTokenRate(tokenRateTracker.ingest(event));
        }
        if (isStreamEventType(type)) {
          if (!tokenRateTracker.hadStreamActivity() || !executionActive || !sessionId || completedSessions.has(sessionId)) return;
          if (activeSessionId && activeSessionId !== sessionId) return;
          if (activeTools.size > 0 || toolTrackingOverflow) return;
          activeSessionId = sessionId;
          run({ reaction: "thinking" });
          return;
        } else if (type === "session.execution.started") {
          beginActivity(sessionId, true);
        } else if (type === "permission.asked") {
          if (!beginActivity(sessionId)) return;
        } else if (type === "permission.replied") {
          if (!executionActive || !sessionId || sessionId !== activeSessionId || currentActivityReaction !== "waiting" || completedSessions.has(sessionId)) return;
          const visibleTools = [...activeTools.values()].filter((reaction) => reaction !== void 0);
          pendingPermissionResume = { activity: activityGeneration };
          run({ reaction: visibleTools.at(-1) ?? "thinking" });
          return;
        } else if (isTerminalEvent(type)) {
          if (!completeSession(sessionId, outcome)) return;
        }
        run(classifyOpenCodeBusEvent(event));
      } catch (error) {
        debugLog(`OpenPets OpenCode event ignored error: ${sanitizeDebugError(error)}`);
      }
    },
    prompt(sessionId) {
      beginActivity(sessionId, true);
      run({ reaction: "thinking" });
    },
    toolBefore(tool, input, sessionId, callId) {
      if (shouldIgnoreOpenPetsTool(tool)) return;
      if (!beginActivity(sessionId)) return;
      const reaction = classifyOpenCodeToolReaction(tool, input);
      if (callId && callId.length <= 256) {
        if (activeTools.size < 256 || activeTools.has(callId)) activeTools.set(callId, reaction);
        else toolTrackingOverflow = true;
      }
      run({ reaction });
    },
    toolAfter(event) {
      if (!isRecord6(event) || event.status !== "error" && event.status !== "completed") return;
      const tool = typeof event.tool === "string" ? event.tool : "";
      if (tool && shouldIgnoreOpenPetsTool(tool)) return;
      const sessionId = getEventSessionId(event);
      if (sessionId && activeSessionId && sessionId !== activeSessionId) return;
      if (completedSessions.has(sessionId ?? activeSessionId)) return;
      if (!executionActive && activeSessionId) return;
      const callId = typeof event.id === "string" ? event.id : void 0;
      const tracked = callId !== void 0 && activeTools.has(callId);
      if (tracked && callId) activeTools.delete(callId);
      if (event.status === "completed") {
        if (!executionActive || !tracked || toolTrackingOverflow) return;
        const remaining = [...activeTools.values()];
        run({ reaction: remaining.length ? remaining.at(-1) ?? "thinking" : "thinking" });
        return;
      }
      run({ reaction: "error", speechCategory: "error" });
      if (activeTools.size > 0 && !toolTrackingOverflow) {
        currentActivityReaction = [...activeTools.values()].at(-1) ?? "thinking";
      }
    },
    reportError(scope, error) {
      process.stderr.write(`OpenPets OpenCode ${scope}: ${sanitizeDebugError(error)}
`);
    },
    cleanup() {
      if (cleanupPromise) return cleanupPromise;
      closed = true;
      pendingPermissionResume = void 0;
      stopKeepalive();
      tokenRateTracker.clear();
      cleanupPromise = finishCleanup();
      return cleanupPromise;
    }
  };
}
function classifyOpenCodeToolReaction(toolName, args) {
  const normalized = toolName.toLowerCase();
  if (/edit|write|patch|apply_patch/.test(normalized)) return "editing";
  if (/bash|shell|terminal/.test(normalized)) return isTestLikeToolArgs(args) ? "testing" : void 0;
  return void 0;
}
function classifyOpenCodeBusEvent(event) {
  const type = getEventType(event);
  if (type === "session.execution.started" || isStreamingEvent(event)) return { reaction: "thinking" };
  if (type === "permission.asked") return getEventPermissions(event).some(shouldIgnoreOpenPetsTool) ? void 0 : { reaction: "waiting", speechCategory: "permission" };
  if (type === "session.execution.failed" || type === "session.error") return { reaction: "error", speechCategory: "error" };
  if (type === "session.execution.succeeded" || type === "session.idle") return { reaction: "success" };
  return void 0;
}
function shouldIgnoreOpenPetsTool(toolName) {
  const normalized = toolName.toLowerCase().replace(/[^a-z0-9_:-]+/g, "_");
  return /(?:^|[_:-])openpets_(?:openpets_)?(?:status|say|react)$/.test(normalized) || /^openpets_(?:status|say|react)$/.test(normalized);
}
function getDefaultOpenCodeThrottlePath() {
  if (process.platform === "win32") return join2(process.env.LOCALAPPDATA || join2(homedir2(), "AppData", "Local"), "OpenPets", "opencode-hook-throttle.json");
  const stateHome = process.env.XDG_STATE_HOME || join2(homedir2(), ".local", "state");
  if (stateHome) return join2(stateHome, "openpets", "opencode-hook-throttle.json");
  return join2(tmpdir(), `openpets-${safeUid()}`, "opencode-hook-throttle.json");
}
function shouldSendSpeech(category, options) {
  const now = options.now?.() ?? Date.now();
  const cooldown = category === "permission" ? permissionCooldownMs : speechCooldownMs;
  const state = readThrottleState(options.throttlePath ?? getDefaultOpenCodeThrottlePath());
  const previous = state[category];
  return previous === void 0 || now - previous >= cooldown;
}
function recordSentSpeech(category, options) {
  const now = options.now?.() ?? Date.now();
  const path = options.throttlePath ?? getDefaultOpenCodeThrottlePath();
  const state = readThrottleState(path);
  state[category] = now;
  writeThrottleState(path, state);
}
function buildExcludedReactionsSet(excludeReactions) {
  const valid = sanitizeOpenCodeExcludedReactions(excludeReactions);
  return valid.length > 0 ? new Set(valid) : emptySet;
}
var emptySet = /* @__PURE__ */ new Set();
function isTestLikeToolArgs(args) {
  const command = isRecord6(args) && typeof args.command === "string" ? args.command.slice(0, 300) : "";
  return /\b(test|vitest|jest|pytest|npm\s+test|pnpm\s+test|yarn\s+test|cargo\s+test|go\s+test)\b/i.test(command);
}
function getEventType(event) {
  if (!isRecord6(event)) return void 0;
  if (typeof event.type === "string") return event.type;
  return void 0;
}
function getEventSessionId(event) {
  if (!isRecord6(event)) return void 0;
  const data = isRecord6(event.data) ? event.data : void 0;
  const properties = isRecord6(event.properties) ? event.properties : void 0;
  const part = isRecord6(properties?.part) ? properties.part : void 0;
  const info = isRecord6(properties?.info) ? properties.info : void 0;
  const sessionId = event.sessionID ?? data?.sessionID ?? properties?.sessionID ?? part?.sessionID ?? info?.sessionID;
  return typeof sessionId === "string" && sessionId.length > 0 && sessionId.length <= 256 ? sessionId : void 0;
}
function isTerminalEvent(type) {
  return type === "session.execution.succeeded" || type === "session.execution.failed" || type === "session.idle" || type === "session.error";
}
function isFailureEvent(type) {
  return type === "session.execution.failed" || type === "session.error";
}
function isStreamEventType(type) {
  return type === "session.text.delta" || type === "session.reasoning.delta" || type === "message.part.delta" || type === "message.part.updated";
}
function isTokenRateEvent(type) {
  return isStreamEventType(type) || type === "session.usage.updated" || type === "session.step.ended" || type === "message.updated";
}
function isStreamingEvent(event) {
  if (!isRecord6(event)) return false;
  const data = isRecord6(event.data) ? event.data : void 0;
  if (event.type === "session.text.delta" || event.type === "session.reasoning.delta") {
    return typeof data?.delta === "string" && data.delta.length > 0;
  }
  const properties = isRecord6(event.properties) ? event.properties : void 0;
  if (typeof properties?.delta !== "string" || properties.delta.length === 0) return false;
  if (event.type === "message.part.delta") return properties.field === "text" || properties.field === "reasoning";
  const part = isRecord6(properties.part) ? properties.part : void 0;
  return event.type === "message.part.updated" && (part?.type === "text" || part?.type === "reasoning");
}
function getEventPermissions(event) {
  if (!isRecord6(event)) return [];
  const data = isRecord6(event.data) ? event.data : void 0;
  const permissions = typeof data?.action === "string" ? [data.action] : [];
  if (Array.isArray(data?.resources)) {
    permissions.push(...data.resources.filter((resource) => typeof resource === "string"));
  }
  return permissions;
}
function readThrottleState(path) {
  try {
    const parsed = JSON.parse(readFileSync2(path, "utf8"));
    if (!isRecord6(parsed)) return {};
    const state = {};
    for (const [key, value] of Object.entries(parsed)) {
      if ((key === "thinking" || key === "success" || key === "error" || key === "permission") && typeof value === "number" && Number.isFinite(value)) state[key] = value;
    }
    return state;
  } catch {
    return {};
  }
}
function writeThrottleState(path, state) {
  try {
    mkdirSync(dirname2(path), { recursive: true, mode: 448 });
    const tempPath = `${path}.${process.pid}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(state)}
`, { encoding: "utf8", mode: 384 });
    renameSync(tempPath, path);
  } catch {
  }
}
function defaultSchedule(work) {
  queueMicrotask(() => {
    void work();
  });
}
function sanitizeDebugError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(?:[A-Za-z]:)?[\\/][^\s"']{2,}/g, "<path>").replace(/\b(api[_-]?key|secret|password|token)\s*[:=]\s*\S+/gi, "$1=<redacted>").slice(0, 200);
}
function safeUid() {
  try {
    return String(userInfo().uid);
  } catch {
    return "user";
  }
}
function isRecord6(value) {
  return typeof value === "object" && value !== null;
}

// src/opencode-plugin-v1-runtime.ts
function createOpenPetsOpenCodeV1Hooks(runtime = createOpenPetsOpenCodeRuntime()) {
  const permissionAsked = (input, action) => {
    const properties = isRecord7(input) ? input : void 0;
    const permission = typeof action === "string" ? action : void 0;
    if (permission && shouldIgnoreOpenPetsTool(permission)) return;
    runtime.event({
      type: "permission.asked",
      data: {
        ...typeof properties?.sessionID === "string" ? { sessionID: properties.sessionID } : {},
        ...permission === void 0 ? {} : { action: permission },
        // V1 tool contains message/call IDs, not a tool name. Patterns and
        // metadata can include private paths or arguments and are not needed.
        resources: []
      }
    });
  };
  return {
    async event(input) {
      const event = input?.event;
      if (!isRecord7(event) || typeof event.type !== "string") return;
      if (event.type === "message.part.updated" || event.type === "message.part.delta" || event.type === "message.updated") {
        runtime.event(event);
        return;
      }
      const properties = isRecord7(event.properties) ? event.properties : void 0;
      const sessionID = typeof properties?.sessionID === "string" ? properties.sessionID : void 0;
      const sessionData = sessionID ? { data: { sessionID } } : {};
      if (event.type === "permission.asked") {
        if (typeof properties?.permission === "string" && properties.permission.length > 0) {
          permissionAsked(properties, properties.permission);
        }
        return;
      }
      if (event.type === "permission.replied") {
        if (sessionID && sessionID.length <= 256) {
          runtime.event({ type: "permission.replied", data: { sessionID } });
        }
        return;
      }
      if (event.type === "session.error") {
        runtime.event({ type: "session.execution.failed", ...sessionData });
        return;
      }
      if (event.type === "session.idle") {
        runtime.event({ type: "session.idle", ...sessionData });
        return;
      }
      if (event.type !== "session.status") return;
      const status = properties && isRecord7(properties.status) ? properties.status : void 0;
      if (status?.type === "busy") runtime.prompt(sessionID);
      if (status?.type === "idle") runtime.event({ type: "session.idle", ...sessionData });
    },
    async "chat.message"(input) {
      runtime.prompt(typeof input?.sessionID === "string" ? input.sessionID : void 0);
    },
    async "tool.execute.before"(input, output) {
      if (typeof input?.tool === "string") runtime.toolBefore(
        input.tool,
        output?.args,
        typeof input.sessionID === "string" ? input.sessionID : void 0,
        typeof input.callID === "string" ? input.callID : void 0
      );
    },
    async "tool.execute.after"(input, output) {
      if (!isRecord7(output) || typeof output.output !== "string") return;
      runtime.toolAfter({
        tool: input?.tool,
        sessionID: input?.sessionID,
        id: input?.callID,
        status: "completed"
      });
    },
    async "permission.ask"(input, output) {
      if (output?.status !== "ask") return;
      const properties = isRecord7(input) ? input : void 0;
      permissionAsked(properties, properties?.type ?? properties?.permission);
    }
  };
}
function isRecord7(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/plugin-v1.ts
async function openPetsOpenCodeV1() {
  return createOpenPetsOpenCodeV1Hooks();
}
export {
  openPetsOpenCodeV1 as default
};
