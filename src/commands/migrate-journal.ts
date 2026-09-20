/**
 * `syntaur migrate journal` — merge legacy record files into journal.md (SV-9 decision 9).
 *
 * Dry-run by default. Per-ticket or `--project <slug> --all` for legacy tickets.
 */

import { Command } from 'commander';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expandHome, syntaurRoot } from '../utils/paths.js';
import { readConfig } from '../utils/config.js';
import { fileExists, writeFileForce } from '../utils/fs.js';
import { resolveTicketTarget, type TicketTargetOptions } from '../utils/ticket-target.js';
import { listTicketsByProject } from '../utils/ticket-walk.js';
import { parseTicketFrontmatter, updateTicketFile } from '../lifecycle/frontmatter.js';
import { emitEvent } from '../lifecycle/event-emit.js';
import { seedMissingBuiltins } from '../ticket-templates/builtins.js';
import { loadTemplate } from '../ticket-templates/registry.js';
import { logRoleFile } from '../ticket-templates/manifest.js';
import { injectPurpose } from '../ticket-templates/scaffold.js';
import { formatLogEntry, parseLogEntries } from '../ticket-templates/log-reader.js';
import type { LogEntryType } from '../ticket-templates/manifest.js';
import { nonEmptyBeyondScaffold } from '../ticket-templates/content.js';
import { parseScratchpad } from '../dashboard/parser.js';
import { initEventsDb } from '../db/events-db.js';

export const MIGRATE_JOURNAL_BACKUP_DIR = '.migrate-journal.bak';
export const MIGRATE_JOURNAL_COMPLETE_MARKER = '.complete';
export const JOURNAL_FILENAME = 'journal.md';
export const JOURNAL_TMP_FILENAME = 'journal.md.tmp';

export const SOURCE_FILES = [
  'progress.md',
  'decision-record.md',
  'handoff.md',
  'comments.md',
  'scratchpad.md',
] as const;

export type MigrateJournalSource = (typeof SOURCE_FILES)[number];

const SOURCE_ORDER: Record<MigrateJournalSource, number> = {
  'progress.md': 0,
  'decision-record.md': 1,
  'handoff.md': 2,
  'comments.md': 3,
  'scratchpad.md': 4,
};

export interface MigratableEntry {
  timestamp: string;
  type: LogEntryType;
  author: string;
  keys?: Record<string, string>;
  body: string;
  source: MigrateJournalSource;
  seqInSource: number;
}

export interface SourceCounts {
  entries: number;
  undated: number;
  rawBlocks: number;
}

export interface MigrateJournalTranscriptLine {
  source: MigrateJournalSource | 'summary';
  text: string;
}

export interface MigrateJournalResult {
  ticketId: string;
  refused?: boolean;
  refuseReason?: string;
  resumed?: boolean;
  lines: MigrateJournalTranscriptLine[];
  totalEntries: number;
  undated: number;
  rawBlocks: number;
  targetPath: string;
}

export interface MigrateJournalOptions extends TicketTargetOptions {
  template?: string;
  apply?: boolean;
  all?: boolean;
  hooks?: MigrateJournalHooks;
}

export interface MigrateJournalHooks {
  beforeDeleteSources?: () => void | Promise<void>;
  /** @internal Test hook for backup copy failures. */
  copySourceFile?: (src: string, dest: string) => Promise<void>;
}

