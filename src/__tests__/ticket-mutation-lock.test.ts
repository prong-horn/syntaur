import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, readFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  acquireTicketMutationLock,
  withTicketMutationLock,
  _internal,
} from '../utils/ticket-mutation-lock.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'sv11-lock-'));
  process.env.SYNTAUR_HOME = home;
});

afterEach(async () => {
  delete process.env.SYNTAUR_HOME;
  await rm(home, { recursive: true, force: true });
});

describe('ticket mutation lock', () => {
  it('acquires and releases exclusively with token ownership', async () => {
    const ticketPath = join(home, 'ticket.md');
    await writeFile(ticketPath, 'ticket', 'utf-8');
    const handle = await acquireTicketMutationLock(ticketPath, home);
    const lockPath = _internal.lockPathForTicket(ticketPath, home);
    const raw = await readFile(lockPath, 'utf-8');
    expect(_internal.parseLock(raw)?.pid).toBe(process.pid);
    await handle.release();
    await expect(readFile(lockPath, 'utf-8')).rejects.toThrow();
  });

  it('withTicketMutationLock runs fn inside lock', async () => {
    const ticketPath = join(home, 'projects', 't', 'ticket.md');
    await mkdir(join(home, 'projects', 't'), { recursive: true });
    await writeFile(ticketPath, 'x', 'utf-8');
    const out = await withTicketMutationLock(ticketPath, async () => 'ok', home);
    expect(out).toBe('ok');
  });

  it('canonicalizes relative and symlinked ticket paths to one lock', async () => {
    const realDir = join(home, 'projects', 'p', 'tickets', 't1');
    const linkDir = join(home, 'alias');
    await mkdir(realDir, { recursive: true });
    await writeFile(join(realDir, 'ticket.md'), 'x', 'utf-8');
    await symlink(realDir, linkDir);

    const absPath = join(realDir, 'ticket.md');
    const linkPath = join(linkDir, 'ticket.md');
    const lockPath = _internal.lockPathForTicket(absPath, home);
    expect(_internal.lockPathForTicket(linkPath, home)).toBe(lockPath);

    const h1 = await acquireTicketMutationLock(absPath, home);
    await expect(acquireTicketMutationLock(linkPath, home)).rejects.toThrow(/Timed out/);
    await h1.release();
    const h2 = await acquireTicketMutationLock(linkPath, home);
    await h2.release();
  });

  it('does not treat malformed lock files as dead ownership', async () => {
    const ticketPath = join(home, 'ticket.md');
    await writeFile(ticketPath, 'ticket', 'utf-8');
    const lockPath = _internal.lockPathForTicket(ticketPath, home);
    await mkdir(resolve(lockPath, '..'), { recursive: true });
    await writeFile(lockPath, 'garbage\n', 'utf-8');

    const started = Date.now();
    await expect(acquireTicketMutationLock(ticketPath, home)).rejects.toThrow(/Timed out/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4000);
    expect(await readFile(lockPath, 'utf-8')).toBe('garbage\n');
  });

  it('does not evict live owners without proof of death', async () => {
    const ticketPath = join(home, 'ticket.md');
    await writeFile(ticketPath, 'ticket', 'utf-8');
    const handle = await acquireTicketMutationLock(ticketPath, home);
    const lockPath = _internal.lockPathForTicket(ticketPath, home);
    const raw = await readFile(lockPath, 'utf-8');
    expect(_internal.isLockDefinitelyStale(_internal.parseLock(raw)!)).toBe(false);
    await expect(acquireTicketMutationLock(ticketPath, home)).rejects.toThrow(/Timed out/);
    await handle.release();
  });

  it('recovers provably dead locks and acquires', async () => {
    const ticketPath = join(home, 'ticket.md');
    await writeFile(ticketPath, 'ticket', 'utf-8');
    const lockPath = _internal.lockPathForTicket(ticketPath, home);
    await mkdir(resolve(lockPath, '..'), { recursive: true });
    await writeFile(lockPath, `999999\nMon Jan  1 00:00:00 2024\ndead-token\n`, 'utf-8');
    const handle = await acquireTicketMutationLock(ticketPath, home);
    const raw = await readFile(lockPath, 'utf-8');
    expect(_internal.parseLock(raw)?.pid).toBe(process.pid);
    await handle.release();
  });

  it('parallel acquirers contend for one lock', async () => {
    const ticketPath = join(home, 'ticket.md');
    await writeFile(ticketPath, 'ticket', 'utf-8');
    const holder = await acquireTicketMutationLock(ticketPath, home);
    const contender = acquireTicketMutationLock(ticketPath, home);
    await expect(contender).rejects.toThrow(/Timed out/);
    await holder.release();
    const next = await acquireTicketMutationLock(ticketPath, home);
    await next.release();
  });
});
