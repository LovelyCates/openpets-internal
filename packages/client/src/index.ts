import net from "node:net";
import { randomUUID } from "node:crypto";
import { posix, win32 } from "node:path";

import { parseIpcEndpoint, readDiscoveryFile, type OpenPetsDiscoveryFile } from "./discovery.js";
import { connectTimeoutMs, maxIpcMessageBytes, openPetsIpcVersion, parseIpcResponse, responseTimeoutMs, validateReaction, OpenPetsClientError, type OpenPetsIpcMethod, type OpenPetsIpcRequest, type OpenPetsReaction } from "./protocol.js";
import { readPetList, type OpenPetsPetListResult } from "./pet-list.js";
import { maxRemoteMessageBytes, openPetsRemoteProtocol, openPetsRemoteVersion, parseRemoteEndpoint, parseRemoteResponse, remoteConnectTimeoutMs, remoteResponseTimeoutMs, validateRemoteClientId, validateRemoteMessage, validateRemoteReaction, validateRemoteToken, type OpenPetsRemoteEndpoint, type OpenPetsRemoteMethod, type OpenPetsRemoteRequest } from "./remote-protocol.js";

export { getDiscoveryFilePath, parseIpcEndpoint, readDiscoveryFile, validateDiscovery, validateEndpoint, type OpenPetsDiscoveryFile, type ParsedIpcEndpoint } from "./discovery.js";
export { allowedReactions, OpenPetsClientError, type OpenPetsReaction } from "./protocol.js";
export { parsePetListResult, type OpenPetsPetListResult, type OpenPetsPetListItem } from "./pet-list.js";
export { maxRemoteMessageBytes, openPetsRemoteProtocol, openPetsRemoteVersion, parseRemoteEndpoint, validateRemoteClientId, validateRemoteMessage, validateRemoteReaction, validateRemoteToken, type OpenPetsRemoteEndpoint, type OpenPetsRemoteMethod, type OpenPetsRemoteRequest, type OpenPetsRemoteResponse } from "./remote-protocol.js";

/**
 * Stable per-process session nonce, generated once at module load.
 * Sent alongside clientPid in lease.acquire so the desktop can distinguish
 * a genuine re-acquire (same process, same nonce) from an OS PID-reuse
 * collision (same PID, different nonce → fresh acquire, no stale-lease reuse).
 */
const SESSION_NONCE = randomUUID();

export interface OpenPetsClientOptions {
  readonly discoveryPath?: string;
  /** Explicit remote mode. Remote mode never reads the local discovery file. */
  readonly remote?: OpenPetsRemoteOptions | false;
  readonly remoteEndpoint?: string;
  readonly remoteToken?: string;
  readonly remoteClientId?: string;
  readonly connectTimeoutMs?: number;
  readonly responseTimeoutMs?: number;
}

export interface OpenPetsRemoteOptions {
  readonly endpoint: string;
  readonly token: string;
  readonly clientId?: string;
}

export interface OpenPetsStatusResult {
  readonly ok: boolean;
  readonly appRunning: boolean;
  readonly unavailableReason?: string;
  readonly [key: string]: unknown;
}

export interface OpenPetsLeaseResult {
  readonly leaseId: string;
  readonly requestedPetId?: string;
  readonly targetKind: "default" | "explicit";
  readonly actualTargetPetId: string;
  readonly actualTargetPetName: string;
  readonly usingDefaultPet: boolean;
  readonly fallbackReason?: string;
  readonly expiresAt: number;
  readonly leaseActive: boolean;
}

export interface OpenPetsPetInstallResult {
  readonly ok: true;
  readonly petId: string;
  readonly displayName: string;
  readonly installed: true;
}

/** Stable wire type; the desktop's shared library schema validates these labels. */
export interface OpenPetsPetLibraryMetadata {
  readonly sourceSite: "codex-pets.net";
  readonly sourcePetId: string;
  readonly kind: "animal" | "person" | "creature" | "object";
  readonly tags: readonly string[];
  readonly creatorName?: string;
  readonly creatorHandle?: string;
}

export interface OpenPetsLocalPetInstallOptions {
  readonly kind: "zip" | "folder";
  /** Optional local provenance; does not grant access or authenticate an author. */
  readonly origin?: "codex";
  /** Optional bounded source labels; accepted only with Codex provenance. */
  readonly libraryMetadata?: OpenPetsPetLibraryMetadata;
}

