/**
 * Per-SSH-workspace config stored locally (not on the remote).
 * Keeps selected_file, expanded_dirs, etc. in:
 *   COLLAB_DIR/ssh-workspaces/<uri-hash>/config.json
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { COLLAB_DIR } from "../paths";

export interface SshWorkspaceConfig {
  selected_file: string | null;
  expanded_dirs: string[];
  agent_skip_permissions: boolean;
}

const SSH_WS_DIR = path.join(COLLAB_DIR, "ssh-workspaces");

function hashUri(uri: string): string {
  return crypto.createHash("sha256").update(uri).digest("hex").slice(0, 16);
}

function configDir(uri: string): string {
  return path.join(SSH_WS_DIR, hashUri(uri));
}

function configPath(uri: string): string {
  return path.join(configDir(uri), "config.json");
}

const DEFAULT_CONFIG: SshWorkspaceConfig = {
  selected_file: null,
  expanded_dirs: [],
  agent_skip_permissions: false,
};

export function loadSshWorkspaceConfig(uri: string): SshWorkspaceConfig {
  try {
    const raw = fs.readFileSync(configPath(uri), "utf-8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveSshWorkspaceConfig(
  uri: string,
  config: SshWorkspaceConfig,
): void {
  const dir = configDir(uri);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(uri), JSON.stringify(config, null, 2));
}

export function deleteSshWorkspaceConfig(uri: string): void {
  try {
    fs.rmSync(configDir(uri), { recursive: true, force: true });
  } catch {
    // no-op
  }
}
