/**
 * The chat event log — `<assignmentDir>/chat/events.jsonl`, the source of truth
 * (Decision 2).
 *
 * Append-only, one JSON object per line, with the same discipline as
 * `src/schedules/event-log.ts`: reads tolerate a torn final line (a crash
 * mid-append), and the directory is created on first use. `seq` is recovered
 * from the last intact line on reopen, so ids stay monotonic across restarts.
 *
 * `rebuildChatIndex` replays the whole log through a fresh `ChatNormalizer` and
 * rewrites `chat_items`. It is both the recovery path and the invariant a test
 * pins: live items and rebuilt items are equal.
 */

import { appendFile, mkdir, open, readFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ChatNormalizer } from './normalizer.js';
import { applyChatPatch, countChatItems, deleteChatItems } from '../db/chat-db.js';
import type { ChatEvent, ChatEventKind, ChatItem } from './types.js';

export function chatDir(assignmentDir: string): string {
  return resolve(assignmentDir, 'chat');
}

export function chatLogPath(assignmentDir: string): string {
  return resolve(chatDir(assignmentDir), 'events.jsonl');
}

export interface AppendEventInput {
  assignmentId: string;
  agentId: string;
  sessionKey: string;
  turnId: string | null;
  kind: ChatEventKind;
  payload: unknown;
  /** Overrides the timestamp (tests). */
  ts?: string;
}

export interface ChatLog {
  readonly path: string;
  /** Next `seq` this log will assign. */
  readonly nextSeq: number;
  append(input: AppendEventInput): Promise<ChatEvent>;
  readAll(): Promise<ChatEvent[]>;
  readAfter(seq: number): Promise<ChatEvent[]>;
}

/**
 * Open (or create) an assignment's chat log. Appends are serialised through an
 * internal promise chain so two concurrent turns cannot interleave a partial
 * line or reuse a `seq`.
 */
export async function openChatLog(assignmentDir: string): Promise<ChatLog> {
  const path = chatLogPath(assignmentDir);
  await mkdir(chatDir(assignmentDir), { recursive: true });

  // Repair a torn final line before appending anything: a crash mid-write leaves
  // a fragment with no newline, and appending onto it would splice the next
  // event into the fragment and lose BOTH. Terminating it leaves one
  // unparseable line that `readEvents` skips, and new events start clean.
  await terminateTornLine(path);

  const existing = await readEvents(path);
  let seq = existing.length > 0 ? existing[existing.length - 1].seq + 1 : 0;
  let tail: Promise<unknown> = Promise.resolve();

  return {
    path,
    get nextSeq() {
      return seq;
    },
    append(input: AppendEventInput): Promise<ChatEvent> {
      const event: ChatEvent = {
        seq: seq++,
        ts: input.ts ?? new Date().toISOString(),
        assignmentId: input.assignmentId,
        agentId: input.agentId,
        sessionKey: input.sessionKey,
        turnId: input.turnId,
        kind: input.kind,
        payload: input.payload,
      };
      const write = tail.then(() => appendFile(path, `${JSON.stringify(event)}\n`, 'utf-8'));
      // Keep the chain alive after a failed write so one ENOSPC does not wedge
      // every later append.
      tail = write.catch(() => {});
      return write.then(() => event);
    },
    readAll: () => readEvents(path),
    readAfter: async (after: number) => (await readEvents(path)).filter((e) => e.seq > after),
  };
}

/** Terminate an unterminated final line, so the next append cannot splice into it. */
async function terminateTornLine(path: string): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(path, 'r+');
  } catch {
    return; // no log yet
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return;
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, size - 1);
    if (last[0] !== 0x0a) await handle.write('\n', size);
  } finally {
    await handle.close();
  }
}

/**
 * Read every event in order. A torn final line (no trailing newline after a
 * crash) is dropped rather than throwing — the next append starts a fresh line.
 */
export async function readEvents(path: string): Promise<ChatEvent[]> {
  let content: string;
  try {
    content = await readFile(path, 'utf-8');
  } catch {
    return [];
  }
  const events: ChatEvent[] = [];
  for (const line of content.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      events.push(JSON.parse(line) as ChatEvent);
    } catch {
      // Only the last line may legitimately be torn; earlier corruption is
      // skipped too rather than poisoning the whole read.
    }
  }
  return events;
}

export interface RebuildResult {
  events: number;
  items: number;
  deleted: number;
}

/**
 * Replay the log through a fresh normalizer and rewrite the assignment's index.
 * The recovery path AND the `rebuild == live` invariant.
 */
export async function rebuildChatIndex(
  assignmentDir: string,
  assignmentId: string,
): Promise<RebuildResult> {
  const events = await readEvents(chatLogPath(assignmentDir));
  const deleted = deleteChatItems(assignmentId);

  const bySession = new Map<string, ChatNormalizer>();
  for (const event of events) {
    let normalizer = bySession.get(event.sessionKey);
    if (!normalizer) {
      normalizer = new ChatNormalizer({
        assignmentId,
        agentId: event.agentId,
        sessionKey: event.sessionKey,
      });
      bySession.set(event.sessionKey, normalizer);
    }
    for (const patch of normalizer.ingest(event)) applyChatPatch(event.sessionKey, patch);
  }
  return { events: events.length, items: countChatItems(assignmentId), deleted };
}

/** Convenience for callers that want the items straight from a rebuild. */
export function replayItems(events: ChatEvent[], assignmentId: string): ChatItem[] {
  const bySession = new Map<string, ChatNormalizer>();
  const items = new Map<string, ChatItem>();
  for (const event of events) {
    let normalizer = bySession.get(event.sessionKey);
    if (!normalizer) {
      normalizer = new ChatNormalizer({
        assignmentId,
        agentId: event.agentId,
        sessionKey: event.sessionKey,
      });
      bySession.set(event.sessionKey, normalizer);
    }
    for (const patch of normalizer.ingest(event)) {
      if (patch.op === 'retract') items.delete(patch.itemId);
      else items.set(patch.item.itemId, patch.item);
    }
  }
  return [...items.values()].sort(
    (a, b) => a.seqFirst - b.seqFirst || a.itemId.localeCompare(b.itemId),
  );
}
