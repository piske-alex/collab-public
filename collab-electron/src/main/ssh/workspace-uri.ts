/**
 * Workspace URI parsing — distinguishes local paths from SSH URIs.
 *
 * Local:  C:\Users\alex\project   or  /home/alex/project
 * SSH:    ssh://alex@myserver:22/home/alex/project
 */

export interface LocalWorkspaceInfo {
  type: "local";
  path: string;
}

export interface SshWorkspaceInfo {
  type: "ssh";
  host: string;
  port: number;
  username: string;
  remotePath: string;
  uri: string;
}

export type WorkspaceInfo = LocalWorkspaceInfo | SshWorkspaceInfo;

const SSH_URI_RE = /^ssh:\/\/([^@]+)@([^:]+):(\d+)(\/.*)?$/;

export function parseWorkspaceUri(workspace: string): WorkspaceInfo {
  const m = workspace.match(SSH_URI_RE);
  if (m) {
    return {
      type: "ssh",
      username: m[1],
      host: m[2],
      port: parseInt(m[3], 10),
      remotePath: m[4] || "/",
      uri: workspace,
    };
  }
  return { type: "local", path: workspace };
}

export function isSshWorkspace(workspace: string): boolean {
  return SSH_URI_RE.test(workspace);
}

export function buildSshUri(
  host: string,
  port: number,
  username: string,
  remotePath: string,
): string {
  const cleanPath = remotePath.startsWith("/") ? remotePath : `/${remotePath}`;
  return `ssh://${username}@${host}:${port}${cleanPath}`;
}
