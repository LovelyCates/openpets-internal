import assert from "node:assert/strict";

import { createParsedUpdateStatus, getAppVersionInfo, isVersionNewer, normalizeVersion } from "../src/update-version.js";

assert.equal(normalizeVersion("v1.2.3"), "1.2.3");
assert.equal(normalizeVersion("1.2.3"), "1.2.3");
assert.equal(normalizeVersion("v1.2.3-beta.1"), "1.2.3");
assert.equal(normalizeVersion("release"), null);
assert.deepEqual(getAppVersionInfo("4.1.0-internal.14"), { currentVersion: "4.1.0", displayVersion: "4.1.0-internal.14" });

assert.equal(isVersionNewer("1.0.1", "1.0.0"), true);
assert.equal(isVersionNewer("1.2.0", "1.1.9"), true);
assert.equal(isVersionNewer("2.0.0", "1.99.99"), true);
assert.equal(isVersionNewer("1.0.0", "1.0.0"), false);
assert.equal(isVersionNewer("1.0.0", "1.0.1"), false);
assert.equal(isVersionNewer("bad", "1.0.1"), false);

const repo = "OpenPetsHQ/openpets";
const releasesUrl = `https://github.com/${repo}/releases`;
const available = createParsedUpdateStatus("1.0.0", { tag_name: "v1.0.1", html_url: "https://github.com/OpenPetsHQ/openpets/releases/tag/v1.0.1" }, 123, repo, releasesUrl);
assert.equal(available.state, "available");
assert.equal(available.latestVersion, "1.0.1");

const current = createParsedUpdateStatus("1.0.1", { tag_name: "v1.0.1", html_url: "https://github.com/OpenPetsHQ/openpets/releases/tag/v1.0.1" }, 124, repo, releasesUrl);
assert.equal(current.state, "current");

const internal = createParsedUpdateStatus("4.1.0-internal.14", { tag_name: "v4.1.0-internal.14" }, 125, repo, releasesUrl);
assert.equal(internal.state, "current");
assert.equal(internal.currentVersion, "4.1.0");
assert.equal(internal.displayVersion, "4.1.0-internal.14");

assert.throws(() => createParsedUpdateStatus("1.0.0", { tag_name: "release" }, 126, repo, releasesUrl));

console.error("Update checker validation passed.");
