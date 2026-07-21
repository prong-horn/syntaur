// Claude adapter: hook-driven via the spool (latest opinionated event wins);
// generic screen heuristics only when the spool is silent (claude launched
// without the syntaur plugin's hooks). Payloads are the hook's stdin JSON
// dumped verbatim by spool-event.sh (D3) — parse defensively, consume the
// few fields probed against Claude Code 2.1.215, ignore the rest.
import type { DeriveInput, DerivedState, HookEvent } from '../types.js';
import { genericAdapter } from './generic.js';
import type { AgentAdapter } from './types.js';

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** One event's opinion, or null when the event says nothing about attention. */
function opinionFor(e: HookEvent): DerivedState | null {
  const payload = asRecord(e.payload);
  switch (e.event) {
    case 'PermissionRequest': {
      const tool = payload && typeof payload.tool_name === 'string' && payload.tool_name !== '' ? payload.tool_name : null;
      return { state: 'blocked', needs: tool ? `permission: ${tool}` : 'permission prompt' };
    }
    case 'Notification': {
      const kind = payload && typeof payload.notification_type === 'string' ? payload.notification_type : '';
      if (kind === 'permission_prompt') {
        const msg =
          payload && typeof payload.message === 'string' && payload.message.trim() !== ''
            ? payload.message
            : null;
        return { state: 'blocked', needs: msg ?? 'permission prompt' };
      }
      if (kind === 'idle_prompt') return { state: 'blocked', needs: 'waiting for input' };
      return null; // auth_success etc.: no attention opinion
    }
    case 'Stop':
    case 'SessionStart':
      return { state: 'working', needs: null };
    default:
      return null; // unknown/future events ignored
  }
}

export const claudeAdapter: AgentAdapter = {
  id: 'claude',
  deriveState: (x: DeriveInput): DerivedState => {
    for (let i = x.hookEvents.length - 1; i >= 0; i -= 1) {
      const evt = x.hookEvents[i];
      if (evt === undefined) continue;
      const opinion = opinionFor(evt);
      if (opinion !== null) return opinion;
    }
    return genericAdapter.deriveState(x); // spool silent: heuristics fallback
  },
};
