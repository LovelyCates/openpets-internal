---
description: Reference the local OpenPets IPC transports, discovery handshake, request protocol, lease model, remote control surface, and security boundaries.
---

# IPC and remote control

Normal agent activity travels over a **local IPC channel** between the
agent-side code and the desktop app. The local wire contract is defined by
`@open-pets/client` (`packages/client/`) and served by `local-ipc.ts`. OpenPets
also has a separate, disabled-by-default remote-control protocol for explicitly
paired coding agents. This doc explains both contracts; their request routers,
authentication, discovery behavior, and capabilities must remain separate.

Source maps: `packages/client/src/codemap.md` (client),
`apps/desktop/src/codemap.md` (local server side: `local-ipc*.ts`,
`lease-manager.ts`; remote side: `remote-control-*.ts`).

## Why local IPC and not HTTP

The pet app is a local companion. Commands are tiny, frequent, and must never
leave the machine. A local socket gives low latency, no network exposure, and a
natural place to enforce trust (a token + a private endpoint). The protocol is a
**line-delimited JSON** request/response over a single connection per call.

The socket has a three-second read-idle limit while receiving its request.
After dispatch, a separate 150-second processing deadline bounds the connection,
so full package validation is not interrupted by the framing timeout. A closed
connection does not cancel an already dispatched installation; clients must
inspect installed state before retrying an ambiguous result.

## Transports

The client and server pick a transport per platform:

- **Unix domain socket** - macOS and Linux.
- **Windows named pipe** - Windows.
- **TCP (IPv4)** - used for cross-platform/WSL: a WSL client connects to the
  Windows desktop app over a private IP.

Native macOS and Windows clients reject a TCP endpoint in local discovery,
including a loopback address; they require an OpenPets Unix socket or named
pipe, respectively. Linux/WSL clients retain the validated Windows-to-WSL TCP
parser, but the internal native desktops do not expose a TCP listener for them.

TCP is the one that touches the network, so it is locked down (see Security).
The internal macOS build always binds a Unix socket, and the internal Windows
build always binds a named pipe. They ignore legacy
`OPENPETS_IPC_BIND` and `OPENPETS_IPC_ENDPOINT` values, including settings that
would otherwise bind a LAN address.

## Discovery handshake

The app writes a **discovery file** at a platform-specific path
(`local-ipc-paths.ts` on the server, `discovery.ts` on the client). The file
contains the endpoint to connect to and an auth **token**. Internal editions
write it at `~/Library/Application Support/OpenPets Internal/runtime/ipc.json`
on macOS and `%APPDATA%/OpenPets Internal/runtime/ipc.json` on Windows, separate
from public OpenPets installs. Both native desktop servers ignore the legacy
`OPENPETS_DISCOVERY_FILE` override. Clients retain an explicit discovery-file
override for controlled local integrations and tests, subject to the same native
endpoint validation. A client:

1. Reads and validates the discovery file (size, permissions, symlink checks;
   on Linux, `XDG_RUNTIME_DIR` must be `0o700` and owned by the user).
2. Parses + validates the endpoint (`parseIpcEndpoint` / `validateEndpoint`).
3. Opens a connection and sends a request carrying the token.

If the file is missing or the app is down, the client fails fast - integrations
treat the app as "unavailable" and degrade gracefully rather than blocking the
agent.

## Protocol shape

Defined in `protocol.ts` (client) and `local-ipc-protocol.ts` (server):

- Protocol **version** `v1`, validated on both ends.
- A message is one JSON object terminated by `\n`. Max message size **16KB**.
- Timeouts: ~2s to connect, ~3s for a response.
- Requests carry `{ id, version, token, method, params }`.
- Responses are a discriminated union on `ok`: `{ ok: true, ... }` or
  `{ ok: false, error, code }`. The client raises a typed `OpenPetsClientError`
  with an error code on failure.

The client factory `createOpenPetsClient(options)` exposes the high-level
methods; `sendRequest()` is the low-level escape hatch. Result parsers validate
shapes before returning.

## Request surface

| Method | Purpose |
|--------|---------|
| `hello` | Handshake / liveness probe |
| `status` | App + pet status snapshot |
| `pets.list` | Installed pets |
| `pets.install` | Install a catalog pet through the running app |
| `pets.install-local` | Install a local pet from an absolute zip-file or folder path |
| `pet.react` | Set a pet reaction (animation state) |
| `pet.say` | Show a speech bubble on a pet |
| `pet.showMedia` | Show a local image inside a pet's speech bubble |
| `pet.tokenRate` | Update the expiring OpenCode reading in a pet's usage dock |
| `lease.acquire` / `lease.heartbeat` / `lease.release` | Manage a pet lease |

