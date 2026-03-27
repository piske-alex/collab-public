/**
 * PTY session manager — dispatches to tmux backend (macOS) or
 * direct node-pty backend (Windows/Linux).
 */
import * as pty from "node-pty";
import * as os from "os";
import * as fs from "node:fs";
import * as crypto from "crypto";
import { execFileSync } from "node:child_process";
import { type IDisposable } from "node-pty";
import { loadConfig, getPref } from "./config";
import {
  getTmuxBin,
  getTerminfoDir,
  tmuxExec,
  tmuxSessionName,
  writeSessionMeta,
  readSessionMeta,
  deleteSessionMeta,
  SESSION_DIR,
  type SessionMeta,
} from "./tmux";
import * as direct from "./pty-direct";
import * as sshPty from "./ssh/ssh-pty";
import { isSshWorkspace } from "./ssh/workspace-uri";

export type { SessionMeta };
export { SESSION_DIR };

// ── Mode detection ────────────────────────────────────────────

let _useTmux: boolean | null = null;

function useTmux(): boolean {
  if (_useTmux !== null) return _useTmux;
  if (process.platform === "win32") {
    _useTmux = false;
    return false;
  }
  try {
    tmuxExec("-V");
    _useTmux = true;
  } catch {
    _useTmux = false;
  }
  return _useTmux;
}

// ── WSL detection ─────────────────────────────────────────────

const WSL_PATH_RE = /^[\\/]{2}(wsl\$|wsl\.localhost)[\\/]/i;

function isWslPath(p: string): boolean {
  return WSL_PATH_RE.test(p);
}

/** Convert a UNC WSL path to a Linux path for use inside WSL.
 *  \\wsl$\Ubuntu\home\user → /home/user
 *  \\wsl.localhost\Ubuntu\home\user → /home/user
 */
function wslToLinuxPath(p: string): string {
  // Strip \\wsl$\<distro>\ or \\wsl.localhost\<distro>\
  const parts = p.replace(/\\/g, "/").replace(/^\/\/[^/]+\/[^/]+/, "");
  return parts || "/";
}

/** Extract the distro name from a WSL UNC path. */
function wslDistro(p: string): string | null {
  const m = p.replace(/\\/g, "/").match(/^\/\/[^/]+\/([^/]+)/);
  return m ? m[1] : null;
}

// ── Shell resolution ──────────────────────────────────────────

function resolveShell(cwd?: string, shellOverride?: string): { shell: string; args: string[]; cwd: string | undefined } {
  const resolvedCwd = cwd;

  // If CWD is a WSL path, always use wsl.exe
  if (process.platform === "win32" && resolvedCwd && isWslPath(resolvedCwd)) {
    const distro = wslDistro(resolvedCwd);
    const linuxCwd = wslToLinuxPath(resolvedCwd);
    const args = distro ? ["-d", distro, "--cd", linuxCwd] : ["--cd", linuxCwd];
    return { shell: "wsl.exe", args, cwd: undefined };
  }

  const config = loadConfig();
  // shellOverride allows restoring the exact shell from a previous session
  // (e.g. a WSL terminal that was saved and is being restored on restart)
  const pref = shellOverride || (getPref(config, "terminal_shell") as string | null);

  if (pref && pref !== "auto") {
    if (pref === "powershell") return { shell: "powershell.exe", args: [], cwd: resolvedCwd };
    if (pref === "cmd") return { shell: "cmd.exe", args: [], cwd: resolvedCwd };
    if (pref === "bash") return { shell: process.platform === "win32" ? "bash.exe" : "/bin/bash", args: [], cwd: resolvedCwd };
    if (pref === "wsl") {
      const linuxCwd = resolvedCwd ? resolvedCwd.replace(/\\/g, "/").replace(/^([A-Z]):/i, (_, d) => `/mnt/${d.toLowerCase()}`) : undefined;
      const args = linuxCwd ? ["--cd", linuxCwd] : [];
      return { shell: "wsl.exe", args, cwd: undefined };
    }
    return { shell: pref, args: [], cwd: resolvedCwd };
  }

  if (process.platform === "win32") {
    try {
      execFileSync("powershell.exe", ["-Command", "echo ok"], {
        encoding: "utf8",
        timeout: 3000,
        stdio: "pipe",
      });
      return { shell: "powershell.exe", args: [], cwd: resolvedCwd };
    } catch {
      return { shell: process.env.COMSPEC || "cmd.exe", args: [], cwd: resolvedCwd };
    }
  }

  return { shell: process.env.SHELL || "/bin/zsh", args: [], cwd: resolvedCwd };
}

// ── Shared helpers ────────────────────────────────────────────

