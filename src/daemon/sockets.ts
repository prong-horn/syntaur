// Shared AF_UNIX bind helper used by control.sock AND every pty/rv sock.
//
// Two-layer defense against stale sockets and bind races:
//   (a) pre-bind — if the path exists, connect-probe it. ECONNREFUSED (or the
//       path having vanished) means a dead owner ⇒ unlink and bind. A
//       successful connect means a LIVE owner ⇒ SyntaurError; never steal it.
//   (b) listen() EADDRINUSE race — the pre-bind probe can lose to a concurrent
//       binder, so on EADDRINUSE probe once more: ECONNREFUSED ⇒ unlink and
//       retry the bind exactly once; a live connect ⇒ fail as a live owner.
//
// Repo precedent for explicit EADDRINUSE handling: src/dashboard/server.ts.

import { connect, createServer, type Server, type Socket } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { SyntaurError } from '../errors.js';

export type ProbeResult = 'live' | 'refused' | 'error';

/**
 * Connect-probe a unix socket path. 'live' = something is accepting; 'refused'
 * = ECONNREFUSED/ENOENT (stale or gone); 'error' = any other failure.
 */
export function probeUnixSocket(path: string, timeoutMs = 250): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolvePromise) => {
    let settled = false;
    const sock = connect(path);
    const done = (r: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolvePromise(r);
    };
    // A socket that connects but never responds is treated as a live owner.
    const timer = setTimeout(() => done('live'), timeoutMs);
    sock.once('connect', () => done('live'));
    sock.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') done('refused');
      else done('error');
    });
  });
}

export interface BindDeps {
  createServer?: (onConnection: (socket: Socket) => void) => Server;
  probe?: (path: string) => Promise<ProbeResult>;
  pathExists?: (path: string) => boolean;
  unlink?: (path: string) => void;
}

function resolveDeps(deps: BindDeps): Required<BindDeps> {
  return {
    createServer: deps.createServer ?? ((onConn) => createServer(onConn)),
    probe: deps.probe ?? ((p) => probeUnixSocket(p)),
    pathExists: deps.pathExists ?? ((p) => existsSync(p)),
    unlink: deps.unlink ?? ((p) => unlinkSync(p)),
  };
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolvePromise();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(path);
  });
}

function liveOwnerError(path: string): SyntaurError {
  return new SyntaurError(`A live process already owns the socket ${path}.`, {
    remediation:
      'Another daemon/pty-host is running. Use `syntaur daemon status`, or stop it before rebinding.',
  });
}

/**
 * Bind `path` as a unix-socket server, defeating stale sockets while never
 * stealing a live one. Resolves the listening `Server`.
 */
export async function bindUnixSocket(
  path: string,
  onConnection: (socket: Socket) => void,
  deps: BindDeps = {},
): Promise<Server> {
  const d = resolveDeps(deps);

  // (a) pre-bind probe. Only a definitive ECONNREFUSED/ENOENT ('refused') is
  // treated as stale; an indeterminate 'error' fails closed (never steal a path
  // we could not prove dead).
  if (d.pathExists(path)) {
    const r = await d.probe(path);
    if (r !== 'refused') throw liveOwnerError(path);
    d.unlink(path); // stale
  }

  const server = d.createServer(onConnection);
  try {
    await listen(server, path);
    return server;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;

    // (b) EADDRINUSE race — probe once more, then retry the bind exactly once.
    // Same fail-closed rule: unlink only on a definitive 'refused'.
    const r = await d.probe(path);
    if (r !== 'refused') throw liveOwnerError(path);
    d.unlink(path);
    const retry = d.createServer(onConnection);
    await listen(retry, path);
    return retry;
  }
}
