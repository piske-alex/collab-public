/**
 * SshFsBackend — implements FsBackend via SFTP.
 */
import type { SFTPWrapper, Stats } from "ssh2";
import type { FileFilter } from "../file-filter";
import type { FsBackend } from "./fs-backend";
import type { DirEntry, WriteResult } from "../files";
import { isImageFile } from "../file-filter";

/** POSIX path join — never uses backslashes. */
function posixJoin(...parts: string[]): string {
  return parts
    .join("/")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "") || "/";
}

function posixDirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

function posixBasename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

function posixExtname(p: string): string {
  const base = posixBasename(p);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot) : "";
}

function sftpStat(sftp: SFTPWrapper, path: string): Promise<Stats> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (err, stats) => {
      if (err) reject(err);
      else resolve(stats);
    });
  });
}

function sftpReaddir(
  sftp: SFTPWrapper,
  path: string,
): Promise<{ filename: string; attrs: Stats }[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (err, list) => {
      if (err) reject(err);
      else resolve(list.map((e) => ({ filename: e.filename, attrs: e.attrs })));
    });
  });
}

function sftpReadFile(sftp: SFTPWrapper, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = sftp.createReadStream(path, { encoding: "utf8" });
    stream.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}

function sftpWriteFile(
  sftp: SFTPWrapper,
  path: string,
  content: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(path, { encoding: "utf8" });
    stream.on("close", () => resolve());
    stream.on("error", reject);
    stream.end(content);
  });
}

function sftpRename(
  sftp: SFTPWrapper,
  oldPath: string,
  newPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rename(oldPath, newPath, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function sftpMkdir(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(path, (err) => {
      if (err && (err as any).code !== 4) reject(err); // code 4 = already exists
      else resolve();
    });
  });
}

async function sftpMkdirRecursive(
  sftp: SFTPWrapper,
  dirPath: string,
): Promise<void> {
  const parts = dirPath.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += "/" + part;
    try {
      await sftpStat(sftp, current);
    } catch {
      await sftpMkdir(sftp, current);
    }
  }
}

function sftpUnlink(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(path, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function sftpExists(sftp: SFTPWrapper, path: string): Promise<boolean> {
  try {
    await sftpStat(sftp, path);
    return true;
  } catch {
    return false;
  }
}

function statsToIso(stats: Stats): { ctime: string; mtime: string } {
  // SFTP doesn't provide birthtime, use mtime for both
  const mtime = new Date(stats.mtime * 1000).toISOString();
  return { ctime: mtime, mtime };
}

function shouldIncludeRemote(
  relPath: string,
  isDir: boolean,
  filter?: FileFilter,
): boolean {
  if (!filter) return true;
  return !filter.isIgnored(isDir ? `${relPath}/` : relPath);
}

async function isBinaryRemote(
  sftp: SFTPWrapper,
  fullPath: string,
  filter?: FileFilter,
): Promise<boolean> {
  if (!filter) return false;
  if (isImageFile(posixBasename(fullPath))) return false;
  // Read first 8KB to check for binary content
  try {
    const buf = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = sftp.createReadStream(fullPath, { start: 0, end: 8191 });
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => resolve(Buffer.concat(chunks)));
      stream.on("error", reject);
    });
    // Check for null bytes (simple binary detection)
    return buf.includes(0);
  } catch {
    return false;
  }
}

// ── SshFsBackend ──────────────────────────────────────────────

export class SshFsBackend implements FsBackend {
  constructor(private sftp: SFTPWrapper) {}