function getWebContents(): typeof import("electron").webContents | null {
  try {
    return require("electron").webContents;
  } catch {
    return null;
  }
}

function sendToSender(
  senderWebContentsId: number | undefined,
  channel: string,
  payload: unknown,
): void {
  if (senderWebContentsId == null) return;
  const wc = getWebContents();
  if (!wc) return;
  const sender = wc.fromId(senderWebContentsId);
  if (sender && !sender.isDestroyed()) {
    sender.send(channel, payload);
  }
}

function utf8Env(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  if (!env.LANG || !env.LANG.includes("UTF-8")) {
    env.LANG = "en_US.UTF-8";
  }
  const terminfoDir = getTerminfoDir();
  if (terminfoDir) env.TERMINFO = terminfoDir;
  return env;
}

function stripTrailingBlanks(text: string): string {
  const lines = text.split("\n");
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") end--;
  return lines.slice(0, end).join("\n");
}

// ── Tmux-mode state ───────────────────────────────────────────

interface PtySession {
  pty: pty.IPty;
  shell: string;
  disposables: IDisposable[];
}

const tmuxSessions = new Map<string, PtySession>();
let shuttingDown = false;

function attachClient(
  sessionId: string,
  cols: number,
  rows: number,
  senderWebContentsId?: number,
): pty.IPty {
  const tmuxBin = getTmuxBin();
  const name = tmuxSessionName(sessionId);

  const ptyProcess = pty.spawn(
    tmuxBin,
    ["-L", "collab", "-u", "attach-session", "-t", name],
    { name: "xterm-256color", cols, rows, env: utf8Env() },
  );

  const disposables: IDisposable[] = [];

  disposables.push(
    ptyProcess.onData((data: string) => {
      sendToSender(senderWebContentsId, "pty:data", { sessionId, data });
    }),
  );

  disposables.push(
    ptyProcess.onExit(() => {
      if (shuttingDown) {
        tmuxSessions.delete(sessionId);
        return;
      }
      try {
        tmuxExec("has-session", "-t", name);
      } catch {
        deleteSessionMeta(sessionId);
        sendToSender(senderWebContentsId, "pty:exit", { sessionId, exitCode: 0 });
      }
      tmuxSessions.delete(sessionId);
    }),
  );

  tmuxSessions.set(sessionId, { pty: ptyProcess, shell: "", disposables });
  return ptyProcess;
}

// ── Public API ────────────────────────────────────────────────

export function setShuttingDown(value: boolean): void {
  shuttingDown = value;
  direct.setShuttingDown(value);
  sshPty.setShuttingDown(value);
}

export function createSession(
  cwd?: string,
  senderWebContentsId?: number,
  cols?: number,
  rows?: number,
  shellOverride?: string,
): { sessionId: string; shell: string } | Promise<{ sessionId: string; shell: string }> {
  // SSH workspace — route to ssh-pty
  if (cwd && isSshWorkspace(cwd)) {
    const info = require("./ssh/workspace-uri").parseWorkspaceUri(cwd);
    return sshPty.createSession(cwd, info.remotePath, senderWebContentsId, cols, rows);
  }

  const resolved = resolveShell(cwd, shellOverride);

  if (!useTmux()) {
    return direct.createSession(resolved.shell, resolved.args, resolved.cwd, senderWebContentsId, cols, rows);
  }

  // ── tmux path ──
  const sessionId = crypto.randomBytes(8).toString("hex");
  const name = tmuxSessionName(sessionId);
  const resolvedCwd = resolved.cwd || os.homedir();
  const c = cols || 80;
  const r = rows || 24;

  tmuxExec(
    "new-session", "-d",
    "-s", name,
    "-c", resolvedCwd,
    "-x", String(c),
    "-y", String(r),
    resolved.shell,
  );

  tmuxExec("set-environment", "-t", name, "COLLAB_PTY_SESSION_ID", sessionId);
  tmuxExec("set-environment", "-t", name, "SHELL", resolved.shell);

  writeSessionMeta(sessionId, {
    shell: resolved.shell,
    cwd: resolvedCwd,
    createdAt: new Date().toISOString(),
    mode: "tmux",
  });

  attachClient(sessionId, c, r, senderWebContentsId);
  const session = tmuxSessions.get(sessionId)!;
  session.shell = resolved.shell;

  return { sessionId, shell: resolved.shell };
}

