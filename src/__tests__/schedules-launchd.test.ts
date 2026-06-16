import { describe, expect, it } from 'vitest';
import {
  buildPlist,
  installLaunchAgent,
  uninstallLaunchAgent,
  LaunchAgentRefusalError,
  LAUNCH_AGENT_LABEL,
  type LaunchAgentSpec,
} from '../schedules/launchd.js';

const spec: LaunchAgentSpec = {
  label: LAUNCH_AGENT_LABEL,
  nodePath: '/usr/local/bin/node',
  syntaurBin: '/usr/local/lib/node_modules/syntaur/bin/syntaur.js',
  intervalSeconds: 60,
  outLog: '/home/u/.syntaur/logs/schedule-tick.out.log',
  errLog: '/home/u/.syntaur/logs/schedule-tick.err.log',
};

describe('buildPlist', () => {
  it('emits the required keys and ProgramArguments', () => {
    const plist = buildPlist(spec);
    expect(plist).toContain(`<string>${LAUNCH_AGENT_LABEL}</string>`);
    expect(plist).toContain('<string>/usr/local/bin/node</string>');
    expect(plist).toContain('<string>/usr/local/lib/node_modules/syntaur/bin/syntaur.js</string>');
    expect(plist).toContain('<string>schedule</string>');
    expect(plist).toContain('<string>tick</string>');
    expect(plist).toContain('<key>StartInterval</key>');
    expect(plist).toContain('<integer>60</integer>');
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<key>StandardOutPath</key>');
    expect(plist).toContain('<key>StandardErrorPath</key>');
  });
});

describe('installLaunchAgent', () => {
  function recordingDeps() {
    const calls: Array<[string, string[]]> = [];
    const writes: Array<[string, string]> = [];
    return {
      calls,
      writes,
      deps: {
        homeDir: '/home/u',
        uid: 501,
        nodePath: '/usr/local/bin/node',
        syntaurBin: '/cli/syntaur.js',
        mkdirp: () => {},
        writeFile: (p: string, c: string) => writes.push([p, c]),
        removeFile: () => {},
        acquireInstallLock: () => () => {},
        run: (cmd: string, args: string[]) => {
          calls.push([cmd, args]);
          return { code: 0, stderr: '' };
        },
      },
    };
  }

  it('writes the plist then boots out before bootstrap (idempotent)', () => {
    const { calls, writes, deps } = recordingDeps();
    const res = installLaunchAgent(deps);
    expect(res.plistPath).toBe('/home/u/Library/LaunchAgents/com.syntaur.schedule.tick.plist');
    expect(writes[0][0]).toBe(res.plistPath);
    expect(calls[0]).toEqual(['launchctl', ['bootout', 'gui/501/com.syntaur.schedule.tick']]);
    expect(calls[1]).toEqual(['launchctl', ['bootstrap', 'gui/501', res.plistPath]]);
  });

  it('throws LaunchAgentRefusalError when bootstrap fails', () => {
    const deps = {
      homeDir: '/home/u',
      uid: 501,
      mkdirp: () => {},
      writeFile: () => {},
      acquireInstallLock: () => () => {},
      run: (_cmd: string, args: string[]) =>
        args[0] === 'bootstrap' ? { code: 5, stderr: 'Load failed: 5: Input/output error' } : { code: 0, stderr: '' },
    };
    expect(() => installLaunchAgent(deps)).toThrow(LaunchAgentRefusalError);
  });

  it('uninstall boots out and removes the plist', () => {
    const calls: Array<[string, string[]]> = [];
    const removed: string[] = [];
    const res = uninstallLaunchAgent({
      homeDir: '/home/u',
      uid: 501,
      run: (cmd, args) => {
        calls.push([cmd, args]);
        return { code: 0, stderr: '' };
      },
      removeFile: (p) => removed.push(p),
    });
    expect(calls[0]).toEqual(['launchctl', ['bootout', 'gui/501/com.syntaur.schedule.tick']]);
    expect(removed).toEqual([res.plistPath]);
  });
});
