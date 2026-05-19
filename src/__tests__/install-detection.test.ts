import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  mkdirSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  detectInstallKind,
  extractNpxHash,
  isHandlerNudgeDisabled,
  hasNudgedHash,
  recordNudge,
  nudgeStampDir,
  nudgeStampPath,
  shouldNudgeForNpx,
  nudgeMessage,
  maybeNudgeForNpxInstall,
} from '../launch/install-detection.js';

// Injected realpath that returns the input unchanged. Used for classifier
// table tests where the paths are fictional file:// URLs that don't exist
// on disk, so calling the real realpathSync would always throw.
const identityRealpath = (p: string) => p;
// Injected readFile that always throws (= no package.json found anywhere).
// Used for table tests that should classify by URL alone.
const noReadFile = (): string => {
  throw new Error('ENOENT');
};

let testHome: string;
let origSyntaurHome: string | undefined;
let origUserAgent: string | undefined;
let origSkip: string | undefined;
let origArgv: string[];

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'syntaur-install-detection-'));
  origSyntaurHome = process.env.SYNTAUR_HOME;
  origUserAgent = process.env.npm_config_user_agent;
  origSkip = process.env.SYNTAUR_SKIP_HANDLER_NUDGE;
  origArgv = process.argv;
  process.env.SYNTAUR_HOME = testHome;
  delete process.env.npm_config_user_agent;
  delete process.env.SYNTAUR_SKIP_HANDLER_NUDGE;
  // Default argv that does NOT contain any META_ARGS — individual tests
  // override when they need to assert the help-flag guard.
  process.argv = ['node', 'syntaur', 'ls'];
});

afterEach(() => {
  if (origSyntaurHome === undefined) delete process.env.SYNTAUR_HOME;
  else process.env.SYNTAUR_HOME = origSyntaurHome;
  if (origUserAgent === undefined) delete process.env.npm_config_user_agent;
  else process.env.npm_config_user_agent = origUserAgent;
  if (origSkip === undefined) delete process.env.SYNTAUR_SKIP_HANDLER_NUDGE;
  else process.env.SYNTAUR_SKIP_HANDLER_NUDGE = origSkip;
  process.argv = origArgv;
  rmSync(testHome, { recursive: true, force: true });
});

describe('detectInstallKind', () => {
  const cases: { url: string; expected: 'npx' | 'global' | 'unknown' }[] = [
    {
      url: 'file:///Users/foo/.npm/_npx/abc123/node_modules/syntaur/dist/index.js',
      expected: 'npx',
    },
    {
      url: 'file:///Users/foo/.local/share/pnpm/dlx/xyz/node_modules/syntaur/dist/index.js',
      expected: 'npx',
    },
    {
      url: 'file:///Users/foo/.bun/install/cache/bunx-deadbeef/node_modules/syntaur/dist/index.js',
      expected: 'npx',
    },
    {
      url: 'file:///usr/local/lib/node_modules/syntaur/dist/index.js',
      expected: 'global',
    },
    {
      url: 'file:///Users/foo/.nvm/versions/node/v22/lib/node_modules/syntaur/dist/index.js',
      expected: 'global',
    },
    // False-positive resistance: contains `_npx` literal but NOT inside the
    // npm cache layout (no `/node_modules/` anchor after the hash). Must
    // NOT classify as npx.
    {
      url: 'file:///Users/foo/projects/_npx-notes/index.js',
      expected: 'unknown',
    },
    {
      url: 'not-a-url-at-all',
      expected: 'unknown',
    },
  ];
  for (const { url, expected } of cases) {
    it(`classifies ${url} as ${expected}`, () => {
      const kind = detectInstallKind(url, {
        realpath: identityRealpath,
        readFile: noReadFile,
        envUserAgent: '',
      });
      expect(kind).toBe(expected);
    });
  }

  it('classifies a local checkout (syntaur package.json walked up, NOT inside node_modules) as local', () => {
    const repo = join(testHome, 'syntaur');
    mkdirSync(join(repo, 'dist'), { recursive: true });
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'syntaur' }));
    const url = pathToFileURL(join(repo, 'dist', 'index.js')).href;
    const kind = detectInstallKind(url, { realpath: identityRealpath, envUserAgent: '' });
    expect(kind).toBe('local');
  });

  it('classifies a syntaur package.json inside a node_modules tree as unknown (not local)', () => {
    const nested = join(testHome, 'host', 'node_modules', 'syntaur');
    mkdirSync(join(nested, 'dist'), { recursive: true });
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'syntaur' }));
    const url = pathToFileURL(join(nested, 'dist', 'index.js')).href;
    const kind = detectInstallKind(url, { realpath: identityRealpath, envUserAgent: '' });
    expect(kind).toBe('unknown');
  });

  it('resolves symlinks before classifying (symlink -> npx-cache path = npx)', () => {
    const cache = join(
      testHome,
      '.npm',
      '_npx',
      'h1',
      'node_modules',
      'syntaur',
    );
    mkdirSync(cache, { recursive: true });
    const realScript = join(cache, 'dist', 'index.js');
    mkdirSync(join(cache, 'dist'));
    writeFileSync(realScript, '');
    const linkPath = join(testHome, 'link.js');
    symlinkSync(realScript, linkPath);
    const url = pathToFileURL(linkPath).href;
    const kind = detectInstallKind(url, { realpath: realpathSync.native, envUserAgent: '' });
    expect(kind).toBe('npx');
  });

  it('uses npm_config_user_agent as a fallback npx signal', () => {
    const kind = detectInstallKind('file:///some/odd/path/index.js', {
      realpath: identityRealpath,
      readFile: noReadFile,
      envUserAgent: 'npx/10.0.0 npm/10 node/v22',
    });
    expect(kind).toBe('npx');
  });
});

