// Roster of live pty-hosts + adoption on daemon startup.
//
// A restarting daemon adopts the previous generation's still-live hosts: an
// entry is kept when its pid is alive AND its `ps -o lstart=` start-time still
// matches the stored value (the PID-recycle guard). Dead/recycled entries are
// dropped and their orphaned pty/rv sockets unlinked. The beyond-roster
// reconcile-scan (state.json files with no roster entry) is Task 6's job.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { isSameProcess, type LivenessDeps } from './liveness.js';
import type { RosterEntry, RosterFile } from './types.js';

export interface RosterDeps extends LivenessDeps {
  readFile?: (path: string) => string | null;
  writeFile?: (path: string, data: string) => void;
  unlinkSocket?: (path: string) => void;
  pathExists?: (path: string) => boolean;
  now?: () => number;
}

function resolveDeps(deps: RosterDeps): Required<RosterDeps> {
  return {
    isPidAlive: deps.isPidAlive ?? ((pid) => isSameProcess(pid, null)),
    pidStartedAt: deps.pidStartedAt ?? (() => null),
    readFile:
      deps.readFile ??
      ((path) => {
        try {
          return readFileSync(path, 'utf8');
        } catch {
          return null;
        }
      }),
    writeFile: deps.writeFile ?? ((path, data) => writeFileSync(path, data)),
    unlinkSocket: deps.unlinkSocket ?? ((path) => unlinkSync(path)),
    pathExists: deps.pathExists ?? ((path) => existsSync(path)),
    now: deps.now ?? (() => Date.now()),
  };
}

function emptyRoster(daemonId = ''): RosterFile {
  return { daemonId, updatedAt: '', entries: [] };
}

/** Read the roster file, returning an empty roster when missing/corrupt. */
export function readRoster(rosterPath: string, deps: RosterDeps = {}): RosterFile {
  const d = resolveDeps(deps);
  const raw = d.readFile(rosterPath);
  if (raw === null) return emptyRoster();
  try {
    const parsed = JSON.parse(raw) as RosterFile;
    if (!Array.isArray(parsed?.entries)) return emptyRoster();
    return parsed;
  } catch {
    return emptyRoster();
  }
}

export function writeRoster(roster: RosterFile, rosterPath: string, deps: RosterDeps = {}): void {
  const d = resolveDeps(deps);
  d.writeFile(rosterPath, JSON.stringify(roster, null, 2));
}

/** Add or replace (by short) one roster entry; read-modify-write. */
export function upsertRosterEntry(
  entry: RosterEntry,
  daemonId: string,
  rosterPath: string,
  deps: RosterDeps = {},
): void {
  const d = resolveDeps(deps);
  const roster = readRoster(rosterPath, deps);
  const entries = roster.entries.filter((e) => e.short !== entry.short);
  entries.push(entry);
  writeRoster(
    { daemonId, updatedAt: new Date(d.now()).toISOString(), entries },
    rosterPath,
    deps,
  );
}

/** Remove one roster entry by short; read-modify-write. */
export function removeRosterEntry(
  short: string,
  daemonId: string,
  rosterPath: string,
  deps: RosterDeps = {},
): void {
  const d = resolveDeps(deps);
  const roster = readRoster(rosterPath, deps);
  const entries = roster.entries.filter((e) => e.short !== short);
  writeRoster(
    { daemonId, updatedAt: new Date(d.now()).toISOString(), entries },
    rosterPath,
    deps,
  );
}

export interface AdoptResult {
  adopted: RosterEntry[];
  dropped: RosterEntry[];
}

/**
 * Adopt still-live hosts from the roster and reap the rest. The new daemon
 * rewrites the roster under its own `daemonId`, keeping only adopted entries
 * (whose sockets still live under the previous daemonId dir — that's fine, the
 * entries carry absolute socket paths).
 */
export function adoptRoster(rosterPath: string, daemonId: string, deps: RosterDeps = {}): AdoptResult {
  const d = resolveDeps(deps);
  const roster = readRoster(rosterPath, deps);
  const adopted: RosterEntry[] = [];
  const dropped: RosterEntry[] = [];

  for (const entry of roster.entries) {
    if (isSameProcess(entry.pid, entry.pidStartedAt, d)) adopted.push(entry);
    else dropped.push(entry);
  }

  for (const entry of dropped) {
    for (const sock of [entry.ptySock, entry.rvSock]) {
      if (sock && d.pathExists(sock)) {
        try {
          d.unlinkSocket(sock);
        } catch {
          /* best-effort reap */
        }
      }
    }
  }

  writeRoster(
    { daemonId, updatedAt: new Date(d.now()).toISOString(), entries: adopted },
    rosterPath,
    deps,
  );
  return { adopted, dropped };
}
