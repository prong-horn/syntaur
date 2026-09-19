import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

describe('npm pack file list', () => {
  it('ships skills, hooks, templates, examples, statusline — not plugin trees', () => {
    const raw = execSync('npm pack --dry-run --json', {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(raw) as Array<{ files: Array<{ path: string }> }>;
    const paths = parsed[0]?.files.map((f) => f.path) ?? [];

    for (const skill of paths.filter((p) => p.startsWith('skills/'))) {
      expect(skill).toMatch(/SKILL\.md$/);
    }
    expect(paths.some((p) => p.endsWith('hooks/session-start.sh'))).toBe(true);
    expect(paths.some((p) => p.endsWith('hooks/session-touch.sh'))).toBe(true);
    expect(paths.some((p) => p.endsWith('hooks/prompt-context.sh'))).toBe(true);
    expect(paths.some((p) => p.endsWith('hooks/lib.sh'))).toBe(true);
    expect(paths.some((p) => p.endsWith('statusline/statusline.sh'))).toBe(true);
    expect(paths.some((p) => p.startsWith('templates/'))).toBe(true);
    expect(paths.some((p) => p.startsWith('examples/'))).toBe(true);

    expect(paths.some((p) => p.includes('platforms/'))).toBe(false);
    expect(paths.some((p) => p.includes('.claude-plugin/'))).toBe(false);
    expect(paths.some((p) => p.includes('.agents/'))).toBe(false);
  });
});