Client method names (`hello()`, `status()`, `listPets()`, `installPet()`,
`installLocalPet()`, `acquireLease()`, `heartbeatLease()`, `releaseLease()`,
`react()`, `say()`, `showMedia()`, `tokenRate()`) wrap these. `installLocalPet()` requires an
absolute path and an explicit `zip`/`folder` kind. `react()`/`say()`/
`showMedia()` and `tokenRate()` accept an optional `leaseId` to target a specific pet.

Local folder and ZIP imports may explicitly declare `origin: "codex"`, for example
`installLocalPet(path, { kind: "zip", origin: "codex" })`. The existing package
validation and installation transaction still run; only its installed source is
recorded as `{ kind: "codex", path: canonicalSourcePath }` for the Codex library
classification. This is caller-supplied provenance, including community sources
such as codex-pets.net, not official certification or an author/ownership claim.
It grants no additional filesystem or network access, does not copy into
`~/.codex/pets`, and does not change native Codex settings. Ordinary folder/ZIP
imports retain their existing behavior. Source paths identify the canonical
folder or original local archive; legacy native-folder repair skips archive
sources rather than treating them as `~/.codex/pets/{id}`. Both sources use the
same ZIP extraction limits, package validation, V1 marker normalization, V2
layout and installation transaction. Unknown origins are rejected before
filesystem access.

An explicit Codex-origin local import may also supply optional `libraryMetadata`:
`{ sourceSite: "codex-pets.net", sourcePetId, kind, tags, creatorName?, creatorHandle? }`.
The four source kinds are `animal`, `person`, `creature`, and `object`. The source
ID is nonblank and at most 256 characters; at most 64 tags are accepted, each
nonblank and at most 80 characters; optional uploader labels are at most 160
characters. Control characters, unknown fields and other sites are rejected.
The desktop's shared `pet-format/library-metadata` schema trims/deduplicates these
labels before reading the source and again at the installer boundary. Labels
are saved through the installation transaction in installed state, outside
`pet.json`; failed validation or replacement leaves the existing install intact.
The public client mirrors the wire type, enforces the metadata/origin association
and retains the complete 16 KiB frame limit; strict metadata validation belongs
to the desktop, so the client does not depend on the private pet-format package.
This optional surface requires a desktop that supports provenance imports.

`listPets()` continues to return every installed pet and the default pet ID.
Internally it requests `pets.list` with `{ offset: 0 }`, then follows the returned
`nextOffset` with the same `revision`. Each page includes `ok`, `pets`,
`defaultPetId`, `total`, `revision`, and `nextOffset` (`null` on the last page).
Every pet retains `id`, `displayName`, `builtIn`, and `broken`. The server packs
pages by the UTF-8 size of the complete response, including the request ID,
envelope and newline, within the existing 16 KiB cap. An individual entry that
cannot fit fails explicitly instead of producing an empty continuation.

The revision covers the installed metadata, its ordering and the default pet.
If these change between pages, the request fails and the caller can retry
`listPets()`; pages from different snapshots are never silently combined. The
client validates exact offset progress, stable totals/revision/default, unique
IDs and final count, with aggregation limits of 100,000 pets, 4,096 pages and
64 MiB. Low-level requests without an offset retain the original complete small
list response. A larger unpaged list returns `pagination_required` with an
instruction to request offset zero. New clients also accept the original small
list response from released servers that ignore pagination parameters.

`pet.tokenRate` is local-only and carries only a bounded opaque session id,
an estimated token rate or a reported output-token count, and an optional
lease id. It carries no prompt, model response, file path, or tool argument.
It can also carry optional `averageTokensPerSecond` in the same finite
`0..10000` range as the live rate. AVG always remains an estimate, including
when `source: "reported"` identifies an exact provider output count. Omitting
AVG preserves the original payload contract; a null-rate clear without an
output count cannot carry AVG.

The OpenCode adapter computes AVG from all accepted stream characters divided
by four, divided by the actual elapsed time from the first to the latest delta
in the current observed output segment. It needs at least one second of
observations. It is not an arithmetic mean of rolling rates or a whole-session
average. A report freezes the segment's AVG before resetting live sampling;
reporting delays do not lower it. The next stream segment, a different session,
or a clear resets sampling, and initial historical V1 full-text snapshots do
not contribute. Historical usage with no observed stream has no AVG.

The host validates numeric bounds and the lease before updating the usage dock;
a null rate without an output count clears that session's current reading.
Live readings expire, while bounded in-memory per-target history lets the dock
remain idle with a clearly labeled last reported output. This history does not
extend leases or the brief final-count window retention.
The method is absent from the remote-control protocol.

