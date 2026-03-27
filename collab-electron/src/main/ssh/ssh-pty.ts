/**
 * SSH terminal backend — opens interactive shell channels over ssh2.
 * Session IDs are prefixed with "ssh-" for routing in pty.ts.
 */
import type { Client, ClientChannel } from "ssh2";
import * as crypto from "node:crypto";
import {
  writeSessionMeta,
  readSessionMeta,
  deleteSessionMeta,
  type SessionMeta,
} from "../tmux";
import { sshConnections } from "./ssh-connection";

interface SshPtySession {
  stream: ClientChannel;
  shell: string;
  cwd: string;
  uri: string;
  senderWebContentsId?: number;
}

const sessions = new Map<string, SshPtySession>();
let shuttingDown = false;

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

export const SSH_SESSION_PREFIX = "ssh-";

export function isSshSession(sessionId: string): boolean {
  return sessionId.startsWith(SSH_SESSION_PREFIX);
}

export function setShuttingDown(value: boolean): void {
  shuttingDown = value;
}

export function createSession(
  uri: string,
  cwd: string | undefined,
  senderWebContentsId: number | undefined,
  cols: number | undefined,
  rows: number | undefined,
): Promise<{ sessionId: string; shell: string }> {
  const client = sshConnections.getClient(uri);
  if (!client) {
    throw new Error(`SSH not connected for ${uri}`);
  }

  const sessionId = SSH_SESSION_PREFIX + crypto.randomBytes(8).toString("hex");
  const c = cols || 80;
  const r = rows || 24;
  const resolvedCwd = cwd || "/";

  return new Promise((resolve, reject) => {
    client.shell(
      { cols: c, rows: r, term: "xterm-256color" },
      (err, stream) => {
        if (err) return reject(err);

        const session: SshPtySession = {
          stream,
          shell: "ssh",
          cwd: resolvedCwd,
          uri,
          senderWebContentsId,
        };
        sessions.set(sessionId, session);

        stream.on("data", (data: Buffer) => {
          sendToSender(senderWebContentsId, "pty:data", {
            sessionId,
            data: data.toString(),
          });
        });

        stream.on("close", () => {
          if (!shuttingDown) {
            deleteSessionMeta(sessionId);
            sendToSender(senderWebContentsId, "pty:exit", {
              sessionId,
              exitCode: 0,
            });
          }
          sessions.delete(sessionId);
        });

        // cd to workspace directory
        if (resolvedCwd && resolvedCwd !== "/") {
          stream.write(`cd ${JSON.stringify(resolvedCwd)}\n`);
        }

        writeSessionMeta(sessionId, {
          shell: "ssh",
          cwd: resolvedCwd,
          createdAt: new Date().toISOString(),
          mode: "direct",
        });

        resolve({ sessionId, shell: "ssh" });
      },
    );
  });
}

export function writeToSession(sessionId: string, data: string): void {
  const session = sessions.get(sessionId);
  if (session) session.stream.write(data);
}

export function sendRawKeys(sessionId: string, data: string): void {
  writeToSession(sessionId, data);
}

export function resizeSession(
  sessionId: string,
  cols: number,
  rows: number,
): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.stream.setWindow(rows, cols, 0, 0);
  }
}

export function killSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.stream.close();
    sessions.delete(sessionId);
  }
  deleteSessionMeta(sessionId);
}

export function listSessions(): string[] {
  return [...sessions.keys()];
}

export function killAll(): void {
  shuttingDown = true;
  for (const [, session] of sessions) {
    session.stream.close();
  }
  sessions.clear();
}

export function killAllAndWait(): Promise<void> {
  killAll();
  return Promise.resolve();
}

export function reconnectSession(
  sessionId: string,
  uri: string,
  cols: number,
  rows: number,
  senderWebContentsId: number,
): Promise<{
  sessionId: string;
  shell: string;
  meta: SessionMeta | null;
  scrollback: string;
}> {
  // SSH sessions can't truly reconnect — create a new shell
  // in the same CWD and return empty scrollback
  const meta = readSessionMeta(sessionId);
  const cwd = meta?.cwd || "/";

  // Clean up old metadata
  deleteSessionMeta(sessionId);

  // Create a new session under the same ID
  const client = sshConnections.getClient(uri);
  if (!client) {
    throw new Error(`SSH not connected for ${uri}`);
  }

  return new Promise((resolve, reject) => {
    client.shell(
      { cols, rows, term: "xterm-256color" },
      (err, stream) => {
        if (err) return reject(err);

        const session: SshPtySession = {
          stream,
          shell: "ssh",
          cwd,
          uri,
          senderWebContentsId,
        };
        sessions.set(sessionId, session);

        stream.on("data", (data: Buffer) => {
          sendToSender(senderWebContentsId, "pty:data", {
            sessionId,
            data: data.toString(),
          });
        });

        stream.on("close", () => {
          if (!shuttingDown) {
            deleteSessionMeta(sessionId);
            sendToSender(senderWebContentsId, "pty:exit", {
              sessionId,
              exitCode: 0,
            });
          }
          sessions.delete(sessionId);
        });

        if (cwd && cwd !== "/") {
          stream.write(`cd ${JSON.stringify(cwd)}\n`);
        }

        writeSessionMeta(sessionId, {
          shell: "ssh",
          cwd,
          createdAt: new Date().toISOString(),
          mode: "direct",
        });

        resolve({
          sessionId,
          shell: "ssh",
          meta,
          scrollback: "",
        });
      },
    );
  });
}
