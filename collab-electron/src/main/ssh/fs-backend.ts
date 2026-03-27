/**
 * FsBackend abstraction — common interface for local and SSH file operations.
 * LocalFsBackend wraps existing files.ts functions.
 * SshFsBackend will implement via SFTP (Phase 3).
 */
import type { FileFilter } from "../file-filter";
import {
  fsReadDir,
  fsReadFile,
  fsWriteFile,
  fsRename,
  fsMkdir,
  fsMove,
  countTreeFiles,
  type DirEntry,
  type WriteResult,
} from "../files";
import { stat } from "node:fs/promises";
import { shell } from "electron";

// ── Interface ─────────────────────────────────────────────────

export interface FsBackend {
  readDir(
    dirPath: string,
    filter?: FileFilter,
    rootPath?: string,
  ): Promise<DirEntry[]>;

  countFiles(
    dirPath: string,
    filter?: FileFilter,
    rootPath?: string,
  ): Promise<number>;

  readFile(filePath: string): Promise<string>;

  writeFile(
    filePath: string,
    content: string,
    expectedMtime?: string,
  ): Promise<WriteResult>;

  stat(filePath: string): Promise<{ ctime: string; mtime: string }>;

  rename(oldPath: string, newName: string): Promise<string>;

  mkdir(dirPath: string): Promise<void>;

  trash(filePath: string): Promise<void>;

  move(oldPath: string, newParentDir: string): Promise<string>;
}

// ── Local implementation ──────────────────────────────────────

export class LocalFsBackend implements FsBackend {
  async readDir(
    dirPath: string,
    filter?: FileFilter,
    rootPath?: string,
  ): Promise<DirEntry[]> {
    return fsReadDir(dirPath, filter, rootPath);
  }

  async countFiles(
    dirPath: string,
    filter?: FileFilter,
    rootPath?: string,
  ): Promise<number> {
    return countTreeFiles(dirPath, filter, rootPath);
  }

  async readFile(filePath: string): Promise<string> {
    return fsReadFile(filePath);
  }

  async writeFile(
    filePath: string,
    content: string,
    expectedMtime?: string,
  ): Promise<WriteResult> {
    return fsWriteFile(filePath, content, expectedMtime);
  }

  async stat(filePath: string): Promise<{ ctime: string; mtime: string }> {
    const s = await stat(filePath);
    return {
      ctime: s.birthtime.toISOString(),
      mtime: s.mtime.toISOString(),
    };
  }

  async rename(oldPath: string, newName: string): Promise<string> {
    return fsRename(oldPath, newName);
  }

  async mkdir(dirPath: string): Promise<void> {
    return fsMkdir(dirPath);
  }

  async trash(filePath: string): Promise<void> {
    await shell.trashItem(filePath);
  }

  async move(oldPath: string, newParentDir: string): Promise<string> {
    return fsMove(oldPath, newParentDir);
  }
}
