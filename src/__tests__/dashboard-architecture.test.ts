import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const CHECKER = join(ROOT, 'scripts', 'check-dashboard-architecture.mjs');

function runChecker(cwd = ROOT) {
  return execFileSync(process.execPath, [CHECKER], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, SYNTAUR_ARCH_CHECK_ROOT: cwd },
  });
}

describe('check-dashboard-architecture', () => {
  it('passes on the production dashboard tree', () => {
    const out = runChecker();
    expect(out).toContain('passed');
  });

  it('fails when a seventh page module is added', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sv12-arch-'));
    const pages = join(dir, 'dashboard', 'src', 'pages');
    mkdirSync(pages, { recursive: true });
    writeFileSync(join(pages, 'NeedsMePage.tsx'), 'export function NeedsMePage(){return null}\n');
    writeFileSync(join(pages, 'BoardPage.tsx'), 'export function BoardPage(){return null}\n');
    writeFileSync(join(pages, 'TicketPage.tsx'), 'export function TicketPage(){return null}\n');
    writeFileSync(join(pages, 'SessionsPage.tsx'), 'export function SessionsPage(){return null}\n');
    writeFileSync(join(pages, 'LibraryPage.tsx'), 'export function LibraryPage(){return null}\n');
    writeFileSync(join(pages, 'SettingsPage.tsx'), 'export function SettingsPage(){return null}\n');
    writeFileSync(join(pages, 'ExtraPage.tsx'), 'export function ExtraPage(){return null}\n');
    mkdirSync(join(dir, 'dashboard', 'src', 'components'), { recursive: true });
    writeFileSync(
      join(dir, 'dashboard', 'src', 'components', 'AppShell.tsx'),
      `const NAV=[{to:'/inbox'},{to:'/board'},{to:'/sessions'},{to:'/library/playbooks'},{to:'/settings'}];\n`,
      { flag: 'w' },
    );
    mkdirSync(join(dir, 'dashboard', 'src', 'data'), { recursive: true });
    writeFileSync(join(dir, 'dashboard', 'src', 'data', 'client.ts'), 'export const requestJson = () => null;\n');
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'check-dashboard-architecture.mjs'), readCheckerSource());
    try {
      expect(() => runChecker(dir)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails on raw fetch outside client.ts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sv12-fetch-'));
    const comp = join(dir, 'dashboard', 'src', 'components');
    mkdirSync(comp, { recursive: true });
    writeFileSync(join(comp, 'BadFetch.tsx'), 'export async function bad(){ return fetch("/api/x"); }\n');
    mkdirSync(join(dir, 'dashboard', 'src', 'data'), { recursive: true });
    writeFileSync(join(dir, 'dashboard', 'src', 'data', 'client.ts'), 'export const requestJson = () => null;\n');
    const pages = join(dir, 'dashboard', 'src', 'pages');
    mkdirSync(pages, { recursive: true });
    for (const name of ['NeedsMePage.tsx', 'BoardPage.tsx', 'TicketPage.tsx', 'SessionsPage.tsx', 'LibraryPage.tsx', 'SettingsPage.tsx']) {
      writeFileSync(join(pages, name), 'export const X=1;\n');
    }
    writeFileSync(
      join(dir, 'dashboard', 'src', 'components', 'AppShell.tsx'),
      `const NAV=[{to:'/inbox'},{to:'/board'},{to:'/sessions'},{to:'/library/playbooks'},{to:'/settings'}];\n`,
    );
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'check-dashboard-architecture.mjs'), readCheckerSource());
    try {
      expect(() => runChecker(dir)).toThrow(/raw fetch/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function readCheckerSource() {
  return readFileSync(CHECKER, 'utf8');
}
