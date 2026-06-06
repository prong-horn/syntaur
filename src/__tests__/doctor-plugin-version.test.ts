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

// The check emits one result per plugin kind (each carries its own remediation),
// so look the per-kind result up by its `affected` tag rather than position.
function forKind(report: DoctorReport, kind: 'claude' | 'codex') {
  return byId(report, 'plugin.version-drift').find((c) => c.affected?.includes(kind));
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
  it('skips per kind when no managed plugin install exists', async () => {
    const report = await runChecks();
    expect(forKind(report, 'claude')?.status).toBe('skipped');
    expect(forKind(report, 'codex')?.status).toBe('skipped');
  });

  it('passes when the installed Claude plugin matches the CLI version', async () => {
    await plantManagedInstall('claude', cliVersion);
    const report = await runChecks();
    expect(forKind(report, 'claude')?.status).toBe('pass');
    expect(forKind(report, 'codex')?.status).toBe('skipped'); // codex not installed
  });

  it('warns when the Claude plugin is stale, suggesting install-plugin --force', async () => {
    await plantManagedInstall('claude', '0.0.1');
    const report = await runChecks();
    const result = forKind(report, 'claude');
    expect(result?.status).toBe('warn');
    expect(result?.detail).toContain('0.0.1');
    expect(result?.remediation?.command).toBe('syntaur install-plugin --force');
  });

  it('warns when the Codex plugin is stale, suggesting install-codex-plugin --force', async () => {
    await plantManagedInstall('codex', '0.0.1');
    const report = await runChecks();
    const result = forKind(report, 'codex');
    expect(result?.status).toBe('warn');
    expect(result?.remediation?.command).toBe('syntaur install-codex-plugin --force');
  });

  it('reports BOTH kinds independently when both drift (each with its own command)', async () => {
    await plantManagedInstall('claude', '0.0.1');
    await plantManagedInstall('codex', '0.0.2');
    const report = await runChecks();
    const claude = forKind(report, 'claude');
    const codex = forKind(report, 'codex');
    expect(claude?.status).toBe('warn');
    expect(claude?.remediation?.command).toBe('syntaur install-plugin --force');
    expect(codex?.status).toBe('warn');
    expect(codex?.remediation?.command).toBe('syntaur install-codex-plugin --force');
  });
});
