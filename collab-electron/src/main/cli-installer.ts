import { app } from "electron";
import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { isWindows, PATH_DELIMITER } from "./platform";

const INSTALL_DIR = isWindows
  ? join(homedir(), ".local", "bin") // keep consistent across platforms
  : join(homedir(), ".local", "bin");

const CLI_NAME = isWindows ? "collab.cmd" : "collab";
const INSTALL_PATH = join(INSTALL_DIR, CLI_NAME);
const COLLAB_DIR = join(homedir(), ".collaborator");
const HINT_MARKER = join(COLLAB_DIR, "cli-path-hinted");

function getCliSource(): string {
  const ext = isWindows ? "collab-cli.cmd" : "collab-cli.sh";
  if (app.isPackaged) {
    return join(process.resourcesPath, ext);
  }
  return join(app.getAppPath(), "scripts", ext);
}

export function installCli(): void {
  const source = getCliSource();
  if (!existsSync(source)) {
    console.warn(
      "[cli-installer] CLI source not found:", source,
    );
    return;
  }

  mkdirSync(INSTALL_DIR, { recursive: true });
  copyFileSync(source, INSTALL_PATH);

  if (!isWindows) {
    chmodSync(INSTALL_PATH, 0o755);
  }

  if (!existsSync(HINT_MARKER)) {
    const pathEnv = process.env["PATH"] ?? "";
    if (!pathEnv.split(PATH_DELIMITER).includes(INSTALL_DIR)) {
      if (isWindows) {
        console.log(
          `[cli-installer] collab installed to ${INSTALL_PATH}. ` +
          `Add the directory to your PATH to use it from any terminal:\n` +
          `  setx PATH "%PATH%;${INSTALL_DIR}"`,
        );
      } else {
        console.log(
          `[cli-installer] collab installed to ${INSTALL_PATH}. ` +
          `Add ~/.local/bin to your PATH to use it from any terminal:\n` +
          `  export PATH="$HOME/.local/bin:$PATH"`,
        );
      }
      mkdirSync(COLLAB_DIR, { recursive: true });
      writeFileSync(HINT_MARKER, "", "utf-8");
    }
  }
}