/** A bounded, local-only OpenCode usage update. No prompt or tool content is sent. */
export interface OpenPetsTokenRateUpdate {
  readonly sessionId: string;
  readonly tokensPerSecond: number | null;
  readonly averageTokensPerSecond?: number;
  readonly outputTokens?: number;
  readonly source: "estimated" | "reported";
  readonly leaseId?: string;
}

export interface OpenPetsClient {
  readonly transport?: "local" | "remote";
  hello(): Promise<unknown>;
  status(options?: { readonly leaseId?: string }): Promise<OpenPetsStatusResult>;
  listPets(): Promise<OpenPetsPetListResult>;
  installPet(petId: string): Promise<OpenPetsPetInstallResult>;
  installLocalPet(path: string, options: OpenPetsLocalPetInstallOptions): Promise<OpenPetsPetInstallResult>;
  acquireLease(options?: { readonly requestedPetId?: string }): Promise<OpenPetsLeaseResult>;
  heartbeatLease(leaseId: string): Promise<{ readonly leaseId: string; readonly expiresAt: number }>;
  releaseLease(leaseId: string): Promise<{ readonly released: boolean }>;
  react(reaction: OpenPetsReaction, options?: { readonly leaseId?: string }): Promise<unknown>;
  say(message: string, options?: { readonly reaction?: OpenPetsReaction; readonly leaseId?: string }): Promise<unknown>;
  showMedia(path: string, options?: { readonly message?: string; readonly reaction?: OpenPetsReaction; readonly durationMs?: number; readonly clickUrl?: string; readonly leaseId?: string }): Promise<unknown>;
  tokenRate?(update: OpenPetsTokenRateUpdate): Promise<unknown>;
}

