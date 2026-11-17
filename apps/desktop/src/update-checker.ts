import { app } from "electron";
import https from "node:https";

import { createParsedUpdateStatus, getAppVersionInfo } from "./update-version.js";
import { openExternalUrl } from "./external-url-opener.js";
import { publicNetworkEnabled, publicNetworkDisabledMessage } from "./internal-network-policy.js";

export type UpdateStatusState = "idle" | "checking" | "available" | "current" | "error";

export interface UpdateStatus {
  readonly state: UpdateStatusState;
  readonly currentVersion: string;
  readonly displayVersion: string;
  readonly latestVersion?: string;
  readonly releaseUrl?: string;
  readonly checkedAt?: number;
  readonly error?: string;
}

interface GitHubReleaseResponse {
  readonly tag_name?: unknown;
  readonly name?: unknown;
  readonly html_url?: unknown;
}

const githubRepository = process.env.OPENPETS_GITHUB_REPOSITORY || "OpenPetsHQ/openpets";
const latestReleaseApiUrl = `https://api.github.com/repos/${githubRepository}/releases/latest`;
const releasesPageUrl = `https://github.com/${githubRepository}/releases`;
const releaseCheckTimeoutMs = 6_000;

let updateStatus: UpdateStatus = { state: "idle", ...getAppVersionInfo(app.getVersion()) };
let checkInFlight: Promise<UpdateStatus> | null = null;

export function getUpdateStatus(): UpdateStatus {
  return updateStatus;
}

export async function checkForGitHubReleaseUpdate(): Promise<UpdateStatus> {
  if (!publicNetworkEnabled) return getUpdateStatus();
  if (checkInFlight) return checkInFlight;
  updateStatus = { ...updateStatus, state: "checking", ...getAppVersionInfo(app.getVersion()) };
  checkInFlight = fetchLatestRelease()
    .then((release) => {
      updateStatus = createUpdateStatusFromLatestRelease(app.getVersion(), release, Date.now());
      return updateStatus;
    })
    .catch((error: unknown) => {
      updateStatus = createUpdateErrorStatus(app.getVersion(), error, Date.now());
      return updateStatus;
    })
    .finally(() => {
      checkInFlight = null;
    });
  return checkInFlight;
}

export async function openUpdateReleasePage(): Promise<void> {
  if (!publicNetworkEnabled) throw new Error(publicNetworkDisabledMessage);
  const url = validateGitHubReleaseUrl(updateStatus.releaseUrl) || releasesPageUrl;
  await openExternalUrl(url);
}

export function createUpdateStatusFromLatestRelease(appVersion: string, release: GitHubReleaseResponse, checkedAt: number): UpdateStatus {
  return createParsedUpdateStatus(appVersion, release, checkedAt, githubRepository, releasesPageUrl);
}

export function createUpdateErrorStatus(appVersion: string, error: unknown, checkedAt: number): UpdateStatus {
  return {
    state: "error",
    ...getAppVersionInfo(appVersion),
    checkedAt,
    error: error instanceof Error ? error.message : "Update check failed.",
  };
}

export function getCurrentAppVersion(): string {
  return getAppVersionInfo(app.getVersion()).currentVersion;
}

function validateGitHubReleaseUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com") return null;
    if (!url.pathname.startsWith(`/${githubRepository}/releases/`)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function fetchLatestRelease(): Promise<GitHubReleaseResponse> {
  return new Promise((resolve, reject) => {
    const request = https.get(latestReleaseApiUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `OpenPets/${getCurrentAppVersion()}`,
      },
      timeout: releaseCheckTimeoutMs,
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
        if (Buffer.byteLength(body, "utf8") > 128 * 1024) {
          request.destroy(new Error("GitHub release response is too large."));
        }
      });
      response.on("end", () => {
        if (response.statusCode === 404) {
          reject(new Error("No public OpenPets releases found yet."));
          return;
        }
        if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
          reject(new Error(`GitHub release check failed with HTTP ${response.statusCode ?? "unknown"}.`));
          return;
        }
        try {
          resolve(JSON.parse(body) as GitHubReleaseResponse);
        } catch {
          reject(new Error("GitHub release response was not valid JSON."));
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("GitHub release check timed out.")));
    request.on("error", reject);
  });
}
