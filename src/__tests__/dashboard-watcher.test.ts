import { describe, it, expect } from 'vitest';
import { win32, posix } from 'node:path';
import { createWatcher, ignoreDotSegmentsBelow } from '../dashboard/watcher.js';

// Deterministic regression guard for the dead-watcher bug. chokidar 4 calls
// `ignored(absolutePath)` for every path it encounters; the old
// `/(^|[\/\\])\../` regex returned `true` (ignore) for records like
// `/x/.syntaur/projects/proj/ticket.md` because it matched the `.syntaur`
// ANCESTOR — so the whole tree was suppressed and 0 events fired. These tests
// assert the new matcher returns the correct boolean for exactly the kinds of
// absolute paths chokidar passes, which is precisely what un-breaks delivery.
//
// (The end-to-end "events actually fire under the running dashboard" behavior is
// verified manually against a live `syntaur dashboard` and captured as a proof
// artifact on the ticket — a real-chokidar test is too timing-flaky to live
// in the parallel suite, where fs-event delivery stalls under heavy load.)
describe('ignoreDotSegmentsBelow', () => {
  it('keeps the root and normal nested records; ignores only dot-segments at/below the root', () => {
    // Root is itself nested under a `.syntaur` ANCESTOR — the exact layout that
    // broke the old regex (matched the ancestor → ignored everything below).
    const ignore = ignoreDotSegmentsBelow('/tmp/.syntaur/projects');

    expect(ignore('/tmp/.syntaur/projects')).toBe(false); // the watched root itself
    expect(ignore('/tmp/.syntaur/other')).toBe(false); // a sibling/ancestor path, outside root
    expect(ignore('/tmp/.syntaur/projects/proj/tickets/x/ticket.md')).toBe(false); // real record
    expect(ignore('/tmp/.syntaur/projects/proj/.git/config')).toBe(true); // hidden dir below root
    expect(ignore('/tmp/.syntaur/projects/proj/.hidden/x')).toBe(true);
    expect(ignore('/tmp/.syntaur/projects/.hidden')).toBe(true); // hidden file directly in root
    // Regression for the `rel.startsWith('..')` hole: an in-root file literally
    // named `..foo` is dot-prefixed and must still be ignored.
    expect(ignore('/tmp/.syntaur/projects/..foo')).toBe(true);
  });

  it('handles the session-db root whose own basename is `.syntaur`', () => {
    // dbDir = dirname(~/.syntaur/syntaur.db) === ~/.syntaur — the root basename
    // is `.syntaur`, which must NOT be treated as an ignorable dot-segment.
    const ignore = ignoreDotSegmentsBelow('/tmp/.syntaur');

    expect(ignore('/tmp/.syntaur')).toBe(false); // root itself
    expect(ignore('/tmp/.syntaur/syntaur.db')).toBe(false);
    expect(ignore('/tmp/.syntaur/syntaur.db-wal')).toBe(false);
    expect(ignore('/tmp/.syntaur/syntaur.db-shm')).toBe(false);
    expect(ignore('/tmp/.syntaur/.hidden')).toBe(true); // genuine hidden file in root
  });

  // Deterministic cross-platform coverage by injecting path.win32 / path.posix,
  // so the backslash-split and the `isAbsolute(rel)` cross-drive guard are real
  // regression guards even on a posix CI host (where they'd otherwise be dead).
  it('handles Windows separators and cross-drive paths via the injected path API', () => {
    const winIgnore = ignoreDotSegmentsBelow('C:\\Users\\me\\.syntaur\\projects', win32);
    expect(winIgnore('C:\\Users\\me\\.syntaur\\projects')).toBe(false); // root itself
    expect(winIgnore('C:\\Users\\me\\.syntaur\\projects\\proj\\ticket.md')).toBe(false); // real record
    expect(winIgnore('C:\\Users\\me\\.syntaur\\projects\\proj\\.git\\config')).toBe(true); // hidden below root
    // Different drive → win32.relative yields an absolute path → isAbsolute guard keeps it.
    expect(winIgnore('D:\\other\\.hidden')).toBe(false);

    const posixIgnore = ignoreDotSegmentsBelow('/home/me/.syntaur/projects', posix);
    expect(posixIgnore('/home/me/.syntaur/projects/proj/ticket.md')).toBe(false);
    expect(posixIgnore('/home/me/.syntaur/projects/proj/.hidden/x')).toBe(true);
  });
});

