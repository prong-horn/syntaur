import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChecks } from '../utils/doctor/index.js';
import type { DoctorReport } from '../utils/doctor/types.js';

const originalHome = process.env.HOME;
let homeDir: string;

// The check reads the running CLI version from the repo package.json.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
let cliVersion: string;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'syntaur-doctor-plugin-'));
  process.env.HOME = homeDir;
  // Minimal config so runChecks loads cleanly.
  await mkdir(resolve(homeDir, '.syntaur'), { recursive: true });
  await writeFile(resolve(homeDir, '.syntaur', 'config.md'), `---\nversion: "1.0"\n---\n`);
  cliVersion = JSON.parse(await readFile(resolve(repoRoot, 'package.json'), 'utf8')).version;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  await rm(homeDir, { recursive: true, force: true });
});

function byId(report: DoctorReport, id: string) {
  return report.checks.filter((c) => c.id === id);
}

// Plant a managed (copy-mode) install marker at the default plugin dir for `kind`.
async function plantManagedInstall(kind: 'claude' | 'codex', packageVersion: string): Promise<void> {
  const dir = kind === 'claude'
    ? resolve(homeDir, '.claude', 'plugins', 'syntaur')
    : resolve(homeDir, 'plugins', 'syntaur');
  await mkdir(dir, { recursive: true });
  await writeFile(
    resolve(dir, '.syntaur-install.json'),
    JSON.stringify({
      packageName: 'syntaur',
      packageVersion,
      pluginKind: kind,
      installMode: 'copy',
      installedAt: '2026-06-06T00:00:00Z',
    }),
  );
}

describe('doctor plugin.version-drift', () => {
  it('skips when no managed plugin install exists', async () => {
    const report = await runChecks();
    const res = byId(report, 'plugin.version-drift');
    expect(res).toHaveLength(1);
    expect(res[0]?.status).toBe('skipped');
  });

  it('passes when the installed Claude plugin matches the CLI version', async () => {
    await plantManagedInstall('claude', cliVersion);
    const report = await runChecks();
    expect(byId(report, 'plugin.version-drift')[0]?.status).toBe('pass');
  });

  it('warns when the Claude plugin is stale, suggesting install-plugin --force', async () => {
    await plantManagedInstall('claude', '0.0.1');
    const report = await runChecks();
    const result = byId(report, 'plugin.version-drift')[0];
    expect(result?.status).toBe('warn');
    expect(result?.detail).toContain('0.0.1');
    expect(result?.affected).toContain('claude');
    expect(result?.remediation?.command).toBe('syntaur install-plugin --force');
  });

  it('warns when the Codex plugin is stale, suggesting install-codex-plugin --force', async () => {
    await plantManagedInstall('codex', '0.0.1');
    const report = await runChecks();
    const result = byId(report, 'plugin.version-drift')[0];
    expect(result?.status).toBe('warn');
    expect(result?.affected).toContain('codex');
    expect(result?.remediation?.command).toBe('syntaur install-codex-plugin --force');
  });
});
