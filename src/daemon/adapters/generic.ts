// Generic screen-heuristics adapter. Bias toward 'working' (research doc
// 2026-07-08 §7): only strong patterns on the PROMPT LINE (last non-blank
// viewport row), held for an idle threshold, flip to blocked.
import type { DeriveInput, DerivedState } from '../types.js';
import type { AgentAdapter } from './types.js';

/** Idle required before an approval-looking prompt line counts as blocked. */
export const APPROVAL_IDLE_MS = 2000;
/** Idle required before a bare REPL prompt counts as blocked (shells sit at
 * prompts legitimately — demand much longer silence). */
export const REPL_IDLE_MS = 10_000;

interface PromptPattern {
  re: RegExp;
  needs: string;
  idleMs: number;
}

const PATTERNS: PromptPattern[] = [
  { re: /\((?:y\/n|yes\/no)\)\s*[:>]?\s*$/i, needs: 'confirm (y/n)', idleMs: APPROVAL_IDLE_MS },
  { re: /\[(?:y\/n|yes\/no)\]\s*[:>]?\s*$/i, needs: 'confirm [y/N]', idleMs: APPROVAL_IDLE_MS },
  { re: /\ballow\b[^?]*\?\s*$/i, needs: 'approval prompt', idleMs: APPROVAL_IDLE_MS },
  { re: /(?:password|passphrase)[^:]*:\s*$/i, needs: 'password prompt', idleMs: APPROVAL_IDLE_MS },
  { re: /^(?:❯|\$|>)\s*$/, needs: 'waiting at prompt', idleMs: REPL_IDLE_MS },
];

function promptLine(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line !== undefined && line.trim() !== '') return line;
  }
  return null;
}

export const genericAdapter: AgentAdapter = {
  id: 'generic',
  deriveState: (x: DeriveInput): DerivedState => {
    const line = promptLine(x.screen.lines);
    if (line !== null) {
      for (const p of PATTERNS) {
        if (x.outputIdleMs >= p.idleMs && p.re.test(line)) {
          return { state: 'blocked', needs: p.needs };
        }
      }
    }
    return { state: 'working', needs: null };
  },
};