export function reconnectSession(
  sessionId: string,
  cols: number,
  rows: number,
  senderWebContentsId: number,
): {
  sessionId: string;
  shell: string;
  meta: SessionMeta | null;
  scrollback: string;
} {
  // SSH sessions — reconnect via ssh-pty
  if (sshPty.isSshSession(sessionId)) {
    const meta = readSessionMeta(sessionId);
    // Find the SSH workspace URI from meta or session state
    // For now, throw — SSH sessions don't survive app restart
    throw new Error(`SSH session ${sessionId} cannot be reconnected after restart`);
  }

  // For reconnect, read saved CWD to determine if WSL shell is needed
  const savedMeta = readSessionMeta(sessionId);
  const resolved = resolveShell(savedMeta?.cwd);

  if (!useTmux()) {
    return direct.reconnectSession(sessionId, resolved.shell, resolved.args, cols, rows, senderWebContentsId);
  }

  // ── tmux path ──
  const name = tmuxSessionName(sessionId);

  try {
    tmuxExec("has-session", "-t", name);
  } catch {
    deleteSessionMeta(sessionId);
    throw new Error(`tmux session ${name} not found`);
  }

  let scrollback = "";
  try {
    const raw = tmuxExec("capture-pane", "-t", name, "-p", "-e", "-S", "-200000");
    scrollback = stripTrailingBlanks(raw);
  } catch { /* proceed without scrollback */ }

  attachClient(sessionId, cols, rows, senderWebContentsId);

  try {
    tmuxExec("resize-window", "-t", name, "-x", String(cols), "-y", String(rows));
  } catch { /* non-fatal */ }

  const meta = readSessionMeta(sessionId);
  const session = tmuxSessions.get(sessionId)!;
  session.shell = meta?.shell || resolved.shell;

  return { sessionId, shell: session.shell, meta, scrollback };
}

export function writeToSession(sessionId: string, data: string): void {
  if (sshPty.isSshSession(sessionId)) return sshPty.writeToSession(sessionId, data);
  if (!useTmux()) return direct.writeToSession(sessionId, data);
  tmuxSessions.get(sessionId)?.pty.write(data);
}

export function sendRawKeys(sessionId: string, data: string): void {
  if (sshPty.isSshSession(sessionId)) return sshPty.sendRawKeys(sessionId, data);
  if (!useTmux()) return direct.sendRawKeys(sessionId, data);
  const name = tmuxSessionName(sessionId);
  tmuxExec("send-keys", "-l", "-t", name, data);
}

export function resizeSession(sessionId: string, cols: number, rows: number): void {
  if (sshPty.isSshSession(sessionId)) return sshPty.resizeSession(sessionId, cols, rows);
  if (!useTmux()) return direct.resizeSession(sessionId, cols, rows);

  tmuxSessions.get(sessionId)?.pty.resize(cols, rows);
  const name = tmuxSessionName(sessionId);
  try {
    tmuxExec("resize-window", "-t", name, "-x", String(cols), "-y", String(rows));
  } catch { /* non-fatal */ }
}

export function killSession(sessionId: string): void {
  if (sshPty.isSshSession(sessionId)) return sshPty.killSession(sessionId);
  if (!useTmux()) return direct.killSession(sessionId);

  const session = tmuxSessions.get(sessionId);
  if (session) {
    for (const d of session.disposables) d.dispose();
    session.pty.kill();
    tmuxSessions.delete(sessionId);
  }
  const name = tmuxSessionName(sessionId);
  try { tmuxExec("kill-session", "-t", name); } catch { /* already dead */ }
  deleteSessionMeta(sessionId);
}

export function listSessions(): string[] {
  const ssh = sshPty.listSessions();
  if (!useTmux()) return [...direct.listSessions(), ...ssh];
  return [...tmuxSessions.keys(), ...ssh];
}

/**
 * Save direct-mode sessions before shutdown so they can be restored.
 * No-op in tmux mode (tmux keeps sessions alive).
 */
export function saveAllSessions(): void {
  if (!useTmux()) direct.saveAllSessions();
}

export function killAll(): void {
  shuttingDown = true;
  sshPty.killAll();
  if (!useTmux()) return direct.killAll();

  for (const [id, session] of tmuxSessions) {
    for (const d of session.disposables) d.dispose();
    session.pty.kill();
    tmuxSessions.delete(id);
  }
}

const KILL_ALL_TIMEOUT_MS = 2000;

export function killAllAndWait(): Promise<void> {
  shuttingDown = true;
  if (!useTmux()) return direct.killAllAndWait();

  if (tmuxSessions.size === 0) return Promise.resolve();

  const pending: Promise<void>[] = [];
  for (const [id, session] of tmuxSessions) {
    pending.push(new Promise<void>((resolve) => { session.pty.onExit(() => resolve()); }));
    for (const d of session.disposables) d.dispose();
    session.pty.kill();
    tmuxSessions.delete(id);
  }

  const timeout = new Promise<void>((resolve) => setTimeout(resolve, KILL_ALL_TIMEOUT_MS));
  return Promise.race([Promise.all(pending).then(() => {}), timeout]);
}