export function createOpenPetsClient(options: OpenPetsClientOptions = {}): OpenPetsClient {
  const remote = resolveRemoteOptions(options);
  const unsupportedRemote = <T>(): Promise<T> => Promise.reject(new OpenPetsClientError("remote_method_not_supported", "This operation is not available in remote mode."));

  return {
    transport: remote ? "remote" : "local",
    hello: () => remote ? sendRemoteRequest(remote.endpoint, remote.token, remote.clientId, "status", {}, options) : sendDiscoveredRequest("hello", {}, options),
    status: async (statusOptions) => {
      try {
        if (remote) return await sendRemoteRequest<OpenPetsStatusResult>(remote.endpoint, remote.token, remote.clientId, "status", {}, options);
        return await sendDiscoveredRequest<OpenPetsStatusResult>("status", { leaseId: statusOptions?.leaseId }, options);
      } catch (error) {
        return {
          ok: false,
          appRunning: false,
          unavailableReason: remote ? "Remote OpenPets is unavailable." : error instanceof Error ? error.message : "OpenPets is unavailable.",
        };
      }
    },
    listPets: async () => remote ? unsupportedRemote() : readPetList((params) => sendDiscoveredRequest("pets.list", params, options)),
    installPet: async (petId) => remote ? unsupportedRemote() : parsePetInstallResult(await sendDiscoveredRequest("pets.install", { petId: validatePetId(petId) }, { ...options, responseTimeoutMs: options.responseTimeoutMs ?? 60_000 })),
    installLocalPet: async (path, installOptions) => {
      if (remote) return unsupportedRemote();
      if (typeof path !== "string" || path.trim().length === 0) {
        throw new OpenPetsClientError("invalid_params", "Path must be a non-empty string.");
      }
      const trimmedPath = path.trim();
      if (!isLocalInstallAbsolutePath(trimmedPath)) {
        throw new OpenPetsClientError("invalid_params", "Path must be absolute.");
      }
      if (!installOptions || (installOptions.kind !== "zip" && installOptions.kind !== "folder")) {
        throw new OpenPetsClientError("invalid_params", "Local install kind must be zip or folder.");
      }
      const origin = installOptions.origin;
      if (origin !== undefined && origin !== "codex") {
        throw new OpenPetsClientError("invalid_params", "Local install origin must be codex when specified.");
      }
      const libraryMetadata = installOptions.libraryMetadata;
      if (libraryMetadata !== undefined && origin !== "codex") {
        throw new OpenPetsClientError("invalid_params", "Pet library metadata requires a Codex-origin local import.");
      }
      return parsePetInstallResult(await sendDiscoveredRequest("pets.install-local", {
        path: trimmedPath,
        kind: installOptions.kind,
        ...(origin === undefined ? {} : { origin }),
        ...(libraryMetadata === undefined ? {} : { libraryMetadata }),
      }, { ...options, responseTimeoutMs: options.responseTimeoutMs ?? 60_000 }));
    },
    acquireLease: (leaseOptions) => remote ? unsupportedRemote() : sendDiscoveredRequest("lease.acquire", { requestedPetId: leaseOptions?.requestedPetId, clientPid: process.pid, sessionNonce: SESSION_NONCE }, options),
    heartbeatLease: (leaseId) => remote ? unsupportedRemote() : sendDiscoveredRequest("lease.heartbeat", { leaseId }, options),
    releaseLease: (leaseId) => remote ? unsupportedRemote() : sendDiscoveredRequest("lease.release", { leaseId }, options),
    react: (reaction, reactOptions) => remote
      ? sendRemoteRequest(remote.endpoint, remote.token, remote.clientId, "pet.react", { reaction: validateRemoteReaction(reaction) }, options)
      : sendDiscoveredRequest("pet.react", { reaction: validateReaction(reaction), leaseId: reactOptions?.leaseId }, options),
    say: (message, sayOptions) => remote
      ? sendRemoteRequest(remote.endpoint, remote.token, remote.clientId, "pet.say", { message: validateRemoteMessage(message), ...(sayOptions?.reaction === undefined ? {} : { reaction: validateRemoteReaction(sayOptions.reaction) }) }, options)
      : sendDiscoveredRequest("pet.say", { message, reaction: sayOptions?.reaction, leaseId: sayOptions?.leaseId }, options),
    showMedia: (path, mediaOptions) => {
      if (remote) return unsupportedRemote();
      if (typeof path !== "string" || path.trim().length === 0) {
        throw new OpenPetsClientError("invalid_params", "Media path must be a non-empty string.");
      }
      const trimmedPath = path.trim();
      if (!isLocalInstallAbsolutePath(trimmedPath)) {
        throw new OpenPetsClientError("invalid_params", "Media path must be absolute.");
      }
      return sendDiscoveredRequest("pet.showMedia", { path: trimmedPath, message: mediaOptions?.message, reaction: mediaOptions?.reaction === undefined ? undefined : validateReaction(mediaOptions.reaction), durationMs: mediaOptions?.durationMs, clickUrl: mediaOptions?.clickUrl, leaseId: mediaOptions?.leaseId }, options);
    },
    tokenRate: async (update) => {
      if (remote) return unsupportedRemote();
      return sendDiscoveredRequest("pet.tokenRate", validateTokenRateUpdate(update), options);
    },
  };
}

export function validateTokenRateUpdate(value: OpenPetsTokenRateUpdate): OpenPetsTokenRateUpdate {
  if (!value || typeof value !== "object") {
    throw new OpenPetsClientError("invalid_params", "Token rate update is invalid.");
  }
  if (typeof value.sessionId !== "string" || !/^[A-Za-z0-9._:-]{1,80}$/.test(value.sessionId)) {
    throw new OpenPetsClientError("invalid_params", "Token rate session id is invalid.");
  }
  if (value.tokensPerSecond !== null && (
    typeof value.tokensPerSecond !== "number"
    || !Number.isFinite(value.tokensPerSecond)
    || value.tokensPerSecond < 0
    || value.tokensPerSecond > 10_000
  )) {
    throw new OpenPetsClientError("invalid_params", "Token rate is outside supported bounds.");
  }
  if (value.outputTokens !== undefined && (
    !Number.isSafeInteger(value.outputTokens)
    || value.outputTokens < 0
    || value.outputTokens > 1_000_000_000
  )) {
    throw new OpenPetsClientError("invalid_params", "Output token count is outside supported bounds.");
  }
  if (value.averageTokensPerSecond !== undefined && (
    typeof value.averageTokensPerSecond !== "number"
    || !Number.isFinite(value.averageTokensPerSecond)
    || value.averageTokensPerSecond < 0
    || value.averageTokensPerSecond > 10_000
  )) {
    throw new OpenPetsClientError("invalid_params", "Average token rate is outside supported bounds.");
  }
  if (value.tokensPerSecond === null && value.outputTokens === undefined && value.averageTokensPerSecond !== undefined) {
    throw new OpenPetsClientError("invalid_params", "A cleared token rate cannot include an average.");
  }
  if (value.source !== "estimated" && value.source !== "reported") {
    throw new OpenPetsClientError("invalid_params", "Token rate source is invalid.");
  }
  if (value.tokensPerSecond === null && value.outputTokens !== undefined && value.source !== "reported") {
    throw new OpenPetsClientError("invalid_params", "Final output token count must be reported.");
  }
  if (value.leaseId !== undefined && (
    typeof value.leaseId !== "string"
    || value.leaseId.length < 1
    || value.leaseId.length > 120
    || /[\x00-\x1F\x7F]/.test(value.leaseId)
  )) {
    throw new OpenPetsClientError("invalid_params", "Token rate lease id is invalid.");
  }
  return {
    sessionId: value.sessionId,
    tokensPerSecond: value.tokensPerSecond,
    ...(value.averageTokensPerSecond === undefined ? {} : { averageTokensPerSecond: value.averageTokensPerSecond }),
    source: value.source,
    ...(value.outputTokens === undefined ? {} : { outputTokens: value.outputTokens }),
    ...(value.leaseId === undefined ? {} : { leaseId: value.leaseId }),
  };
}

