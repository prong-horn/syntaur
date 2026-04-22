import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  configureStatuslineCommand,
  writeDefaultConfigIfMissing,
  PRESETS,
} from '../commands/configure-statusline.js';
import { installStatuslineCommand } from '../commands/install-statusline.js';

const here = dirname(fileURLToPath(import.meta.url));
const sourceScript = resolve(here, '../../statusline/statusline.sh');

let sandbox: string;
let installRoot: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'syntaur-configure-statusline-'));
  // Mirror the real layout: installRoot = $HOME/.syntaur so end-to-end tests
  // that spawn the bash script with HOME=sandbox find the config at the same
  // path as in production.
  installRoot = resolve(sandbox, '.syntaur');
  await mkdir(installRoot, { recursive: true });
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

async function readJson(path: string): Promise<any> {
  return JSON.parse(await readFile(path, 'utf-8'));
}

describe('configure-statusline', () => {
  it('writes a default config via writeDefaultConfigIfMissing', async () => {
    await writeDefaultConfigIfMissing(installRoot);
    const cfg = await readJson(resolve(installRoot, 'statusline.config.json'));
    expect(cfg.segments).toEqual(['git', 'assignment', 'session']);
    expect(cfg.separator).toBe(' · ');
  });

  it('does not overwrite an existing config', async () => {
    const path = resolve(installRoot, 'statusline.config.json');
    await writeFile(
      path,
      JSON.stringify({ segments: ['git'], separator: ' | ' }),
      'utf-8',
    );
    await writeDefaultConfigIfMissing(installRoot);
    const cfg = await readJson(path);
    expect(cfg.segments).toEqual(['git']);
    expect(cfg.separator).toBe(' | ');
  });

  it('applies a preset correctly', async () => {
    await configureStatuslineCommand({
      preset: 'full',
      installRoot,
      statuslineScript: 'nonexistent-skip-preview',
    });
    const cfg = await readJson(resolve(installRoot, 'statusline.config.json'));
    expect(cfg.segments).toEqual(PRESETS.full.segments);
    expect(cfg.separator).toBe(PRESETS.full.separator);
  });

  it('parses --segments with --separator', async () => {
    await configureStatuslineCommand({
      segments: 'model, ctx , git',
      separator: ' | ',
      installRoot,
      statuslineScript: 'nonexistent-skip-preview',
    });
    const cfg = await readJson(resolve(installRoot, 'statusline.config.json'));
    expect(cfg.segments).toEqual(['model', 'ctx', 'git']);
    expect(cfg.separator).toBe(' | ');
  });

  it('rejects an invalid segment name', async () => {
    await expect(
      configureStatuslineCommand({ segments: 'git,bogus', installRoot }),
    ).rejects.toThrow(/Unknown segment/i);
  });

  it('rejects an invalid preset', async () => {
    await expect(
      configureStatuslineCommand({ preset: 'banana', installRoot }),
    ).rejects.toThrow(/Unknown preset/i);
  });

  it('--preview does not write the config', async () => {
    await configureStatuslineCommand({
      preset: 'minimal',
      preview: true,
      installRoot,
      statuslineScript: 'nonexistent-skip-preview',
    });
    const path = resolve(installRoot, 'statusline.config.json');
    const exists = await readFile(path, 'utf-8').then(
      () => true,
      () => false,
    );
    expect(exists).toBe(false);
  });

  it('preserves an existing wrap path when not overridden', async () => {
    await configureStatuslineCommand({
      segments: 'wrap,git,session',
      wrap: '/tmp/whatever.sh',
      installRoot,
      statuslineScript: 'nonexistent-skip-preview',
    });
    await configureStatuslineCommand({
      preset: 'minimal',
      installRoot,
      statuslineScript: 'nonexistent-skip-preview',
    });
    const cfg = await readJson(resolve(installRoot, 'statusline.config.json'));
    expect(cfg.wrap).toBe('/tmp/whatever.sh');
  });

  it('script picks up the user-selected segment order end-to-end', async () => {
    // Write a config with model first, then git, then session.
    await writeFile(
      resolve(installRoot, 'statusline.config.json'),
      JSON.stringify(
        { segments: ['model', 'session'], separator: ' ~ ' },
        null,
        2,
      ),
      'utf-8',
    );

    const res = spawnSync('bash', [sourceScript], {
      input: JSON.stringify({
        session_id: 'aaaaaaaaaaaaaaaaaaaa1234567890ab',
        cwd: sandbox,
        model: { display_name: 'Sonnet 4.6' },
      }),
      encoding: 'utf-8',
      // Point HOME at the sandbox so ~/.syntaur/statusline.config.json resolves
      // to our freshly-written config.
      env: { ...process.env, HOME: sandbox },
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('Sonnet 4.6 ~ aaaaaaaaaaaaaaaaaaaa1234567890ab');
  });

  it('script falls back to default segments when config is missing', async () => {
    const res = spawnSync('bash', [sourceScript], {
      input: JSON.stringify({
        session_id: 'aaaaaaaaaaaaaaaaaaaa1234567890ab',
        cwd: sandbox,
      }),
      encoding: 'utf-8',
      env: { ...process.env, HOME: sandbox }, // no syntaur/ dir exists
    });
    expect(res.status).toBe(0);
    // Non-git sandbox -> only session renders with defaults.
    expect(res.stdout).toBe('aaaaaaaaaaaaaaaaaaaa1234567890ab');
  });

  it('install-statusline seeds a default config', async () => {
    const settingsPath = resolve(sandbox, 'claude', 'settings.json');
    await mkdir(dirname(settingsPath), { recursive: true });
    await installStatuslineCommand({
      mode: 'replace',
      sourceScript,
      settingsPath,
      installRoot,
    });
    const cfg = await readJson(resolve(installRoot, 'statusline.config.json'));
    expect(cfg.segments).toEqual(['git', 'assignment', 'session']);
  });

  it('external segment renders Jira/Linear ids from assignment.md', async () => {
    await writeFile(
      resolve(installRoot, 'statusline.config.json'),
      JSON.stringify({ segments: ['external', 'session'], separator: ' · ' }, null, 2),
      'utf-8',
    );

    const assignmentDir = resolve(sandbox, 'proj', 'assignments', 'demo');
    await mkdir(assignmentDir, { recursive: true });
    await writeFile(
      resolve(assignmentDir, 'assignment.md'),
      [
        '---',
        'id: demo-id',
        'slug: demo',
        'title: "X"',
        'externalIds:',
        '  - system: jira',
        '    id: PROJ-123',
        '    url: https://jira.example.com/PROJ-123',
        '  - system: linear',
        '    id: ENG-456',
        '    url: https://linear.app/example/issue/ENG-456',
        'status: in_progress',
        '---',
        '',
      ].join('\n'),
    );
    await mkdir(resolve(sandbox, '.syntaur'), { recursive: true });
    await writeFile(
      resolve(sandbox, '.syntaur', 'context.json'),
      JSON.stringify({
        projectSlug: 'p',
        assignmentSlug: 'demo',
        assignmentDir,
      }),
    );

    const res = spawnSync('bash', [sourceScript], {
      input: JSON.stringify({
        session_id: 'sessionid-xxxxxxxxxxxxxxxx12345678',
        cwd: sandbox,
      }),
      encoding: 'utf-8',
      env: { ...process.env, HOME: sandbox },
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('PROJ-123');
    expect(res.stdout).toContain('ENG-456');
    expect(res.stdout).toContain('sessionid-xxxxxxxxxxxxxxxx12345678');
  });

  it('external segment is empty when externalIds is [] or absent', async () => {
    await writeFile(
      resolve(installRoot, 'statusline.config.json'),
      JSON.stringify({ segments: ['external', 'session'], separator: ' · ' }, null, 2),
      'utf-8',
    );

    const assignmentDir = resolve(sandbox, 'proj', 'assignments', 'demo');
    await mkdir(assignmentDir, { recursive: true });
    await writeFile(
      resolve(assignmentDir, 'assignment.md'),
      '---\nid: d\nslug: demo\ntitle: "X"\nexternalIds: []\nstatus: in_progress\n---\n',
    );
    await mkdir(resolve(sandbox, '.syntaur'), { recursive: true });
    await writeFile(
      resolve(sandbox, '.syntaur', 'context.json'),
      JSON.stringify({ projectSlug: 'p', assignmentSlug: 'demo', assignmentDir }),
    );

    const res = spawnSync('bash', [sourceScript], {
      input: JSON.stringify({
        session_id: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        cwd: sandbox,
      }),
      encoding: 'utf-8',
      env: { ...process.env, HOME: sandbox },
    });
    expect(res.status).toBe(0);
    // Only session renders; the empty external segment is suppressed.
    expect(res.stdout).not.toContain(' · ');
    expect(res.stdout).toBe('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  });

  it('supports all segments rendering together', async () => {
    // Config with every segment; syntaur context lets assignment render.
    await writeFile(
      resolve(installRoot, 'statusline.config.json'),
      JSON.stringify(
        { segments: ['git', 'assignment', 'model', 'ctx', 'cwd', 'session'], separator: ' · ' },
        null,
        2,
      ),
      'utf-8',
    );

    const assignmentDir = resolve(sandbox, 'proj', 'assignments', 'demo');
    await mkdir(assignmentDir, { recursive: true });
    await writeFile(
      resolve(assignmentDir, 'assignment.md'),
      '---\ntitle: "My Demo"\n---\n',
    );
    await mkdir(resolve(sandbox, '.syntaur'), { recursive: true });
    await writeFile(
      resolve(sandbox, '.syntaur', 'context.json'),
      JSON.stringify({
        projectSlug: 'p',
        assignmentSlug: 'demo',
        assignmentDir,
      }),
    );
    spawnSync('git', ['init', '-q'], { cwd: sandbox });
    spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=x', 'commit', '--allow-empty', '-m', 'i', '-q'], { cwd: sandbox });
    spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=x', 'checkout', '-q', '-B', 'feat/xyz'], { cwd: sandbox });

    const res = spawnSync('bash', [sourceScript], {
      input: JSON.stringify({
        session_id: 'sid-aaaaaaaa-0000-bbbb-ccccdddddddd',
        cwd: sandbox,
        model: { display_name: 'Opus 4.7' },
        context_window: { used_percentage: 75 },
      }),
      encoding: 'utf-8',
      env: { ...process.env, HOME: sandbox },
    });
    expect(res.status).toBe(0);
    const out = res.stdout;
    // Check each segment is present and in order.
    expect(out).toContain('feat/xyz');
    expect(out).toContain('p/demo — My Demo');
    expect(out).toContain('Opus 4.7');
    expect(out).toContain('ctx:[');
    expect(out).toContain('] 75%');
    // cwd segment is the tmpdir leaf.
    const leaf = sandbox.split('/').pop()!;
    expect(out).toContain(leaf);
    expect(out).toMatch(/sid-aaaaaaaa-0000-bbbb-ccccdddddddd$/);
  });
});
