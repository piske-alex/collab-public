/**
 * Platform detection helpers used across the main process.
 */

export const isWindows = process.platform === "win32";
export const isMac = process.platform === "darwin";
export const isLinux = process.platform === "linux";

/** OS path separator — backslash on Windows, forward slash elsewhere. */
export const SEP = isWindows ? "\\" : "/";

/** PATH environment variable delimiter — semicolon on Windows, colon elsewhere. */
export const PATH_DELIMITER = isWindows ? ";" : ":";

/**
 * Check whether `child` is equal to or nested inside `parent`.
 * Handles both `/` and `\` separators so it works on every OS.
 */
export function isInsideDir(child: string, parent: string): boolean {
  const normChild = child.replace(/\\/g, "/");
  const normParent = parent.replace(/\\/g, "/");
  return (
    normChild === normParent || normChild.startsWith(normParent + "/")
  );
}

/**
 * Return the user's default shell.
 * On macOS/Linux this reads $SHELL (falling back to /bin/sh).
 * On Windows it returns PowerShell or falls back to cmd.exe.
 */
export function getDefaultShell(): string {
  if (isWindows) {
    return (
      process.env["COMSPEC"] ||
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    );
  }
  // macOS defaults to zsh, Linux defaults to bash
  const fallback = isMac ? "/bin/zsh" : "/bin/bash";
  return process.env["SHELL"] || fallback;
}

/**
 * `which` on Unix, `where` on Windows.
 */
export function whichCommand(): string {
  return isWindows ? "where" : "which";
}
