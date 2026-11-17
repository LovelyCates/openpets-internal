/**
 * Reject Windows network and device namespaces on every host, before any file
 * API can resolve them. Drive letters and mounted volumes still follow OS policy.
 */
export function isNetworkOrDevicePath(path: string): boolean {
  return /^[\\/]{2}/.test(path)
    || /^[\\/](?:\?\?|device|global\?\?|dosdevices)(?:[\\/]|$)/i.test(path);
}

export const localFilesystemPathMessage = "Network and device paths are not allowed for local files.";

export function assertLocalFilesystemPath(path: string): void {
  if (isNetworkOrDevicePath(path)) {
    throw new Error(localFilesystemPathMessage);
  }
}
