# packages/client/contracts/

Runtime contract validation tests for the client protocol.

## Responsibility

Contains executable contract tests that validate protocol compliance, discovery file handling, endpoint parsing, and response parsing. These are runtime assertions, not traditional unit tests.

## Design/Patterns

**Contract Pattern**: Uses `*.contract.ts` naming and runs via `pnpm test` which builds and executes the contract file directly.

**Build Setup**: Separate TypeScript configuration (`tsconfig.tests.json`) compiles contracts to `.test-dist/` without declarations/sourcemaps.

**Test Execution**: 
```bash
pnpm test:build  # Compiles contracts + src to .test-dist/
pnpm test        # Runs node .test-dist/contracts/client-protocol.contract.js
```

## Files

### pet-list.contract.ts

Pure complete-list pagination regression for 1336 pets, all metadata fields,
small legacy responses, empty lists, duplicate entries, non-progressing offsets,
changed revisions/counts/defaults, incomplete results and bounded response sizes.

### local-pet-list-socket.contract.ts

Real Unix socket / Windows named-pipe regression for `listPets()` automatically
reading 1336 pets through multiple 16 KiB-bounded, fragmented response frames.
The same local fixture checks unchanged ordinary folder/ZIP install requests,
explicit Codex-origin folder/ZIP imports with optional source labels, and rejection
of invalid origin/metadata associations before a request reaches the socket.

### client-protocol.contract.ts

Runtime protocol validation. Imports from `../src/` and asserts:

- **Discovery validation**: Protocol, version, endpoint, token, platform validation
- **Discovery filesystem boundary**: Private disposable file succeeds, atomic replacement remains readable, oversized/empty/nonregular files and file/runtime-directory symlinks reject; POSIX public token modes and group-writable directories reject; Windows UNC/device overrides reject on every host
- **Endpoint parsing**: Unix sockets, Windows named pipes, TCP endpoints
- **TCP private IP validation**: Loopback (127.x), private ranges (10.x, 172.16-31.x, 192.168.x), link-local (169.254.x)
- **Cross-platform discovery**: Windows desktop → WSL client via private IPs
- **Public IP rejection**: Ensures public IPs are rejected for security
- **Response parsing**: ok/error discriminated union parsing
- **Pet list/install result parsing**: Validates pet data structures
- **Remote isolation**: Local Codex-origin installs remain unavailable in remote mode.

**Security Coverage**:
- IPv4 only (no hostnames)
- Private/local addresses only for TCP
- Rejects 0.0.0.0, public IPs, and URLs with auth/path components

## Integration Points

**Source Dependencies**: Imports from `../src/discovery.js`, `../src/index.js`, `../src/protocol.js`

**Test Command**: `pnpm test` in `packages/client/` runs all three contracts.

**Build Output**: `.test-dist/contracts/client-protocol.contract.js` (not published)

## Notes

- Contract files are excluded from npm package (`files: ["dist"]` in package.json)
- Contracts validate runtime behavior, not implementation details
- Uses Node.js `assert/strict` for assertions