describe('extractNpxHash', () => {
  it('extracts npm npx hash', () => {
    const url = 'file:///Users/foo/.npm/_npx/abc123/node_modules/syntaur/dist/index.js';
    expect(extractNpxHash(url, { realpath: identityRealpath })).toBe('abc123');
  });
  it('extracts pnpm dlx hash', () => {
    const url =
      'file:///Users/foo/.local/share/pnpm/dlx/xyz/node_modules/syntaur/dist/index.js';
    expect(extractNpxHash(url, { realpath: identityRealpath })).toBe('xyz');
  });
  it('extracts bun bunx hash', () => {
    const url =
      'file:///Users/foo/.bun/install/cache/bunx-deadbeef/node_modules/syntaur/dist/index.js';
    expect(extractNpxHash(url, { realpath: identityRealpath })).toBe('deadbeef');
  });
  it('returns null for global', () => {
    const url = 'file:///usr/local/lib/node_modules/syntaur/dist/index.js';
    expect(extractNpxHash(url, { realpath: identityRealpath })).toBeNull();
  });
  it('returns null for an arbitrary path', () => {
    expect(extractNpxHash('file:///etc/passwd', { realpath: identityRealpath })).toBeNull();
  });
});

describe('isHandlerNudgeDisabled — truthiness table', () => {
  const disabled = ['1', 'true', 'TRUE', 'yes', 'YES', '  true  '];
  const enabled = ['0', 'false', 'FALSE', '', '   ', 'maybe'];
  for (const v of disabled) {
    it(`disables for SYNTAUR_SKIP_HANDLER_NUDGE=${JSON.stringify(v)}`, () => {
      process.env.SYNTAUR_SKIP_HANDLER_NUDGE = v;
      expect(isHandlerNudgeDisabled()).toBe(true);
    });
  }
  for (const v of enabled) {
    it(`stays enabled for SYNTAUR_SKIP_HANDLER_NUDGE=${JSON.stringify(v)}`, () => {
      process.env.SYNTAUR_SKIP_HANDLER_NUDGE = v;
      expect(isHandlerNudgeDisabled()).toBe(false);
    });
  }
  it('stays enabled when unset', () => {
    delete process.env.SYNTAUR_SKIP_HANDLER_NUDGE;
    expect(isHandlerNudgeDisabled()).toBe(false);
  });
});