Experimental multi-pet LAN mode converts only default-target `working`,
`editing`, `running`, and `testing` reactions into a coarse authenticated
`work` activity when the owner's pet is away and meeting another pet. The LAN
request contains no MCP text or arbitrary message field; `pet.say`,
`pet.showMedia`, non-work reactions, and explicit lease targets remain local.
The LAN coordinator binds these mutations to a per-host session credential
issued during registration; possession of the shared LAN token alone cannot
publish activity or return a pet for another active host.

`pet.showMedia` renders a local image file as a transient media bubble on the
pet - for example an image a local generation tool just produced. Params:
`path` (required absolute path, extension must be `.png`/`.jpg`/`.jpeg`/
`.webp`/`.gif`, file capped at 10 MB), optional `message` (validated exactly
like `pet.say`), optional `reaction`, and optional `durationMs` (1000–30000,
default 8000). The image never leaves the machine: the app reads the validated
local file and renders it inside the bubble via a `file:` URL, sized to the
bubble's media constraints.

`pet.showMedia` also accepts an optional `clickUrl`: clicking the media bubble
opens it via the shell on top of the normal dismiss behavior, so the sender
can hand the click back to itself (a custom registered app protocol) or to a
site (`https:`). Validation is deny-list based: local-content and script
schemes (`file:`, `javascript:`, `data:`, …), plain `http:`, and side-effect
Windows shell handlers are rejected; unregistered custom schemes are an OS
no-op.

## The lease model

Leases are how multiple agents and the default pet coexist without fighting over
one window. The model (server side in `lease-manager.ts`):

- A lease is a short-lived claim with a **15s TTL**, kept alive by heartbeats.
- `resolveTarget()` decides whether a command hits the **default pet** or an
  **explicit agent pet**.
- **Re-acquiring is idempotent per client.** When a client process re-acquires
  while it still holds a live lease, the manager refreshes that existing lease
  (same `leaseId`, same target) instead of resolving a new target. This stops a
  transient heartbeat lapse from silently *downgrading* an explicit agent pet to
  the default pet on the next acquire. Client identity is the **client PID plus a
  per-process `sessionNonce`** (a random id minted once per client process), so a
  recycled PID belonging to a brand-new process is treated as a distinct session
  and gets its own pet rather than inheriting the previous session's lease. On
  reuse the manager also re-validates that the held target is still eligible; if
  it is not (for example the pet was uninstalled or went broken), it releases the
  stale lease and resolves a fresh target instead of handing back an unavailable
  pet.
- The **first** explicit lease for a pet triggers `showAgentPet()`; the **last**
  explicit lease released triggers `closeAgentPetIfOpen()`. So agent pets appear
  on demand and disappear when their agents are done.
- **Liveness reclaims dead sessions.** A periodic check releases a lease once its
  owning process is gone, probing the **terminal owner PID** (when known) as well
  as the client PID - so a lease can't outlive its session even when the client
  process is orphaned but still alive.
- The default pet is persistent and not lease-bound.

Integrations follow a consistent pattern: acquire a lease on first activity,
heartbeat on an interval (the MCP server uses ~5s; OpenCode renews with a ~2s
buffer before expiry), and release on shutdown. If a heartbeat fails, an
integration first stashes the stale `leaseId` and retries `lease.heartbeat` to
restore it before falling back to a fresh `lease.acquire`, so a dropped heartbeat
never re-routes an agent pet onto the default. The MCP server additionally
releases its lease and exits **exactly once** when its stdio transport closes (or
on `SIGINT`/`SIGTERM`), so the pet tears down promptly when the session ends and
the shutdown path never runs twice. Failures are swallowed so the agent is never
blocked by pet IPC.

See [Pets](/pets) for what happens once a command reaches a pet window, and
[Agent integrations](/agent-integrations) for how each integration drives
this surface.

## Reaction validation

Reactions are a closed enum. The client validates a reaction against the allowed
set before sending, and `@open-pets/agent-events` validates *speech* strings
(single line, length-bounded, no code/URLs/paths/secrets) so nothing unsafe ever
reaches a bubble. See [Agent integrations](/agent-integrations).

## Remote control protocol

Remote control is an independent versioned line-delimited JSON protocol owned by
`apps/desktop/src/remote-control-service.ts` and
`packages/client/src/remote-protocol.ts`. It is not a network transport for
local IPC and it never reads or writes the local discovery file.

