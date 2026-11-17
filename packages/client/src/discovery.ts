import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { isRecord, maxIpcMessageBytes, openPetsIpcProtocol, openPetsIpcVersion, OpenPetsClientError } from "./protocol.js";

export interface OpenPetsDiscoveryFile {
  readonly protocolVersion: 1;
  readonly protocol: "openpets-ipc";
  readonly endpoint: string;
  readonly token: string;
  readonly appVersion: string;
  readonly pid: number;
  readonly platform: NodeJS.Platform;
}

export type ParsedIpcEndpoint =
  | { readonly kind: "tcp"; readonly host: string; readonly port: number }
  | { readonly kind: "path"; readonly path: string };

export function getDiscoveryFilePath(): string {
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

export function readDiscoveryFile(path = getDiscoveryFilePath()): OpenPetsDiscoveryFile {
  let raw: string;
  try {
    raw = readTrustedDiscoverySnapshot(path);
  } catch (error) {
    if (error instanceof OpenPetsClientError) throw error;
    throw new OpenPetsClientError("unavailable", `OpenPets discovery file is unavailable: ${error instanceof Error ? error.message : "unknown error"}`);
  }

  try {
    return validateDiscovery(JSON.parse(raw) as unknown);
  } catch (error) {
    if (error instanceof OpenPetsClientError) throw error;
    throw new OpenPetsClientError("invalid_discovery", "OpenPets discovery file is malformed JSON.");
  }
}

function readTrustedDiscoverySnapshot(path: string): string {
  // An override is still local input. In particular, do not let a Windows UNC
  // path contact SMB before we have even read and validated the endpoint.
  if (/^[\\/]{2}/.test(path) || /^[\\/](?:\?\?|device|global\?\?|dosdevices)(?:[\\/]|$)/i.test(path)) {
    throw new OpenPetsClientError("invalid_discovery", "Discovery must use a local filesystem path.");
  }

  const parentPath = dirname(path);
  const parentBefore = lstatSync(parentPath);
  assertTrustedDiscoveryMetadata(parentBefore, "directory");
  const before = lstatSync(path);
  assertTrustedDiscoveryMetadata(before, "file");

  // Windows does not provide O_NOFOLLOW or POSIX ownership/mode semantics.
  // It still gets lstat symlink/junction checks and opened-descriptor identity.
  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const descriptor = openSync(path, flags);
  try {
    const opened = fstatSync(descriptor);
    assertTrustedDiscoveryMetadata(opened, "file");
    if (!sameDiscoverySnapshot(before, opened)) {
      throw new OpenPetsClientError("invalid_discovery", "Discovery changed while opening it.");
    }

    // A file that grows after lstat must never turn this into an unbounded read.
    const buffer = Buffer.alloc(maxIpcMessageBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }

    const after = fstatSync(descriptor);
    const linked = lstatSync(path);
    const parentAfter = lstatSync(parentPath);
    assertTrustedDiscoveryMetadata(after, "file");
    assertTrustedDiscoveryMetadata(linked, "file");
    assertTrustedDiscoveryMetadata(parentAfter, "directory");
    if (bytesRead !== opened.size || !sameDiscoverySnapshot(opened, after) || !sameDiscoverySnapshot(after, linked)
      || parentBefore.dev !== parentAfter.dev || parentBefore.ino !== parentAfter.ino) {
      throw new OpenPetsClientError("invalid_discovery", "Discovery changed while reading it.");
    }
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

function assertTrustedDiscoveryMetadata(stat: Stats, kind: "file" | "directory"): void {
  if (stat.isSymbolicLink() || (kind === "file" ? !stat.isFile() : !stat.isDirectory())) {
    throw new OpenPetsClientError("invalid_discovery", `Discovery ${kind} must not be a symlink and must be a regular ${kind}.`);
  }
  if (kind === "file" && (stat.size < 1 || stat.size > maxIpcMessageBytes)) {
    throw new OpenPetsClientError("invalid_discovery", "Discovery file size is invalid.");
  }
  if (process.platform !== "win32") {
    if (typeof process.getuid !== "function" || stat.uid !== process.getuid()) {
      throw new OpenPetsClientError("invalid_discovery", `Discovery ${kind} must be owned by the current user.`);
    }
    // The token is private; its containing directory must not allow replacement
    // by another user. Defaults remain file 0600 and runtime directory 0700.
    const forbiddenPermissions = kind === "file" ? 0o077 : 0o022;
    if ((stat.mode & forbiddenPermissions) !== 0) {
      throw new OpenPetsClientError("invalid_discovery", `Discovery ${kind} permissions are unsafe.`);
    }
  }
}

function sameDiscoverySnapshot(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.uid === right.uid && left.mode === right.mode
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

export function validateDiscovery(value: unknown): OpenPetsDiscoveryFile {
  if (!isRecord(value)) throw new OpenPetsClientError("invalid_discovery", "Discovery must be an object.");
  if (value.protocol !== openPetsIpcProtocol) throw new OpenPetsClientError("invalid_discovery", "Discovery protocol is invalid.");
  if (value.protocolVersion !== openPetsIpcVersion) throw new OpenPetsClientError("invalid_discovery", "Discovery protocol version is invalid.");
  if (typeof value.endpoint !== "string") throw new OpenPetsClientError("invalid_discovery", "Discovery endpoint is invalid.");
  if (typeof value.token !== "string" || value.token.length < 16 || value.token.length > 256) throw new OpenPetsClientError("invalid_discovery", "Discovery token is invalid.");
  if (typeof value.appVersion !== "string") throw new OpenPetsClientError("invalid_discovery", "Discovery app version is invalid.");
  if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) throw new OpenPetsClientError("invalid_discovery", "Discovery pid is invalid.");
  if (value.platform !== "darwin" && value.platform !== "linux" && value.platform !== "win32") throw new OpenPetsClientError("invalid_discovery", "Discovery platform is invalid.");

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
    platform: value.platform as NodeJS.Platform,
  };
}

export function validateEndpoint(endpoint: string): void {
  parseIpcEndpoint(endpoint);
}

export function parseIpcEndpoint(endpoint: string): ParsedIpcEndpoint {
  if (endpoint.length < 1 || endpoint.length > 240) throw new OpenPetsClientError("invalid_discovery", "Discovery endpoint length is invalid.");
  if (endpoint.includes("\0")) throw new OpenPetsClientError("invalid_discovery", "Discovery endpoint contains NUL.");

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

function parseTcpEndpoint(endpoint: string): ParsedIpcEndpoint {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new OpenPetsClientError("invalid_discovery", "Discovery TCP endpoint is invalid.");
  }

  if (url.protocol !== "tcp:" || url.username || url.password || (url.pathname !== "" && url.pathname !== "/") || url.search || url.hash) {
    throw new OpenPetsClientError("invalid_discovery", "Discovery TCP endpoint must be tcp://<host>:<port> with no credentials, path, query, or fragment.");
  }

  const host = url.hostname;

  // Reject 0.0.0.0 - not a valid target address
  if (host === "0.0.0.0") {
    throw new OpenPetsClientError("invalid_discovery", "Discovery TCP endpoint cannot use 0.0.0.0 as target host.");
  }

  // Validate IPv4 format
  if (!isValidIpv4(host)) {
    throw new OpenPetsClientError("invalid_discovery", "Discovery TCP endpoint host must be a valid IPv4 address.");
  }

  // Reject hostnames (contain letters)
  if (/[a-zA-Z]/.test(host)) {
    throw new OpenPetsClientError("invalid_discovery", "Discovery TCP endpoint host must be an IPv4 address, not a hostname.");
  }

  // Validate that it's a private/local address (loopback, private, or link-local)
  if (!isPrivateOrLocalIpv4(host)) {
    throw new OpenPetsClientError("invalid_discovery", `Discovery TCP endpoint host ${host} is not a private/local IPv4 address. Only loopback (127.0.0.1), private (10.x.x.x, 172.16-31.x.x, 192.168.x.x), or link-local (169.254.x.x) addresses are allowed.`);
  }

  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || String(port) !== url.port) {
    throw new OpenPetsClientError("invalid_discovery", "Discovery TCP endpoint port is invalid.");
  }

  return { kind: "tcp", host, port };
}

function isValidIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    const num = Number(part);
    return String(num) === part && num >= 0 && num <= 255;
  });
}

function isPrivateOrLocalIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4) return false;

  // Loopback: 127.0.0.0/8
  if (parts[0] === 127) return true;

  // Private: 10.0.0.0/8
  if (parts[0] === 10) return true;

  // Private: 172.16.0.0/12
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;

  // Private: 192.168.0.0/16
  if (parts[0] === 192 && parts[1] === 168) return true;

  // Link-local: 169.254.0.0/16
  if (parts[0] === 169 && parts[1] === 254) return true;

  return false;
}

function allowsCrossPlatformDiscovery(platform: NodeJS.Platform, endpoint: ParsedIpcEndpoint): boolean {
  // Allow cross-platform discovery for TCP endpoints when:
  // - Desktop is Windows (win32) and client is Linux (WSL)
  // - The endpoint is a private/local IPv4 address (not just loopback)
  if (endpoint.kind !== "tcp" || platform !== "win32" || process.platform !== "linux") {
    return false;
  }
  // Additional validation: ensure the host is a valid private/local IPv4
  return isPrivateOrLocalIpv4(endpoint.host);
}

function getSecureXdgRuntimeDir(): string | null {
  const dir = process.env.XDG_RUNTIME_DIR;
  if (!dir || !existsSync(dir)) return null;
  try {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return null;
    if ((stat.mode & 0o777) !== 0o700) return null;
    return dir;
  } catch {
    return null;
  }
}
