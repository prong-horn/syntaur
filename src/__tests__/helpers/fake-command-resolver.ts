import type { CommandResolution } from '../../chat/harnesses.js';
import type { HarnessSpec } from '../../chat/types.js';

/** Stable fake adapter path for in-process broker tests (no real harness on PATH). */
export function fakeCommandResolver(spec: HarnessSpec): CommandResolution {
  return { path: `/fake/bin/${spec.command}`, installHint: null };
}

export function missingCommandResolver(spec: HarnessSpec): CommandResolution {
  return { path: null, installHint: spec.installHint };
}
