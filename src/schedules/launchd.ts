/**
 * launchd LaunchAgent installer. Hosts two periodic agents, both config-driven
 * off `AgentConfig`: `com.syntaur.schedule.tick` (the scheduler tick) and
 * `com.syntaur.session.scan` (the liveness-GC `session scan` — #5). We mirror the
 * *discipline* of `src/commands/install-url-handler.ts` — typed refusal on
 * failure, surfaced stderr. The impure surface (`launchctl`, fs) is behind
 * injectable deps so `buildPlist` (pure) is fully unit-tested and
 * install/uninstall are driveable without touching the real system.
 *
 * macOS-only for the auto-fire; the on-demand `syntaur schedule tick` /
 * `syntaur session scan` work everywhere (non-macOS: a documented cron line).
 * The Mac must be awake + logged in for an agent to fire (wake-from-sleep is a
 * deliberate cut — documented in `schedule install` / `session scan-install`).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, realpathSync, openSync, closeSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const LAUNCH_AGENT_LABEL = 'com.syntaur.schedule.tick';
export const SESSION_SCAN_LABEL = 'com.syntaur.session.scan';

export class LaunchAgentRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaunchAgentRefusalError';
  }
}

export interface LaunchAgentSpec {
  label: string;
  /** CLI subcommand args (e.g. `['schedule','tick']` or `['session','scan']`).
   *  Defaults to the scheduler tick when omitted. */
  command?: string[];
  /** Absolute node binary (launchd has a stripped PATH — never rely on $PATH). */
  nodePath: string;
  /** Absolute path to the syntaur CLI entry (bin/syntaur.js). */
  syntaurBin: string;
  intervalSeconds: number;
  outLog: string;
  errLog: string;
}

/** Per-agent fixed config (label, CLI command, log filenames, default cadence). */
interface AgentConfig {
  label: string;
  command: string[];
  outLogName: string;
  errLogName: string;
  defaultIntervalSeconds: number;
}

const TICK_AGENT: AgentConfig = {
  label: LAUNCH_AGENT_LABEL,
  command: ['schedule', 'tick'],
  outLogName: 'schedule-tick.out.log',
  errLogName: 'schedule-tick.err.log',
  defaultIntervalSeconds: 60,
};

const SCAN_AGENT: AgentConfig = {
  label: SESSION_SCAN_LABEL,
  command: ['session', 'scan'],
  outLogName: 'session-scan.out.log',
  errLogName: 'session-scan.err.log',
  // The dashboard's 45s reconcile loop is the fast path; this scheduled scan is
  // the floor for dashboard-off + Codex. 5 min keeps dangling intervals + dead
  // rows bounded without churn.
  defaultIntervalSeconds: 300,
};

