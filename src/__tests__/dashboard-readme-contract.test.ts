import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const README_URL = 'https://github.com/prong-horn/syntaur#readme';

describe('dashboard README navigation contract', () => {
  it('Settings links to the public README with noreferrer', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'dashboard/src/components/settings/ReadmeLinkSection.tsx'),
      'utf8',
    );
    expect(source).toContain(README_URL);
    expect(source).toContain('rel="noreferrer"');
    expect(source).toContain('target="_blank"');
  });

  it('legacy /help redirects to settings readme section', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'dashboard/src/lib/legacyRoutes.ts'),
      'utf8',
    );
    expect(source).toContain("head === 'help'");
    expect(source).toContain("params.set('section', 'readme')");
    expect(source).toContain('destination: `/settings${qs ? `?${qs}` : \'\'}${hash}`');
  });

  it('AppShell exposes six navigation families without ticket in the sidebar', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'dashboard/src/components/AppShell.tsx'),
      'utf8',
    );
    for (const path of ['/inbox', '/board', '/sessions', '/library/playbooks', '/settings']) {
      expect(source).toContain(path);
    }
    expect(source).not.toMatch(/to:\s*['"]\/t\//);
  });
});
