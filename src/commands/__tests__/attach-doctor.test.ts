import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { scanPathForClaude, attachDoctorCommand } from '../attach-doctor.js';

describe('attach-doctor', () => {
  it('scanPathForClaude finds executables in PATH order and skips non-executable dirs', async () => {
    const a = await mkdtemp(join(tmpdir(), 'ad-a-'));
    const b = await mkdtemp(join(tmpdir(), 'ad-b-'));
    const c = await mkdtemp(join(tmpdir(), 'ad-c-')); // no claude here
    await writeFile(join(a, 'claude'), '#!/bin/sh\n');
    await chmod(join(a, 'claude'), 0o755);
    await writeFile(join(b, 'claude'), '#!/bin/sh\n');
    await chmod(join(b, 'claude'), 0o755);
    const hits = scanPathForClaude([c, a, b].join(delimiter));
    expect(hits).toEqual([join(a, 'claude'), join(b, 'claude')]);
  });

  it('scanPathForClaude returns [] for an empty PATH (undefined falls back to process.env.PATH by design)', () => {
    expect(scanPathForClaude('')).toEqual([]);
  });

  it('registers as `attach-doctor` with an optional short-id argument', () => {
    expect(attachDoctorCommand.name()).toBe('attach-doctor');
    expect(attachDoctorCommand.registeredArguments.map((a) => a.name())).toEqual(['short']);
    expect(attachDoctorCommand.registeredArguments[0]?.required).toBe(false);
  });
});