describe('nudge stamp lifecycle', () => {
  // Build a synthetic npx URL that resolves to a real path inside the temp
  // home so detectInstallKind+extractNpxHash return 'npx' and a hash. We
  // need REAL files because maybeNudgeForNpxInstall uses the default
  // realpath (no injection point).
  function makeNpxUrl(hash: string): string {
    const dir = join(testHome, '.npm', '_npx', hash, 'node_modules', 'syntaur', 'dist');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'index.js');
    writeFileSync(file, '');
    return pathToFileURL(file).href;
  }

  it('first invocation writes the stamp and emits the nudge to stderr', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const url = makeNpxUrl('h1');
    await maybeNudgeForNpxInstall(url);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(nudgeMessage());
    expect(await hasNudgedHash('h1')).toBe(true);
    errSpy.mockRestore();
  });

  it('second invocation with the SAME hash is silent', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const url = makeNpxUrl('h1');
    await maybeNudgeForNpxInstall(url);
    errSpy.mockClear();
    await maybeNudgeForNpxInstall(url);
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('a DIFFERENT hash re-arms the nudge', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await maybeNudgeForNpxInstall(makeNpxUrl('h1'));
    errSpy.mockClear();
    await maybeNudgeForNpxInstall(makeNpxUrl('h2'));
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it('removing the stamp re-arms the nudge for the same hash', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const url = makeNpxUrl('h1');
    await maybeNudgeForNpxInstall(url);
    rmSync(nudgeStampPath('h1'));
    errSpy.mockClear();
    await maybeNudgeForNpxInstall(url);
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it('SYNTAUR_SKIP_HANDLER_NUDGE=1 suppresses the nudge and writes no stamp', async () => {
    process.env.SYNTAUR_SKIP_HANDLER_NUDGE = '1';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const url = makeNpxUrl('h1');
    await maybeNudgeForNpxInstall(url);
    expect(errSpy).not.toHaveBeenCalled();
    expect(await hasNudgedHash('h1')).toBe(false);
    errSpy.mockRestore();
  });

  it('SYNTAUR_SKIP_HANDLER_NUDGE=0 does NOT suppress (truthiness boundary)', async () => {
    process.env.SYNTAUR_SKIP_HANDLER_NUDGE = '0';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const url = makeNpxUrl('h1');
    await maybeNudgeForNpxInstall(url);
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it('META_ARGS (--help) guard skips the nudge', async () => {
    process.argv = ['node', 'syntaur', '--help'];
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const url = makeNpxUrl('h1');
    await maybeNudgeForNpxInstall(url);
    expect(errSpy).not.toHaveBeenCalled();
    expect(await hasNudgedHash('h1')).toBe(false);
    errSpy.mockRestore();
  });

  it('arbitrary content in a pre-existing stamp file still suppresses the nudge (presence-based semantics)', async () => {
    mkdirSync(nudgeStampDir(), { recursive: true });
    writeFileSync(nudgeStampPath('h1'), 'some legacy bytes');
    expect(await hasNudgedHash('h1')).toBe(true);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const url = makeNpxUrl('h1');
    await maybeNudgeForNpxInstall(url);
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('non-npx install (no hash) never nudges even with stale stamp dir', async () => {
    // Synthesize a global-layout file under testHome so realpath succeeds.
    const dir = join(testHome, 'usr', 'local', 'lib', 'node_modules', 'syntaur', 'dist');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'index.js');
    writeFileSync(file, '');
    const url = pathToFileURL(file).href;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await maybeNudgeForNpxInstall(url);
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('shouldNudgeForNpx', () => {
  it('returns false for null hash regardless of state', async () => {
    expect(await shouldNudgeForNpx(null)).toBe(false);
  });
  it('returns false when the disabled env var is set', async () => {
    process.env.SYNTAUR_SKIP_HANDLER_NUDGE = 'yes';
    expect(await shouldNudgeForNpx('h-anything')).toBe(false);
  });
  it('returns true for a fresh hash when not disabled', async () => {
    expect(await shouldNudgeForNpx('h-fresh')).toBe(true);
  });
  it('returns false after recordNudge has fired for that hash', async () => {
    await recordNudge('h1');
    expect(await shouldNudgeForNpx('h1')).toBe(false);
  });
});

describe('nudgeStampPath sanitization', () => {
  it('replaces unsafe characters and never escapes the stamp dir', () => {
    const safe = nudgeStampPath('../../etc/passwd');
    expect(safe.startsWith(nudgeStampDir())).toBe(true);
    expect(safe.includes('..')).toBe(false);
    expect(safe.includes('/etc/')).toBe(false);
  });

  it('returns a stable path for clean hashes', () => {
    const a = nudgeStampPath('abc-123_DEF');
    expect(a).toBe(join(nudgeStampDir(), 'abc-123_DEF'));
  });
});

describe('nudgeMessage', () => {
  it('returns the exact literal required by the assignment AC', () => {
    expect(nudgeMessage()).toBe(
      'syntaur: running from npx — the syntaur:// deep-link handler is not registered. Install durably with `npm i -g syntaur` to enable "Open in agent" buttons.',
    );
  });
});
