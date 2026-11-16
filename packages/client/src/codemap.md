# packages/client/src/

Core IPC client implementation for OpenPets desktop app communication.

## Files

### index.ts

Main client implementation (193 lines). `createOpenPetsClient()` factory, all client methods, result parsers, and `sendRequest()` for low-level IPC.

**Client Methods:**
- `hello()` - Protocol handshake
- `status(options?)` - App connectivity check with graceful error handling
- `listPets()` - Fetch all installed metadata through bounded sequential IPC pages, preserving its complete-list return shape
- `installPet(petId)` - Install pet with 60s timeout
- `installLocalPet(path, options)` - Local absolute folder/ZIP install; explicit `origin: "codex"` can carry typed `libraryMetadata` source labels for either kind. Origin associations are checked before discovery; ordinary request shapes stay unchanged. The server owns the shared strict metadata schema and the normal 16 KiB frame cap remains in force.
- `acquireLease(options?)` - Get lease for targeted pet operations
- `heartbeatLease(leaseId)` - Keep lease alive
- `releaseLease(leaseId)` - Release acquired lease
- `react(reaction, options?)` - Send reaction (lease-aware)
- `say(message, options?)` - Display message (lease-aware, optional reaction)
- `tokenRate(update)` - Send bounded live token-rate, optional observed-segment `averageTokensPerSecond` estimate, or reported output-token updates to the local usage dock; unavailable in remote mode

**Result Parsers:**
- `parsePetListResult()` - Re-exported installed-list result validation from `pet-list.ts`
- `parsePetInstallResult()` - Validates install response
- `validatePetId()` - Pet ID format validation (regex: `^[a-z0-9][a-z0-9_-]{0,63}$`)
- `validateTokenRateUpdate()` - Reject unsafe session identifiers and out-of-range/nonfinite telemetry before local IPC. Optional AVG uses the same `0..10000` range as live speed; clears cannot retain an AVG. Provider-reported output counts do not make AVG exact.

`OpenPetsLocalPetInstallOptions` and `OpenPetsPetLibraryMetadata` mirror the local
import wire contract without a runtime dependency on private pet-format. The
optional Codex source label is classification provenance, not authentication;
metadata validation and transactional persistence remain desktop-owned.

**Socket Management:**
- Node.js `net.createConnection()` for TCP/Unix sockets/Windows named pipes
- Dual timeout handling (connect + response)
- Line-delimited JSON protocol (`\n` separator)
- Buffer size enforcement (16KB max)

### protocol.ts

IPC protocol constants, request/response types, `parseIpcResponse()`, `validateReaction()`, `OpenPetsClientError` class.

**Protocol Constants:**
- Version: v1
- Message limit: 16KB
- Timeouts: 2s connect, 3s response

**Error Codes:**
- `unavailable` - Desktop app not reachable
- `invalid_discovery` - Discovery file malformed
- `invalid_token` - Authentication failed
- `invalid_response` - Response parsing failed
- `connect_timeout`, `response_timeout` - Timeout errors
- `request_too_large`, `response_too_large` - Size limits

**Validation:**
- `validateReaction()` - Ensures reaction is in allowed enum
- `parseIpcResponse()` - Discriminated union parsing (ok: true/false)

### pet-list.ts

Owns installed-list item/result types, result parsing, and the complete-list
pagination loop. Pages carry an offset, total, metadata revision, and next offset;
the client checks stable metadata, exact progress, unique IDs and completion.
Aggregation is capped at 100,000 pets, 4,096 pages and 64 MiB without increasing
the 16 KiB wire-frame limit. Released servers returning an unpaged small list
remain accepted. Public types and `parsePetListResult()` stay exported by
`index.ts`.

### discovery.ts

Discovery file handling (226 lines). `getDiscoveryFilePath()`, `readDiscoveryFile()`, `validateDiscovery()`, `validateEndpoint()`, platform-specific path logic, XDG security checks.

**Platform Paths:**
- macOS internal edition: `~/Library/Application Support/OpenPets Internal/runtime/ipc.json`
- Windows internal edition: `%APPDATA%/OpenPets Internal/runtime/ipc.json`
- Linux: `$XDG_RUNTIME_DIR/openpets/ipc.json` (preferred) or `~/.config/OpenPets/runtime/ipc.json`

**Endpoint Types:**
- Unix sockets: `/tmp/openpets-*/openpets-*.sock` or `$XDG_RUNTIME_DIR/openpets/*.sock`
- Windows named pipes: `\\.\pipe\openpets-*`
- TCP: `tcp://<host>:<port>` (IPv4 only, private/local addresses)

**TCP/WSL Support:**
- Native macOS clients reject TCP local discovery and require an OpenPets Unix socket
- Cross-platform discovery for Windows desktop → WSL client
- Native Windows clients reject TCP local discovery and require `\\.\pipe\openpets-*`
- Validates private/local IPv4: loopback (127.x), private (10.x, 172.16-31.x, 192.168.x), link-local (169.254.x)
- Rejects hostnames, 0.0.0.0, public IPs

**Security:**
- XDG_RUNTIME_DIR permission checks (0o700, ownership)
- File size limits (16KB)
- Symlink rejection
- Platform mismatch detection

### smoke.ts

Manual testing CLI for client operations (hello, status, react, say, invalid-token).

## Related Contracts

### ../contracts/client-protocol.contract.ts

Contract validation (moved from src/check-client-protocol.ts). Runtime assertions for protocol compliance.

**Test Coverage:**
- Discovery validation (protocol, version, endpoint, token)
- Endpoint parsing (Unix socket, Windows pipe, TCP)
- TCP private IP validation (loopback, private ranges, link-local)
- Cross-platform discovery (Windows desktop → WSL)
- Public IP rejection
- Response parsing (ok/error cases)
- Pet list/install result parsing
