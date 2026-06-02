import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { buildCreateViewPayload, DEFAULT_CREATE_VIEW_STATE } from '../utils/saved-view-builder.js';
import type { SavedView, SavedViewsFile } from '../utils/saved-views-schema.js';

const CLI_ENTRY = resolve(__dirname, '..', '..', 'bin', 'syntaur.js');

interface RunResult { code: number; stdout: string; stderr: string }

async function runCli(args: string[], syntaurHome: string): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      env: { ...process.env, SYNTAUR_HOME: syntaurHome },
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

describe('syntaur views', () => {
  let syntaurHome: string;

  beforeEach(async () => {
    syntaurHome = await mkdtemp(join(tmpdir(), 'syntaur-views-'));
  });

  afterEach(async () => {
    await rm(syntaurHome, { recursive: true, force: true });
  });

  async function readStore(): Promise<SavedViewsFile> {
    const raw = await readFile(resolve(syntaurHome, 'saved-views.json'), 'utf-8');
    return JSON.parse(raw) as SavedViewsFile;
  }

  async function addView(args: string[]): Promise<SavedView> {
    const r = await runCli(['views', 'add', ...args, '--json'], syntaurHome);
    expect(r.code, r.stderr).toBe(0);
    return JSON.parse(r.stdout) as SavedView;
  }

  it('creates a view whose default config is byte-identical to the dashboard builder', async () => {
    const view = await addView(['--name', 'Default']);
    // The canonical UI default (kanban, empty filters, updated/desc, empty visibility).
    expect(view.config).toEqual(buildCreateViewPayload(DEFAULT_CREATE_VIEW_STATE, null).config);
    expect(view.config.viewMode).toBe('kanban');
    expect(view.workspace).toBeNull();

    const store = await readStore();
    expect(store.views.find((v) => v.id === view.id)?.config).toEqual(view.config);
  });

  it('minimizes filters: dedupes and drops "all"/empties', async () => {
    const view = await addView(['--name', 'Filtered', '--status', 'open,open,all,', '--priority', 'high']);
    expect(view.config.filters.status).toEqual(['open']);
    expect(view.config.filters.priority).toEqual(['high']);
  });

  it('scopes to a workspace with --workspace', async () => {
    const view = await addView(['--name', 'WS', '--workspace', 'acme']);
    expect(view.workspace).toBe('acme');
  });

  it('rejects --workspace together with --global', async () => {
    const r = await runCli(['views', 'add', '--name', 'X', '--workspace', 'a', '--global'], syntaurHome);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('mutually exclusive');
  });

  it('show returns the created view; list includes it', async () => {
    const view = await addView(['--name', 'Findme']);
    const shown = await runCli(['views', 'show', view.id, '--json'], syntaurHome);
    expect(shown.code, shown.stderr).toBe(0);
    expect((JSON.parse(shown.stdout) as SavedView).id).toBe(view.id);

    const listed = await runCli(['views', 'list', '--json'], syntaurHome);
    expect(listed.code).toBe(0);
    const views = JSON.parse(listed.stdout) as SavedView[];
    expect(views.some((v) => v.id === view.id)).toBe(true);
  });

  it('update merges onto existing config, preserving unspecified fields', async () => {
    const view = await addView(['--name', 'Merge', '--view-mode', 'table', '--status', 'open', '--priority', 'high']);
    const r = await runCli(['views', 'update', view.id, '--priority', 'low', '--json'], syntaurHome);
    expect(r.code, r.stderr).toBe(0);
    const updated = JSON.parse(r.stdout) as SavedView;
    expect(updated.config.viewMode).toBe('table'); // preserved
    expect(updated.config.filters.status).toEqual(['open']); // preserved
    expect(updated.config.filters.priority).toEqual(['low']); // changed
  });

  it('update clears a filter when passed "all"', async () => {
    const view = await addView(['--name', 'Clear', '--status', 'open', '--priority', 'high']);
    const r = await runCli(['views', 'update', view.id, '--status', 'all', '--json'], syntaurHome);
    expect(r.code, r.stderr).toBe(0);
    const updated = JSON.parse(r.stdout) as SavedView;
    expect(updated.config.filters.status).toBeUndefined();
    expect(updated.config.filters.priority).toEqual(['high']); // untouched
  });

  it('update --clear-date-range removes a previously-set date range', async () => {
    const view = await addView(['--name', 'Dates', '--date-range-field', 'created', '--date-range-preset', 'last_7d']);
    expect(view.config.filters.dateRange).toEqual({ field: 'created', preset: 'last_7d' });
    const r = await runCli(['views', 'update', view.id, '--clear-date-range', '--json'], syntaurHome);
    expect(r.code, r.stderr).toBe(0);
    expect((JSON.parse(r.stdout) as SavedView).config.filters.dateRange).toBeUndefined();
  });

  it('update with no flags exits 1 (at-least-one rule)', async () => {
    const view = await addView(['--name', 'Empty']);
    const r = await runCli(['views', 'update', view.id], syntaurHome);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('at least one');
  });

  it('delete removes the view; subsequent show exits 1', async () => {
    const view = await addView(['--name', 'Doomed']);
    const del = await runCli(['views', 'delete', view.id], syntaurHome);
    expect(del.code, del.stderr).toBe(0);
    const shown = await runCli(['views', 'show', view.id], syntaurHome);
    expect(shown.code).toBe(1);
    expect(shown.stderr).toContain('view-not-found');
  });

  it('rejects an invalid --view-mode with the valid set listed', async () => {
    const r = await runCli(['views', 'add', '--name', 'Bad', '--view-mode', 'bogus'], syntaurHome);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('kanban, list, table');
  });

  it('enforces name length <= 200 (API parity)', async () => {
    const r = await runCli(['views', 'add', '--name', 'x'.repeat(201)], syntaurHome);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('200');
  });
});