export function destroyAll(): void {
  if (!useTmux()) return direct.destroyAll();
  killAll();
  try { tmuxExec("kill-server"); } catch { /* not running */ }
}

export interface DiscoveredSession {
  sessionId: string;
  meta: SessionMeta;
}

export function discoverSessions(): DiscoveredSession[] {
  if (!useTmux()) return direct.discoverSessions();

  // ── tmux path ──
  let tmuxNames: string[];
  try {
    const raw = tmuxExec("list-sessions", "-F", "#{session_name}");
    tmuxNames = raw.split("\n").filter(Boolean);
  } catch {
    tmuxNames = [];
  }

  const tmuxSet = new Set(tmuxNames);
  const result: DiscoveredSession[] = [];

  let metaFiles: string[];
  try {
    metaFiles = fs.readdirSync(SESSION_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    metaFiles = [];
  }

  for (const file of metaFiles) {
    const sessionId = file.replace(".json", "");
    const name = tmuxSessionName(sessionId);
    if (tmuxSet.has(name)) {
      const meta = readSessionMeta(sessionId);
      if (meta) result.push({ sessionId, meta });
      tmuxSet.delete(name);
    } else {
      deleteSessionMeta(sessionId);
    }
  }

  for (const orphan of tmuxSet) {
    if (orphan.startsWith("collab-")) {
      try { tmuxExec("kill-session", "-t", orphan); } catch { /* dead */ }
    }
  }

  return result;
}

export function cleanDetachedSessions(
  activeSessionIds: string[],
): void {
  if (!useTmux()) return; // direct mode has no detached sessions
  const active = new Set(activeSessionIds);
  const discovered = discoverSessions();
  for (const { sessionId } of discovered) {
    if (active.has(sessionId)) continue;
    killSession(sessionId);
  }
}

export function verifyTmuxAvailable(): void {
  if (!useTmux()) return; // direct mode, no tmux needed
  tmuxExec("-V");
}

/**
 * On non-tmux platforms, PTY sessions don't survive restarts.
 * Clean up stale session metadata files so they don't appear as ghosts.
 */
export function cleanStaleSessionMeta(): void {
  if (useTmux()) return; // tmux sessions survive restarts
  try {
    const files = fs.readdirSync(SESSION_DIR).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const sessionId = file.replace(".json", "");
      deleteSessionMeta(sessionId);
    }
  } catch {
    // SESSION_DIR may not exist yet
  }
}

// ── Foreground process detection ──────────────────────────────

export function getForegroundProcess(
  sessionId: string,
): string | null {
  if (!useTmux()) {
    // Direct mode: use node-pty process property
    const sessions = direct.listSessions();
    // We don't have direct access to the pty object from here,
    // so fall back to shell name from metadata
    const meta = readSessionMeta(sessionId);
    return meta?.shell
      ? meta.shell.split(/[/\\]/).pop()?.replace(/\.exe$/i, "") || null
      : null;
  }

  const name = tmuxSessionName(sessionId);
  try {
    return tmuxExec(
      "display-message", "-t", name,
      "-p", "#{pane_current_command}",
    );
  } catch {
    return null;
  }
}

function sendToMainWindow(channel: string, payload: unknown): void {
  try {
    const { BrowserWindow } = require("electron");
    const wins = BrowserWindow.getAllWindows();
    if (wins.length > 0 && !wins[0].isDestroyed()) {
      wins[0].webContents.send(channel, payload);
    }
  } catch { /* ignore */ }
}

const lastForeground = new Map<string, string>();
const statusTimers = new Map<string, ReturnType<typeof setTimeout>>();
const STATUS_DEBOUNCE_MS = 500;

export function startForegroundPolling(sessionId: string): void {
  if (statusTimers.has(sessionId)) return;
  statusTimers.set(
    sessionId,
    setInterval(() => {
      const fg = getForegroundProcess(sessionId);
      if (fg == null) return;

      const prev = lastForeground.get(sessionId);
      if (fg === prev) return;

      lastForeground.set(sessionId, fg);
      sendToMainWindow("pty:status-changed", {
        sessionId,
        foreground: fg,
      });
    }, STATUS_DEBOUNCE_MS),
  );
}

export function clearForegroundCache(sessionId: string): void {
  lastForeground.delete(sessionId);
  const timer = statusTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    statusTimers.delete(sessionId);
  }
}
