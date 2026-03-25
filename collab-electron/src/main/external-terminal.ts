import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { getTmuxBin, getSocketName, getTmuxConf } from "./tmux";

function escapeAppleScriptString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function isITerm2Available(): boolean {
  return existsSync("/Applications/iTerm.app");
}

export function openInITerm2(sessionName: string): Promise<void> {
  if (!/^collab-[0-9a-f]+$/.test(sessionName)) {
    return Promise.reject(new Error(`Invalid session name: ${sessionName}`));
  }

  const tmuxBin = getTmuxBin();
  const socket = getSocketName();
  const conf = getTmuxConf();
  const cmd = `'${tmuxBin}' -L ${socket} -f '${conf}' -u attach-session -t ${sessionName}`;
  const escaped = escapeAppleScriptString(cmd);

  return new Promise((resolve, reject) => {
    execFile(
      "osascript",
      [
        "-e",
        `tell application "iTerm2"
          activate
          create window with default profile command "${escaped}"
        end tell`,
      ],
      { timeout: 10000 },
      (err) => {
        if (err) reject(err);
        else resolve();
      },
    );
  });
}
