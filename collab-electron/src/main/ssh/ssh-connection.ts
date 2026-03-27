/**
 * SSH connection pool — manages ssh2 client connections and SFTP channels
 * keyed by workspace URI.
 */
import { Client, type SFTPWrapper, type ConnectConfig } from "ssh2";
import * as fs from "node:fs";
import { EventEmitter } from "node:events";
import { parseWorkspaceUri, type SshWorkspaceInfo } from "./workspace-uri";

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

interface ManagedConnection {
  client: Client;
  sftp: SFTPWrapper | null;
  status: ConnectionStatus;
  error?: string;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  reconnectAttempt: number;
}

const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;
const KEEPALIVE_INTERVAL_MS = 10000;
const KEEPALIVE_COUNT_MAX = 3;

class SshConnectionManager extends EventEmitter {
  private connections = new Map<string, ManagedConnection>();
  private passwords = new Map<string, string>();

  getStatus(uri: string): ConnectionStatus {
    return this.connections.get(uri)?.status ?? "disconnected";
  }

  getClient(uri: string): Client | null {
    const conn = this.connections.get(uri);
    return conn?.status === "connected" ? conn.client : null;
  }

  getSftp(uri: string): SFTPWrapper | null {
    const conn = this.connections.get(uri);
    return conn?.status === "connected" ? conn.sftp : null;
  }

  /**
   * Store a password for the connection (held in memory only, never persisted).
   */
  setPassword(uri: string, password: string): void {
    this.passwords.set(uri, password);
  }

  async connect(
    uri: string,
    options?: {
      password?: string;
      privateKeyPath?: string;
    },
  ): Promise<void> {
    const info = parseWorkspaceUri(uri);
    if (info.type !== "ssh") throw new Error(`Not an SSH URI: ${uri}`);

    // Clean up existing connection
    this.disconnectInternal(uri, false);

    const managed: ManagedConnection = {
      client: new Client(),
      sftp: null,
      status: "connecting",
      reconnectAttempt: 0,
    };
    this.connections.set(uri, managed);
    this.emitStatus(uri, "connecting");

    if (options?.password) {
      this.passwords.set(uri, options.password);
    }

    await this.doConnect(uri, info, managed, options?.privateKeyPath);
  }

  private async doConnect(
    uri: string,
    info: SshWorkspaceInfo,
    managed: ManagedConnection,
    privateKeyPath?: string,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const connectConfig: ConnectConfig = {
        host: info.host,
        port: info.port,
        username: info.username,
        keepaliveInterval: KEEPALIVE_INTERVAL_MS,
        keepaliveCountMax: KEEPALIVE_COUNT_MAX,
        readyTimeout: 15000,
      };

      // Auth: key file → stored password → agent
      if (privateKeyPath) {
        try {
          connectConfig.privateKey = fs.readFileSync(privateKeyPath);
        } catch (err) {
          managed.status = "error";
          managed.error = `Failed to read key: ${privateKeyPath}`;
          this.emitStatus(uri, "error", managed.error);
          reject(new Error(managed.error));
          return;
        }
      } else if (this.passwords.has(uri)) {
        connectConfig.password = this.passwords.get(uri);
      } else {
        connectConfig.agent = process.env.SSH_AUTH_SOCK;
      }

      managed.client.on("ready", () => {
        managed.client.sftp((err, sftp) => {
          if (err) {
            managed.status = "error";
            managed.error = `SFTP failed: ${err.message}`;
            this.emitStatus(uri, "error", managed.error);
            reject(err);
            return;
          }
          managed.sftp = sftp;
          managed.status = "connected";
          managed.reconnectAttempt = 0;
          this.emitStatus(uri, "connected");
          resolve();
        });
      });

      managed.client.on("error", (err) => {
        managed.status = "error";
        managed.error = err.message;
        this.emitStatus(uri, "error", err.message);
        if (managed.reconnectAttempt === 0) {
          reject(err);
        }
      });

      managed.client.on("close", () => {
        if (managed.status === "connected") {
          managed.status = "disconnected";
          managed.sftp = null;
          this.emitStatus(uri, "disconnected");
          this.scheduleReconnect(uri, info, privateKeyPath);
        }
      });

      managed.client.connect(connectConfig);
    });
  }

  private scheduleReconnect(
    uri: string,
    info: SshWorkspaceInfo,
    privateKeyPath?: string,
  ): void {
    const managed = this.connections.get(uri);
    if (!managed) return;
    if (managed.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      console.error(`[ssh] Max reconnect attempts reached for ${uri}`);
      return;
    }

    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * Math.pow(2, managed.reconnectAttempt),
      MAX_RECONNECT_DELAY_MS,
    );
    managed.reconnectAttempt++;

    console.log(
      `[ssh] Reconnecting to ${info.host} in ${delay}ms (attempt ${managed.reconnectAttempt})`,
    );

    managed.reconnectTimer = setTimeout(async () => {
      managed.client = new Client();
      managed.status = "connecting";
      this.emitStatus(uri, "connecting");
      try {
        await this.doConnect(uri, info, managed, privateKeyPath);
      } catch {
        // doConnect will schedule another retry via the close handler
      }
    }, delay);
  }

  disconnect(uri: string): void {
    this.disconnectInternal(uri, true);
  }

  private disconnectInternal(uri: string, emit: boolean): void {
    const managed = this.connections.get(uri);
    if (!managed) return;

    if (managed.reconnectTimer) {
      clearTimeout(managed.reconnectTimer);
    }

    try {
      managed.client.end();
    } catch {
      // already closed
    }

    this.connections.delete(uri);
    this.passwords.delete(uri);

    if (emit) {
      this.emitStatus(uri, "disconnected");
    }
  }

  disconnectAll(): void {
    for (const uri of [...this.connections.keys()]) {
      this.disconnect(uri);
    }
  }

  private emitStatus(
    uri: string,
    status: ConnectionStatus,
    error?: string,
  ): void {
    this.emit("status", { uri, status, error });
  }
}

// Singleton
export const sshConnections = new SshConnectionManager();
