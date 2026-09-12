import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  allocateTicketId,
  derivePrefix,
  isTicketId,
  parseTicketId,
  readProjectTicketCounter,
} from '../utils/ticket-ids.js';
import { renderProject } from '../templates/project.js';
import { writeFileForce } from '../utils/fs.js';

const TIMESTAMP = '2026-01-01T00:00:00Z';

describe('derivePrefix', () => {
  const cases: Array<{ slug: string; expected: string }> = [
    { slug: 'fitsync', expected: 'FIT' },
    { slug: 'scratch', expected: 'SCR' },
    { slug: 'ai-tax-firm-outreach', expected: 'ATFO' },
    { slug: 'syntaur-meta', expected: 'SM' },
  ];

  for (const { slug, expected } of cases) {
    it(`derives ${expected} from ${slug}`, () => {
      expect(derivePrefix(slug)).toBe(expected);
    });
  }

  it('appends the next unused letter on collision', () => {
    expect(derivePrefix('fitsync', ['FIT'])).toBe('FITS');
  });
});

describe('ticket id helpers', () => {
  it('validates and parses ticket ids', () => {
    expect(isTicketId('SCR-1')).toBe(true);
    expect(isTicketId('ATFO-142')).toBe(true);
    expect(isTicketId('uuid')).toBe(false);
    expect(parseTicketId('FIT-7')).toEqual({ prefix: 'FIT', number: 7 });
    expect(parseTicketId('bad')).toBeNull();
  });
});

describe('allocateTicketId', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'ticket-ids-test-'));
    const projectMd = renderProject({
      id: 'proj-1',
      slug: 'demo',
      title: 'Demo',
      timestamp: TIMESTAMP,
      prefix: 'DEM',
      nextTicket: 1,
      defaultTemplate: 'feature',
    });
    await writeFileForce(join(testDir, 'project.md'), projectMd);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('allocates sequential ids and bumps nextTicket', async () => {
    const first = await allocateTicketId(testDir);
    const second = await allocateTicketId(testDir);
    expect(first).toBe('DEM-1');
    expect(second).toBe('DEM-2');
    const counter = await readProjectTicketCounter(testDir);
    expect(counter.nextTicket).toBe(3);
  });

  it('allocates unique ids under parallel contention', async () => {
    const ids = await Promise.all(
      Array.from({ length: 12 }, () => allocateTicketId(testDir)),
    );
    expect(new Set(ids).size).toBe(12);
    const sorted = [...ids].sort(
      (a, b) => (parseTicketId(a)?.number ?? 0) - (parseTicketId(b)?.number ?? 0),
    );
    expect(sorted).toEqual(
      Array.from({ length: 12 }, (_, i) => `DEM-${i + 1}`),
    );
    const counter = await readProjectTicketCounter(testDir);
    expect(counter.nextTicket).toBe(13);
    const lockExists = await readFile(join(testDir, '.ticket-lock'), 'utf-8').catch(
      () => null,
    );
    expect(lockExists).toBeNull();
  });
});