export function parsePetInstallResult(value: unknown): OpenPetsPetInstallResult {
  if (!isRecord(value) || value.ok !== true || typeof value.petId !== "string" || typeof value.displayName !== "string" || value.installed !== true) {
    throw new OpenPetsClientError("invalid_response", "OpenPets pet install response is invalid.");
  }
  return { ok: true, petId: value.petId, displayName: value.displayName, installed: true };
}

function validatePetId(value: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value) || value === "builtin") {
    throw new OpenPetsClientError("invalid_pet_id", "Invalid OpenPets pet id.");
  }
  return value;
}

function isLocalInstallAbsolutePath(value: string): boolean {
  return posix.isAbsolute(value) || win32.isAbsolute(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function sendDiscoveredRequest<T>(method: OpenPetsIpcMethod, params: unknown, options: OpenPetsClientOptions): Promise<T> {
  const discovery = readDiscoveryFile(options.discoveryPath);
  return sendRequest<T>(discovery, method, params, options);
}

interface ResolvedRemoteOptions {
  readonly endpoint: OpenPetsRemoteEndpoint;
  readonly token: string;
  readonly clientId?: string;
}

function resolveRemoteOptions(options: OpenPetsClientOptions): ResolvedRemoteOptions | null {
  if (options.remote === false) return null;
  const explicit = options.remote;
  const hasFlatRemote = options.remoteEndpoint !== undefined || options.remoteToken !== undefined || options.remoteClientId !== undefined;
  const hasEnvironmentRemote = process.env.OPENPETS_REMOTE_ENDPOINT !== undefined || process.env.OPENPETS_REMOTE_TOKEN !== undefined || process.env.OPENPETS_REMOTE_CLIENT_ID !== undefined;
  if (!explicit && !hasFlatRemote && !hasEnvironmentRemote) return null;

  const endpoint = explicit?.endpoint ?? options.remoteEndpoint ?? process.env.OPENPETS_REMOTE_ENDPOINT;
  const token = explicit?.token ?? options.remoteToken ?? process.env.OPENPETS_REMOTE_TOKEN;
  const clientId = explicit?.clientId ?? options.remoteClientId ?? process.env.OPENPETS_REMOTE_CLIENT_ID;
  if (endpoint === undefined || token === undefined) {
    throw new OpenPetsClientError("invalid_remote_configuration", "Remote configuration is incomplete.");
  }
  const validatedClientId = validateRemoteClientId(clientId);
  return {
    endpoint: parseRemoteEndpoint(endpoint),
    token: validateRemoteToken(token),
    ...(validatedClientId === undefined ? {} : { clientId: validatedClientId }),
  };
}

export function sendRemoteRequest<T>(endpoint: OpenPetsRemoteEndpoint | string, token: string, clientId: string | undefined, method: OpenPetsRemoteMethod, params: unknown, options: OpenPetsClientOptions = {}): Promise<T> {
  const parsedEndpoint = typeof endpoint === "string" ? parseRemoteEndpoint(endpoint) : parseRemoteEndpoint(`tcp://${endpoint.host}:${endpoint.port}`);
  const validToken = validateRemoteToken(token);
  const validClientId = validateRemoteClientId(clientId);
  const request: OpenPetsRemoteRequest = {
    id: randomUUID(),
    protocol: openPetsRemoteProtocol,
    version: openPetsRemoteVersion,
    ...(validClientId === undefined ? {} : { clientId: validClientId }),
    token: validToken,
    method,
    params,
  };
  const requestLine = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(requestLine, "utf8") > maxRemoteMessageBytes) {
    return Promise.reject(new OpenPetsClientError("request_too_large", "Remote request is too large."));
  }

  return new Promise<T>((resolve, reject) => {
    const socket = net.createConnection({ host: parsedEndpoint.host, port: parsedEndpoint.port });
    let buffer = "";
    let settled = false;
    let connectTimer: NodeJS.Timeout | null = setTimeout(() => finish(new OpenPetsClientError("connect_timeout", "Timed out connecting to remote OpenPets.")), options.connectTimeoutMs ?? remoteConnectTimeoutMs);
    let responseTimer: NodeJS.Timeout | null = null;

    const finish = (error?: unknown, result?: T): void => {
      if (settled) return;
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
      if (error) reject(error);
      else resolve(result as T);
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
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > maxRemoteMessageBytes) {
        finish(new OpenPetsClientError("response_too_large", "Remote response is too large."));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const parsed = parseRemoteResponse<T>(JSON.parse(buffer.slice(0, newline)) as unknown);
        if (parsed.id !== request.id) throw new OpenPetsClientError("invalid_remote_response", "Remote response is invalid.");
        if (parsed.ok) finish(undefined, parsed.result);
        else finish(new OpenPetsClientError(parsed.error?.code ?? "remote_request_failed", "Remote request failed."));
      } catch (error) {
        finish(error);
      }
    });
    socket.once("error", () => finish(new OpenPetsClientError("unavailable", "Remote OpenPets is unavailable.")));
    socket.once("end", () => {
      if (!settled) finish(new OpenPetsClientError("connection_closed", "Remote OpenPets closed the connection."));
    });
  });
}