function demoteBodyHeadings(body: string): string {
  return body.replace(/^## /gm, '### ');
}

function mapAuthor(author: string): string {
  return author === 'brennen' ? 'human' : author;
}

function normalizeRecordedTimestamp(raw: string): string {
  const trimmed = raw.trim().replace(/^["']|["']$/g, '');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(trimmed)) return trimmed;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(trimmed)) {
    return trimmed.replace(/\.\d+Z$/, 'Z');
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return `${trimmed}T00:00:00Z`;
  return trimmed;
}

function extractFrontmatterBody(content: string): { fm: string; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { fm: '', body: content };
  return { fm: match[1], body: match[2] ?? '' };
}

function frontmatterScalar(fm: string, key: string): string {
  const match = fm.match(new RegExp(`^${key}:\\s*"?([^"\\n]+)"?\\s*$`, 'm'));
  return match?.[1]?.trim() ?? '';
}

function splitDecisionBlocks(body: string): Array<{ heading: string; block: string }> {
  const parts = body.split(/^## (?:Decision \d+(?::\s*[^\n]*)?|DR-\d+:\s*[^\n]*)\s*$/m);
  const headings = [...body.matchAll(/^## (?:Decision \d+(?::\s*[^\n]*)?|DR-\d+:\s*[^\n]*)\s*$/gm)].map(
    (m) => m[0].replace(/^##\s+/, '').trim(),
  );
  const blocks: Array<{ heading: string; block: string }> = [];
  for (let i = 0; i < headings.length; i += 1) {
    blocks.push({ heading: headings[i], block: parts[i + 1] ?? '' });
  }
  return blocks;
}

function decisionTitleFromHeading(heading: string): string {
  const decisionMatch = heading.match(/^Decision \d+:\s*(.+)$/);
  if (decisionMatch) return decisionMatch[1].trim();
  const drMatch = heading.match(/^DR-\d+:\s*(.+)$/);
  if (drMatch) return drMatch[1].trim();
  return '';
}

export function parseProgressEntriesForMigrate(
  content: string,
): { entries: MigratableEntry[]; counts: SourceCounts } {
  const parsed = parseLogEntries(content);
  const entries: MigratableEntry[] = [];
  parsed.forEach((entry, index) => {
    entries.push({
      timestamp: entry.timestamp,
      type: entry.type,
      author: entry.author ?? 'legacy',
      keys: Object.keys(entry.keys).length > 0 ? { ...entry.keys } : undefined,
      body: demoteBodyHeadings(entry.body),
      source: 'progress.md',
      seqInSource: index,
    });
  });
  return {
    entries,
    counts: { entries: entries.length, undated: 0, rawBlocks: 0 },
  };
}

export function parseDecisionEntriesForMigrate(
  content: string,
): { entries: MigratableEntry[]; counts: SourceCounts } {
  const { fm, body } = extractFrontmatterBody(content);
  const fileUpdated = frontmatterScalar(fm, 'updated') || '1970-01-01T00:00:00Z';
  const blocks = splitDecisionBlocks(body);
  const entries: MigratableEntry[] = [];
  let undated = 0;
  blocks.forEach((block, index) => {
    const title = decisionTitleFromHeading(block.heading);
    const recorded = block.block.match(/\*\*Recorded:\*\*\s*([^\n]+)/);
    let timestamp = recorded ? normalizeRecordedTimestamp(recorded[1]) : fileUpdated;
    if (!recorded) undated += 1;
    let blockText = block.block.replace(/\*\*Recorded:\*\*\s*[^\n]+\n?/, '').trim();
    blockText = demoteBodyHeadings(blockText);
    const bodyParts: string[] = [];
    if (title) bodyParts.push(`**${title}**`);
    if (blockText) bodyParts.push(blockText);
    entries.push({
      timestamp,
      type: 'decision',
      author: 'legacy',
      body: bodyParts.join('\n\n'),
      source: 'decision-record.md',
      seqInSource: index,
    });
  });
  return {
    entries,
    counts: { entries: entries.length, undated, rawBlocks: 0 },
  };
}

function handoffTimestampFromHeading(heading: string): string | null {
  const match = heading.match(/^Handoff \d+:\s*(.+)$/);
  if (!match) return null;
  const candidate = match[1].trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(candidate)) return normalizeRecordedTimestamp(candidate);
  return null;
}

function splitHandoffBlocks(body: string): Array<{ heading: string; block: string }> {
  const parts = body.split(/^## Handoff \d+(?::\s*[^\n]*)?\s*$/m);
  const headings = [...body.matchAll(/^## Handoff \d+(?::\s*[^\n]*)?\s*$/gm)].map((m) =>
    m[0].replace(/^##\s+/, '').trim(),
  );
  const blocks: Array<{ heading: string; block: string }> = [];
  for (let i = 0; i < headings.length; i += 1) {
    blocks.push({ heading: headings[i], block: parts[i + 1] ?? '' });
  }
  return blocks;
}

export function parseHandoffEntriesForMigrate(
  content: string,
): { entries: MigratableEntry[]; counts: SourceCounts } {
  const { fm, body } = extractFrontmatterBody(content);
  const fileUpdated = frontmatterScalar(fm, 'updated') || '1970-01-01T00:00:00Z';
  const blocks = splitHandoffBlocks(body);
  const entries: MigratableEntry[] = [];
  let undated = 0;
  blocks.forEach((block, index) => {
    const recorded = block.block.match(/\*\*Recorded:\*\*\s*([^\n]+)/);
    const fromHeading = handoffTimestampFromHeading(block.heading);
    let timestamp = fromHeading ?? (recorded ? normalizeRecordedTimestamp(recorded[1]) : fileUpdated);
    if (!fromHeading && !recorded) undated += 1;
    let blockText = block.block.replace(/\*\*Recorded:\*\*\s*[^\n]+\n?/, '').trim();
    entries.push({
      timestamp,
      type: 'handoff',
      author: 'legacy',
      body: demoteBodyHeadings(blockText),
      source: 'handoff.md',
      seqInSource: index,
    });
  });
  return {
    entries,
    counts: { entries: entries.length, undated, rawBlocks: 0 },
  };
}

interface ParsedCommentLike {
  id: string;
  timestamp: string;
  author: string;
  type: 'question' | 'note' | 'feedback';
  body: string;
  replyTo?: string;
  resolved?: boolean;
  malformed?: boolean;
}

function parseCommentsForMigrate(fileContent: string): {
  fileUpdated: string;
  parsed: ParsedCommentLike[];
} {
  const { fm, body } = extractFrontmatterBody(fileContent);
  const fileUpdated =
    frontmatterScalar(fm, 'updated') ||
    frontmatterScalar(fm, 'generated') ||
    '1970-01-01T00:00:00Z';
  const parsed: ParsedCommentLike[] = [];
  const headerRe =
    /^\s*\*\*Recorded:\*\*\s*(.*)\n\*\*Author:\*\*\s*(.*)\n\*\*Type:\*\*\s*(question|note|feedback)(?:\n\*\*Reply to:\*\*\s*(.*))?(?:\n\*\*Resolved:\*\*\s*(true|false))?\n+([\s\S]*)$/;
  const commentSplitRe =
    /^## (?=[^\n]*\n\s*\*\*Recorded:\*\*[^\n]*\n\*\*Author:\*\*[^\n]*\n\*\*Type:\*\*\s*(?:question|note|feedback)\b)/m;
  const trailingMalformedRe =
    /\n## ([^\n]+)\n\*\*Recorded:\*\*[^\n]*\n\*\*Author:\*\*[^\n]*\n(?!\*\*Type:\*\*\s*(?:question|note|feedback)\b)[\s\S]*$/;

  const sections = body.split(commentSplitRe);
  const preamble = sections[0]?.trim() ?? '';
  if (preamble && nonEmptyBeyondScaffold(preamble)) {
    parsed.push({
      id: 'preamble',
      timestamp: fileUpdated,
      author: 'legacy',
      type: 'note',
      body: demoteBodyHeadings(preamble),
      malformed: true,
    });
  }

  function pushMalformedSection(sectionText: string): void {
    const newlineIdx = sectionText.indexOf('\n');
    const id = newlineIdx === -1 ? sectionText.trim() : sectionText.slice(0, newlineIdx).trim();
    const rest = newlineIdx === -1 ? '' : sectionText.slice(newlineIdx + 1);
    parsed.push({
      id,
      timestamp: fileUpdated,
      author: 'legacy',
      type: 'note',
      body: demoteBodyHeadings(rest.trim() ? `## ${sectionText}`.trim() : `## ${id}`),
      malformed: true,
    });
  }

  for (const section of sections.slice(1)) {
    const newlineIdx = section.indexOf('\n');
    if (newlineIdx === -1) continue;
    const id = section.slice(0, newlineIdx).trim();
    const rest = section.slice(newlineIdx + 1);
    const headerMatch = rest.match(headerRe);
    if (!headerMatch) {
      pushMalformedSection(section);
      continue;
    }
    const [, timestamp, author, type, replyTo, resolvedStr, entryBody] = headerMatch;
    let bodyText = entryBody.trim();
    const orphans: string[] = [];
    while (true) {
      const orphanMatch = bodyText.match(trailingMalformedRe);
      if (!orphanMatch || orphanMatch.index === undefined) break;
      orphans.unshift(bodyText.slice(orphanMatch.index + 1).trimStart());
      bodyText = bodyText.slice(0, orphanMatch.index).trimEnd();
    }
    parsed.push({
      id,
      timestamp: normalizeRecordedTimestamp(timestamp.trim()),
      author: mapAuthor(author.trim()),
      type: type as 'question' | 'note' | 'feedback',
      body: demoteBodyHeadings(bodyText),
      replyTo: replyTo?.trim(),
      resolved: resolvedStr ? resolvedStr === 'true' : undefined,
    });
    for (const orphan of orphans) {
      pushMalformedSection(orphan.startsWith('## ') ? orphan.slice(3) : orphan);
    }
  }

  return { fileUpdated, parsed };
}

export function parseCommentEntriesForMigrate(
  content: string,
): { entries: MigratableEntry[]; counts: SourceCounts } {
  const { parsed } = parseCommentsForMigrate(content);
  const entries: MigratableEntry[] = [];
  let rawBlocks = 0;
  let seq = 0;
  for (const comment of parsed) {
    if (comment.malformed) rawBlocks += 1;
    const logType: LogEntryType =
      comment.type === 'question' ? 'question' : 'note';
    let body = comment.body;
    if (comment.replyTo) {
      body = body.length > 0
        ? `Reply to: ${comment.replyTo}\n${body}`
        : `Reply to: ${comment.replyTo}`;
    }
    entries.push({
      timestamp: comment.timestamp,
      type: logType,
      author: comment.author,
      body,
      source: 'comments.md',
      seqInSource: seq,
    });
    seq += 1;
    if (comment.type === 'question' && comment.resolved) {
      entries.push({
        timestamp: comment.timestamp,
        type: 'answer',
        author: comment.author,
        keys: { answers: comment.timestamp },
        body: 'Resolved in comments.md',
        source: 'comments.md',
        seqInSource: seq,
      });
      seq += 1;
    }
  }
  return {
    entries,
    counts: { entries: entries.length, undated: 0, rawBlocks },
  };
}

export function parseScratchpadEntryForMigrate(
  content: string,
): { entries: MigratableEntry[]; counts: SourceCounts } {
  const parsed = parseScratchpad(content);
  if (!nonEmptyBeyondScaffold(content)) {
    return { entries: [], counts: { entries: 0, undated: 0, rawBlocks: 0 } };
  }
  const timestamp = parsed.updated || '1970-01-01T00:00:00Z';
  const body = demoteBodyHeadings(parsed.body.trim());
  return {
    entries: [
      {
        timestamp,
        type: 'note',
        author: 'legacy',
        body,
        source: 'scratchpad.md',
        seqInSource: 0,
      },
    ],
    counts: { entries: 1, undated: 0, rawBlocks: 0 },
  };
}

export function sortMigratableEntries(entries: MigratableEntry[]): MigratableEntry[] {
  return [...entries].sort((a, b) => {
    const cmp = a.timestamp.localeCompare(b.timestamp);
    if (cmp !== 0) return cmp;
    const sourceCmp = SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source];
    if (sourceCmp !== 0) return sourceCmp;
    return a.seqInSource - b.seqInSource;
  });
}

export function renderJournalContent(entries: MigratableEntry[], purpose: string): string {
  const sorted = sortMigratableEntries(entries);
  const blocks = sorted.map((entry) =>
    formatLogEntry({
      timestamp: entry.timestamp,
      type: entry.type,
      author: entry.author,
      keys: entry.keys,
      body: entry.body,
    }),
  );
  return injectPurpose(blocks.join('\n'), purpose);
}

export async function collectMigrateEntries(
  ticketDir: string,
): Promise<{ entries: MigratableEntry[]; perSource: Map<MigrateJournalSource, SourceCounts> }> {
  const entries: MigratableEntry[] = [];
  const perSource = new Map<MigrateJournalSource, SourceCounts>();

  const parsers: Array<{
    file: MigrateJournalSource;
    parse: (content: string) => { entries: MigratableEntry[]; counts: SourceCounts };
  }> = [
    { file: 'progress.md', parse: parseProgressEntriesForMigrate },
    { file: 'decision-record.md', parse: parseDecisionEntriesForMigrate },
    { file: 'handoff.md', parse: parseHandoffEntriesForMigrate },
    { file: 'comments.md', parse: parseCommentEntriesForMigrate },
    { file: 'scratchpad.md', parse: parseScratchpadEntryForMigrate },
  ];

  for (const { file, parse } of parsers) {
    const path = resolve(ticketDir, file);
    if (!(await fileExists(path))) {
      perSource.set(file, { entries: 0, undated: 0, rawBlocks: 0 });
      continue;
    }
    const content = await readFile(path, 'utf-8');
    const result = parse(content);
    entries.push(...result.entries);
    perSource.set(file, result.counts);
  }

  return { entries, perSource };
}

function formatSourceLine(
  source: MigrateJournalSource,
  counts: SourceCounts,
  targetPath: string,
  mode: string,
): string {
  const extras: string[] = [];
  if (counts.undated > 0) extras.push(`undated ${counts.undated}`);
  if (counts.rawBlocks > 0) extras.push(`raw-blocks ${counts.rawBlocks}`);
  const extra = extras.length > 0 ? ` (${extras.join(', ')})` : '';
  return `${mode}${source}: ${counts.entries} entries → ${targetPath}${extra}`;
}

async function existingSources(ticketDir: string): Promise<MigrateJournalSource[]> {
  const found: MigrateJournalSource[] = [];
  for (const file of SOURCE_FILES) {
    if (await fileExists(resolve(ticketDir, file))) found.push(file);
  }
  return found;
}

async function backupIsComplete(ticketDir: string): Promise<boolean> {
  return await fileExists(resolve(ticketDir, MIGRATE_JOURNAL_BACKUP_DIR, MIGRATE_JOURNAL_COMPLETE_MARKER));
}

async function createBackup(
  ticketDir: string,
  sources: MigrateJournalSource[],
  copySourceFile: (src: string, dest: string) => Promise<void> = cp,
): Promise<void> {
  const backupDir = resolve(ticketDir, MIGRATE_JOURNAL_BACKUP_DIR);
  await rm(backupDir, { recursive: true, force: true });
  try {
    await mkdir(backupDir, { recursive: true });
    const copied: string[] = [];
    for (const file of sources) {
      const src = resolve(ticketDir, file);
      if (!(await fileExists(src))) continue;
      await copySourceFile(src, resolve(backupDir, file));
      copied.push(file);
    }
    await writeFile(resolve(backupDir, MIGRATE_JOURNAL_COMPLETE_MARKER), `${copied.join('\n')}\n`);
  } catch (err) {
    await rm(backupDir, { recursive: true, force: true });
    throw err;
  }
}

async function restoreFromBackup(ticketDir: string): Promise<void> {
  const backupDir = resolve(ticketDir, MIGRATE_JOURNAL_BACKUP_DIR);
  const markerPath = resolve(backupDir, MIGRATE_JOURNAL_COMPLETE_MARKER);
  if (!(await fileExists(markerPath))) {
    throw new Error('backup is incomplete — cannot restore');
  }
  const listed = (await readFile(markerPath, 'utf-8'))
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean) as MigrateJournalSource[];

  for (const file of listed) {
    const src = resolve(backupDir, file);
    if (await fileExists(src)) {
      await cp(src, resolve(ticketDir, file));
    }
  }

  const journalPath = resolve(ticketDir, JOURNAL_FILENAME);
  if (await fileExists(journalPath)) {
    await rm(journalPath);
  }
}

async function removeBackup(ticketDir: string): Promise<void> {
  await rm(resolve(ticketDir, MIGRATE_JOURNAL_BACKUP_DIR), { recursive: true, force: true });
}

function sumSourceCounts(perSource: Map<MigrateJournalSource, SourceCounts>): {
  undated: number;
  rawBlocks: number;
} {
  let undated = 0;
  let rawBlocks = 0;
  for (const counts of perSource.values()) {
    undated += counts.undated;
    rawBlocks += counts.rawBlocks;
  }
  return { undated, rawBlocks };
}

export async function resolveMigrateProjectsDir(
  options: TicketTargetOptions = {},
): Promise<string> {
  const config = await readConfig();
  return options.dir ? expandHome(options.dir) : config.defaultProjectDir;
}

async function deleteSources(ticketDir: string, sources: MigrateJournalSource[]): Promise<void> {
  for (const file of sources) {
    await rm(resolve(ticketDir, file), { force: true });
  }
}

export async function migrateJournalTicket(
  ticketDir: string,
  options: {
    targetTemplate: string;
    purpose: string;
    apply: boolean;
    ticketId: string;
    projectSlug: string | null;
    hooks?: MigrateJournalHooks;
  },
): Promise<MigrateJournalResult> {
  const mode = options.apply ? '[apply] ' : '[dry-run] ';
  const lines: MigrateJournalTranscriptLine[] = [];
  const ticketMdPath = resolve(ticketDir, 'ticket.md');
  const ticketContent = await readFile(ticketMdPath, 'utf-8');
  const fm = parseTicketFrontmatter(ticketContent);
  const ticketId = fm.id || options.ticketId;
  const template = fm.template ?? 'legacy';
  const journalPath = resolve(ticketDir, JOURNAL_FILENAME);
  const journalExists = await fileExists(journalPath);
  const sources = await existingSources(ticketDir);
  const backupComplete = await backupIsComplete(ticketDir);

  if (journalExists && sources.length === 0 && !backupComplete) {
    return {
      ticketId,
      refused: true,
      refuseReason: 'already migrated (journal.md exists with no legacy sources or backup)',
      lines: [{ source: 'summary', text: `${mode}refused: already migrated` }],
      totalEntries: 0,
      undated: 0,
      rawBlocks: 0,
      targetPath: JOURNAL_FILENAME,
    };
  }

  if (template !== 'legacy' && !journalExists) {
    return {
      ticketId,
      refused: true,
      refuseReason: `template ${template} is not legacy and no journal.md exists`,
      lines: [{ source: 'summary', text: `${mode}refused: non-legacy ticket without journal.md` }],
      totalEntries: 0,
      undated: 0,
      rawBlocks: 0,
      targetPath: JOURNAL_FILENAME,
    };
  }

  const resume = journalExists && (sources.length > 0 || backupComplete);
  let entries: MigratableEntry[] = [];
  let perSource = new Map<MigrateJournalSource, SourceCounts>();

  if (!resume) {
    const collected = await collectMigrateEntries(ticketDir);
    entries = collected.entries;
    perSource = collected.perSource;
    for (const source of SOURCE_FILES) {
      const counts = perSource.get(source) ?? { entries: 0, undated: 0, rawBlocks: 0 };
      if (counts.entries > 0 || (await fileExists(resolve(ticketDir, source)))) {
        lines.push({
          source,
          text: formatSourceLine(source, counts, JOURNAL_FILENAME, mode),
        });
      }
    }
  } else {
    lines.push({
      source: 'summary',
      text: `${mode}resume: journal.md present with legacy sources or complete backup`,
    });
    if (journalExists) {
      entries = parseLogEntries(await readFile(journalPath, 'utf-8')).map((entry, index) => ({
        timestamp: entry.timestamp,
        type: entry.type,
        author: entry.author ?? 'legacy',
        keys: Object.keys(entry.keys).length > 0 ? { ...entry.keys } : undefined,
        body: entry.body,
        source: 'progress.md' as MigrateJournalSource,
        seqInSource: index,
      }));
    }
  }

  if (!options.apply) {
    const { undated, rawBlocks } = sumSourceCounts(perSource);
    lines.push({
      source: 'summary',
      text: `${mode}total: ${entries.length} entries → ${JOURNAL_FILENAME} (template → ${options.targetTemplate})`,
    });
    return {
      ticketId,
      resumed: resume,
      lines,
      totalEntries: entries.length,
      undated,
      rawBlocks,
      targetPath: JOURNAL_FILENAME,
    };
  }

  const sourcesToBackup = sources.length > 0 ? sources : [];

  let backupCreated = backupComplete;
  if (!backupComplete && sourcesToBackup.length > 0) {
    try {
      await createBackup(ticketDir, sourcesToBackup, options.hooks?.copySourceFile);
      backupCreated = true;
    } catch {
      await rm(resolve(ticketDir, MIGRATE_JOURNAL_BACKUP_DIR), { recursive: true, force: true });
      throw new Error('backup copy failed — sources untouched');
    }
  }

  try {
    if (!resume) {
      const journalContent = renderJournalContent(entries, options.purpose);
      const tmpPath = resolve(ticketDir, JOURNAL_TMP_FILENAME);
      await writeFileForce(tmpPath, journalContent);
      await rename(tmpPath, journalPath);
    }

    const nextTicket =
      template === 'legacy'
        ? updateTicketFile(ticketContent, { template: options.targetTemplate })
        : ticketContent;
    if (nextTicket !== ticketContent) {
      await writeFileForce(ticketMdPath, nextTicket);
    }

    if (options.hooks?.beforeDeleteSources) {
      await options.hooks.beforeDeleteSources();
    }

    const toDelete = resume ? await existingSources(ticketDir) : sourcesToBackup;
    if (toDelete.length > 0) {
      await deleteSources(ticketDir, toDelete);
    }

    if (backupCreated) {
      await removeBackup(ticketDir);
    }

    emitEvent({
      ticketId,
      projectSlug: options.projectSlug,
      type: 'retemplated',
      actor: 'human',
      details: {
        from: 'legacy',
        to: options.targetTemplate,
        written: [JOURNAL_FILENAME],
      },
    });

    lines.push({
      source: 'summary',
      text: `${mode}migrated ${ticketId}: ${entries.length} entries → ${JOURNAL_FILENAME}, template → ${options.targetTemplate}`,
    });

    const { undated, rawBlocks } = sumSourceCounts(perSource);
    return {
      ticketId,
      resumed: resume,
      lines,
      totalEntries: entries.length,
      undated,
      rawBlocks,
      targetPath: JOURNAL_FILENAME,
    };
  } catch (err) {
    if (backupCreated || backupComplete) {
      await restoreFromBackup(ticketDir);
      const restoredTicket = await readFile(ticketMdPath, 'utf-8');
      await writeFileForce(ticketMdPath, updateTicketFile(restoredTicket, { template: 'legacy' }));
    }
    throw err;
  }
}

export async function migrateJournalCommand(
  ticketId: string | undefined,
  options: MigrateJournalOptions = {},
): Promise<MigrateJournalTranscriptLine[]> {
  const root = syntaurRoot();
  await seedMissingBuiltins(root);
  initEventsDb(resolve(root, 'syntaur.db'));

  const targetTemplate = options.template ?? 'feature';
  let purpose = 'Append-only log for progress, decisions, handoffs, questions, answers, and reviews.';
  try {
    const manifest = await loadTemplate(root, targetTemplate);
    const logRole = logRoleFile(manifest);
    if (logRole?.description) purpose = logRole.description;
  } catch {
    // keep default purpose string
  }

  const allLines: MigrateJournalTranscriptLine[] = [];

  if (options.all) {
    if (!options.project) {
      throw new Error('--all requires --project <slug>');
    }
    const projectsDir = await resolveMigrateProjectsDir(options);
    const projectsLine = `projects: ${projectsDir}`;
    allLines.push({ source: 'summary', text: projectsLine });
    console.log(projectsLine);

    const walk = await listTicketsByProject(projectsDir);
    let migrated = 0;
    let skipped = 0;
    let refused = 0;
    let totalUndated = 0;
    const refusedIds: string[] = [];

    for (const entry of walk.withTicketMd) {
      if (entry.projectSlug !== options.project) continue;
      const ticketMd = await readFile(resolve(entry.ticketDir, 'ticket.md'), 'utf-8');
      const fm = parseTicketFrontmatter(ticketMd);
      const isLegacy = (fm.template ?? 'legacy') === 'legacy';
      const sources = await existingSources(entry.ticketDir);
      const backupComplete = await backupIsComplete(entry.ticketDir);
      const canResume = sources.length > 0 || backupComplete;
      if (!isLegacy && !canResume) {
        skipped += 1;
        continue;
      }
      const id = fm.id || entry.ticketId;
      if (!id) continue;

      const result = await migrateJournalTicket(entry.ticketDir, {
        targetTemplate,
        purpose,
        apply: options.apply ?? false,
        ticketId: id,
        projectSlug: entry.projectSlug,
        hooks: options.hooks,
      });

      for (const line of result.lines) {
        allLines.push(line);
        console.log(line.text);
      }

      totalUndated += result.undated;

      if (result.refused) {
        refused += 1;
        refusedIds.push(id);
      } else {
        migrated += 1;
      }
    }

    const mode = options.apply ? '[apply] ' : '[dry-run] ';
    const summary =
      `${mode}--all: ${migrated} migrated, ${skipped} skipped (not legacy), ${refused} refused` +
      (totalUndated > 0 ? `, undated ${totalUndated}` : '') +
      (refusedIds.length > 0 ? ` (${refusedIds.join(', ')})` : '');
    allLines.push({ source: 'summary', text: summary });
    console.log(summary);
    return allLines;
  }

  if (!ticketId) {
    throw new Error('ticket id required unless --project <slug> --all is used');
  }

  const projectsDir = await resolveMigrateProjectsDir(options);
  const projectsLine = `projects: ${projectsDir}`;
  allLines.push({ source: 'summary', text: projectsLine });
  console.log(projectsLine);

  const target = await resolveTicketTarget(ticketId, options);
  const result = await migrateJournalTicket(target.ticketDir, {
    targetTemplate,
    purpose,
    apply: options.apply ?? false,
    ticketId: target.id ?? ticketId,
    projectSlug: target.projectSlug,
    hooks: options.hooks,
  });

  if (result.refused) {
    for (const line of result.lines) {
      allLines.push(line);
      console.log(line.text);
    }
    throw new Error(result.refuseReason ?? 'migration refused');
  }

  for (const line of result.lines) {
    allLines.push(line);
    console.log(line.text);
  }
  return allLines;
}

export const journalMigrateCommand = new Command('journal')
  .description('Merge legacy record files into journal.md and switch template')
  .argument('[id]', 'Ticket id (<PREFIX>-<n>); omit with --project <slug> --all')
  .option('--project <slug>', 'Project slug')
  .option('--all', 'Migrate all legacy tickets in the project')
  .option('--template <id>', 'Target template (default: feature)', 'feature')
  .option('--apply', 'Apply changes (default is dry-run)')
  .action(
    async (
      id: string | undefined,
      opts: { project?: string; all?: boolean; template?: string; apply?: boolean },
    ) => {
      try {
        await migrateJournalCommand(id, {
          project: opts.project,
          all: opts.all,
          template: opts.template,
          apply: opts.apply,
        });
      } catch (error) {
        console.error('Error:', error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    },
  );
