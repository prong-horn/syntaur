import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkClaudeBgAvailable, resetClaudeBgAvailableCache, checkClaudeAttachCommand, resolveClaudeAttachBinary, resetClaudeAttachCommandCache } from '../capability.js';

afterEach(() => resetClaudeBgAvailableCache());

describe('checkClaudeBgAvailable', () => {
  it('resolves true when the probe succeeds', async () => {
    expect(await checkClaudeBgAvailable(async () => 'ok')).toBe(true);
  });

  it('resolves false (never rejects) when the probe fails', async () => {
    expect(await checkClaudeBgAvailable(async () => { throw new Error('ENOENT'); })).toBe(false);
  });

  it('memoizes across calls — the probe runs at most once', async () => {
    const probe = vi.fn(async () => 'ok');
    await checkClaudeBgAvailable(probe);
    await checkClaudeBgAvailable(probe);
    await checkClaudeBgAvailable(probe);
    expect(probe).toHaveBeenCalledOnce();
  });

  it('resetClaudeBgAvailableCache forces a fresh probe', async () => {
    const probe = vi.fn(async () => 'ok');
    await checkClaudeBgAvailable(probe);
    resetClaudeBgAvailableCache();
    await checkClaudeBgAvailable(probe);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

describe('resolveClaudeAttachBinary / checkClaudeAttachCommand', () => {
  afterEach(() => resetClaudeAttachCommandCache());

  const ATTACH_USAGE = 'Usage: claude attach <id>\n\n  Open the background session in this terminal.';
  const GENERAL_HELP = 'Usage: claude [options] [command] [prompt]\n\nClaude Code - starts an interactive session by default';

  it('resolves the candidate that prints attach-specific usage', async () => {
    const bin = await resolveClaudeAttachBinary(async () => ({ stdout: ATTACH_USAGE }), () => ['/real/claude']);
    expect(bin).toBe('/real/claude');
    resetClaudeAttachCommandCache();
    expect(await checkClaudeAttachCommand(async () => ({ stdout: ATTACH_USAGE }), () => ['/real/claude'])).toBe(true);
  });

  it('REGRESSION (cmux shim): skips a first candidate answering GENERAL help and pins the shadowed real binary', async () => {
    // Root-caused live: cmux's CLI shim sat first on PATH and answered
    // `attach --help` with the general help (attach through it opens a NEW
    // session prompted "attach <id>"), while the real claude sat shadowed
    // right behind it. The resolver must probe past the shim.
    const probe = vi.fn(async (binary: string) => ({ stdout: binary.includes('shim') ? GENERAL_HELP : ATTACH_USAGE }));
    const bin = await resolveClaudeAttachBinary(probe, () => ['/tmp/cmux-cli-shims/x/claude', '/Users/u/.local/bin/claude']);
    expect(bin).toBe('/Users/u/.local/bin/claude');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('FALSE when every candidate answers the GENERAL help — old claude everywhere', async () => {
    expect(await checkClaudeAttachCommand(async () => ({ stdout: GENERAL_HELP }), () => ['/a/claude', '/b/claude'])).toBe(false);
  });

  it('true when the usage arrives on STDERR (some CLI versions print help there)', async () => {
    expect(await checkClaudeAttachCommand(async () => ({ stdout: '', stderr: ATTACH_USAGE }), () => ['/real/claude'])).toBe(true);
  });

  it('false with no candidates on PATH, and false when the probe rejects — never rejects itself', async () => {
    expect(await checkClaudeAttachCommand(async () => ({ stdout: ATTACH_USAGE }), () => [])).toBe(false);
    resetClaudeAttachCommandCache();
    expect(await checkClaudeAttachCommand(async () => { throw new Error('ENOENT'); }, () => ['/a/claude'])).toBe(false);
  });

  it('memoizes the resolution process-wide', async () => {
    const probe = vi.fn(async () => ({ stdout: ATTACH_USAGE }));
    await checkClaudeAttachCommand(probe, () => ['/real/claude']);
    await checkClaudeAttachCommand(probe, () => ['/real/claude']);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
