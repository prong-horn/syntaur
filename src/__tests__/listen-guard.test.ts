import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { findListenGuardViolations, scanTestTree } from './helpers/listen-guard-scan.js';

describe('listen guard', () => {
  it('flags a listen call without 127.0.0.1', () => {
    const bad = `
      server.listen(0, () => ready());
    `;
    expect(findListenGuardViolations(bad, 'snippet')).toEqual(['snippet:2']);
  });

  it('ignores .listen( that appears only inside a string', () => {
    const doc = `
      const hint = "app.listen(0, () => {}) binds the wildcard";
    `;
    expect(findListenGuardViolations(doc, 'snippet')).toEqual([]);
  });

  it('matches calls whose argument list spans multiple lines', () => {
    const ok = `
      app.listen(
        0,
        '127.0.0.1',
        () => ready(),
      );
    `;
    expect(findListenGuardViolations(ok, 'snippet')).toEqual([]);

    const bad = `
      app.listen(
        0,
        () => ready(),
      );
    `;
    expect(findListenGuardViolations(bad, 'snippet')).toEqual(['snippet:2']);
  });

  it('accepts a compliant call and the ignore marker', () => {
    const good = `
      app.listen(0, '127.0.0.1', () => ready());
      server.listen(port, () => resolve()); // listen-guard: ignore
    `;
    expect(findListenGuardViolations(good, 'snippet')).toEqual([]);
  });

  it('every test listen binds 127.0.0.1', async () => {
    const root = join(import.meta.dirname, '.');
    const violations = await scanTestTree(root);
    expect(violations).toEqual([]);
  });
});
