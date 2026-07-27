import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkClaudeBgAvailable, resetClaudeBgAvailableCache, checkClaudeAttachCommand, resetClaudeAttachCommandCache } from '../capability.js';

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

describe('checkClaudeAttachCommand', () => {
  afterEach(() => resetClaudeAttachCommandCache());

  it('true when the probe returns attach-specific usage (hidden command registered)', async () => {
    expect(await checkClaudeAttachCommand(async () => ({
      stdout: 'Usage: claude attach <id>\n\n  Open the background session in this terminal.',
    }))).toBe(true);
  });

  it('FALSE when the probe returns the GENERAL help — an old claude without the hidden command', async () => {
    // On such a claude `attach <short>` would be consumed as the [prompt] and
    // launch a NEW session (the 0.78.0 bug) — exit code 0 both ways, so the
    // probe must discriminate on the usage TEXT, never the exit code.
    expect(await checkClaudeAttachCommand(async () => ({
      stdout: 'Usage: claude [options] [command] [prompt]\n\nClaude Code - starts an interactive session by default',
    }))).toBe(false);
  });

  it('false when the probe rejects (claude missing), and never rejects', async () => {
    expect(await checkClaudeAttachCommand(async () => { throw new Error('ENOENT'); })).toBe(false);
  });

  it('memoizes the probe process-wide', async () => {
    const probe = vi.fn(async () => ({ stdout: 'Usage: claude attach <id>' }));
    await checkClaudeAttachCommand(probe);
    await checkClaudeAttachCommand(probe);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
