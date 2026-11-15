import assert from "node:assert/strict";
import { register } from "node:module";
import { join } from "node:path";

const desktopRoot = process.env.OPENPETS_DESKTOP_ROOT ?? join(process.cwd(), "apps/desktop");
const electronMock = `data:text/javascript,${encodeURIComponent(`
  export const app = { getAppPath: () => ${JSON.stringify(desktopRoot)} };
  export default { app };
`)}`;

register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "electron") return { url: ${JSON.stringify(electronMock)}, shortCircuit: true };
    return nextResolve(specifier, context);
  }
`)}`, import.meta.url);

const originalFetch = globalThis.fetch;
let fetchCalls = 0;

try {
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("catalog unavailable");
  };

  const fixtureFallback = await import("../src/catalog.js");
  const fixtureState = await fixtureFallback.getCatalogUiState();
  assert.equal(fixtureState.source, "fixture");
  assert.deepEqual(fixtureState.pets, []);
  assert.equal(fixtureState.total, 0);
  assert.deepEqual((await fixtureFallback.getCatalogPageUiState(0)).pets, []);
  assert.deepEqual((await fixtureFallback.getCatalogSearchUiState()).pets, []);
  await assert.rejects(() => fixtureFallback.getCatalogPet("snoopy"), /Public network services are disabled/);
  assert.equal(fetchCalls, 0);
} finally {
  globalThis.fetch = originalFetch;
}

console.log("Internal catalog remains empty without a network request.");
