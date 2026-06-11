import { describe, it, expect, vi } from 'vitest';

// Partial-mock terminal-probe: pin only `probeTerminalInstalled` to a positive
// cmux result (the running-app path resolved via lsappinfo), keeping the real
// APP_BUNDLE_IDS / CLI_NAMES that the doctor check also reads. This proves the
// AC5 consumer chain — doctor's `terminal.installed` check reports installed
// purely through the shared probe — without touching the host or lsappinfo.
vi.mock('../utils/terminal-probe.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../utils/terminal-probe.js')>();
  return {
    ...actual,
    probeTerminalInstalled: vi.fn(() => ({
      ok: true,
      foundPath: '/Volumes/cmux/cmux.app/Contents/Resources/bin/cmux',
    })),
  };
});

import { terminalChecks } from '../utils/doctor/checks/terminal.js';
import type { CheckContext } from '../utils/doctor/types.js';

describe('doctor terminal.installed consumes probeTerminalInstalled (cmux via lsappinfo)', () => {
  it('passes with the running-app foundPath when the shared probe resolves cmux', async () => {
    const check = terminalChecks.find((c) => c.id === 'terminal.installed');
    expect(check).toBeDefined();

    // The check only reads ctx.config (via getTerminal); a minimal config with
    // terminal pinned to cmux is sufficient.
    const ctx = {
      config: { terminal: 'cmux' },
    } as unknown as CheckContext;

    const result = await check!.run(ctx);
    const single = Array.isArray(result) ? result[0] : result;

    expect(single.status).toBe('pass');
    // cmux has no APP_BUNDLE_IDS entry, so the detail uses the CLI-name form.
    expect(single.detail).toContain('resolved cmux');
    expect(single.detail).toContain(
      '/Volumes/cmux/cmux.app/Contents/Resources/bin/cmux',
    );
  });
});
