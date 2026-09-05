/**
 * Pure helpers for harness slash commands — parsing `available_commands_update`,
 * detecting a leading `/command` in human text, and comparing command lists.
 */

import type { ChatEvent, Harness } from './types.js';

export type ChatCommandAction =
  | { kind: 'prompt' }
  | { kind: 'set-config'; configId: string; value: string };

export interface ChatCommand {
  name: string;
  description: string;
  inputHint: string | null;
  action: ChatCommandAction;
}

export type ChatCommandsSource = 'session' | 'harness-cache';

const SLUG_CHAR = /[A-Za-z0-9_-]/;
const COMMAND_NAME = /[A-Za-z0-9:_.-]+/;

interface AvailableCommandEntry {
  name?: unknown;
  description?: unknown;
  input?: { hint?: unknown } | null;
  _meta?: { commandAction?: { kind?: unknown; configId?: unknown; value?: unknown } } | null;
}

interface AvailableCommandsUpdate {
  sessionUpdate?: string;
  availableCommands?: unknown;
}

function parseAction(entry: AvailableCommandEntry): ChatCommandAction {
  const action = entry._meta?.commandAction;
  if (
    action?.kind === 'setConfigOption' &&
    typeof action.configId === 'string' &&
    typeof action.value === 'string'
  ) {
    return { kind: 'set-config', configId: action.configId, value: action.value };
  }
  return { kind: 'prompt' };
}

/** Map an `available_commands_update` payload into stable-order `ChatCommand[]`. */
export function parseAvailableCommands(update: unknown): ChatCommand[] {
  const payload = update as AvailableCommandsUpdate;
  const raw = payload.availableCommands;
  if (!Array.isArray(raw)) return [];
  const commands: ChatCommand[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as AvailableCommandEntry;
    if (typeof e.name !== 'string' || !e.name) continue;
    const hint = e.input && typeof e.input.hint === 'string' ? e.input.hint : null;
    commands.push({
      name: e.name,
      description: typeof e.description === 'string' ? e.description : '',
      inputHint: hint,
      action: parseAction(e),
    });
  }
  return commands;
}

export interface DetectedCommand {
  name: string;
  args: string;
  /** `/name` or `/name args` — what the harness should receive. */
  line: string;
  /** Leading attached mentions stripped before the slash. */
  mentions: string[];
}

/**
 * When human text is a slash command: optional leading attached `@mentions`, then
 * `/name` with optional args. Mid-text `/` is not a command.
 */
export function detectCommand(text: string, attachedIds: readonly string[]): DetectedCommand | null {
  const byLower = new Map(attachedIds.map((id) => [id.toLowerCase(), id]));
  let rest = text;
  const mentions: string[] = [];

  // Strip a run of leading mention tokens (attached only), each followed by whitespace.
  for (;;) {
    const trimmed = rest.trimStart();
    const leadingWs = rest.length - trimmed.length;
    if (leadingWs > 0 && rest.slice(0, leadingWs).trim().length > 0) break;
    rest = trimmed;
    if (!rest.startsWith('@')) break;
    let i = 1;
    while (i < rest.length && SLUG_CHAR.test(rest[i])) i++;
    const token = rest.slice(1, i);
    const id = byLower.get(token.toLowerCase());
    if (!id) break;
    mentions.push(id);
    rest = rest.slice(i).trimStart();
  }

  if (!rest.startsWith('/')) return null;
  const nameMatch = rest.slice(1).match(new RegExp(`^(${COMMAND_NAME.source})`));
  if (!nameMatch) return null;
  const name = nameMatch[1];
  const afterName = rest.slice(1 + name.length);
  const args = afterName.trimStart();
  const line = args ? `/${name} ${args}` : `/${name}`;
  return { name, args, line, mentions };
}

const HARNESS_MARKERS = new Set(['session.created', 'session.resumed', 'session.rotated']);

/**
 * Newest `available_commands_update` in a session's events, only when the newest
 * harness marker names the current harness.
 */
export function latestAdvertisedCommands(events: ChatEvent[], harness: Harness): ChatCommand[] | null {
  let candidate: ChatCommand[] | null = null;

  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind === 'acp.update') {
      const payload = event.payload as { sessionUpdate?: string };
      if (payload.sessionUpdate === 'available_commands_update' && candidate === null) {
        const parsed = parseAvailableCommands(payload);
        candidate = parsed.length > 0 ? parsed : null;
      }
      continue;
    }
    if (HARNESS_MARKERS.has(event.kind)) {
      if (candidate === null) return null;
      const payload = event.payload as { harness?: unknown };
      if (typeof payload.harness !== 'string') return null;
      return payload.harness === harness ? candidate : null;
    }
  }

  return candidate;
}

/** Deep equality for deduping command lists before persist/emit. */
export function commandsEqual(a: readonly ChatCommand[], b: readonly ChatCommand[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (
      left.name !== right.name ||
      left.description !== right.description ||
      left.inputHint !== right.inputHint ||
      left.action.kind !== right.action.kind
    ) {
      return false;
    }
    if (left.action.kind === 'set-config' && right.action.kind === 'set-config') {
      if (left.action.configId !== right.action.configId || left.action.value !== right.action.value) {
        return false;
      }
    }
  }
  return true;
}
