import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { nowTimestamp } from '../utils/timestamp.js';
import { renderDecisionRecord } from '../templates/index.js';
import { parseDecisionRecord } from '../dashboard/parser.js';

function formatYamlValue(value: boolean | number | string | null): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value);
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return `"${value}"`;
  }
  if (value === '' || /[:#{}[\],&*?|>!%@`]/.test(value) || /^\s|\s$/.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Exported for regression testing (AC5). Pure string transform.
export function setTopLevelField(
  content: string,
  key: string,
  value: boolean | number | string | null,
): string {
  const formatted = formatYamlValue(value);

  // Operate ONLY within the frontmatter block. The field regex uses the `m`
  // flag, so testing it against the whole document would match (and rewrite) a
  // body line that happens to start with `key:` — and, when the field is absent
  // from frontmatter, would never insert it. Scope to the frontmatter substring
  // so both cases are safe.
  const closingIdx = content.indexOf('\n---', 4);
  if (closingIdx === -1) {
    return content;
  }
  const frontmatter = content.slice(0, closingIdx);
  const rest = content.slice(closingIdx);
  const fieldRegex = new RegExp(`^(${escapeRegExp(key)}:)\\s*.*$`, 'm');

  if (fieldRegex.test(frontmatter)) {
    return `${frontmatter.replace(fieldRegex, `$1 ${formatted}`)}${rest}`;
  }

  return `${frontmatter}\n${key}: ${formatted}${rest}`;
}

export function appendLogEntry(
  existingContent: string,
  countField: 'handoffCount' | 'decisionCount',
  nextCount: number,
  heading: string,
  body: string,
  emptyPlaceholder: string,
): string {
  const timestamp = nowTimestamp();
  let next = setTopLevelField(existingContent, 'updated', timestamp);
  next = setTopLevelField(next, countField, nextCount);

  const entryBody = body.trim();
  const entry = `## ${heading}\n\n**Recorded:** ${timestamp}\n\n${entryBody}\n`;

  if (next.includes(emptyPlaceholder)) {
    return next.replace(emptyPlaceholder, entry.trimEnd());
  }

  return `${next.trimEnd()}\n\n${entry}`;
}

export interface AppendDecisionEntryInput {
  assignmentDir: string;
  assignmentRef: string;
  title: string;
  body: string;
}

/** Read-or-scaffold `decision-record.md`, append one decision, write atomically. */
export async function appendDecisionEntry(
  input: AppendDecisionEntryInput,
): Promise<{ number: number; title: string }> {
  const path = resolve(input.assignmentDir, 'decision-record.md');
  const timestamp = nowTimestamp();

  const content = (await fileExists(path))
    ? await readFile(path, 'utf-8')
    : renderDecisionRecord({ assignmentSlug: input.assignmentRef, timestamp });

  const parsed = parseDecisionRecord(content);
  const nextNumber = parsed.decisionCount + 1;
  const title = input.title.trim();
  const next = appendLogEntry(
    content,
    'decisionCount',
    nextNumber,
    title,
    input.body,
    'No decisions recorded yet.',
  );
  await writeFileForce(path, next);
  return { number: nextNumber, title };
}
