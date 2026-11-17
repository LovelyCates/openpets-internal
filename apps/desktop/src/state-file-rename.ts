/** Retry Windows sharing violations when replacing an already-open state file. */
const windowsRenameRetryDelaysMs = [20, 40, 80, 160, 320] as const;
const renameSleep = new Int32Array(new SharedArrayBuffer(4));

export function retryWindowsLockedRename(rename: () => void): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rename();
      return;
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
      const retryable = process.platform === "win32"
        && (code === "EPERM" || code === "EACCES" || code === "EBUSY");
      if (!retryable || attempt >= windowsRenameRetryDelaysMs.length) throw error;
      Atomics.wait(renameSleep, 0, 0, windowsRenameRetryDelaysMs[attempt]);
    }
  }
}