// ── derived-status v3: recompute hooks ──────────────────────────────────────

describe('watcher ticket hooks', () => {
  it('fires onTicketChanged when a project ticket file changes', async () => {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'syntaur-watch-derive-'));
    const projectsDir = join(root, 'projects');
    await mkdir(join(projectsDir, 'p1', 'tickets', 'TP-1-a1'), { recursive: true });

    const ticketEvents: Array<[string | null, string]> = [];

    const watcher = createWatcher({
      projectsDir,
      onMessage: () => {},
      onTicketChanged: (p, a) => ticketEvents.push([p, a]),
      debounceMs: 50,
    });

    // let chokidar settle before generating events
    await new Promise((r) => setTimeout(r, 300));
    await writeFile(
      join(projectsDir, 'p1', 'tickets', 'TP-1-a1', 'ticket.md'),
      '---\nid: TP-1\nslug: a1\nstatus: backlog\n---\n',
    );
    await new Promise((r) => setTimeout(r, 1200));

    await watcher.close();

    expect(ticketEvents).toContainEqual(['p1', 'TP-1']);
  });
});


// ── SV-12: config / view-prefs / agents / templates notifications ───────────

describe('watcher config, agents and templates notifications', () => {
  it('emits scoped config-updated, agents-updated and templates-updated frames', async () => {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'syntaur-watch-config-'));
    const projectsDir = join(root, 'projects');
    const agents = join(root, 'agents');
    const templates = join(root, 'templates');
    await mkdir(projectsDir, { recursive: true });
    await mkdir(agents, { recursive: true });
    await mkdir(join(templates, 'custom'), { recursive: true });

    const messages: Array<{ type: string; payload?: unknown }> = [];
    const watcher = createWatcher({
      projectsDir,
      configPath: join(root, 'config.md'),
      viewPrefsPath: join(root, 'view-prefs.json'),
      agentsDir: agents,
      templatesDir: templates,
      onMessage: (m) => messages.push({ type: m.type, payload: m.payload }),
      debounceMs: 50,
    });

    await new Promise((r) => setTimeout(r, 300));
    await writeFile(join(root, 'config.md'), '---\nversion: "2.0"\n---\n');
    await writeFile(join(root, 'view-prefs.json'), '{}\n');
    // Unrelated root file: must not produce a config frame.
    await writeFile(join(root, 'notes.txt'), 'x');
    await writeFile(join(agents, 'reviewer.md'), '---\nid: reviewer\n---\n');
    await writeFile(join(templates, 'custom', 'template.md'), '---\nid: custom\n---\n');
    await new Promise((r) => setTimeout(r, 1200));
    await watcher.close();

    // Debouncing may still split one file's add/change pair into two frames
    // under heavy fs-event latency, so assert the scoped kinds, not counts.
    const configKinds = [
      ...new Set(
        messages
          .filter((m) => m.type === 'config-updated')
          .map((m) => (m.payload as { kind: string }).kind),
      ),
    ].sort();
    expect(configKinds).toEqual(['config', 'view-prefs']);
    expect(messages.some((m) => m.type === 'agents-updated')).toBe(true);
    expect(messages.some((m) => m.type === 'templates-updated')).toBe(true);
    expect(messages.some((m) => m.type === 'ticket-updated' || m.type === 'project-updated')).toBe(false);
  });

  it('tolerates watched roots that do not exist yet', async () => {
    const { mkdtemp, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'syntaur-watch-missing-'));
    await mkdir(join(root, 'projects'), { recursive: true });
    const watcher = createWatcher({
      projectsDir: join(root, 'projects'),
      agentsDir: join(root, 'agents'),
      templatesDir: join(root, 'templates'),
      onMessage: () => {},
      debounceMs: 50,
    });
    await new Promise((r) => setTimeout(r, 100));
    await watcher.close();
  });

  it('builds config-updated frames that carry only the kind', async () => {
    const { configUpdatedMessage } = await import('../dashboard/watcher.js');
    const message = configUpdatedMessage('view-prefs');
    expect(message.type).toBe('config-updated');
    expect(message.payload).toEqual({ kind: 'view-prefs' });
  });
});
