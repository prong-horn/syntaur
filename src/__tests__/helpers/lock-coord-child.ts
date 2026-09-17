import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  acquireOwnerRecord,
  recoverStaleOwnerRecord,
  serializeOwnerRecord,
} from '../../utils/process-owner.js';

function brokerOwnerPath(root: string): string {
  return join(root, 'runtime', 'broker-owner');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForFile(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${path}`);
}

export async function runLockCoordChild(op: string): Promise<void> {
  const home = process.env.LOCK_COORD_HOME ?? process.env.SYNTAUR_HOME;
  const barrierDir = process.env.LOCK_BARRIER_DIR;
  const slot = process.env.LOCK_CHILD_SLOT ?? '0';
  if (!home || !barrierDir) {
    throw new Error('lock coord child requires LOCK_COORD_HOME and LOCK_BARRIER_DIR');
  }
  await mkdir(barrierDir, { recursive: true });
  const ownerPath = brokerOwnerPath(home);

  if (op === 'recover-acquire-release') {
    const recovered = await recoverStaleOwnerRecord(ownerPath, home);
    await writeFile(join(barrierDir, `recovered-${slot}`), recovered ? '1' : '0');
    await waitForFile(join(barrierDir, 'go'));
    const handle = await acquireOwnerRecord(ownerPath, Number(slot) + 10, home);
    await writeFile(join(barrierDir, `acquired-${slot}`), handle.record.ownerToken);
    await handle.release();
    await writeFile(join(barrierDir, `done-${slot}`), '1');
    return;
  }

  if (op === 'recover-then-contend') {
    await waitForFile(join(barrierDir, 'seeded'));
    const recovered = await recoverStaleOwnerRecord(ownerPath, home);
    await writeFile(join(barrierDir, `recover-${slot}`), recovered ? '1' : '0');
    await writeFile(join(barrierDir, `ready-${slot}`), '1');
    await waitForFile(join(barrierDir, 'contend'));
    try {
      const handle = await acquireOwnerRecord(ownerPath, 9000 + Number(slot), home);
      await writeFile(join(barrierDir, `winner-${slot}`), handle.record.ownerToken);
      await waitForFile(join(barrierDir, 'release'));
      await handle.release();
    } catch {
      await writeFile(join(barrierDir, `loser-${slot}`), '1');
    }
    await writeFile(join(barrierDir, `done-${slot}`), '1');
    return;
  }

  if (op === 'seed-stale') {
    await mkdir(join(home, 'runtime'), { recursive: true });
    await writeFile(
      ownerPath,
      serializeOwnerRecord({
        pid: 999_999,
        processStartedAt: 'Tue Jan  1 00:00:00 2020',
        ownerToken: 'dead-token',
        port: 1,
      }),
      'utf-8',
    );
    await writeFile(join(barrierDir, 'seeded'), '1');
    return;
  }

  throw new Error(`unknown lock coord op: ${op}`);
}
