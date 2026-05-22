import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runCcusage,
  isoToCcusageDate,
  _resetEnoentWarnedForTests,
} from '../usage/ccusage-collector.js';
import { parseCcusageSession, extractSessionId } from '../usage/ccusage-parse.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, 'fixtures/ccusage-session.json');

let sandbox: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-ccusage-'));
  _resetEnoentWarnedForTests();
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

async function writeStubBinary(content: string): Promise<string> {
  const path = resolve(sandbox, 'ccusage');
  await writeFile(path, content);
  await chmod(path, 0o755);
  return path;
}

// --- parser (against the real fixture) -------------------------------------

describe('parseCcusageSession (against real ccusage 20.0.1 fixture)', () => {
  it('parses claude, codex, and opencode rows', async () => {
    const raw = JSON.parse(await readFile(fixturePath, 'utf-8'));
    const { rows, highWaterMark, warnings } = parseCcusageSession(raw);

    expect(warnings).toEqual([]);
    expect(rows.length).toBeGreaterThanOrEqual(4);

    const claude = rows.find((r) => r.tool === 'claude');
    const codex = rows.find((r) => r.tool === 'codex');
    const opencode = rows.find((r) => r.tool === 'opencode');
    expect(claude).toBeDefined();
    expect(codex).toBeDefined();
    expect(opencode).toBeDefined();

    // claude: period is a UUID; lastActivity is date-only YYYY-MM-DD.
    expect(claude!.sessionId).toMatch(/^[0-9a-f-]+$/);
    expect(claude!.eventTs).toMatch(/T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // codex: sessionId is extracted from the trailing UUID in period.
    expect(codex!.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    // opencode: lastActivity is undefined → eventTs falls back to nowIso() - 1min.
    expect(opencode!.eventTs).toMatch(/T/);

    expect(highWaterMark).not.toBeNull();
    // Multi-model session contributes multiple rows under the same sessionId.
  });

  it('handles invalid payloads without throwing', () => {
    const a = parseCcusageSession(null);
    expect(a.rows).toEqual([]);
    expect(a.warnings.length).toBeGreaterThan(0);

    const b = parseCcusageSession({ session: 'not-an-array' });
    expect(b.rows).toEqual([]);
    expect(b.warnings.length).toBeGreaterThan(0);

    const c = parseCcusageSession({ session: [{}] });
    expect(c.rows).toEqual([]);
    expect(c.warnings.length).toBeGreaterThan(0);
  });

  it('idempotent: parsing the same input twice yields identical rows', async () => {
    const raw = JSON.parse(await readFile(fixturePath, 'utf-8'));
    const a = parseCcusageSession(raw, () => '2026-05-21T15:00:00.000Z');
    const b = parseCcusageSession(raw, () => '2026-05-21T15:00:00.000Z');
    expect(a.rows).toEqual(b.rows);
    expect(a.highWaterMark).toEqual(b.highWaterMark);
  });
});

describe('extractSessionId', () => {
  it('extracts UUID from a codex period path', () => {
    expect(
      extractSessionId(
        'codex',
        '2026/03/13/rollout-2026-03-13T05-48-02-019ce706-657d-7b70-ae09-9f33e32745ee',
      ),
    ).toBe('019ce706-657d-7b70-ae09-9f33e32745ee');
  });

  it('returns period unchanged for non-codex tools', () => {
    expect(extractSessionId('claude', 'abc-123')).toBe('abc-123');
    expect(extractSessionId('opencode', 'ses_xyz')).toBe('ses_xyz');
  });
});

describe('isoToCcusageDate', () => {
  it('strips time and hyphens', () => {
    expect(isoToCcusageDate('2026-05-21T15:00:00.000Z')).toBe('20260521');
  });
});

// --- collector spawn behavior ---------------------------------------------

describe('runCcusage spawn behavior', () => {
  it('returns null and logs install hint on ENOENT', async () => {
    const logs: string[] = [];
    const result = await runCcusage({
      binary: '/nonexistent/ccusage-binary-asdfqwer',
      env: { ...process.env, PATH: '' },
      logger: (m) => logs.push(m),
    });
    expect(result).toBeNull();
    expect(logs.some((l) => l.includes('ccusage not on PATH'))).toBe(true);
  });

  it('returns null on non-zero exit', async () => {
    const stub = await writeStubBinary('#!/usr/bin/env bash\nexit 7\n');
    const logs: string[] = [];
    const result = await runCcusage({
      binary: stub,
      logger: (m) => logs.push(m),
    });
    expect(result).toBeNull();
    expect(logs.some((l) => l.includes('ccusage session exited 7'))).toBe(true);
  });

  it('parses a real fixture when the stub prints it', async () => {
    const fixture = await readFile(fixturePath, 'utf-8');
    const fixtureFile = resolve(sandbox, 'fixture.json');
    await writeFile(fixtureFile, fixture);
    // Stub prints the fixture for the session command; reports a version for --version.
    const stubBody = `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "ccusage 20.0.1"
  exit 0
fi
cat ${fixtureFile}
exit 0
`;
    const stub = await writeStubBinary(stubBody);
    const logs: string[] = [];
    const result = await runCcusage({
      binary: stub,
      logger: (m) => logs.push(m),
    });
    expect(result).not.toBeNull();
    expect(result!.ccusageVersion).toBe('ccusage 20.0.1');
    expect(result!.rows.length).toBeGreaterThan(0);
    expect(result!.highWaterMark).not.toBeNull();
  });
});
