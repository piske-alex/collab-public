export {
  parseWorkspaceUri,
  isSshWorkspace,
  buildSshUri,
  type WorkspaceInfo,
  type LocalWorkspaceInfo,
  type SshWorkspaceInfo,
} from "./workspace-uri";

export {
  sshConnections,
  type ConnectionStatus,
} from "./ssh-connection";

export {
  loadSshWorkspaceConfig,
  saveSshWorkspaceConfig,
  deleteSshWorkspaceConfig,
  type SshWorkspaceConfig,
} from "./ssh-workspace-config";

export { LocalFsBackend, type FsBackend } from "./fs-backend";
export { SshFsBackend } from "./fs-backend-ssh";
export * as sshPty from "./ssh-pty";
