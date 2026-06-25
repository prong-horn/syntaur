import { describe, expect, it } from 'vitest';
import {
  buildPlist,
  installSessionScanAgent,
  uninstallSessionScanAgent,
  SESSION_SCAN_LABEL,
  type LaunchAgentSpec,
} from '../schedules/launchd.js';

const spec: LaunchAgentSpec = {
  label: SESSION_SCAN_LABEL,
  command: ['session', 'scan'],
  nodePath: '/usr/local/bin/node',
  syntaurBin: '/usr/local/lib/node_modules/syntaur/bin/syntaur.js',
  intervalSeconds: 300,
  outLog: '/home/u/.syntaur/logs/session-scan.out.log',
  errLog: '/home/u/.syntaur/logs/session-scan.err.log',
};

describe('buildPlist (session scan)', () => {
  it('emits the session-scan label, the `session scan` args, and the interval', () => {
    const plist = buildPlist(spec);
    expect(SESSION_SCAN_LABEL).toBe('com.syntaur.session.scan');
    expect(plist).toContain(`<string>${SESSION_SCAN_LABEL}</string>`);
    expect(plist).toContain('<string>/usr/local/bin/node</string>');
    expect(plist).toContain('<string>/usr/local/lib/node_modules/syntaur/bin/syntaur.js</string>');
    expect(plist).toContain('<string>session</string>');
    expect(plist).toContain('<string>scan</string>');
    // Must NOT carry the scheduler-tick command.
    expect(plist).not.toContain('<string>tick</string>');
    expect(plist).toContain('<key>StartInterval</key>');
    expect(plist).toContain('<integer>300</integer>');
    expect(plist).toContain('<key>StandardOutPath</key>');
    expect(plist).toContain('<key>StandardErrorPath</key>');
  });
});

describe('installSessionScanAgent', () => {
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

  it('writes the session-scan plist then boots out before bootstrap (idempotent)', () => {
    const { calls, writes, deps } = recordingDeps();
    const res = installSessionScanAgent(deps);
    expect(res.plistPath).toBe('/home/u/Library/LaunchAgents/com.syntaur.session.scan.plist');
    expect(res.label).toBe(SESSION_SCAN_LABEL);
    expect(writes[0][0]).toBe(res.plistPath);
    expect(writes[0][1]).toContain('<string>scan</string>');
    expect(calls[0]).toEqual(['launchctl', ['bootout', 'gui/501/com.syntaur.session.scan']]);
    expect(calls[1]).toEqual(['launchctl', ['bootstrap', 'gui/501', res.plistPath]]);
  });

  it('uninstall boots out and removes the session-scan plist', () => {
    const calls: Array<[string, string[]]> = [];
    const removed: string[] = [];
    const res = uninstallSessionScanAgent({
      homeDir: '/home/u',
      uid: 501,
      run: (cmd, args) => {
        calls.push([cmd, args]);
        return { code: 0, stderr: '' };
      },
      removeFile: (p) => removed.push(p),
    });
    expect(calls[0]).toEqual(['launchctl', ['bootout', 'gui/501/com.syntaur.session.scan']]);
    expect(removed).toEqual([res.plistPath]);
  });
});
