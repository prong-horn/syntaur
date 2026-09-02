/**
 * Pure helpers behind the work-card block renderers. They live here rather than
 * in `components/chat/blocks.tsx` so they unit-test under the node-env dashboard
 * vitest config, which has no JSX pipeline.
 */

import { diffLines } from 'diff';

/** Hard cap on raw I/O text (`buzz-agent` bounds tool-result text the same way). */
export const RAW_IO_CAP = 50 * 1024;

/**
 * Strip ANSI escapes. Phase 2 advertises no client `terminal` capability
 * (Decision 6), so command output arrives as text the agent already captured,
 * which may still carry its colouring.
 */
export function stripAnsi(text: string): string {
  // CSI sequences only, anchored on the ESC — without the \u001B this would
  // also eat ordinary bracketed text such as a markdown link.
  return text.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx';
  text: string;
}

/** Flatten a unified diff into renderable lines. */
export function toDiffLines(oldText: string | null, newText: string): DiffLine[] {
  const out: DiffLine[] = [];
  for (const part of diffLines(oldText ?? '', newText ?? '')) {
    const kind: DiffLine['kind'] = part.added ? 'add' : part.removed ? 'del' : 'ctx';
    for (const line of part.value.replace(/\n$/, '').split('\n')) {
      out.push({ kind, text: line });
    }
  }
  return out;
}

/** Pretty-print a tool's raw input/output for the disclosure. */
export function prettyJson(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Apply {@link RAW_IO_CAP}, with a visible marker when it bites. */
export function capRawIo(body: string): string {
  return body.length > RAW_IO_CAP
    ? `${body.slice(0, RAW_IO_CAP)}\n… truncated at ${RAW_IO_CAP} bytes`
    : body;
}
