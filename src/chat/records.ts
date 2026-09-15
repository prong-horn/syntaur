import { isAbsolute, relative } from 'node:path';
import { appendTypedLogEntry } from '../lifecycle/log-append.js';
import type { ChatItem, FileChatRecordInput, FiledChatRecord } from './types.js';
import { HUMAN_AGENT_ID } from './types.js';

const EDIT_KINDS = new Set(['edit', 'delete', 'move']);

export function formatDurationMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }
  return `${seconds}s`;
}

/** Cut at a paragraph boundary when possible; append an ellipsis when shortened. */
export function clipExcerpt(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;

  let cut = trimmed.slice(0, max);
  const lastBlank = cut.lastIndexOf('\n\n');
  if (lastBlank > 0) {
    cut = cut.slice(0, lastBlank);
  } else {
    const lastPeriod = cut.lastIndexOf('. ');
    const lastNewline = cut.lastIndexOf('\n');
    const boundary = Math.max(lastPeriod, lastNewline);
    if (boundary > 0) {
      cut = cut.slice(0, boundary + (lastPeriod === boundary ? 1 : 0));
    }
  }

  return `${cut.trim()}…`;
}

function relativePath(cwd: string | null, path: string): string {
  if (!cwd) return path;
  const rel = relative(cwd, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel === path) return path;
  return rel;
}

function collectEditedPaths(items: ChatItem[], cwd: string | null): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const item of items) {
    if (item.type !== 'agent.work') continue;
    for (const row of item.tools) {
      if (!EDIT_KINDS.has(row.kind)) continue;
      for (const loc of row.locations) {
        const display = relativePath(cwd, loc.path);
        if (!seen.has(display)) {
          seen.add(display);
          paths.push(display);
        }
      }
    }
  }
  return paths;
}

export function buildTurnProgressEntry(input: {
  agentId: string;
  durationMs: number;
  items: ChatItem[];
  cwd: string | null;
  turnId: string;
}): string | null {
  let edits = 0;
  let runs = 0;
  let reads = 0;
  let failed = 0;

  for (const item of input.items) {
    if (item.type !== 'agent.work') continue;
    edits += item.summary.edits;
    runs += item.summary.runs;
    reads += item.summary.reads;
    failed += item.summary.failed;
  }

  if (edits + runs === 0) return null;

  const duration = formatDurationMs(input.durationMs);
  let lead =
    `**@${input.agentId}** worked ${duration} in chat — edited ${edits} file(s), ran ${runs} command(s), read ${reads}`;
  if (failed > 0) lead += ` (${failed} failed)`;
  lead += '.';

  const lines: string[] = [lead];

  const editedPaths = collectEditedPaths(input.items, input.cwd);
  if (editedPaths.length > 0) {
    const shown = editedPaths.slice(0, 8);
    const more = editedPaths.length - shown.length;
    let editedLine = `Edited: ${shown.map((p) => `\`${p}\``).join(', ')}`;
    if (more > 0) editedLine += `, +${more} more`;
    lines.push(editedLine);
  }

  const replyTexts = input.items
    .filter((item): item is ChatItem & { type: 'agent.message'; text: string } =>
      item.type === 'agent.message' && item.sealed,
    )
    .map((item) => item.text.trim())
    .filter((text) => text.length > 0);

  const excerpt = replyTexts.length > 0 ? clipExcerpt(replyTexts.join('\n\n'), 600) : '(no reply text)';
  const blockquote = excerpt
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  lines.push(blockquote);

  lines.push(`Chat turn \`${input.turnId}\`.`);

  return lines.join('\n\n');
}

export function provenanceLine(source: { agentId: string; ts: string }): string {
  if (source.agentId === HUMAN_AGENT_ID) {
    return `_Filed from chat (you, ${source.ts})._`;
  }
  return `_Filed from chat (@${source.agentId}, ${source.ts})._`;
}

/** Escape markdown heading lines so record parsers do not treat them as new sections. */
export function escapeHeadings(text: string): string {
  return text.replace(/^( {0,3})(#{1,6})(?=\s|$)/gm, (_match, indent: string, hashes: string) => {
    return `${indent}\\${hashes}`;
  });
}

export async function fileChatRecord(input: {
  ticketDir: string;
  ticketRef: string;
  ticketId: string;
  record: FileChatRecordInput;
  source: { agentId: string; ts: string };
}): Promise<FiledChatRecord> {
  const { record, source } = input;
  const trimmed = record.body.trim();
  const body = `${escapeHeadings(trimmed)}\n\n${provenanceLine(source)}`;
  const author = source.agentId === HUMAN_AGENT_ID ? 'human' : source.agentId;

  const { timestamp } = await appendTypedLogEntry({
    ticketDir: input.ticketDir,
    ticketId: input.ticketId,
    type: record.kind,
    body,
    author,
  });

  const labels: Record<FileChatRecordInput['kind'], string> = {
    decision: 'a decision entry',
    progress: 'a progress entry',
    note: 'a note entry',
    question: 'a question entry',
  };

  return {
    kind: record.kind,
    ref: timestamp,
    label: labels[record.kind],
  };
}
