import { symlinkSync } from "node:fs";
import { symlink } from "node:fs/promises";

export function createDirectoryLinkSync(target: string, link: string): void {
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

export async function createDirectoryLink(target: string, link: string): Promise<void> {
  await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
}

export function tryCreateFileLinkSync(target: string, link: string, scenario: string): boolean {
  try {
    symlinkSync(target, link, "file");
    return true;
  } catch (error) {
    if (!isWindowsFileLinkPermissionError(error)) throw error;
    reportSkippedFileLinkScenario(scenario);
    return false;
  }
}

export async function tryCreateFileLink(target: string, link: string, scenario: string): Promise<boolean> {
  try {
    await symlink(target, link, "file");
    return true;
  } catch (error) {
    if (!isWindowsFileLinkPermissionError(error)) throw error;
    reportSkippedFileLinkScenario(scenario);
    return false;
  }
}

function isWindowsFileLinkPermissionError(error: unknown): boolean {
  return process.platform === "win32"
    && error instanceof Error
    && "code" in error
    && (error.code === "EPERM" || error.code === "EACCES");
}

function reportSkippedFileLinkScenario(scenario: string): void {
  console.warn(`[SKIP] ${scenario}: Windows file symlink privilege is unavailable; enable Developer Mode or grant symlink creation permission to run this security scenario.`);
}