  async readDir(
    dirPath: string,
    filter?: FileFilter,
    rootPath?: string,
  ): Promise<DirEntry[]> {
    const entries = await sftpReaddir(this.sftp, dirPath);
    const result: DirEntry[] = [];

    for (const { filename, attrs } of entries) {
      if (filename === "." || filename === "..") continue;

      const isDir = (attrs.mode! & 0o40000) !== 0;
      const isFile = (attrs.mode! & 0o100000) !== 0;
      const isSymlink = (attrs.mode! & 0o120000) === 0o120000;

      // Apply filter
      if (rootPath && filter) {
        const normDir = dirPath.replace(/\\/g, "/");
        const normRoot = rootPath.replace(/\\/g, "/");
        const prefix = normDir.length > normRoot.length
          ? normDir.slice(normRoot.length + 1) + "/"
          : "";
        const relPath = prefix + filename;
        if (!shouldIncludeRemote(relPath, isDir, filter)) continue;
      }

      if (isFile && !isDir) {
        const fullPath = posixJoin(dirPath, filename);
        if (await isBinaryRemote(this.sftp, fullPath, filter)) continue;
      }

      const { ctime, mtime } = statsToIso(attrs);

      const entry: DirEntry = {
        name: filename,
        isDirectory: isDir,
        isFile: isFile,
        isSymlink,
        createdAt: ctime,
        modifiedAt: mtime,
      };

      if (isDir) {
        try {
          entry.fileCount = await this.countFiles(
            posixJoin(dirPath, filename),
            filter,
            rootPath,
          );
        } catch { /* ignore */ }
      }

      result.push(entry);
    }

    return result;
  }

  async countFiles(
    dirPath: string,
    filter?: FileFilter,
    rootPath?: string,
  ): Promise<number> {
    let count = 0;
    const entries = await sftpReaddir(this.sftp, dirPath);
    for (const { filename, attrs } of entries) {
      if (filename === "." || filename === "..") continue;
      const isDir = (attrs.mode! & 0o40000) !== 0;

      if (rootPath && filter) {
        const normDir = dirPath.replace(/\\/g, "/");
        const normRoot = rootPath.replace(/\\/g, "/");
        const prefix = normDir.length > normRoot.length
          ? normDir.slice(normRoot.length + 1) + "/"
          : "";
        const relPath = prefix + filename;
        if (!shouldIncludeRemote(relPath, isDir, filter)) continue;
      }

      if (isDir) {
        count += await this.countFiles(
          posixJoin(dirPath, filename),
          filter,
          rootPath,
        );
      } else {
        count += 1;
      }
    }
    return count;
  }

  async readFile(filePath: string): Promise<string> {
    return sftpReadFile(this.sftp, filePath);
  }

  async writeFile(
    filePath: string,
    content: string,
    expectedMtime?: string,
  ): Promise<WriteResult> {
    if (expectedMtime) {
      try {
        const before = await sftpStat(this.sftp, filePath);
        const beforeMtime = new Date(before.mtime * 1000).toISOString();
        if (beforeMtime !== expectedMtime) {
          return { ok: false, mtime: beforeMtime, conflict: true };
        }
      } catch {
        // File doesn't exist — no conflict
      }
    }

    await sftpWriteFile(this.sftp, filePath, content);
    const after = await sftpStat(this.sftp, filePath);
    return { ok: true, mtime: new Date(after.mtime * 1000).toISOString() };
  }

  async stat(filePath: string): Promise<{ ctime: string; mtime: string }> {
    const stats = await sftpStat(this.sftp, filePath);
    return statsToIso(stats);
  }

  async rename(oldPath: string, newName: string): Promise<string> {
    const dir = posixDirname(oldPath);
    let target = posixJoin(dir, newName);
    if (oldPath === target) return oldPath;

    const ext = posixExtname(newName);
    const stem = ext ? newName.slice(0, -ext.length) : newName;
    let n = 2;
    while (await sftpExists(this.sftp, target)) {
      target = posixJoin(dir, ext ? `${stem} ${n}${ext}` : `${stem} ${n}`);
      n++;
    }

    await sftpRename(this.sftp, oldPath, target);
    return target;
  }

  async mkdir(dirPath: string): Promise<void> {
    await sftpMkdirRecursive(this.sftp, dirPath);
  }

  async trash(filePath: string): Promise<void> {
    // SFTP has no trash — delete directly
    await sftpUnlink(this.sftp, filePath);
  }

  async move(oldPath: string, newParentDir: string): Promise<string> {
    const name = posixBasename(oldPath);
    let target = posixJoin(newParentDir, name);
    if (oldPath === target) return oldPath;

    const ext = posixExtname(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    let n = 2;
    while (await sftpExists(this.sftp, target)) {
      target = posixJoin(
        newParentDir,
        ext ? `${stem} ${n}${ext}` : `${stem} ${n}`,
      );
      n++;
    }

    await sftpRename(this.sftp, oldPath, target);
    return target;
  }
}