/** Serialize the LaunchAgent plist. PURE — the unit test asserts its keys. */
export function buildPlist(spec: LaunchAgentSpec): string {
  const args = [spec.nodePath, spec.syntaurBin, ...(spec.command ?? ['schedule', 'tick'])];
  const argXml = args.map((a) => `    <string>${escapeXml(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(spec.label)}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>StartInterval</key>
  <integer>${Math.max(1, Math.floor(spec.intervalSeconds))}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(spec.outLog)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(spec.errLog)}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export interface LaunchdDeps {
  homeDir?: string;
  uid?: number;
  /** Absolute node binary. Defaults to the running `process.execPath`. */
  nodePath?: string;
  /** Absolute CLI entry. Defaults to the running `process.argv[1]`. */
  syntaurBin?: string;
  intervalSeconds?: number;
  writeFile?: (path: string, content: string) => void;
  mkdirp?: (path: string) => void;
  removeFile?: (path: string) => void;
  /** Run a command; return exit status. Defaults to a real `launchctl` exec. */
  run?: (command: string, args: string[]) => { code: number; stderr: string };
  /** Acquire an exclusive install lock; returns a release fn (or throws if held).
   *  Defaults to a `wx` lockfile under `~/.syntaur` (mirrors the URL-handler installer). */
  acquireInstallLock?: () => () => void;
}

function defaultAcquireInstallLock(home: string): () => void {
  const lockPath = join(home, '.syntaur', 'install-launch-agent.lock');
  mkdirSync(dirname(lockPath), { recursive: true });
  const fd = openSync(lockPath, 'wx'); // EEXIST if another install is in flight
  return () => {
    try {
      closeSync(fd);
      rmSync(lockPath, { force: true });
    } catch {
      /* best-effort release */
    }
  };
}

/** Resolve the CLI entry to a real absolute path (launchd has a stripped PATH,
 *  so a relative `process.argv[1]` under npx/dev would never run). */
function absolutize(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function defaultRun(command: string, args: string[]): { code: number; stderr: string } {
  try {
    execFileSync(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    return { code: 0, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stderr?: Buffer | string };
    return { code: e.status ?? 1, stderr: e.stderr ? String(e.stderr) : '' };
  }
}

function resolveSpec(
  config: AgentConfig,
  deps: LaunchdDeps,
): { spec: LaunchAgentSpec; plistPath: string; home: string; uid: number } {
  const home = deps.homeDir ?? homedir();
  const uid = deps.uid ?? userInfo().uid;
  const spec: LaunchAgentSpec = {
    label: config.label,
    command: config.command,
    nodePath: deps.nodePath ?? process.execPath,
    syntaurBin: absolutize(deps.syntaurBin ?? process.argv[1] ?? 'syntaur'),
    intervalSeconds: deps.intervalSeconds ?? config.defaultIntervalSeconds,
    outLog: join(home, '.syntaur', 'logs', config.outLogName),
    errLog: join(home, '.syntaur', 'logs', config.errLogName),
  };
  const plistPath = join(home, 'Library', 'LaunchAgents', `${spec.label}.plist`);
  return { spec, plistPath, home, uid };
}

export interface InstallResult {
  plistPath: string;
  label: string;
  intervalSeconds: number;
}

/**
 * Install (or idempotently re-install) a LaunchAgent: write the plist, then
 * `bootout` any prior instance (ignored if absent) and `bootstrap` the new one.
 * Throws `LaunchAgentRefusalError` with the launchctl stderr on failure.
 */
function installAgent(config: AgentConfig, deps: LaunchdDeps): InstallResult {
  const { spec, plistPath, home, uid } = resolveSpec(config, deps);
  const mkdirp = deps.mkdirp ?? ((p: string) => mkdirSync(p, { recursive: true }));
  const writeFile = deps.writeFile ?? ((p: string, c: string) => writeFileSync(p, c));
  const run = deps.run ?? defaultRun;

  const releaseLock = (deps.acquireInstallLock ?? (() => defaultAcquireInstallLock(home)))();
  try {
    mkdirp(join(home, '.syntaur', 'logs'));
    mkdirp(join(home, 'Library', 'LaunchAgents'));
    writeFile(plistPath, buildPlist(spec));

    const domain = `gui/${uid}`;
    // Idempotent: tear down any prior instance first (ignore "not found").
    run('launchctl', ['bootout', `${domain}/${spec.label}`]);
    const boot = run('launchctl', ['bootstrap', domain, plistPath]);
    if (boot.code !== 0) {
      throw new LaunchAgentRefusalError(
        `launchctl bootstrap failed (code ${boot.code}): ${boot.stderr.trim() || 'no stderr'}`,
      );
    }
    return { plistPath, label: spec.label, intervalSeconds: spec.intervalSeconds };
  } finally {
    releaseLock();
  }
}

/** Uninstall: `bootout` the agent and remove the plist. Best-effort bootout. */
function uninstallAgent(config: AgentConfig, deps: LaunchdDeps): { plistPath: string; label: string } {
  const { spec, plistPath, uid } = resolveSpec(config, deps);
  const run = deps.run ?? defaultRun;
  const removeFile = deps.removeFile ?? ((p: string) => rmSync(p, { force: true }));
  run('launchctl', ['bootout', `gui/${uid}/${spec.label}`]);
  removeFile(plistPath);
  return { plistPath, label: spec.label };
}

/** Install the scheduler-tick LaunchAgent (`com.syntaur.schedule.tick`). */
export function installLaunchAgent(deps: LaunchdDeps = {}): InstallResult {
  return installAgent(TICK_AGENT, deps);
}

/** Uninstall the scheduler-tick LaunchAgent. */
export function uninstallLaunchAgent(deps: LaunchdDeps = {}): { plistPath: string; label: string } {
  return uninstallAgent(TICK_AGENT, deps);
}

/** Install the liveness-GC scan LaunchAgent (`com.syntaur.session.scan`) — runs
 *  `syntaur session scan` on an interval so the engagement GC + dead-row sweep
 *  cover Codex + dashboard-off (Decision 6). */
export function installSessionScanAgent(deps: LaunchdDeps = {}): InstallResult {
  return installAgent(SCAN_AGENT, deps);
}

/** Uninstall the liveness-GC scan LaunchAgent. */
export function uninstallSessionScanAgent(deps: LaunchdDeps = {}): { plistPath: string; label: string } {
  return uninstallAgent(SCAN_AGENT, deps);
}
