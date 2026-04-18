import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { syntaurRoot } from './paths.js';
import { fileExists, writeFileForce } from './fs.js';
import { readPackageVersion } from './version.js';

interface NpxPromptState {
  decision: 'never' | 'installed';
  decidedAt: string;
  lastUpgradeHintVersion?: string;
  lastUpgradeHintAt?: string;
}

const STATE_FILE = resolve(syntaurRoot(), 'npx-install.json');
const META_ARGS = new Set(['-h', '--help', '-V', '--version', 'help']);
const GLOBAL_VERSION_TIMEOUT_MS = 2000;

function isRunningViaNpx(scriptUrl: string): boolean {
  let scriptPath: string;
  try {
    scriptPath = fileURLToPath(scriptUrl);
  } catch {
    return false;
  }
  const p = scriptPath.replace(/\\/g, '/');
  if (p.includes('/_npx/')) return true;
  if (p.includes('/pnpm/dlx/') || p.includes('/dlx-')) return true;
  if (p.includes('/bun/install/cache/bunx-') || p.includes('/bunx-')) return true;

  const ua = process.env.npm_config_user_agent ?? '';
  if (ua.includes('npx/')) return true;

  return false;
}

async function readState(): Promise<NpxPromptState | null> {
  if (!(await fileExists(STATE_FILE))) return null;
  try {
    const raw = await readFile(STATE_FILE, 'utf-8');
    return JSON.parse(raw) as NpxPromptState;
  } catch {
    return null;
  }
}

async function writeState(state: NpxPromptState): Promise<void> {
  await writeFileForce(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

async function resolveNpmBin(): Promise<{ cmd: string; shell: boolean }> {
  const nodeDir = dirname(process.execPath);
  const isWin = process.platform === 'win32';
  const npmName = isWin ? 'npm.cmd' : 'npm';
  const nearNode = join(nodeDir, npmName);
  if (await fileExists(nearNode)) {
    return { cmd: nearNode, shell: false };
  }
  return { cmd: 'npm', shell: isWin };
}

async function installGlobally(): Promise<boolean> {
  const { cmd, shell } = await resolveNpmBin();
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, ['install', '-g', 'syntaur'], {
      stdio: 'inherit',
      shell,
    });
    child.on('exit', (code) => resolvePromise(code === 0));
    child.on('error', () => resolvePromise(false));
  });
}

async function readGlobalVersion(): Promise<string | null> {
  const { cmd, shell } = await resolveNpmBin();
  const rootPath = await new Promise<string | null>((resolvePromise) => {
    const child = spawn(cmd, ['root', '-g'], {
      shell,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      resolvePromise(null);
    }, GLOBAL_VERSION_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf-8');
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolvePromise(code === 0 ? out.trim() : null);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolvePromise(null);
    });
  });
  if (!rootPath) return null;
  try {
    const manifestPath = join(rootPath, 'syntaur', 'package.json');
    if (!(await fileExists(manifestPath))) return null;
    const raw = await readFile(manifestPath, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

export function compareSemver(a: string, b: string): number {
  const parse = (v: string): number[] => {
    const core = v.split(/[-+]/)[0];
    const parts = core.split('.').map((p) => parseInt(p, 10));
    if (parts.some((n) => !Number.isFinite(n))) return [];
    while (parts.length < 3) parts.push(0);
    return parts.slice(0, 3);
  };
  const pa = parse(a);
  const pb = parse(b);
  if (pa.length === 0 || pb.length === 0) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

async function askChoice(promptLabel: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once('SIGINT', onSigint);
  try {
    const raw = await rl.question(promptLabel, {
      signal: controller.signal,
    });
    return raw.trim();
  } catch {
    return '';
  } finally {
    process.off('SIGINT', onSigint);
    rl.close();
  }
}

async function maybePromptUpgrade(
  scriptUrl: string,
  state: NpxPromptState,
): Promise<void> {
  const running = await readPackageVersion(scriptUrl);
  if (!running) return;
  if (state.lastUpgradeHintVersion === running) return;

  const globalV = await readGlobalVersion();
  if (!globalV) return;
  if (compareSemver(running, globalV) <= 0) return;

  console.log('');
  console.log(
    `Your installed syntaur (${globalV}) is behind this one (${running}). Upgrade your global install?`,
  );
  console.log('  1) Yes — upgrade now');
  console.log('  2) Not now — just start it for this run');
  const answer = await askChoice('Choose [1/2]: ');

  const hintUpdate = {
    lastUpgradeHintVersion: running,
    lastUpgradeHintAt: new Date().toISOString(),
  };

  if (answer === '1') {
    console.log('\nUpgrading syntaur globally...\n');
    const ok = await installGlobally();
    if (ok) {
      await writeState({ ...state, ...hintUpdate });
      console.log(
        `\nUpgraded to ${running}. From now on \`syntaur\` will use the new version.\n`,
      );
    } else {
      console.log('\nUpgrade failed. Continuing with this run.\n');
    }
    return;
  }

  await writeState({ ...state, ...hintUpdate });
}

export async function maybePromptInstall(scriptUrl: string): Promise<void> {
  if (!isRunningViaNpx(scriptUrl)) return;
  if (process.env.SYNTAUR_SKIP_INSTALL_PROMPT === '1') return;
  if (!process.stdout.isTTY || !process.stdin.isTTY) return;

  const args = process.argv.slice(2);
  if (args.some((a) => META_ARGS.has(a))) return;

  const state = await readState();
  if (state?.decision === 'never') return;
  if (state?.decision === 'installed') {
    await maybePromptUpgrade(scriptUrl, state);
    return;
  }

  console.log('');
  console.log(
    "You're running syntaur via npx. Install it globally for faster startup?",
  );
  console.log('  1) Yes — install now');
  console.log('  2) Maybe later — just start it for now');
  console.log("  3) Never — don't ask again");
  const answer = await askChoice('Choose [1/2/3]: ');

  if (answer === '1') {
    console.log('\nInstalling syntaur globally...\n');
    const ok = await installGlobally();
    if (ok) {
      await writeState({
        decision: 'installed',
        decidedAt: new Date().toISOString(),
      });
      console.log('\nInstalled. From now on you can run `syntaur` directly.\n');
    } else {
      console.log('\nInstall failed. Continuing with this run.\n');
    }
  } else if (answer === '3') {
    await writeState({
      decision: 'never',
      decidedAt: new Date().toISOString(),
    });
    console.log("Got it — won't ask again.\n");
  }
}
