/**
 * Direct node-pty backend — no tmux.
 * Used on Windows and Linux where tmux is unavailable.
 * Provides "soft persistence": saves scrollback + CWD on shutdown,
 * restores into a fresh shell on reconnect.
 */
import * as pty from "node-pty";
import * as os from "os";
import * as fs from "node:fs";
import * as crypto from "crypto";
import { type IDisposable } from "node-pty";
import {
  getTerminfoDir,
  writeSessionMeta,
  readSessionMeta,
  deleteSessionMeta,
  SESSION_DIR,
  type SessionMeta,
} from "./tmux";

// ── ScrollbackBuffer ──────────────────────────────────────────

const MAX_SCROLLBACK_BYTES = 1_000_000; // ~1 MB

class ScrollbackBuffer {
  private chunks: string[] = [];
  private totalLength = 0;

  append(data: string): void {
    this.chunks.push(data);
    this.totalLength += data.length;
    while (this.totalLength > MAX_SCROLLBACK_BYTES && this.chunks.length > 1) {
      const removed = this.chunks.shift()!;
      this.totalLength -= removed.length;
    }
  }

  toString(): string {
    return this.chunks.join("");
  }

  clear(): void {
    this.chunks = [];
    this.totalLength = 0;
  }
}

// ── Types & state ─────────────────────────────────────────────

interface DirectPtySession {
  pty: pty.IPty;
  shell: string;
  cwd: string;
  scrollback: ScrollbackBuffer;
  disposables: IDisposable[];
}

const sessions = new Map<string, DirectPtySession>();
let shuttingDown = false;

// ── Helpers ───────────────────────────────────────────────────

let _getWebContents: (() => typeof import("electron").webContents | null) | null = null;

function getWebContents(): typeof import("electron").webContents | null {
  if (!_getWebContents) {
    _getWebContents = () => {
      try { return require("electron").webContents; } catch { return null; }
    };
  }
  return _getWebContents();
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
  if (terminfoDir) {
    env.TERMINFO = terminfoDir;
  }
  return env;
}

function stripTrailingBlanks(text: string): string {
  const lines = text.split("\n");
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim() === "") end--;
  return lines.slice(0, end).join("\n");
}

// ── Public API (same signatures as tmux-backed pty.ts) ────────

export function setShuttingDown(value: boolean): void {
  shuttingDown = value;
}

export function createSession(
  shell: string,
  args: string[],
  cwd?: string,
  senderWebContentsId?: number,
  cols?: number,
  rows?: number,
): { sessionId: string; shell: string } {
  const sessionId = crypto.randomBytes(8).toString("hex");
  const resolvedCwd = cwd || os.homedir();
  const c = cols || 80;
  const r = rows || 24;

  // When args include --cd (WSL), don't pass cwd to pty.spawn
  const ptyProcess = pty.spawn(shell, args, {
    name: "xterm-256color",
    cols: c,
    rows: r,
    cwd: args.length > 0 ? undefined : resolvedCwd,
    env: utf8Env(),
  });

  const scrollback = new ScrollbackBuffer();
  const disposables: IDisposable[] = [];

  disposables.push(
    ptyProcess.onData((data: string) => {
      scrollback.append(data);
      sendToSender(senderWebContentsId, "pty:data", { sessionId, data });
    }),
  );

  disposables.push(
    ptyProcess.onExit(({ exitCode }) => {
      if (!shuttingDown) {
        deleteSessionMeta(sessionId);
        sendToSender(senderWebContentsId, "pty:exit", { sessionId, exitCode });
      }
      sessions.delete(sessionId);
    }),
  );

  sessions.set(sessionId, {
    pty: ptyProcess,
    shell,
    cwd: resolvedCwd,
    scrollback,
    disposables,
  });

  writeSessionMeta(sessionId, {
    shell,
    cwd: resolvedCwd,
    createdAt: new Date().toISOString(),
    mode: "direct",
  });

  return { sessionId, shell };
}

