import { type BrowserWindow } from "electron";
import type { FileFilter } from "./file-filter";
import type { AppConfig } from "./config";
import { invalidateImageCache } from "./image-service";
import { saveWorkspaceConfig } from "./workspace-config";
import * as watcher from "./watcher";
import * as wikilinkIndex from "./wikilink-index";
import { trackEvent } from "./analytics";
import { LocalFsBackend, type FsBackend } from "./ssh/fs-backend";
import { SshFsBackend } from "./ssh/fs-backend-ssh";
import { isSshWorkspace, sshConnections } from "./ssh";

import {
  registerFilesystemHandlers,
  getRecentlyRenamedRefCounts,
} from "./ipc-filesystem";
import {
  registerWorkspaceHandlers,
  startWorkspaceServices,
  getWorkspaceConfig,
  setBackendCallback,
} from "./ipc-workspace";
import { registerKnowledgeHandlers } from "./ipc-knowledge";
import { registerCanvasHandlers } from "./ipc-canvas";
import { registerMiscHandlers } from "./ipc-misc";

const FS_CHANGE_DELETED = 3;

let appConfig: AppConfig;
let mainWindow: BrowserWindow | null = null;
const fileFilterRef: { current: FileFilter | null } = {
  current: null,
};
const backendRef: { current: FsBackend } = {
  current: new LocalFsBackend(),
};

export function setBackendForWorkspace(workspacePath: string): void {
  if (isSshWorkspace(workspacePath)) {
    const sftp = sshConnections.getSftp(workspacePath);
    if (sftp) {
      backendRef.current = new SshFsBackend(sftp);
    }
  } else {
    backendRef.current = new LocalFsBackend();
  }
}

function activeWorkspacePath(): string {
  const { workspaces, active_workspace } = appConfig;
  return workspaces[active_workspace] ?? "";
}

function forwardToWebview(
  target: string,
  channel: string,
  ...args: unknown[]
): void {
  mainWindow?.webContents.send(
    "shell:forward",
    target,
    channel,
    ...args,
  );
}

export function setMainWindow(win: BrowserWindow): void {
  mainWindow = win;
}

export function registerIpcHandlers(config: AppConfig): void {
  appConfig = config;

  const wsPath = activeWorkspacePath();
  if (wsPath) {
    startWorkspaceServices(wsPath, (f) => {
      fileFilterRef.current = f;
    });
  }

  // File watcher notifications
  watcher.setNotifyFn((events) => {
    const changedPaths = events.flatMap(
      (event) => event.changes.map((change) => change.path),
    );
    fileFilterRef.current?.invalidateBinaryCache(changedPaths);
    invalidateImageCache(changedPaths);

    forwardToWebview("nav", "fs-changed", events);
    forwardToWebview("viewer", "fs-changed", events);

    for (const event of events) {
      for (const change of event.changes) {
        if (!change.path.endsWith(".md")) continue;
        if (change.type === FS_CHANGE_DELETED) {
          wikilinkIndex.removeFile(change.path);
        } else {
          void wikilinkIndex.updateFile(change.path);
        }
      }
    }

    const recentlyRenamed = getRecentlyRenamedRefCounts();
    const deletedPaths = events.flatMap((e) =>
      e.changes
        .filter(
          (c) =>
            c.type === FS_CHANGE_DELETED &&
            !recentlyRenamed.has(c.path),
        )
        .map((c) => c.path),
    );
    if (deletedPaths.length > 0) {
      forwardToWebview("nav", "files-deleted", deletedPaths);
      forwardToWebview(
        "viewer", "files-deleted", deletedPaths,
      );
      const active = activeWorkspacePath();
      if (active) {
        const wsConfig = getWorkspaceConfig(active);
        if (
          wsConfig.selected_file &&
          deletedPaths.includes(wsConfig.selected_file)
        ) {
          wsConfig.selected_file = null;
          saveWorkspaceConfig(active, wsConfig);
        }
      }
    }
  });

  // Shared context for domain modules
  const fsCtx = {
    mainWindow: () => mainWindow,
    getActiveWorkspacePath: activeWorkspacePath,
    getWorkspaceConfig,
    saveWorkspaceConfig: (
      path: string,
      cfg: {
        selected_file: string | null;
        expanded_dirs: string[];
        agent_skip_permissions: boolean;
      },
    ) => saveWorkspaceConfig(path, cfg),
    fileFilter: () => fileFilterRef.current,
    backend: () => backendRef.current,
    forwardToWebview,
    trackEvent,
  };

  const wsCtx = {
    mainWindow: () => mainWindow,
    getActiveWorkspacePath: activeWorkspacePath,
    forwardToWebview,
  };

  const sharedCtx = {
    mainWindow: () => mainWindow,
    getActiveWorkspacePath: () =>
      activeWorkspacePath() || null,
    getWorkspaceConfig: (path: string) =>
      getWorkspaceConfig(path) as any,
    fileFilter: () => fileFilterRef.current as any,
    forwardToWebview,
    trackEvent,
  };

  // Wire backend switching on workspace change
  setBackendCallback(setBackendForWorkspace);

  // Register domain handlers
  registerFilesystemHandlers(fsCtx);
  registerWorkspaceHandlers(wsCtx, appConfig, fileFilterRef);
  registerKnowledgeHandlers(sharedCtx);
  registerCanvasHandlers(sharedCtx);
  registerMiscHandlers(sharedCtx);
}