The service is disabled by default. Enabling it requires a local configuration
with a concrete IPv4 address from loopback, private, link-local, or CGNAT
`100.64.0.0/10` ranges and a non-zero port. Wildcard addresses, public
addresses, hostnames, IPv6, and implicit/default bindings are rejected. The
client accepts remote configuration
only through explicit `remote: { endpoint, token, clientId? }` options, the
equivalent `remoteEndpoint`/`remoteToken`/`remoteClientId` options, or the
carefully named `OPENPETS_REMOTE_ENDPOINT`, `OPENPETS_REMOTE_TOKEN`, and
`OPENPETS_REMOTE_CLIENT_ID` environment variables. A configured remote client
never consults discovery.

Remote messages are capped at 4 KiB, one request per bounded socket, and are
rate-limited per remote address. The absolute connection deadline remains active
through response shutdown, so a peer that leaves the TCP connection half-open
cannot retain a concurrent-socket slot indefinitely; complete responses remain
readable before the bounded socket is reclaimed. Malformed, unauthenticated,
oversized, and unsupported requests receive generic errors. Pairing and rotation generate an
opaque high-entropy token and disclose it exactly once to the local caller;
only a SHA-256 verifier is persisted. Local service actions can list metadata,
rotate, or revoke clients without returning a token for an existing client.

The allowlist is deliberately small:

| Remote method | Required scope | Capability |
|---------------|----------------|------------|
| `status` | `status` | Minimal sanitized app/default-pet snapshot |
| `pet.react` | `react` | Allowlisted reaction on the default pet only |
| `pet.say` | `say` | Short validated single-line message on the default pet only |

Remote requests have no lease, install, discovery, file, media, path, prompt,
tool-output, or arbitrary-pet-target capability. Remote reactions are not
forwarded through LAN pet presence. Existing MCP and CLI commands that use
status/react/say can use this mode through the client options or environment;
unsupported local-only operations fail with a generic remote-mode error.

When LAN mode is enabled, its mode is initialized before the remote listener and
remote `pet.react`/`pet.say` fail closed with `shown: false` until current LAN
ownership proves that the local host owns the default pet. LAN-disabled mode
preserves the normal local default-pet behavior.

Remote protocol v1 is raw TCP and is **not encrypted**. A trusted private
network is an explicit deployment prerequisite: a network observer can capture
and replay the bearer token. Never bind it for public Internet access, use port
forwarding, or place it on shared/untrusted Wi-Fi. An encrypted overlay with
its own access-control list is strongly preferred. CGNAT-range addressing is
only an address classification for the boundary check; it does not provide
encryption or confidentiality.

### Control Center Setup & Pairing Flow

Control Center provides UI management under **Settings → Remote**:

1. **Status & Listener Configuration**: Disabled by default. Enabling requires entering an explicit concrete IPv4 bind address and port (no wildcard `0.0.0.0` or default autocomplete).
2. **Transport Warning & Acknowledgement**: Enabling requires reading a prominent warning regarding raw unencrypted TCP and explicitly checking an acknowledgement of the private network requirement before the listener can be started.
3. **Paired Client Management**: Displays active/revoked clients with scopes (`status`, `react`, `say`), creation date, and last activity time.
4. **Pairing Flow**: Pairing requires a client name and scope selection (`status` and `react` required; `say` unchecked by default).
5. **One-Time Token Handoff**: Pair and rotate return the plaintext bearer token exactly once in a dedicated setup modal along with Client ID, environment variable examples (`OPENPETS_REMOTE_ENDPOINT="tcp://<address>:<port>"`, `OPENPETS_REMOTE_CLIENT_ID`, `OPENPETS_REMOTE_TOKEN`), and copy controls. Dismissing the modal immediately clears the token from component state. The token is never stored in plaintext or logged.
6. **Rotation & Revocation**: Destructive actions require explicit confirmation modals. Revoking immediately invalidates access for the client ID.

## Security

- **Local token auth** on every local request; the token comes only from the
  permission-checked local discovery file.
- **TCP is private-only.** IPv4 addresses only (no hostnames); allowed ranges are
  loopback `127.0.0.0/8`, private `10/8`, `172.16/12`, `192.168/16`, and
  link-local `169.254/16`. `0.0.0.0`, public IPs, and hostnames are rejected.
  This is exactly enough to let a WSL client reach the Windows host and nothing
  more.
- **Size + timeout caps** bound resource use and protect against malformed input.

## Contracts

- `packages/client/contracts/client-protocol.contract.ts` - client-side protocol
  validation.
- `apps/desktop/contracts/local-ipc-protocol.contract.ts` - server-side
  request/response parsing.
- `apps/desktop/contracts/remote-control-protocol.contract.ts` - remote
  allowlist, validation, and secure binding configuration.

These run in the test suite ([Testing and validation](/testing-and-validation))
and are the guardrail against protocol drift between client and app.