export function sendRequest<T>(discovery: OpenPetsDiscoveryFile, method: OpenPetsIpcMethod, params: unknown, options: OpenPetsClientOptions = {}): Promise<T> {
  const request: OpenPetsIpcRequest = {
    id: randomUUID(),
    version: openPetsIpcVersion,
    token: discovery.token,
    method,
    params,
  };

  const requestLine = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(requestLine, "utf8") > maxIpcMessageBytes) {
    return Promise.reject(new OpenPetsClientError("request_too_large", "OpenPets IPC request is too large."));
  }

  return new Promise<T>((resolve, reject) => {
    const endpoint = parseIpcEndpoint(discovery.endpoint);
    const socket = endpoint.kind === "tcp" ? net.createConnection({ host: endpoint.host, port: endpoint.port }) : net.createConnection(endpoint.path);
    let buffer = "";
    let settled = false;

    const connectTimer = setTimeout(() => finish(new OpenPetsClientError("connect_timeout", "Timed out connecting to OpenPets.")), options.connectTimeoutMs ?? connectTimeoutMs);
    const responseTimer = setTimeout(() => finish(new OpenPetsClientError("response_timeout", "Timed out waiting for OpenPets response.")), options.responseTimeoutMs ?? responseTimeoutMs);

    const finish = (error?: unknown, result?: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(responseTimer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result as T);
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
      if (newline === -1) return;

      try {
        const parsed = parseIpcResponse<T>(JSON.parse(buffer.slice(0, newline)) as unknown);
        if (parsed.ok) finish(undefined, parsed.result);
        else finish(new OpenPetsClientError(parsed.error.code, parsed.error.message));
      } catch (error) {
        finish(error);
      }
    });
    socket.once("error", (error) => finish(new OpenPetsClientError("unavailable", error.message)));
    socket.once("end", () => {
      if (!settled) finish(new OpenPetsClientError("connection_closed", "OpenPets closed the IPC connection before responding."));
    });
  });
}
