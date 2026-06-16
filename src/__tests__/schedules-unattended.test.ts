import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canFire,
  assertUnattendedTerminalSupported,
  isKillSwitchEngaged,
  UnattendedRefusalError,
} from '../schedules/unattended.js';
import { sampleJob } from './schedules-helpers.js';

const at = (iso: string) => ({ now: () => new Date(iso) });

describe('unattended gating', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'syntaur-unatt-'));
    process.env.SYNTAUR_SCHEDULES_DIR = dir;
  });
  afterEach(async () => {
    delete process.env.SYNTAUR_SCHEDULES_DIR;
    delete process.env.SYNTAUR_SCHEDULES_DISABLED;
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses an unattended Warp schedule', () => {
    expect(() => assertUnattendedTerminalSupported('warp')).toThrow(UnattendedRefusalError);
    expect(() => assertUnattendedTerminalSupported('terminal-app')).not.toThrow();
    expect(() => assertUnattendedTerminalSupported(null)).not.toThrow();
  });

  it('allows a fresh unattended job', () => {
    expect(canFire(sampleJob(), { ...at('2026-06-15T03:00:00Z'), killSwitch: () => false }).allowed).toBe(true);
  });

  it('blocks while inside the cooldown window', () => {
    const job = sampleJob({
      limits: { ...sampleJob().limits, cooldownMs: 600_000 },
      attempt: { ...sampleJob().attempt, lastFiredAt: '2026-06-15T03:00:00Z' },
    });
    const d = canFire(job, { ...at('2026-06-15T03:05:00Z'), killSwitch: () => false });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('cooldown');
  });

  it('blocks once the per-day launch cap is hit', () => {
    const job = sampleJob({
      limits: { ...sampleJob().limits, maxLaunchesPerDay: 2, cooldownMs: null },
      attempt: { ...sampleJob().attempt, launchDayStamps: ['2026-06-15', '2026-06-15'] },
    });
    const d = canFire(job, { ...at('2026-06-15T20:00:00Z'), killSwitch: () => false });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('max-launches-per-day');
  });

  it('the kill switch halts all firing', () => {
    const d = canFire(sampleJob(), { ...at('2026-06-15T03:00:00Z'), killSwitch: () => true });
    expect(d).toEqual({ allowed: false, reason: 'kill-switch-engaged' });
  });

  it('an interactive job is not gated by unattended limits', () => {
    const job = sampleJob({
      unattended: false,
      limits: { ...sampleJob().limits, maxLaunchesPerDay: 0 },
    });
    expect(canFire(job, { ...at('2026-06-15T03:00:00Z'), killSwitch: () => false }).allowed).toBe(true);
  });

  it('detects the KILL file and the env switch', async () => {
    expect(isKillSwitchEngaged()).toBe(false);
    process.env.SYNTAUR_SCHEDULES_DISABLED = '1';
    expect(isKillSwitchEngaged()).toBe(true);
    delete process.env.SYNTAUR_SCHEDULES_DISABLED;
    await writeFile(join(dir, 'KILL'), '', 'utf-8');
    expect(isKillSwitchEngaged()).toBe(true);
  });
});
