import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { Client, type ConnectConfig } from 'ssh2';
import type { ConnectionConfig } from '../shared/types.ts';
import { HttpError } from './util.ts';

export interface Tunnel {
  /** Local endpoint the database driver connects to instead of the remote host. */
  host: string;
  port: number;
  close(): void;
}

/**
 * Opens an SSH connection and a local TCP listener on 127.0.0.1 that forwards every
 * accepted socket to `cfg.host:cfg.port` as seen from the SSH server.
 */
export async function openTunnel(cfg: ConnectionConfig, remotePort: number): Promise<Tunnel> {
  if (!cfg.sshHost || !cfg.sshUser) throw new HttpError(400, 'SSH host and user are required');
  const ssh = new Client();
  const auth: ConnectConfig = {
    host: cfg.sshHost,
    port: cfg.sshPort || 22,
    username: cfg.sshUser,
    readyTimeout: 15_000,
    keepaliveInterval: 20_000,
  };
  if (cfg.sshKeyFile) {
    // "~/.ssh/id_ed25519" (as the form suggests) means the user's home folder on every platform.
    const keyPath = cfg.sshKeyFile.replace(/^~(?=$|[\\/])/, os.homedir());
    try {
      auth.privateKey = fs.readFileSync(keyPath);
    } catch {
      throw new HttpError(400, `Cannot read SSH key file: ${cfg.sshKeyFile}`);
    }
    if (cfg.sshPassphrase) auth.passphrase = cfg.sshPassphrase;
  } else if (cfg.sshPassword) {
    auth.password = cfg.sshPassword;
  } else {
    throw new HttpError(400, 'SSH needs a password or a private key file');
  }

  await new Promise<void>((resolve, reject) => {
    ssh.once('ready', () => resolve());
    ssh.once('error', (e) => reject(new HttpError(400, `SSH: ${e.message}`)));
    ssh.connect(auth);
  });

  const remoteHost = cfg.host || '127.0.0.1';
  const server = net.createServer((socket) => {
    ssh.forwardOut(socket.remoteAddress ?? '127.0.0.1', socket.remotePort ?? 0, remoteHost, remotePort, (err, stream) => {
      if (err) {
        socket.destroy();
        return;
      }
      socket.pipe(stream).pipe(socket);
      socket.on('error', () => stream.destroy());
      stream.on('error', () => socket.destroy());
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Loopback only: the forwarded port must never be reachable from the network.
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as net.AddressInfo;

  return {
    host: '127.0.0.1',
    port,
    close() {
      server.close();
      ssh.end();
    },
  };
}
