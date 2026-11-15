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
    return join(homedir(), "Library", "Application Support", "OpenPets", "runtime", "ipc.json");
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
  if (!isRecord2(value) || typeof value.id !== "string" && value.id !== null) {
    throw new OpenPetsClientError("invalid_remote_response", "Remote response is invalid.");
  }
  if (value.ok === true)
    return { id: value.id, ok: true, result: value.result };
  if (value.ok === false && isRecord2(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string") {
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
function isRecord2(value) {
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
    listPets: async () => remote ? unsupportedRemote() : parsePetListResult(await sendDiscoveredRequest("pets.list", {}, options)),
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
      return parsePetInstallResult(await sendDiscoveredRequest("pets.install-local", { path: trimmedPath, kind: installOptions.kind }, { ...options, responseTimeoutMs: options.responseTimeoutMs ?? 6e4 }));
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
    source: value.source,
    ...value.outputTokens === void 0 ? {} : { outputTokens: value.outputTokens },
    ...value.leaseId === void 0 ? {} : { leaseId: value.leaseId }
  };
}
function parsePetInstallResult(value) {
  if (!isRecord3(value) || value.ok !== true || typeof value.petId !== "string" || typeof value.displayName !== "string" || value.installed !== true) {
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
function parsePetListResult(value) {
  if (!isRecord3(value) || value.ok !== true || !Array.isArray(value.pets) || typeof value.defaultPetId !== "string") {
    throw new OpenPetsClientError("invalid_response", "OpenPets pet list response is invalid.");
  }
  return {
    ok: true,
    defaultPetId: value.defaultPetId,
    pets: value.pets.map(parsePetListItem)
  };
}
function parsePetListItem(value) {
  if (!isRecord3(value) || typeof value.id !== "string" || typeof value.displayName !== "string" || typeof value.builtIn !== "boolean" || typeof value.broken !== "boolean") {
    throw new OpenPetsClientError("invalid_response", "OpenPets pet list item is invalid.");
  }
  return { id: value.id, displayName: value.displayName, builtIn: value.builtIn, broken: value.broken };
}
function isRecord3(value) {
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
  let samples = [];
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
    samples = [];
    return sessionId ? { sessionId, tokensPerSecond: null, source: "estimated" } : void 0;
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
      samples = [];
    }
    lastDeltaAt = at;
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
      source: "estimated"
    };
  };
  const reported = (sessionId, outputTokens) => {
    activeSessionId = sessionId;
    startedAt = void 0;
    lastDeltaAt = 0;
    lastEstimatedAt = 0;
    reportedAt = now();
    samples = [];
    return { sessionId, tokensPerSecond: null, outputTokens, source: "reported" };
  };
  return {
    ingest(event) {
      const item = isRecord4(event) ? event : void 0;
      const type = typeof item?.type === "string" ? item.type : void 0;
      const data = isRecord4(item?.data) ? item.data : void 0;
      const properties = isRecord4(item?.properties) ? item.properties : void 0;
      if (type === "session.text.delta" || type === "session.reasoning.delta") {
        const sessionId = readSessionId(data?.sessionID);
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
      if (type === "message.part.delta" && properties?.field === "text") {
        const sessionId = readSessionId(properties.sessionID);
        return sessionId && typeof properties.delta === "string" ? estimate(sessionId, properties.delta) : void 0;
      }
      if (type === "message.part.updated") {
        const part = isRecord4(properties?.part) ? properties.part : void 0;
        const sessionId = readSessionId(part?.sessionID);
        if (part?.type !== "text" && part?.type !== "reasoning" || !sessionId) return void 0;
        return typeof properties?.delta === "string" ? estimate(sessionId, properties.delta) : void 0;
      }
      if (type === "message.updated") {
        const info = isRecord4(properties?.info) ? properties.info : void 0;
        if (info?.role !== "assistant") return void 0;
        const sessionId = readSessionId(info.sessionID);
        const time = isRecord4(info.time) ? info.time : void 0;
        const metadata = isRecord4(info.metadata) ? info.metadata : void 0;
        const metadataTime = isRecord4(metadata?.time) ? metadata.time : void 0;
        if (typeof time?.completed !== "number" && typeof metadataTime?.completed !== "number" && typeof info.finish !== "string") return void 0;
        const assistant = isRecord4(metadata?.assistant) ? metadata.assistant : void 0;
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
    clear
  };
}
function readOutputTokens(value) {
  const tokens = isRecord4(value) ? value : void 0;
  const output = tokens?.output;
  return typeof output === "number" && Number.isSafeInteger(output) && output >= 0 && output <= maxReportedTokens ? output : void 0;
}
function isRecord4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/opencode-plugin-runtime.ts
var speechCooldownMs = 2e4;
var permissionCooldownMs = 3e3;
var reactionCooldownMs = 1e4;
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
  let tokenRateSessionSent;
  let tokenRateFinalReported = false;
  let closed = false;
  let cleanupPromise;
  let dispatchTail = Promise.resolve();
  const activeWork = /* @__PURE__ */ new Set();
  const enqueue = (task) => {
    const run2 = dispatchTail.then(task, task);
    dispatchTail = run2.then(() => void 0, () => void 0);
    return run2;
  };
  const run = (decision) => {
    if (closed || !decision?.reaction) return;
    if (isReactionExcluded(decision.reaction, excludedReactions)) return;
    const reaction = decision.reaction;
    try {
      schedule(() => {
        if (closed) return Promise.resolve();
        const pending = enqueue(() => dispatchReaction(decision, reaction));
        activeWork.add(pending);
        void pending.finally(() => activeWork.delete(pending));
        return pending;
      });
    } catch (error) {
      debugLog(`OpenPets OpenCode plugin scheduling ignored error: ${sanitizeDebugError(error)}`);
    }
  };
  const dispatchReaction = async (decision, reaction) => {
    if (closed) return;
    try {
      const shouldSpeak = decision.speechCategory ? shouldSendSpeech(decision.speechCategory, options) : false;
      const shouldReact = shouldSendReaction(reaction, options);
      if (!shouldSpeak && !shouldReact) return;
      client ??= clientFactory();
      const leaseId = pet ? await getLeaseId(client, pet) : void 0;
      if (closed) return;
      if (decision.speechCategory && shouldSpeak) {
        await client.say(validateHookSpeech(pickHookSpeech(decision.speechCategory, options.random)), { reaction, leaseId });
        return;
      }
      await client.react(reaction, { leaseId });
    } catch (error) {
      debugLog(`OpenPets OpenCode plugin ignored error: ${sanitizeDebugError(error)}`);
    }
  };
  const dispatchTokenRate = async (update, allowDuringCleanup = false) => {
    if (closed && !allowDuringCleanup) return;
    try {
      client ??= clientFactory();
      if (!client.tokenRate) return;
      const leaseId = pet ? await getLeaseId(client, pet, allowDuringCleanup) : void 0;
      if (closed && !allowDuringCleanup) return;
      await client.tokenRate({ ...update, leaseId });
      tokenRateSessionSent = update.tokensPerSecond === null && update.outputTokens === void 0 ? void 0 : update.sessionId;
      tokenRateFinalReported = update.source === "reported" && update.outputTokens !== void 0;
    } catch (error) {
      debugLog(`OpenPets OpenCode token rate ignored error: ${sanitizeDebugError(error)}`);
    }
  };
  const runTokenRate = (update) => {
    if (closed || !update) return;
    try {
      if (update.tokensPerSecond === null) {
        const pending = enqueue(() => dispatchTokenRate(update, true));
        activeWork.add(pending);
        void pending.finally(() => activeWork.delete(pending));
        return;
      }
      schedule(() => {
        if (closed) return Promise.resolve();
        const pending = enqueue(() => dispatchTokenRate(update));
        activeWork.add(pending);
        void pending.finally(() => activeWork.delete(pending));
        return pending;
      });
    } catch (error) {
      debugLog(`OpenPets OpenCode token rate scheduling ignored error: ${sanitizeDebugError(error)}`);
    }
  };
  const getLeaseId = async (hit, requestedPetId, allowDuringCleanup = false) => {
    if (closed && !allowDuringCleanup) return void 0;
    if (lease && (!lease.expiresAt || lease.expiresAt - Date.now() > 2e3)) return lease.leaseId;
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
    const displayedSession = tokenRateSessionSent;
    const leaveFinalUntilExpiry = tokenRateFinalReported;
    lease = void 0;
    tokenRateSessionSent = void 0;
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
        runTokenRate(tokenRateTracker.ingest(event));
        run(classifyOpenCodeBusEvent(event));
      } catch (error) {
        debugLog(`OpenPets OpenCode event ignored error: ${sanitizeDebugError(error)}`);
      }
    },
    prompt() {
      run({ reaction: "thinking" });
    },
    toolBefore(tool, input) {
      if (shouldIgnoreOpenPetsTool(tool)) return;
      run({ reaction: classifyOpenCodeToolReaction(tool, input) });
    },
    toolAfter(event) {
      if (!isRecord5(event) || event.status !== "error") return;
      const tool = typeof event.tool === "string" ? event.tool : "";
      if (tool && shouldIgnoreOpenPetsTool(tool)) return;
      run({ reaction: "error", speechCategory: "error" });
    },
    reportError(scope, error) {
      process.stderr.write(`OpenPets OpenCode ${scope}: ${sanitizeDebugError(error)}
`);
    },
    cleanup() {
      if (cleanupPromise) return cleanupPromise;
      closed = true;
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
  if (type === "permission.asked") return getEventPermissions(event).some(shouldIgnoreOpenPetsTool) ? void 0 : { reaction: "waiting", speechCategory: "permission" };
  if (type === "session.execution.failed") return { reaction: "error", speechCategory: "error" };
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
  return shouldSendThrottleKey(category, cooldown, now, options.throttlePath ?? getDefaultOpenCodeThrottlePath());
}
function shouldSendReaction(reaction, options) {
  if (reaction === "success" || reaction === "error") return true;
  const now = options.now?.() ?? Date.now();
  return shouldSendThrottleKey(`reaction:${reaction}`, reactionCooldownMs, now, options.throttlePath ?? getDefaultOpenCodeThrottlePath());
}
function shouldSendThrottleKey(key, cooldown, now, path) {
  const state = readThrottleState(path);
  const previous = typeof state[key] === "number" ? state[key] : 0;
  if (now - previous < cooldown) return false;
  state[key] = now;
  writeThrottleState(path, state);
  return true;
}
function buildExcludedReactionsSet(excludeReactions) {
  const valid = sanitizeOpenCodeExcludedReactions(excludeReactions);
  return valid.length > 0 ? new Set(valid) : emptySet;
}
var emptySet = /* @__PURE__ */ new Set();
function isTestLikeToolArgs(args) {
  const command = isRecord5(args) && typeof args.command === "string" ? args.command.slice(0, 300) : "";
  return /\b(test|vitest|jest|pytest|npm\s+test|pnpm\s+test|yarn\s+test|cargo\s+test|go\s+test)\b/i.test(command);
}
function getEventType(event) {
  if (!isRecord5(event)) return void 0;
  if (typeof event.type === "string") return event.type;
  return void 0;
}
function getEventPermissions(event) {
  if (!isRecord5(event)) return [];
  const data = isRecord5(event.data) ? event.data : void 0;
  const permissions = typeof data?.action === "string" ? [data.action] : [];
  if (Array.isArray(data?.resources)) {
    permissions.push(...data.resources.filter((resource) => typeof resource === "string"));
  }
  return permissions;
}
function readThrottleState(path) {
  try {
    const parsed = JSON.parse(readFileSync2(path, "utf8"));
    if (!isRecord5(parsed)) return {};
    const state = {};
    for (const [key, value] of Object.entries(parsed)) {
      if ((key === "thinking" || key === "success" || key === "error" || key === "permission" || key.startsWith("reaction:")) && typeof value === "number" && Number.isFinite(value)) state[key] = value;
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
function isRecord5(value) {
  return typeof value === "object" && value !== null;
}

// src/opencode-plugin-v1-runtime.ts
function createOpenPetsOpenCodeV1Hooks(runtime = createOpenPetsOpenCodeRuntime()) {
  return {
    async event(input) {
      const event = input?.event;
      if (!isRecord6(event) || typeof event.type !== "string") return;
      if (event.type === "message.part.updated" || event.type === "message.part.delta" || event.type === "message.updated") {
        runtime.event(event);
        return;
      }
      const properties = isRecord6(event.properties) ? event.properties : void 0;
      const sessionID = typeof properties?.sessionID === "string" ? properties.sessionID : void 0;
      const sessionData = sessionID ? { data: { sessionID } } : {};
      if (event.type === "session.error") {
        runtime.event({ type: "session.execution.failed", ...sessionData });
        return;
      }
      if (event.type === "session.idle") {
        runtime.event({ type: "session.idle", ...sessionData });
        return;
      }
      if (event.type !== "session.status") return;
      const status = properties && isRecord6(properties.status) ? properties.status : void 0;
      if (status?.type === "busy") runtime.prompt();
      if (status?.type === "idle") runtime.event({ type: "session.idle", ...sessionData });
    },
    async "chat.message"() {
      runtime.prompt();
    },
    async "tool.execute.before"(input, output) {
      if (typeof input?.tool === "string") runtime.toolBefore(input.tool, output?.args);
    },
    async "permission.ask"(_input, output) {
      if (output?.status === "ask") runtime.event({ type: "permission.asked" });
    }
  };
}
function isRecord6(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/plugin-v1.ts
async function openPetsOpenCodeV1() {
  return createOpenPetsOpenCodeV1Hooks();
}
export {
  openPetsOpenCodeV1 as default
};
