import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonCommand } from '../daemon.js';

// Command-level test: exercises `syntaur daemon logs` end-to-end (not a
// reproduction of its body), so it fails if logsSub stops rendering via
// formatLogLine and starts dumping raw JSON at users.
describe('syntaur daemon logs (command-level render)', () => {
  let home: string;
  let origHome: string | undefined;

  beforeEach(async () => {
    origHome = process.env.SYNTAUR_HOME;
    home = await mkdtemp(join(tmpdir(), 'syntaur-daemonlogs-'));
    process.env.SYNTAUR_HOME = home;
  });
  afterEach(async () => {
    if (origHome === undefined) delete process.env.SYNTAUR_HOME;
    else process.env.SYNTAUR_HOME = origHome;
    await rm(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('renders a mixed legacy + NDJSON + malformed tail human-readably (never raw JSON)', async () => {
    const raw =
      [
        '2026-07-01T00:00:00.000Z started daemon old pid=1', // legacy plaintext
        JSON.stringify({ ts: '2026-07-02T00:00:00.000Z', level: 'info', event: 'dispatch', short: 's1', agent: 'codex' }),
        '{broken', // malformed
        JSON.stringify({ ts: '2026-07-03T00:00:00.000Z', level: 'warn', event: 'kill', short: 's1' }),
      ].join('\n') + '\n';
    await writeFile(join(home, 'daemon.log'), raw, 'utf8');

    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));

    await daemonCommand.parseAsync(['logs', '-n', '4'], { from: 'user' });

    const text = out.join('\n');
    expect(text).toContain('dispatch');
    expect(text).toContain('short=s1');
    expect(text).toContain('[warn]');
    expect(text).toContain('{broken'); // malformed passed through raw
    expect(text).toContain('started daemon old'); // legacy passed through
    // never surfaces a raw structured NDJSON record to the user
    expect(text).not.toContain('{"ts"');
  });

  it('prints the empty-log hint when there is no log', async () => {
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
    await daemonCommand.parseAsync(['logs'], { from: 'user' });
    expect(out.join('\n')).toContain('no daemon log yet');
  });
});
