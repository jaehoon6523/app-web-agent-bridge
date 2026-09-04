import { createHash } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  CodexConfigurationError,
  ExecutableIntegrityError,
} from "./errors.js";

/**
 * @param {string} value
 * @param {NodeJS.Platform} platform
 */
function normalizeForComparison(value, platform) {
  const normalized = path.resolve(value);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * @param {string} candidate
 * @param {string} root
 * @param {NodeJS.Platform} platform
 */
function isPathInside(candidate, root, platform) {
  const normalizedCandidate = normalizeForComparison(candidate, platform);
  const normalizedRoot = normalizeForComparison(root, platform);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** @param {string} filePath */
async function hashFile(filePath) {
  const handle = await open(filePath, "r");
  const hash = createHash("sha256");
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close().catch(() => {});
  }
  return `sha256:${hash.digest("hex")}`;
}

/**
 * @param {{
 *   executablePath?: string,
 *   workspaceRoot?: string,
 *   platform?: NodeJS.Platform,
 * }} [options]
 */
export async function resolvePinnedExecutable({
  executablePath,
  workspaceRoot,
  platform = process.platform,
} = {}) {
  if (typeof executablePath !== "string" || !path.isAbsolute(executablePath)) {
    throw new CodexConfigurationError(
      "Codex executablePath must be an absolute path",
      "CODEX_EXECUTABLE_PATH_NOT_ABSOLUTE",
    );
  }
  if (typeof workspaceRoot !== "string" || !path.isAbsolute(workspaceRoot)) {
    throw new CodexConfigurationError(
      "Codex workspaceRoot must be an absolute path",
      "CODEX_WORKSPACE_PATH_NOT_ABSOLUTE",
    );
  }

  const [resolvedExecutable, resolvedWorkspace] = await Promise.all([
    realpath(executablePath),
    realpath(workspaceRoot),
  ]);
  const executableStat = await stat(resolvedExecutable);
  if (!executableStat.isFile()) {
    throw new CodexConfigurationError(
      "Codex executablePath must resolve to a regular file",
      "CODEX_EXECUTABLE_NOT_FILE",
    );
  }
  if (isPathInside(resolvedExecutable, resolvedWorkspace, platform)) {
    throw new CodexConfigurationError(
      "Refusing a Codex executable located inside the workspace",
      "CODEX_EXECUTABLE_INSIDE_WORKSPACE",
      { executablePath: resolvedExecutable },
    );
  }
  if (platform === "win32" && path.extname(resolvedExecutable).toLowerCase() !== ".exe") {
    throw new CodexConfigurationError(
      "Windows Codex executable must be the actual .exe, not a command shim",
      "CODEX_WINDOWS_EXECUTABLE_NOT_EXE",
      { executablePath: resolvedExecutable },
    );
  }
  if ([".cmd", ".bat", ".ps1"].includes(path.extname(resolvedExecutable).toLowerCase())) {
    throw new CodexConfigurationError(
      "Codex command shims and shell scripts are not accepted as the pinned executable",
      "CODEX_EXECUTABLE_IS_SHELL_SHIM",
      { executablePath: resolvedExecutable },
    );
  }

  return Object.freeze({
    path: resolvedExecutable,
    workspaceRoot: resolvedWorkspace,
    sha256: await hashFile(resolvedExecutable),
    size: executableStat.size,
    platform,
  });
}

/** @param {any} pin */
export async function verifyPinnedExecutable(pin) {
  if (!pin || typeof pin.path !== "string" || typeof pin.sha256 !== "string") {
    throw new ExecutableIntegrityError(
      "Pinned executable metadata is missing",
      "CODEX_EXECUTABLE_PIN_MISSING",
    );
  }

  let resolvedPath;
  let actualHash;
  try {
    resolvedPath = await realpath(pin.path);
    actualHash = await hashFile(resolvedPath);
  } catch (cause) {
    throw new ExecutableIntegrityError(
      "Pinned Codex executable is no longer readable",
      "CODEX_EXECUTABLE_UNREADABLE",
      { executablePath: pin.path, cause },
    );
  }

  if (normalizeForComparison(resolvedPath, pin.platform) !== normalizeForComparison(pin.path, pin.platform)) {
    throw new ExecutableIntegrityError(
      "Pinned Codex executable now resolves to a different path",
      "CODEX_EXECUTABLE_REALPATH_CHANGED",
      { expectedPath: pin.path, actualPath: resolvedPath },
    );
  }
  if (actualHash !== pin.sha256) {
    throw new ExecutableIntegrityError(
      "Pinned Codex executable hash changed",
      "CODEX_EXECUTABLE_HASH_CHANGED",
      { expectedSha256: pin.sha256, actualSha256: actualHash },
    );
  }
  return true;
}

export { hashFile, isPathInside };
