import type { PluginCatalogEntryV2 } from "./plugin-contract-types.js";

type MarketplaceReleaseMetadata = {
  readonly releaseId: string;
  readonly pluginId: string;
  readonly status: "approved";
  readonly changelog: string;
  readonly createdAt: number | null;
  readonly reviewedAt: number | null;
};

/** Remote releases carry a verified download URL and checksum. */
export type RemoteMarketplaceRelease = PluginCatalogEntryV2 & MarketplaceReleaseMetadata & {
  readonly source?: "remote";
};

/** Built-in releases are already installed with the desktop app. */
export type BundledMarketplaceRelease = Omit<PluginCatalogEntryV2, "downloadUrl" | "sha256"> & MarketplaceReleaseMetadata & {
  readonly source: "bundled";
};

export type MarketplaceRelease = RemoteMarketplaceRelease | BundledMarketplaceRelease;

export type MarketplacePlugin = MarketplaceRelease & {
  readonly category: string;
  readonly tags: readonly string[];
  readonly publisher: {
    readonly id: string;
    readonly username: string;
    readonly displayName: string;
    readonly publisherType: "official" | "community";
  };
  readonly iconUrl: string | null;
  readonly heartCount: number;
  readonly ratingAverage: number | null;
  readonly ratingCount: number;
  readonly downloadCount: number;
  readonly hearted: boolean;
  readonly myRating: number | null;
};

export type MarketplaceDetail = MarketplacePlugin & {
  readonly readme: string;
  readonly screenshots: readonly string[];
  readonly sourceUrl: string | null;
  readonly homepageUrl: string | null;
  readonly license: string | null;
  readonly changelog: string;
  readonly releases: readonly MarketplaceRelease[];
};

export type MarketplacePage = {
  readonly plugins: readonly MarketplacePlugin[];
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
};

export type MarketplaceQuery = {
  readonly q?: string;
  readonly sort?: "popular" | "newest" | "rating" | "name";
  readonly category?: string;
  readonly offset?: number;
  readonly limit?: number;
};