export function reconnectSession(
  sessionId: string,
  shell: string,
  args: string[],
  cols: number,
  rows: number,
  senderWebContentsId: number,
): {
  sessionId: string;
  shell: string;
  meta: SessionMeta | null;
  scrollback: string;
} {
  const meta = readSessionMeta(sessionId);
  if (!meta) {
    throw new Error(`session ${sessionId} metadata not found`);
  }

  const savedScrollback = meta.scrollback
    ? stripTrailingBlanks(meta.scrollback)
    : "";

  const resolvedCwd = meta.cwd || os.homedir();
  const resolvedShell = meta.shell || shell;

  // Use provided args (e.g. WSL --cd) or empty
  const ptyProcess = pty.spawn(resolvedShell, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: args.length > 0 ? undefined : resolvedCwd,
    env: utf8Env(),
  });

  const scrollback = new ScrollbackBuffer();
  const disposables: IDisposable[] = [];

  disposables.push(
    ptyProcess.onData((data: string) => {
      scrollback.append(data);
      sendToSender(senderWebContentsId, "pty:data", { sessionId, data });
    }),
  );

  disposables.push(
    ptyProcess.onExit(({ exitCode }) => {
      if (!shuttingDown) {
        deleteSessionMeta(sessionId);
        sendToSender(senderWebContentsId, "pty:exit", { sessionId, exitCode });
      }
      sessions.delete(sessionId);
    }),
  );

  sessions.set(sessionId, {
    pty: ptyProcess,
    shell: resolvedShell,
    cwd: resolvedCwd,
    scrollback,
    disposables,
  });

  // Update meta — clear saved scrollback, mark active
  writeSessionMeta(sessionId, {
    shell: resolvedShell,
    cwd: resolvedCwd,
    createdAt: new Date().toISOString(),
    mode: "direct",
  });

  return {
    sessionId,
    shell: resolvedShell,
    meta,
    scrollback: savedScrollback,
  };
}

export function writeToSession(sessionId: string, data: string): void {
  sessions.get(sessionId)?.pty.write(data);
}

export function sendRawKeys(sessionId: string, data: string): void {
  // No tmux parser to bypass — write directly
  sessions.get(sessionId)?.pty.write(data);
}

export function resizeSession(sessionId: string, cols: number, rows: number): void {
  sessions.get(sessionId)?.pty.resize(cols, rows);
}

export function killSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    for (const d of session.disposables) d.dispose();
    session.pty.kill();
    sessions.delete(sessionId);
  }
  deleteSessionMeta(sessionId);
}

export function listSessions(): string[] {
  return [...sessions.keys()];
}

/**
 * Save scrollback + CWD for all live sessions before shutdown.
 * Called before killAll so the data can be restored on next launch.
 */
export function saveAllSessions(): void {
  for (const [sessionId, session] of sessions) {
    const scrollbackText = session.scrollback.toString();
    writeSessionMeta(sessionId, {
      shell: session.shell,
      cwd: session.cwd,
      createdAt: new Date().toISOString(),
      scrollback: scrollbackText,
      savedAt: new Date().toISOString(),
      mode: "direct",
    });
  }
}

export function killAll(): void {
  shuttingDown = true;
  for (const [, session] of sessions) {
    for (const d of session.disposables) d.dispose();
    session.pty.kill();
  }
  sessions.clear();
}

const KILL_ALL_TIMEOUT_MS = 2000;

export function killAllAndWait(): Promise<void> {
  shuttingDown = true;
  if (sessions.size === 0) return Promise.resolve();

  const pending: Promise<void>[] = [];
  for (const [, session] of sessions) {
    pending.push(
      new Promise<void>((resolve) => {
        session.pty.onExit(() => resolve());
      }),
    );
    for (const d of session.disposables) d.dispose();
    session.pty.kill();
  }
  sessions.clear();

  const timeout = new Promise<void>((resolve) =>
    setTimeout(resolve, KILL_ALL_TIMEOUT_MS),
  );
  return Promise.race([
    Promise.all(pending).then(() => {}),
    timeout,
  ]);
}

export function destroyAll(): void {
  killAll();
}

export interface DiscoveredSession {
  sessionId: string;
  meta: SessionMeta;
}

const STALE_HOURS = 24;

export function discoverSessions(): DiscoveredSession[] {
  let metaFiles: string[];
  try {
    metaFiles = fs
      .readdirSync(SESSION_DIR)
      .filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  const result: DiscoveredSession[] = [];
  const now = Date.now();

  for (const file of metaFiles) {
    const sessionId = file.replace(".json", "");
    const meta = readSessionMeta(sessionId);
    if (!meta) {
      deleteSessionMeta(sessionId);
      continue;
    }

    // Only restore direct-mode sessions that have saved scrollback
    if (meta.mode !== "direct" || !meta.savedAt) {
      deleteSessionMeta(sessionId);
      continue;
    }

    // Skip stale sessions
    const age = now - new Date(meta.savedAt).getTime();
    if (age > STALE_HOURS * 60 * 60 * 1000) {
      deleteSessionMeta(sessionId);
      continue;
    }

    result.push({ sessionId, meta });
  }

  return result;
}

export function verifyTmuxAvailable(): void {
  // No-op in direct mode
}
