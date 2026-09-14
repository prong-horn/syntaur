/**
 * `syntaur migrate v2` — one-time migration from v1 / Phase-A layout to v2
 * id-prefixed ticket folders and colon-free keys (plan decision 8, task 9).
 *
 * Dry-run by default. Sets `SYNTAUR_HOME` from `--root` BEFORE any helper touch;
 * all paths derive from `<root>` directly — never from config.defaultProjectDir.
 */

import { Command } from 'commander';
import { cp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { expandHome, syntaurRoot } from '../utils/paths.js';
import { ensureDir, fileExists, writeFileForce } from '../utils/fs.js';
import { derivePrefix } from '../utils/ticket-ids.js';
import { formatTicketFolderName, parseTicketFolderName } from '../utils/ticket-folder.js';
import { parseTicketFrontmatter } from '../lifecycle/frontmatter.js';
import { escapeYamlString } from '../utils/yaml.js';
import {
  rebuildProjectTicketIndex,
  writeProjectScaffold,
} from '../utils/project-scaffold.js';
import { rebuildChatIndex } from '../chat/store.js';
import {
  closeSessionDb,
  initSessionDb,
  resetSessionDb,
} from '../dashboard/session-db.js';
import {
  closeEventsDb,
  getEventsDb,
  initEventsDb,
  insertEventOrThrow,
  resetEventsDb,
} from '../db/events-db.js';
import type { StageId } from '../ticket-templates/manifest.js';

/** v1 status → v2 stage id (`migrate v2` statuses step only). */
const LEGACY_STATUS_TO_STAGE: Record<string, StageId | 'dropped'> = {
  draft: 'backlog',
  pending: 'backlog',
  ready_for_planning: 'planning',
  ready_to_implement: 'ready',
  in_progress: 'in_progress',
  blocked: 'in_progress',
  review: 'review',
  completed: 'done',
  failed: 'dropped',
};

export function legacyStatusToStage(status: string): StageId | 'dropped' {
  if (
    ['backlog', 'planning', 'ready', 'in_progress', 'review', 'done', 'dropped'].includes(status)
  ) {
    return status as StageId | 'dropped';
  }
  const mapped = LEGACY_STATUS_TO_STAGE[status];
  if (mapped) return mapped;
  return 'backlog';
}
import { closeUsageDb, initUsageDb, resetUsageDb } from '../db/usage-db.js';
import { BUILTIN_TEMPLATE_IDS, seedMissingBuiltins } from '../ticket-templates/builtins.js';
import { latestPlanRevision } from '../ticket-templates/roles.js';

export const V2_MIGRATED_MARKER = 'v2-migrated';

const MIGRATION_STEPS = ['rename-ids', 'templates', 'statuses'] as const;
export type MigrationStep = (typeof MIGRATION_STEPS)[number];

const ISO_TIMESTAMP_LINE_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMPACT_TS_RE = /^\d{8}T\d{6}Z$/;

const SIDECAR_FILES = [
  'progress.md',
  'comments.md',
  'handoff.md',
  'scratchpad.md',
  'plan.md',
  'decision-record.md',
];

export interface MigrateV2Options {
  root?: string;
  apply?: boolean;
  /** Repeated `slug=PFX` overrides from `--prefix`. */
  prefix?: string[];
  /** @internal Set by tests to force database re-key failure. */
  injectDbFailure?: () => void;
}

interface DiscoveredTicket {
  uuid: string;
  slug: string;
  status: string;
  created: string;
  oldFolder: string;
  ticketMdRel: string;
  ticketDir: string;
  ticketMdPath: string;
  isStandalone: boolean;
  projectSlug: string | null;
  newId: string;
  newFolder: string;
}

interface ProjectPlan {
  slug: string;
  projectDir: string;
  prefix: string;
  nextTicket: number;
  tickets: DiscoveredTicket[];
}

interface MigrationMaps {
  uuidToId: Map<string, string>;
  slugToId: Map<string, string>;
  projectSlugToId: Map<string, Map<string, string>>;
  itemIdMap: Map<string, string>;
  duplicateStandaloneSlugs: Set<string>;
  refWarnings: string[];
}

function dbProjectSlugForMapKey(project: string): string {
  return project === 'scratch' ? '' : project;
}

function slugProjectOccurrenceCount(slug: string, maps: MigrationMaps): number {
  let count = 0;
  for (const per of maps.projectSlugToId.values()) {
    if (per.has(slug)) count += 1;
  }
  return count;
}

function resolveSlugInProject(
  slug: string,
  projectSlug: string | null,
  maps: MigrationMaps,
): string | null {
  if (projectSlug) {
    const per = maps.projectSlugToId.get(projectSlug);
    if (per?.has(slug)) return per.get(slug)!;
  }
  if (slugProjectOccurrenceCount(slug, maps) === 1) {
    for (const per of maps.projectSlugToId.values()) {
      if (per.has(slug)) return per.get(slug)!;
    }
  }
  return null;
}

export interface MigrateV2Transcript {
  lines: string[];
}

function logLine(lines: string[], mode: string, text: string): void {
  const line = `${mode}${text}`;
  lines.push(line);
  console.log(line);
}

function parsePrefixOverrides(raw: string[] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of raw ?? []) {
    const eq = pair.indexOf('=');
    if (eq <= 0) {
      throw new Error(`Invalid --prefix "${pair}" — expected slug=PFX`);
    }
    const slug = pair.slice(0, eq);
    const pfx = pair.slice(eq + 1).toUpperCase();
    if (!/^[A-Z]{2,5}$/.test(pfx)) {
      throw new Error(`Invalid prefix "${pfx}" for project "${slug}" — use 2–5 uppercase letters`);
    }
    out.set(slug, pfx);
  }
  return out;
}

function replaceFrontmatterScalar(content: string, key: string, value: string): string {
  const fieldRegex = new RegExp(`^(${key}:)\\s*.*$`, 'm');
  if (fieldRegex.test(content)) {
    return content.replace(fieldRegex, `$1 ${value}`);
  }
  const closeIdx = content.indexOf('\n---', 4);
  if (closeIdx === -1) return content;
  return `${content.slice(0, closeIdx)}\n${key}: ${value}${content.slice(closeIdx)}`;
}

function mapListField(
  content: string,
  field: 'dependsOn' | 'links',
  mapper: (ref: string) => string,
): string {
  const inline = new RegExp(`^${field}:\\s*\\[\\s*\\]`, 'm');
  if (inline.test(content)) return content;

  const block = new RegExp(`^${field}:\\s*\\n((?:\\s+-\\s+.*\\n?)*)`, 'm');
  const match = content.match(block);
  if (!match) return content;

  const mapped = match[1].replace(/^\s+-\s+(.+)$/gm, (_, raw: string) => {
    const trimmed = raw.trim().replace(/^["']|["']$/g, '');
    return `  - ${mapper(trimmed)}`;
  });
  return content.replace(block, `${field}:\n${mapped}`);
}

function renameFrontmatterKey(content: string, oldKey: string, newKey: string): string {
  if (!new RegExp(`^${oldKey}:`, 'm').test(content)) return content;
  return content.replace(new RegExp(`^${oldKey}:`, 'gm'), `${newKey}:`);
}

function dropFrontmatterScalar(content: string, key: string): string {
  return content.replace(new RegExp(`^${key}:.*\\n`, 'm'), '');
}

function setTemplateLegacy(content: string): string {
  if (/^template:\s*/m.test(content)) {
    return content.replace(/^template:\s*.*$/m, 'template: legacy');
  }
  const projectMatch = content.match(/^project:.*$/m);
  if (!projectMatch) return content;
  return content.replace(/^project:.*$/m, `${projectMatch[0]}\ntemplate: legacy`);
}

interface PlanApprovalV1 {
  file: string | null;
  digest: string | null;
  by: string | null;
  at: string | null;
}

function parseNestedFrontmatterBlock(
  fm: string,
  key: string,
): Record<string, string | null> | null {
  const blockRe = new RegExp(`^${key}:\\s*\\n((?:  \\w+:.*\\n?)*)`, 'm');
  const match = fm.match(blockRe);
  if (!match) return null;
  const out: Record<string, string | null> = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^\s{2}(\w+):\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (val === 'null' || val === '~') {
      out[m[1]] = null;
    } else {
      val = val.replace(/^["']|["']$/g, '');
      out[m[1]] = val;
    }
  }
  return out;
}

function parsePlanApprovalV1(content: string): PlanApprovalV1 | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const block = parseNestedFrontmatterBlock(fmMatch[1], 'planApproval');
  if (!block) return null;
  return {
    file: block.file ?? null,
    digest: block.digest ?? null,
    by: block.by ?? null,
    at: block.at ?? null,
  };
}

function renderPlanBlockYaml(plan: {
  file: string | null;
  approvedDigest: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
}): string {
  const fileLine = plan.file === null ? 'null' : plan.file;
  const digestLine = plan.approvedDigest === null ? 'null' : plan.approvedDigest;
  const atLine =
    plan.approvedAt === null ? 'null' : `"${plan.approvedAt.replace(/"/g, '\\"')}"`;
  const byLine = plan.approvedBy === null ? 'null' : plan.approvedBy;
  return `plan:
  file: ${fileLine}
  approvedDigest: ${digestLine}
  approvedAt: ${atLine}
  approvedBy: ${byLine}`;
}

function replacePlanApprovalWithPlanBlock(
  content: string,
  planYaml: string,
): string {
  let next = content.replace(/^planApproval:\s*\n(?:  \w+:.*\n?)*/m, '');
  if (/^plan:\s*\n(?:  \w+:.*\n?)*/m.test(next)) {
    next = next.replace(/^plan:\s*\n(?:  \w+:.*\n?)*/m, planYaml);
  } else {
    const closeIdx = next.indexOf('\n---', 4);
    if (closeIdx === -1) return next;
    next = `${next.slice(0, closeIdx)}\n${planYaml}${next.slice(closeIdx)}`;
  }
  return next;
}

export interface MarkerState {
  completed: Map<MigrationStep, string>;
  /** Legacy bare-timestamp marker: rename-ids implied, templates not — skip statuses until templates ledger exists. */
  barePreTemplates: boolean;
}

export async function readMarkerSteps(markerPath: string): Promise<MarkerState> {
  const completed = new Map<MigrationStep, string>();
  if (!(await fileExists(markerPath))) {
    return { completed, barePreTemplates: false };
  }
  const raw = await readFile(markerPath, 'utf-8');
  let sawLedgerRename = false;
  for (const line of raw.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const ledger = line.match(/^(rename-ids|templates|statuses)\s+(.+)$/);
    if (ledger) {
      if (ledger[1] === 'rename-ids') sawLedgerRename = true;
      completed.set(ledger[1] as MigrationStep, ledger[2]);
      continue;
    }
    if (ISO_TIMESTAMP_LINE_RE.test(line)) {
      completed.set('rename-ids', line);
    }
  }
  const barePreTemplates =
    completed.has('rename-ids') && !sawLedgerRename && !completed.has('templates');
  return { completed, barePreTemplates };
}

export function pendingMigrationSteps(state: MarkerState | Map<MigrationStep, string>): MigrationStep[] {
  const completed = state instanceof Map ? state : state.completed;
  const barePreTemplates = state instanceof Map ? false : state.barePreTemplates;
  const pending = MIGRATION_STEPS.filter((step) => !completed.has(step));
  if (barePreTemplates && pending.includes('statuses')) {
    return pending.filter((step) => step !== 'statuses');
  }
  return pending;
}

async function appendMarkerStep(markerPath: string, step: MigrationStep): Promise<void> {
  const ts = new Date().toISOString();
  if (step === 'rename-ids') {
    await writeFileForce(markerPath, `rename-ids ${ts}\n`);
    return;
  }
  let prefix = '';
  if (await fileExists(markerPath)) {
    prefix = await readFile(markerPath, 'utf-8');
    if (prefix.length > 0 && !prefix.endsWith('\n')) prefix += '\n';
  }
  await writeFileForce(markerPath, `${prefix}${step} ${ts}\n`);
}

interface TemplatesStepCounts {
  seeded: string[];
  templateLegacy: number;
  dependsOnRenamed: number;
  planBlock: number;
  approvalsCarried: number;
  supersededDropped: number;
  typeDropped: number;
}

/** All ticket markdown paths for the templates step (v1 assignments + v2 tickets). */
async function collectTicketMdPaths(home: string): Promise<string[]> {
  const paths = new Set<string>();
  const projectsDir = resolve(home, 'projects');
  if (await fileExists(projectsDir)) {
    const projects = await readdir(projectsDir, { withFileTypes: true });
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const projectDir = resolve(projectsDir, project.name);
      if (!(await fileExists(resolve(projectDir, 'project.md')))) continue;

      for (const t of await discoverProjectTickets(project.name, projectDir)) {
        paths.add(t.ticketMdPath);
      }

      const ticketsDir = resolve(projectDir, 'tickets');
      if (await fileExists(ticketsDir)) {
        const folders = await readdir(ticketsDir, { withFileTypes: true });
        for (const folder of folders) {
          if (!folder.isDirectory()) continue;
          const ticketMd = resolve(ticketsDir, folder.name, 'ticket.md');
          if (await fileExists(ticketMd)) paths.add(ticketMd);
        }
      }
    }
  }

  for (const t of await discoverStandaloneTickets(home)) {
    paths.add(t.ticketMdPath);
  }

  return [...paths].sort();
}

async function transformTicketTemplatesFrontmatter(
  content: string,
  ticketDir: string,
): Promise<{ content: string; counts: TemplatesStepCounts }> {
  const counts: TemplatesStepCounts = {
    seeded: [],
    templateLegacy: 0,
    dependsOnRenamed: 0,
    planBlock: 0,
    approvalsCarried: 0,
    supersededDropped: 0,
    typeDropped: 0,
  };

  let next = content;
  next = setTemplateLegacy(next);
  counts.templateLegacy += 1;

  if (/^dependsOn:/m.test(next)) {
    next = renameFrontmatterKey(next, 'dependsOn', 'depends_on');
    counts.dependsOnRenamed += 1;
  }

  if (/^type:/m.test(next)) {
    next = dropFrontmatterScalar(next, 'type');
    counts.typeDropped += 1;
  }

  const approval = parsePlanApprovalV1(next);
  const fmMatch = next.match(/^---\n([\s\S]*?)\n---/);
  const existingPlan = fmMatch ? parseNestedFrontmatterBlock(fmMatch[1], 'plan') : null;
  const latestPlan = await latestPlanRevision(ticketDir, 'plan');
  const planBlock = {
    file: latestPlan,
    approvedDigest: null as string | null,
    approvedAt: null as string | null,
    approvedBy: null as string | null,
  };

  if (approval?.file && approval.file === latestPlan && approval.digest) {
    planBlock.approvedDigest = approval.digest;
    planBlock.approvedAt = approval.at;
    planBlock.approvedBy = approval.by;
    counts.approvalsCarried += 1;
  } else if (approval?.file && latestPlan && approval.file !== latestPlan) {
    counts.supersededDropped += 1;
  } else if (!approval && existingPlan?.file === latestPlan && existingPlan.approvedDigest) {
    planBlock.approvedDigest = existingPlan.approvedDigest;
    planBlock.approvedAt = existingPlan.approvedAt;
    planBlock.approvedBy = existingPlan.approvedBy;
  }

  next = replacePlanApprovalWithPlanBlock(next, renderPlanBlockYaml(planBlock));
  counts.planBlock += 1;

  return { content: next, counts };
}

function mergeTemplateCounts(
  total: TemplatesStepCounts,
  partial: TemplatesStepCounts,
): void {
  total.templateLegacy += partial.templateLegacy;
  total.dependsOnRenamed += partial.dependsOnRenamed;
  total.planBlock += partial.planBlock;
  total.approvalsCarried += partial.approvalsCarried;
  total.supersededDropped += partial.supersededDropped;
  total.typeDropped += partial.typeDropped;
}

async function listMissingBuiltinTemplates(home: string): Promise<string[]> {
  const missing: string[] = [];
  for (const id of BUILTIN_TEMPLATE_IDS) {
    if (!(await fileExists(resolve(home, 'templates', id, 'template.md')))) {
      missing.push(id);
    }
  }
  return missing;
}

async function runTemplatesStep(
  home: string,
  apply: boolean,
  lines: string[],
  mode: string,
): Promise<void> {
  const seeded = apply ? await seedMissingBuiltins(home) : await listMissingBuiltinTemplates(home);
  const counts: TemplatesStepCounts = {
    seeded,
    templateLegacy: 0,
    dependsOnRenamed: 0,
    planBlock: 0,
    approvalsCarried: 0,
    supersededDropped: 0,
    typeDropped: 0,
  };

  if (seeded.length > 0) {
    logLine(
      lines,
      mode,
      apply ? `templates: seeded ${seeded.join(', ')}` : `templates: seeded ${seeded.join(', ')}`,
    );
  } else {
    logLine(lines, mode, 'templates: present');
  }

  const ticketPaths = await collectTicketMdPaths(home);
  for (const ticketMdPath of ticketPaths) {
    const content = await readFile(ticketMdPath, 'utf-8');
    if (!content.trimStart().startsWith('---')) continue;
    const ticketDir = resolve(ticketMdPath, '..');
    const { content: next, counts: partial } = await transformTicketTemplatesFrontmatter(
      content,
      ticketDir,
    );
    mergeTemplateCounts(counts, partial);
    if (apply && next !== content) {
      await writeFileForce(ticketMdPath, next);
    }
  }

  logLine(lines, mode, `template legacy: ${counts.templateLegacy} tickets`);
  logLine(lines, mode, `depends_on: ${counts.dependsOnRenamed} renamed`);
  logLine(
    lines,
    mode,
    `plan block: ${counts.planBlock} tickets (${counts.approvalsCarried} approvals carried, ${counts.supersededDropped} superseded approvals dropped)`,
  );
  logLine(lines, mode, `dropped type: ${counts.typeDropped}`);
}

const V1_TERMINAL_STATUSES = new Set(['completed', 'failed', 'done', 'dropped']);

const DROPPED_V1_FIELDS = [
  'workflow',
  'externalIds',
  'statusHistory',
  'archived',
  'archivedAt',
  'archivedReason',
  'phase',
  'disposition',
  'reviewRequested',
  'reworkRequested',
  'implementationStarted',
  'override',
  'facts',
  'attestations',
  'solicitations',
  'firedVerdicts',
  'frozenChecks',
  'hold',
  'gateOverrides',
  'workspaceGroup',
  'blockedReason',
  'planApproval',
  'type',
  'dependsOn',
] as const;

interface StatusHistoryEntryV1 {
  at: string;
  from: string | null;
  to: string;
  command: string;
  by: string | null;
}

function parseScalarV1(fm: string, key: string): string | null {
  const match = fm.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
  if (!match) return null;
  const trimmed = match[1].trim();
  if (trimmed === 'null' || trimmed === '~' || trimmed === '') return null;
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseBoolV1(fm: string, key: string): boolean | null {
  const matches = [...fm.matchAll(new RegExp(`^${key}:\\s*(.*)$`, 'gm'))];
  if (matches.length === 0) return null;
  const raw = matches[matches.length - 1][1].trim();
  if (raw === 'null' || raw === '~' || raw === '') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
}

function parseStatusHistoryV1(fm: string): StatusHistoryEntryV1[] {
  const lines = fm.split('\n');
  const start = lines.findIndex((l) => l.startsWith('statusHistory:'));
  if (start < 0) return [];

  const entries: StatusHistoryEntryV1[] = [];
  let i = start + 1;
  while (i < lines.length) {
    const line = lines[i];
    if (line.length > 0 && !/^\s/.test(line)) break;
    const atMatch = line.match(/^\s+-\s+at:\s*(.+)$/);
    if (!atMatch) {
      i += 1;
      continue;
    }
    const entry: StatusHistoryEntryV1 = {
      at: atMatch[1].trim().replace(/^["']|["']$/g, ''),
      from: null,
      to: '',
      command: '',
      by: null,
    };
    i += 1;
    while (i < lines.length && /^\s{4}\w+:/.test(lines[i])) {
      const sub = lines[i].match(/^\s{4}(\w+):\s*(.*)$/);
      if (sub) {
        const val = sub[2].trim();
        const parsed =
          val === 'null' || val === '~' ? null : val.replace(/^["']|["']$/g, '');
        if (sub[1] === 'from') entry.from = parsed;
        if (sub[1] === 'to') entry.to = parsed ?? '';
        if (sub[1] === 'command') entry.command = parsed ?? '';
        if (sub[1] === 'by') entry.by = parsed;
      }
      i += 1;
    }
    entries.push(entry);
  }
  return entries;
}

export const V2_TICKET_FIELD_ORDER = [
  'id',
  'slug',
  'title',
  'project',
  'template',
  'status',
  'priority',
  'blocked',
  'parked',
  'depends_on',
  'assignee',
  'tags',
  'links',
  'workspace',
  'plan',
  'created',
  'updated',
] as const;

const V2_TICKET_FIELD_SET = new Set<string>(V2_TICKET_FIELD_ORDER);

/** Top-level frontmatter keys in source order (excludes nested block children). */
export function listTopLevelFrontmatterKeys(fm: string): string[] {
  const keys: string[] = [];
  for (const line of fm.split('\n')) {
    if (line.length === 0 || line[0] === ' ' || line[0] === '\t') continue;
    const match = line.match(/^([A-Za-z_][\w]*):/);
    if (match) keys.push(match[1]);
  }
  return keys;
}

function formatMigratedYamlScalar(value: string | null): string {
  if (value === null) return 'null';
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return `"${value}"`;
  if (
    /[:#{}[\],&*?|>!%@`]/.test(value) ||
    /\s/.test(value) ||
    /^\s|\s$/.test(value) ||
    value === ''
  ) {
    return escapeYamlString(value);
  }
  return value;
}

function parseYamlListV1(fm: string, keys: string[]): string[] {
  for (const key of keys) {
    if (new RegExp(`^${key}:\\s*\\[\\s*\\]`, 'm').test(fm)) return [];
    const block = fm.match(new RegExp(`^${key}:\\s*\\n((?:\\s+-\\s+.*\\n?)*)`, 'm'));
    if (block) {
      return [...block[1].matchAll(/^\s+-\s+(.+)$/gm)].map((m) =>
        m[1].trim().replace(/^["']|["']$/g, ''),
      );
    }
  }
  return [];
}

function parseWorkspaceV1(fm: string): {
  repository: string | null;
  worktree: string | null;
  branch: string | null;
  parentBranch: string | null;
  hadWorktreePath: boolean;
} {
  const block = parseNestedFrontmatterBlock(fm, 'workspace');
  const defaults = {
    repository: null as string | null,
    worktree: null as string | null,
    branch: null as string | null,
    parentBranch: null as string | null,
    hadWorktreePath: false,
  };
  if (!block) return defaults;
  const hadWorktreePath = block.worktreePath != null && block.worktreePath !== '';
  return {
    repository: block.repository ?? null,
    worktree: block.worktree ?? block.worktreePath ?? null,
    branch: block.branch ?? null,
    parentBranch: block.parentBranch ?? null,
    hadWorktreePath,
  };
}

interface RenderV2TicketFrontmatterInput {
  id: string;
  slug: string;
  title: string;
  project: string | null;
  template: string | null;
  status: string;
  priority: string;
  blocked: string | null;
  parked: string | null;
  depends_on: string[];
  assignee: string | null;
  tags: string[];
  links: string[];
  workspace: {
    repository: string | null;
    worktree: string | null;
    branch: string | null;
    parentBranch: string | null;
  };
  plan: {
    file: string | null;
    approvedDigest: string | null;
    approvedAt: string | null;
    approvedBy: string | null;
  };
  created: string;
  updated: string;
}

function renderListYaml(key: string, items: string[]): string[] {
  if (items.length === 0) return [`${key}: []`];
  return [`${key}:`, ...items.map((item) => `  - ${item}`)];
}

function renderV2TicketFrontmatter(data: RenderV2TicketFrontmatterInput): string {
  const lines: string[] = [
    `id: ${data.id}`,
    `slug: ${data.slug}`,
    `title: ${escapeYamlString(data.title)}`,
    `project: ${data.project ?? 'null'}`,
    `template: ${data.template ?? 'legacy'}`,
    `status: ${data.status}`,
    `priority: ${data.priority}`,
    `blocked: ${formatMigratedYamlScalar(data.blocked)}`,
    `parked: ${formatMigratedYamlScalar(data.parked)}`,
    ...renderListYaml('depends_on', data.depends_on),
    `assignee: ${data.assignee ?? 'null'}`,
    ...renderListYaml('tags', data.tags),
    ...renderListYaml('links', data.links),
    'workspace:',
    `  repository: ${formatMigratedYamlScalar(data.workspace.repository)}`,
    `  branch: ${formatMigratedYamlScalar(data.workspace.branch)}`,
    `  worktree: ${formatMigratedYamlScalar(data.workspace.worktree)}`,
    `  parentBranch: ${formatMigratedYamlScalar(data.workspace.parentBranch)}`,
    'plan:',
    `  file: ${data.plan.file ?? 'null'}`,
    `  approvedDigest: ${data.plan.approvedDigest ?? 'null'}`,
    `  approvedAt: ${formatMigratedYamlScalar(data.plan.approvedAt)}`,
    `  approvedBy: ${data.plan.approvedBy ?? 'null'}`,
    `created: ${formatMigratedYamlScalar(data.created)}`,
    `updated: ${formatMigratedYamlScalar(data.updated)}`,
  ];
  return lines.join('\n');
}

function migrateArchivedSourceKey(ticketId: string): string {
  return `migrate~${ticketId}~archived`;
}

interface StatusesStepCounts {
  mapped: number;
  stageCounts: Record<string, number>;
  mappingBreakdown: Map<string, number>;
  archivedToDropped: number;
  blockedFlags: number;
  parkedFlags: number;
  historyBackfilled: number;
  statusChangeRewritten: number;
  planApprovalRewritten: number;
  worktreeRenamed: number;
  fieldsDropped: number;
}

function transformTicketStatusesFrontmatter(
  content: string,
  ticketId: string,
  applyEvents: boolean,
): {
  content: string;
  counts: Partial<StatusesStepCounts>;
  mappingKey: string | null;
} {
  const partial: Partial<StatusesStepCounts> = {
    stageCounts: {
      backlog: 0,
      planning: 0,
      ready: 0,
      in_progress: 0,
      review: 0,
      done: 0,
      dropped: 0,
    },
  };
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return { content, counts: partial, mappingKey: null };

  const fm = fmMatch[1];
  const body = content.slice(fmMatch[0].length);
  const legacyStatus = parseScalarV1(fm, 'status') ?? 'draft';
  let nextStatus = legacyStatusToStage(legacyStatus);
  const blockedReason = parseScalarV1(fm, 'blockedReason');
  const parkedBool = parseBoolV1(fm, 'parked');
  const archived = parseBoolV1(fm, 'archived') === true;

  let blocked: string | null = blockedReason;
  if (legacyStatus === 'blocked' && !blocked) {
    blocked = 'blocked before v2';
  }
  let parked: string | null = null;
  if (parkedBool === true) {
    parked = 'parked before v2 (no reason recorded)';
  }

  let archivedEvent: { from: string; to: string; at: string } | undefined;
  if (archived && !V1_TERMINAL_STATUSES.has(legacyStatus)) {
    partial.archivedToDropped = 1;
    archivedEvent = {
      from: nextStatus,
      to: 'dropped',
      at: parseScalarV1(fm, 'updated') ?? new Date().toISOString(),
    };
    nextStatus = 'dropped';
  }

  const mappingKey = `${legacyStatus}→${nextStatus}`;
  partial.stageCounts![nextStatus] = (partial.stageCounts![nextStatus] ?? 0) + 1;
  partial.mapped = 1;
  if (blocked) partial.blockedFlags = 1;
  if (parked) partial.parkedFlags = 1;

  const workspace = parseWorkspaceV1(fm);
  if (workspace.hadWorktreePath) partial.worktreeRenamed = 1;

  const topLevelKeys = listTopLevelFrontmatterKeys(fm);
  partial.fieldsDropped = topLevelKeys.filter((key) => !V2_TICKET_FIELD_SET.has(key)).length;

  const planBlock = parseNestedFrontmatterBlock(fm, 'plan');
  const approval = parsePlanApprovalV1(`---\n${fm}\n---`);
  const plan = {
    file: planBlock?.file ?? approval?.file ?? null,
    approvedDigest: planBlock?.approvedDigest ?? approval?.digest ?? null,
    approvedAt: planBlock?.approvedAt ?? approval?.at ?? null,
    approvedBy: planBlock?.approvedBy ?? approval?.by ?? null,
  };

  const rendered = renderV2TicketFrontmatter({
    id: parseScalarV1(fm, 'id') ?? ticketId,
    slug: parseScalarV1(fm, 'slug') ?? '',
    title: parseScalarV1(fm, 'title') ?? '',
    project: parseScalarV1(fm, 'project'),
    template: parseScalarV1(fm, 'template'),
    status: nextStatus,
    priority: parseScalarV1(fm, 'priority') ?? 'medium',
    blocked,
    parked,
    depends_on: parseYamlListV1(fm, ['depends_on', 'dependsOn']),
    assignee: parseScalarV1(fm, 'assignee'),
    tags: parseYamlListV1(fm, ['tags']),
    links: parseYamlListV1(fm, ['links']),
    workspace: {
      repository: workspace.repository,
      worktree: workspace.worktree,
      branch: workspace.branch,
      parentBranch: workspace.parentBranch,
    },
    plan,
    created: parseScalarV1(fm, 'created') ?? '',
    updated: parseScalarV1(fm, 'updated') ?? '',
  });

  const next = `---\n${rendered}\n---${body.startsWith('\n') ? '' : '\n'}${body}`;

  if (applyEvents && archivedEvent) {
    insertEventOrThrow({
      ticketId,
      type: 'moved',
      actor: 'system',
      at: archivedEvent.at,
      sourceKey: migrateArchivedSourceKey(ticketId),
      details: {
        from: archivedEvent.from,
        to: archivedEvent.to,
        verb: 'drop',
        by: 'system',
        reason: 'archived',
      },
    });
  }

  return { content: next, counts: partial, mappingKey };
}

function synthesizeBackfillEvents(
  ticketId: string,
  fm: string,
): Array<{
  type: string;
  at: string;
  actor: string;
  details: Record<string, unknown>;
  sourceKey: string;
}> {
  const events: Array<{
    type: string;
    at: string;
    actor: string;
    details: Record<string, unknown>;
    sourceKey: string;
  }> = [];

  const history = parseStatusHistoryV1(fm);
  history.forEach((entry, index) => {
    if (entry.from === entry.to) return;
    events.push({
      type: 'status-change',
      at: entry.at,
      actor: entry.by ?? 'system',
      details: { from: entry.from, to: entry.to, command: entry.command },
      sourceKey: backfillStatusSourceKey(ticketId, index),
    });
  });

  const plan = parseNestedFrontmatterBlock(fm, 'plan');
  const approval = parsePlanApprovalV1(`---\n${fm}\n---`);
  const approvedDigest = plan?.approvedDigest ?? approval?.digest ?? null;
  const approvedFile = plan?.file ?? approval?.file ?? null;
  const approvedAt = plan?.approvedAt ?? approval?.at ?? parseScalarV1(fm, 'updated');
  const approvedBy = plan?.approvedBy ?? approval?.by ?? 'system';
  if (approvedFile && approvedDigest) {
    events.push({
      type: 'plan-approval',
      at: approvedAt ?? new Date().toISOString(),
      actor: approvedBy ?? 'system',
      details: { file: approvedFile, digest: approvedDigest },
      sourceKey: backfillPlanApprovalSourceKey(ticketId),
    });
  }

  return events;
}

function countLegacyEventRows(dbPath: string): {
  statusChange: number;
  planApproval: number;
} {
  const database = new Database(dbPath, { readonly: true });
  const statusChange = (
    database.prepare(`SELECT count(*) AS n FROM events WHERE type = 'status-change'`).get() as {
      n: number;
    }
  ).n;
  const planApproval = (
    database.prepare(`SELECT count(*) AS n FROM events WHERE type = 'plan-approval'`).get() as {
      n: number;
    }
  ).n;
  database.close();
  return { statusChange, planApproval };
}

function rewriteLegacyEvents(dbPath: string, apply: boolean): {
  statusChangeRewritten: number;
  planApprovalRewritten: number;
} {
  const database = apply ? getEventsDb() : new Database(dbPath, { readonly: true });
  let statusChangeRewritten = 0;
  let planApprovalRewritten = 0;

  const statusRows = database
    .prepare(
      `SELECT event_id, details, actor FROM events WHERE type = 'status-change'`,
    )
    .all() as Array<{ event_id: string; details: string | null; actor: string }>;

  for (const row of statusRows) {
    let parsed: { from?: string; to?: string; command?: string } = {};
    try {
      parsed = JSON.parse(row.details ?? '{}') as typeof parsed;
    } catch {
      continue;
    }
    const from = legacyStatusToStage(parsed.from ?? '');
    const to = legacyStatusToStage(parsed.to ?? '');
    const verb = parsed.command ?? 'unknown';
    const details = JSON.stringify({
      from,
      to,
      verb,
      by: row.actor,
    });
    if (apply) {
      database
        .prepare(`UPDATE events SET type = 'moved', details = ? WHERE event_id = ?`)
        .run(details, row.event_id);
    }
    statusChangeRewritten += 1;
  }

  const planRows = database
    .prepare(`SELECT event_id, details FROM events WHERE type = 'plan-approval'`)
    .all() as Array<{ event_id: string; details: string | null }>;

  for (const row of planRows) {
    if (apply) {
      database
        .prepare(`UPDATE events SET type = 'plan-approved', details = ? WHERE event_id = ?`)
        .run(row.details, row.event_id);
    }
    planApprovalRewritten += 1;
  }

  if (!apply) {
    database.close();
  }

  return { statusChangeRewritten, planApprovalRewritten };
}

const MAPPING_BREAKDOWN_ORDER = [
  'draft→backlog',
  'draft→dropped',
  'ready_for_planning→planning',
  'ready_for_planning→dropped',
  'ready_to_implement→ready',
  'in_progress→in_progress',
  'in_progress→dropped',
  'review→review',
  'completed→done',
  'failed→dropped',
  'blocked→in_progress',
  'pending→backlog',
] as const;

function formatMappingBreakdown(breakdown: Map<string, number>): string {
  const parts: string[] = [];
  for (const key of MAPPING_BREAKDOWN_ORDER) {
    const count = breakdown.get(key);
    if (count && count > 0) parts.push(`${key} ${count}`);
  }
  for (const [key, count] of breakdown.entries()) {
    if (count > 0 && !(MAPPING_BREAKDOWN_ORDER as readonly string[]).includes(key)) {
      parts.push(`${key} ${count}`);
    }
  }
  return parts.length > 0 ? parts.join(', ') : 'none';
}

async function runStatusesStep(
  home: string,
  apply: boolean,
  lines: string[],
  mode: string,
): Promise<void> {
  const counts: StatusesStepCounts = {
    mapped: 0,
    stageCounts: {
      backlog: 0,
      planning: 0,
      ready: 0,
      in_progress: 0,
      review: 0,
      done: 0,
      dropped: 0,
    },
    mappingBreakdown: new Map(),
    archivedToDropped: 0,
    blockedFlags: 0,
    parkedFlags: 0,
    historyBackfilled: 0,
    statusChangeRewritten: 0,
    planApprovalRewritten: 0,
    worktreeRenamed: 0,
    fieldsDropped: 0,
  };

  const dbPath = resolve(home, 'syntaur.db');
  const hasDb = await fileExists(dbPath);
  const legacyEventCounts = hasDb ? countLegacyEventRows(dbPath) : { statusChange: 0, planApproval: 0 };
  if (apply) {
    initEventsDb(dbPath);
  }

  const ticketPaths = await collectTicketMdPaths(home);
  for (const ticketMdPath of ticketPaths) {
    const content = await readFile(ticketMdPath, 'utf-8');
    if (!content.trimStart().startsWith('---')) continue;
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;
    const ticketId = parseScalarV1(fmMatch[1], 'id');
    if (!ticketId) continue;

    const backfillEvents = synthesizeBackfillEvents(ticketId, fmMatch[1]);
    for (const event of backfillEvents) {
      if (apply) {
        const inserted = insertEventOrThrow({
          ticketId,
          type: event.type,
          actor: event.actor,
          at: event.at,
          details: event.details,
          sourceKey: event.sourceKey,
        });
        counts.historyBackfilled += inserted;
      } else if (hasDb) {
        const database = new Database(dbPath, { readonly: true });
        const existing = database
          .prepare('SELECT 1 FROM events WHERE source_key = ? LIMIT 1')
          .get(event.sourceKey);
        if (!existing) counts.historyBackfilled += 1;
        database.close();
      } else {
        counts.historyBackfilled += 1;
      }
    }

    const { content: next, counts: partial, mappingKey } = transformTicketStatusesFrontmatter(
      content,
      ticketId,
      apply,
    );
    counts.mapped += partial.mapped ?? 0;
    counts.archivedToDropped += partial.archivedToDropped ?? 0;
    counts.blockedFlags += partial.blockedFlags ?? 0;
    counts.parkedFlags += partial.parkedFlags ?? 0;
    counts.worktreeRenamed += partial.worktreeRenamed ?? 0;
    counts.fieldsDropped += partial.fieldsDropped ?? 0;
    if (mappingKey) {
      counts.mappingBreakdown.set(
        mappingKey,
        (counts.mappingBreakdown.get(mappingKey) ?? 0) + 1,
      );
    }
    for (const [stage, n] of Object.entries(partial.stageCounts ?? {})) {
      counts.stageCounts[stage] = (counts.stageCounts[stage] ?? 0) + n;
    }
    if (apply && next !== content) {
      await writeFileForce(ticketMdPath, next);
    }
  }

  const rewritten = hasDb
    ? rewriteLegacyEvents(dbPath, apply)
    : { statusChangeRewritten: 0, planApprovalRewritten: 0 };
  counts.statusChangeRewritten = rewritten.statusChangeRewritten;
  counts.planApprovalRewritten = rewritten.planApprovalRewritten;

  if (apply) {
    const deriveMarker = resolve(home, 'derive-migrated');
    const stagesMarker = resolve(home, 'stages-migrated');
    const workflowsDirPath = resolve(home, 'workflows');
    if (await fileExists(deriveMarker)) await rm(deriveMarker);
    if (await fileExists(stagesMarker)) await rm(stagesMarker);
    if (await fileExists(workflowsDirPath)) await rm(workflowsDirPath, { recursive: true });
  }

  const sc = counts.stageCounts;
  logLine(
    lines,
    mode,
    `statuses: ${counts.mapped} tickets mapped (backlog ${sc.backlog}, planning ${sc.planning}, ready ${sc.ready}, in_progress ${sc.in_progress}, review ${sc.review}, done ${sc.done}, dropped ${sc.dropped})`,
  );
  logLine(lines, mode, `archived → dropped: ${counts.archivedToDropped}`);
  logLine(
    lines,
    mode,
    `flags: blocked ${counts.blockedFlags}, parked ${counts.parkedFlags}`,
  );
  logLine(
    lines,
    mode,
    `history: ${counts.historyBackfilled} backfilled, ${legacyEventCounts.statusChange} status-change and ${legacyEventCounts.planApproval} plan-approval rows rewritten`,
  );
  logLine(lines, mode, `mapped: ${formatMappingBreakdown(counts.mappingBreakdown)}`);
  logLine(lines, mode, `worktree: ${counts.worktreeRenamed} renamed`);
  logLine(lines, mode, `dropped fields: ${counts.fieldsDropped}`);
  logLine(lines, mode, 'removed: derive-migrated, stages-migrated, workflows/');
}

function updateProjectMd(
  content: string,
  prefix: string,
  nextTicket: number,
): string {
  let next = content;
  next = replaceFrontmatterScalar(next, 'prefix', prefix);
  next = replaceFrontmatterScalar(next, 'nextTicket', String(nextTicket));
  if (!/^defaultTemplate:\s*/m.test(next)) {
    next = replaceFrontmatterScalar(next, 'defaultTemplate', 'feature');
  }
  return next;
}

export function migrateSessionKey(
  sessionKey: string,
  uuidToId: Map<string, string>,
): string {
  if (!sessionKey.includes(':')) return sessionKey;
  const colonIdx = sessionKey.indexOf(':');
  const first = sessionKey.slice(0, colonIdx);
  const rest = sessionKey.slice(colonIdx + 1);
  const id = uuidToId.get(first);
  if (!id) return sessionKey;
  if (rest === '@assignment') return `${id}~@ticket`;
  return `${id}~${rest}`;
}

export function migrateItemId(
  itemId: string,
  uuidToId: Map<string, string>,
  itemIdMap: Map<string, string>,
): string {
  if (itemIdMap.has(itemId)) return itemIdMap.get(itemId)!;

  const replay = itemId.match(/^replay:(\d+):(\d+)$/);
  if (replay) return `replay~${replay[1]}~${replay[2]}`;

  const sessionScoped = itemId.match(/^session:([^:]+):([^:]+):(\d+)$/);
  if (sessionScoped) {
    const uuid = sessionScoped[1];
    const harness = sessionScoped[2];
    const n = sessionScoped[3];
    const id = uuidToId.get(uuid) ?? uuid;
    return `session~${id}~${harness}~${n}`;
  }

  const turnScoped = itemId.match(/^([0-9a-f-]{36}):(\d+)$/i);
  if (turnScoped) {
    const uuid = turnScoped[1];
    const n = turnScoped[2];
    const id = uuidToId.get(uuid);
    return id ? `${id}~${n}` : `${uuid}~${n}`;
  }

  if (itemId.includes(':')) {
    const parts = itemId.split(':');
    if (uuidToId.has(parts[0])) {
      parts[0] = uuidToId.get(parts[0])!;
      return parts.join('~');
    }
  }

  return itemId;
}

/** Canonical tilde form for backfilled status events. */
export function backfillStatusSourceKey(ticketId: string, index: number): string {
  return `backfill~${ticketId}~status~${index}`;
}

/** Canonical tilde form for backfilled plan-approval events. */
export function backfillPlanApprovalSourceKey(ticketId: string): string {
  return `backfill~${ticketId}~plan-approval`;
}

/** `backfill:<uuid>:status:<n>` → `backfill~<ID>~status~<n>`; same for plan-approval. */
export function migrateBackfillSourceKey(
  sourceKey: string,
  uuidToId: Map<string, string>,
): string | null {
  const statusMatch = sourceKey.match(/^backfill:([^:]+):status:(\d+)$/);
  if (statusMatch) {
    const id = uuidToId.get(statusMatch[1]);
    return id ? `backfill~${id}~status~${statusMatch[2]}` : null;
  }
  const planMatch = sourceKey.match(/^backfill:([^:]+):plan-approval$/);
  if (planMatch) {
    const id = uuidToId.get(planMatch[1]);
    return id ? `backfill~${id}~plan-approval` : null;
  }
  return null;
}

export function migrateSnoozeKey(
  key: string,
  uuidToId: Map<string, string>,
  itemIdMap: Map<string, string>,
): string {
  if (itemIdMap.has(key)) return itemIdMap.get(key)!;
  if (!key.includes(':')) return key;

  const colonIdx = key.indexOf(':');
  const first = key.slice(0, colonIdx);
  const rest = key.slice(colonIdx + 1);

  // `<UUID>:<category>` or `<UUID>:<compact-ts>`
  const idFromFirst = uuidToId.get(first);
  if (idFromFirst) return `${idFromFirst}~${rest}`;

  // `<category>:<UUID>` (legacy inbox row key)
  const idFromRest = uuidToId.get(rest);
  if (idFromRest && UUID_RE.test(rest)) return `${idFromRest}~${first}`;

  // Chat item ids and other colon forms
  return migrateItemId(key, uuidToId, itemIdMap);
}

function migratePayloadValue(
  value: unknown,
  uuidToId: Map<string, string>,
  itemIdMap: Map<string, string>,
): unknown {
  if (typeof value === 'string') {
    if (value.includes(':')) {
      if (UUID_RE.test(value) && uuidToId.has(value)) return uuidToId.get(value)!;
      return migrateItemId(value, uuidToId, itemIdMap);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => migratePayloadValue(v, uuidToId, itemIdMap));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = migratePayloadValue(v, uuidToId, itemIdMap);
    }
    return out;
  }
  return value;
}

function migratePayloadKeys(
  value: unknown,
  uuidToId: Map<string, string>,
  itemIdMap: Map<string, string>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => migratePayloadKeys(v, uuidToId, itemIdMap));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'assignmentId' && typeof v === 'string') {
        out.ticketId = uuidToId.get(v) ?? v;
        continue;
      }
      out[k] = migratePayloadKeys(v, uuidToId, itemIdMap);
    }
    return out;
  }
  return migratePayloadValue(value, uuidToId, itemIdMap);
}

function migrateChatEventLine(
  line: string,
  uuidToId: Map<string, string>,
  itemIdMap: Map<string, string>,
): string {
  if (!line.trim()) return line;
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (typeof event.assignmentId === 'string') {
      event.ticketId = uuidToId.get(event.assignmentId) ?? event.assignmentId;
      delete event.assignmentId;
    } else if (typeof event.ticketId === 'string') {
      event.ticketId = uuidToId.get(event.ticketId) ?? event.ticketId;
    }
    if (typeof event.sessionKey === 'string') {
      event.sessionKey = migrateSessionKey(event.sessionKey, uuidToId);
    }
    if ('payload' in event) {
      event.payload = migratePayloadKeys(event.payload, uuidToId, itemIdMap);
    }
    return `${JSON.stringify(event)}\n`;
  } catch {
    return line.endsWith('\n') ? line : `${line}\n`;
  }
}

function tableColumns(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

async function discoverTicketMd(
  ticketDir: string,
  folderName: string,
): Promise<{ path: string; rel: string } | null> {
  const assignmentMd = resolve(ticketDir, folderName, 'assignment.md');
  const ticketMd = resolve(ticketDir, folderName, 'ticket.md');
  if (await fileExists(assignmentMd)) return { path: assignmentMd, rel: 'assignment.md' };
  if (await fileExists(ticketMd)) return { path: ticketMd, rel: 'ticket.md' };
  return null;
}

async function discoverProjectTickets(
  projectSlug: string,
  projectDir: string,
): Promise<DiscoveredTicket[]> {
  const tickets: DiscoveredTicket[] = [];
  for (const sub of ['assignments', 'tickets'] as const) {
    const base = resolve(projectDir, sub);
    if (!(await fileExists(base))) continue;
    const entries = await readdir(base, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) {
        continue;
      }
      if (parseTicketFolderName(entry.name)) continue;
      const md = await discoverTicketMd(base, entry.name);
      if (!md) continue;
      const content = await readFile(md.path, 'utf-8');
      let fm;
      try {
        fm = parseTicketFrontmatter(content);
      } catch {
        continue;
      }
      if (!fm.id || !fm.slug) continue;
      tickets.push({
        uuid: fm.id,
        slug: fm.slug,
        status: fm.status,
        created: fm.created || '',
        oldFolder: entry.name,
        ticketMdRel: md.rel,
        ticketDir: resolve(base, entry.name),
        ticketMdPath: md.path,
        isStandalone: false,
        projectSlug,
        newId: '',
        newFolder: '',
      });
    }
  }
  return tickets;
}

async function discoverStandaloneTickets(home: string): Promise<DiscoveredTicket[]> {
  const tickets: DiscoveredTicket[] = [];
  const seen = new Set<string>();

  async function scanRoot(base: string): Promise<void> {
    if (!(await fileExists(base))) return;
    const entries = await readdir(base, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) {
        continue;
      }
      if (parseTicketFolderName(entry.name)) continue;
      const md = await discoverTicketMd(base, entry.name);
      if (!md) continue;
      const content = await readFile(md.path, 'utf-8');
      let fm;
      try {
        fm = parseTicketFrontmatter(content);
      } catch {
        continue;
      }
      if (!fm.id || !fm.slug) continue;
      if (seen.has(fm.id)) continue;
      seen.add(fm.id);
      tickets.push({
        uuid: fm.id,
        slug: fm.slug,
        status: fm.status,
        created: fm.created || '',
        oldFolder: entry.name,
        ticketMdRel: md.rel,
        ticketDir: resolve(base, entry.name),
        ticketMdPath: md.path,
        isStandalone: true,
        projectSlug: null,
        newId: '',
        newFolder: '',
      });
    }
  }

  // v1 real home: `<home>/assignments/<uuid>/assignment.md`
  await scanRoot(resolve(home, 'assignments'));
  // Phase-A-era home: `<home>/tickets/<folder>/`
  await scanRoot(resolve(home, 'tickets'));
  return tickets;
}

async function hasHalfAppliedTicketFolders(projectsDir: string): Promise<boolean> {
  if (!(await fileExists(projectsDir))) return false;
  const projects = await readdir(projectsDir, { withFileTypes: true });
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    for (const sub of ['assignments', 'tickets']) {
      const base = resolve(projectsDir, project.name, sub);
      if (!(await fileExists(base))) continue;
      const entries = await readdir(base, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && parseTicketFolderName(entry.name)) return true;
      }
    }
  }
  return false;
}

function buildMaps(plans: ProjectPlan[], standalone: DiscoveredTicket[]): MigrationMaps {
  const uuidToId = new Map<string, string>();
  const slugToId = new Map<string, string>();
  const projectSlugToId = new Map<string, Map<string, string>>();
  const itemIdMap = new Map<string, string>();
  const refWarnings: string[] = [];

  const standaloneSlugCounts = new Map<string, number>();
  for (const t of standalone) {
    standaloneSlugCounts.set(t.slug, (standaloneSlugCounts.get(t.slug) ?? 0) + 1);
  }
  const duplicateStandaloneSlugs = new Set(
    [...standaloneSlugCounts.entries()].filter(([, n]) => n > 1).map(([slug]) => slug),
  );

  for (const plan of plans) {
    const perProject = new Map<string, string>();
    for (const t of plan.tickets) {
      uuidToId.set(t.uuid, t.newId);
      slugToId.set(`${plan.slug}:${t.slug}`, t.newId);
      perProject.set(t.slug, t.newId);
    }
    projectSlugToId.set(plan.slug, perProject);
  }
  if (standalone.length > 0) {
    const scratchMap = new Map<string, string>();
    for (const t of standalone) {
      uuidToId.set(t.uuid, t.newId);
      slugToId.set(`scratch:${t.slug}`, t.newId);
      if (!duplicateStandaloneSlugs.has(t.slug)) {
        scratchMap.set(t.slug, t.newId);
      }
    }
    projectSlugToId.set('scratch', scratchMap);
  }

  return {
    uuidToId,
    slugToId,
    projectSlugToId,
    itemIdMap,
    duplicateStandaloneSlugs,
    refWarnings,
  };
}

export function mapTicketRef(
  ref: string,
  projectSlug: string | null,
  maps: MigrationMaps,
): string {
  if (maps.uuidToId.has(ref)) return maps.uuidToId.get(ref)!;
  if (/^[A-Z]{2,5}-\d+$/.test(ref)) return ref;

  const resolved = resolveSlugInProject(ref, projectSlug, maps);
  if (resolved) return resolved;

  if (slugProjectOccurrenceCount(ref, maps) > 1) {
    const scope = projectSlug ?? 'unknown';
    maps.refWarnings.push(
      `ambiguous ticket reference "${ref}" in project ${scope} — left unchanged`,
    );
  }
  return ref;
}

async function rewriteSidecarTicketField(
  path: string,
  projectSlug: string | null,
  maps: MigrationMaps,
): Promise<void> {
  if (!(await fileExists(path))) return;
  const content = await readFile(path, 'utf-8');
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return;
  const ticketVal = fmMatch[1].match(/^ticket:\s*(.*)$/m)?.[1]?.trim() ?? '';
  const bare = ticketVal.replace(/^["']|["']$/g, '');
  const mapped = mapTicketRef(bare, projectSlug, maps);
  if (mapped === bare) return;
  const next = replaceFrontmatterScalar(content, 'ticket', mapped);
  await writeFileForce(path, next);
}

async function rewriteCommentsItemMarkers(
  path: string,
  maps: MigrationMaps,
): Promise<void> {
  if (!(await fileExists(path))) return;
  let content = await readFile(path, 'utf-8');
  const next = content.replace(/item="([^"]+)"/g, (_, itemId: string) => {
    const migrated = migrateItemId(itemId, maps.uuidToId, maps.itemIdMap);
    maps.itemIdMap.set(itemId, migrated);
    return `item="${migrated}"`;
  });
  if (next !== content) await writeFileForce(path, next);
}

async function migrateChatEventsFile(
  ticketDir: string,
  maps: MigrationMaps,
): Promise<boolean> {
  const eventsPath = resolve(ticketDir, 'chat', 'events.jsonl');
  if (!(await fileExists(eventsPath))) return false;
  const raw = await readFile(eventsPath, 'utf-8');
  const lines = raw.split('\n');
  const out = lines
    .map((line) => (line.trim() ? migrateChatEventLine(line, maps.uuidToId, maps.itemIdMap) : ''))
    .join('\n');
  const normalized = out.endsWith('\n') || out.length === 0 ? out : `${out}\n`;
  await writeFileForce(eventsPath, normalized);
  return true;
}

interface UnmatchedTableReport {
  count: number;
  slugs: string[];
}

export interface UnmatchedReport {
  usageEvents: UnmatchedTableReport;
  usageDaily: UnmatchedTableReport;
  engagement: UnmatchedTableReport;
  unattributedUsageEvents: number;
  unattributedUsageDaily: number;
  unattributedEngagement: number;
}

const USAGE_DAILY_SUM_COLS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_tokens',
  'cache_read_tokens',
  'total_tokens',
  'total_cost',
] as const;

function hasRowAttribution(
  ticketVal: string | null | undefined,
  slugVal: string | null | undefined,
): boolean {
  return (ticketVal ?? '').trim().length > 0 || (slugVal ?? '').trim().length > 0;
}

function resolveUsageDailyTicketId(
  ticketVal: string,
  projectSlug: string,
  maps: MigrationMaps,
): string {
  if (!ticketVal) return ticketVal;
  if (maps.uuidToId.has(ticketVal)) return maps.uuidToId.get(ticketVal)!;
  if (/^[A-Z]{2,5}-\d+$/.test(ticketVal)) return ticketVal;

  const projectKey = projectSlug === '' ? 'scratch' : projectSlug;
  if (
    projectKey === 'scratch' &&
    maps.duplicateStandaloneSlugs.has(ticketVal) &&
    !maps.uuidToId.has(ticketVal)
  ) {
    return ticketVal;
  }

  const resolved = resolveSlugInProject(ticketVal, projectKey, maps);
  return resolved ?? ticketVal;
}

function ticketRefMappable(
  ticketVal: string | null | undefined,
  projectSlug: string | null | undefined,
  slugVal: string | null | undefined,
  maps: MigrationMaps,
): boolean {
  if (ticketVal && maps.uuidToId.has(ticketVal)) return true;
  if (ticketVal && /^[A-Z]{2,5}-\d+$/.test(ticketVal)) return true;

  const dbProject = projectSlug ?? '';
  const projectKey = dbProject === '' ? 'scratch' : dbProject;

  if (slugVal) {
    if (projectKey === 'scratch' && maps.duplicateStandaloneSlugs.has(slugVal)) {
      return maps.uuidToId.has(ticketVal ?? '');
    }
    if (resolveSlugInProject(slugVal, projectKey, maps)) return true;
  }

  if (ticketVal && !UUID_RE.test(ticketVal)) {
    if (projectKey === 'scratch' && maps.duplicateStandaloneSlugs.has(ticketVal)) {
      return false;
    }
    if (resolveSlugInProject(ticketVal, projectKey, maps)) return true;
  }

  return false;
}

export function analyzeUnmatched(
  database: Database.Database,
  maps: MigrationMaps,
): UnmatchedReport {
  const empty = (): UnmatchedTableReport => ({ count: 0, slugs: [] });

  const tally = (
    ticketVal: string | null | undefined,
    projectSlug: string | null | undefined,
    slugVal: string | null | undefined,
    report: UnmatchedTableReport,
    unattributed: { count: number },
  ): void => {
    if (!hasRowAttribution(ticketVal, slugVal)) {
      unattributed.count += 1;
      return;
    }
    if (ticketRefMappable(ticketVal, projectSlug, slugVal, maps)) return;
    report.count += 1;
    const slugHint = (slugVal ?? '').trim() || (ticketVal ?? '').trim();
    if (slugHint) report.slugs.push(slugHint);
  };

  const usageEvents = empty();
  const usageDaily = empty();
  const engagement = empty();
  const unattributedUsageEvents = { count: 0 };
  const unattributedUsageDaily = { count: 0 };
  const unattributedEngagement = { count: 0 };

  const engagementCols = tableColumns(database, 'engagement');
  const engTicketCol = engagementCols.has('ticket_id') ? 'ticket_id' : 'assignment_id';
  if (engagementCols.has(engTicketCol)) {
    const rows = database
      .prepare(
        `SELECT ${engTicketCol} AS ticket_val, project_slug, assignment_slug FROM engagement`,
      )
      .all() as Array<{
      ticket_val: string | null;
      project_slug: string | null;
      assignment_slug: string | null;
    }>;
    for (const row of rows) {
      tally(
        row.ticket_val,
        row.project_slug,
        row.assignment_slug,
        engagement,
        unattributedEngagement,
      );
    }
  }

  const usageEventCols = tableColumns(database, 'usage_events');
  const usageEventTicketCol = usageEventCols.has('ticket_id')
    ? 'ticket_id'
    : usageEventCols.has('assignment_id')
      ? 'assignment_id'
      : usageEventCols.has('assignment_slug')
        ? 'assignment_slug'
        : null;
  if (usageEventTicketCol) {
    const slugCol = usageEventCols.has('assignment_slug') ? 'assignment_slug' : null;
    const rows = database
      .prepare(
        `SELECT ${usageEventTicketCol} AS ticket_val, project_slug${
          slugCol ? `, ${slugCol}` : ', NULL AS assignment_slug'
        } FROM usage_events`,
      )
      .all() as Array<{
      ticket_val: string | null;
      project_slug: string | null;
      assignment_slug: string | null;
    }>;
    for (const row of rows) {
      tally(
        row.ticket_val,
        row.project_slug,
        row.assignment_slug,
        usageEvents,
        unattributedUsageEvents,
      );
    }
  }

  const usageDailyCols = tableColumns(database, 'usage_daily');
  const usageDailyTicketCol = usageDailyCols.has('ticket_id')
    ? 'ticket_id'
    : usageDailyCols.has('assignment_slug')
      ? 'assignment_slug'
      : null;
  if (usageDailyTicketCol) {
    const slugCol = usageDailyCols.has('assignment_slug') ? 'assignment_slug' : null;
    const rows = database
      .prepare(
        `SELECT ${usageDailyTicketCol} AS ticket_val, project_slug${
          slugCol ? `, ${slugCol}` : ', NULL AS assignment_slug'
        } FROM usage_daily`,
      )
      .all() as Array<{
      ticket_val: string | null;
      project_slug: string | null;
      assignment_slug: string | null;
    }>;
    for (const row of rows) {
      tally(
        row.ticket_val,
        row.project_slug,
        row.assignment_slug,
        usageDaily,
        unattributedUsageDaily,
      );
    }
  }

  const dedupeSlugs = (r: UnmatchedTableReport): UnmatchedTableReport => ({
    count: r.count,
    slugs: [...new Set(r.slugs)].sort(),
  });

  return {
    usageEvents: dedupeSlugs(usageEvents),
    usageDaily: dedupeSlugs(usageDaily),
    engagement: dedupeSlugs(engagement),
    unattributedUsageEvents: unattributedUsageEvents.count,
    unattributedUsageDaily: unattributedUsageDaily.count,
    unattributedEngagement: unattributedEngagement.count,
  };
}

export function countUsageDailyMerges(
  database: Database.Database,
  maps: MigrationMaps,
): number {
  const usageDailyCols = tableColumns(database, 'usage_daily');
  const ticketCol = usageDailyCols.has('ticket_id')
    ? 'ticket_id'
    : usageDailyCols.has('assignment_slug')
      ? 'assignment_slug'
      : null;
  if (!ticketCol) return 0;

  const rows = database
    .prepare(
      `SELECT day, tool, model, project_slug, ${ticketCol} AS ticket_val FROM usage_daily`,
    )
    .all() as Array<{
    day: string;
    tool: string;
    model: string;
    project_slug: string;
    ticket_val: string;
  }>;

  const groups = new Map<string, number>();
  for (const row of rows) {
    const newId = resolveUsageDailyTicketId(row.ticket_val, row.project_slug, maps);
    const key = `${row.day}\0${row.tool}\0${row.model}\0${row.project_slug}\0${newId}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }

  let merges = 0;
  for (const count of groups.values()) {
    if (count > 1) merges += count - 1;
  }
  return merges;
}

function formatUnmatchedLine(
  kind: 'usage_events' | 'usage_daily' | 'engagement',
  report: UnmatchedTableReport,
): string | null {
  if (report.count === 0) return null;
  const shown = report.slugs.slice(0, 10);
  const extra = report.slugs.length > 10 ? `, … (+${report.slugs.length - 10} more)` : '';
  const slugHint =
    shown.length > 0
      ? ` (slugs without a ticket folder: ${shown.join(', ')}${extra})`
      : '';
  return `unmatched ${kind} rows: ${report.count}${slugHint}`;
}

function logUnmatchedReport(
  lines: string[],
  mode: string,
  report: UnmatchedReport,
): void {
  for (const line of [
    formatUnmatchedLine('usage_events', report.usageEvents),
    formatUnmatchedLine('usage_daily', report.usageDaily),
    formatUnmatchedLine('engagement', report.engagement),
  ]) {
    if (line) logLine(lines, mode, line);
  }
  if (report.unattributedUsageEvents > 0) {
    logLine(lines, mode, `unattributed usage_events rows: ${report.unattributedUsageEvents}`);
  }
  if (report.unattributedUsageDaily > 0) {
    logLine(lines, mode, `unattributed usage_daily rows: ${report.unattributedUsageDaily}`);
  }
  if (report.unattributedEngagement > 0) {
    logLine(lines, mode, `unattributed engagement rows: ${report.unattributedEngagement}`);
  }
}

function countBackfillSourceKeyRewrites(
  database: Database.Database,
  maps: MigrationMaps,
): number {
  const eventsCols = tableColumns(database, 'events');
  if (!eventsCols.has('source_key')) return 0;
  const rows = database
    .prepare('SELECT source_key FROM events WHERE source_key IS NOT NULL')
    .all() as Array<{ source_key: string }>;
  let count = 0;
  for (const row of rows) {
    const next = migrateBackfillSourceKey(row.source_key, maps.uuidToId);
    if (next && next !== row.source_key) count += 1;
  }
  return count;
}

function mergeUsageDailyRows(
  database: Database.Database,
  cols: Set<string>,
  ticketCol: string,
  targetTicket: string,
  sourceTicket: string,
  day: string,
  tool: string,
  model: string,
  projectSlug: string,
): void {
  const source = database
    .prepare(
      `SELECT * FROM usage_daily WHERE day = ? AND tool = ? AND model = ? AND project_slug = ? AND ${ticketCol} = ?`,
    )
    .get(day, tool, model, projectSlug, sourceTicket) as Record<string, number | string> | undefined;
  if (!source) return;

  const sumParts: string[] = [];
  const params: Record<string, number | string> = {
    day,
    tool,
    model,
    project_slug: projectSlug,
    target_ticket: targetTicket,
    source_ticket: sourceTicket,
  };
  for (const col of USAGE_DAILY_SUM_COLS) {
    if (!cols.has(col)) continue;
    sumParts.push(`${col} = ${col} + @src_${col}`);
    params[`src_${col}`] = source[col] as number;
  }
  if (cols.has('frozen')) {
    sumParts.push('frozen = MAX(frozen, @src_frozen)');
    params.src_frozen = source.frozen as number;
  }
  const tsCol = cols.has('computed_at') ? 'computed_at' : null;
  if (tsCol) {
    sumParts.push(
      `${tsCol} = CASE WHEN ${tsCol} > @src_${tsCol} THEN ${tsCol} ELSE @src_${tsCol} END`,
    );
    params[`src_${tsCol}`] = source[tsCol] as string;
  }

  database
    .prepare(
      `UPDATE usage_daily SET ${sumParts.join(', ')}
       WHERE day = @day AND tool = @tool AND model = @model AND project_slug = @project_slug AND ${ticketCol} = @target_ticket`,
    )
    .run(params);

  database
    .prepare(
      `DELETE FROM usage_daily WHERE day = @day AND tool = @tool AND model = @model AND project_slug = @project_slug AND ${ticketCol} = @source_ticket`,
    )
    .run(params);
}

export function rekeyDatabase(
  dbPath: string,
  maps: MigrationMaps,
): {
  events: number;
  eventsSourceKey: number;
  engagementByUuid: number;
  engagementBySlug: number;
  chatSessionsTicket: number;
  chatSessionsKey: number;
  chatItemsSessionKey: number;
  chatItemsTicket: number;
  usageEvents: number;
  usageDaily: number;
  usageDailyMerged: number;
  skippedStandaloneSlugRekeys: string[];
} {
  const database = new Database(dbPath);
  database.pragma('journal_mode = WAL');
  const skippedStandaloneSlugRekeys: string[] = [];
  const counts = {
    events: 0,
    eventsSourceKey: 0,
    engagementByUuid: 0,
    engagementBySlug: 0,
    chatSessionsTicket: 0,
    chatSessionsKey: 0,
    chatItemsSessionKey: 0,
    chatItemsTicket: 0,
    usageEvents: 0,
    usageDaily: 0,
    usageDailyMerged: 0,
    skippedStandaloneSlugRekeys,
  };

  database.exec('BEGIN IMMEDIATE');
  try {
  const eventsCols = tableColumns(database, 'events');
  const ticketCol = eventsCols.has('ticket_id') ? 'ticket_id' : 'assignment_id';
  if (eventsCols.has(ticketCol)) {
    for (const [uuid, id] of maps.uuidToId) {
      const r = database
        .prepare(`UPDATE events SET ${ticketCol} = ? WHERE ${ticketCol} = ?`)
        .run(id, uuid);
      counts.events += r.changes;
    }
    if (eventsCols.has('source_key')) {
      const rows = database
        .prepare('SELECT source_key FROM events WHERE source_key IS NOT NULL')
        .all() as Array<{ source_key: string }>;
      for (const row of rows) {
        const next = migrateBackfillSourceKey(row.source_key, maps.uuidToId);
        if (next && next !== row.source_key) {
          counts.eventsSourceKey += database
            .prepare('UPDATE events SET source_key = ? WHERE source_key = ?')
            .run(next, row.source_key).changes;
        }
      }
    }
  }

  const engagementCols = tableColumns(database, 'engagement');
  const engTicketCol = engagementCols.has('ticket_id') ? 'ticket_id' : 'assignment_id';
  if (engagementCols.has(engTicketCol)) {
    for (const [uuid, id] of maps.uuidToId) {
      const r = database
        .prepare(
          `UPDATE engagement SET ${engTicketCol} = ? WHERE ${engTicketCol} = ? AND ${engTicketCol} IS NOT NULL AND ${engTicketCol} != ''`,
        )
        .run(id, uuid);
      counts.engagementByUuid += r.changes;
    }
    if (engagementCols.has('project_slug') && engagementCols.has('assignment_slug')) {
      for (const [key, id] of maps.slugToId) {
        const [project, slug] = key.split(':');
        if (project === 'scratch' && maps.duplicateStandaloneSlugs.has(slug)) {
          if (!skippedStandaloneSlugRekeys.includes(slug)) {
            skippedStandaloneSlugRekeys.push(slug);
          }
          continue;
        }
        const r = database
          .prepare(
            `UPDATE engagement SET ${engTicketCol} = ? WHERE (${engTicketCol} IS NULL OR ${engTicketCol} = '') AND project_slug = ? AND assignment_slug = ?`,
          )
          .run(id, dbProjectSlugForMapKey(project), slug);
        counts.engagementBySlug += r.changes;
      }
    }
  }

  const chatSessionCols = tableColumns(database, 'chat_sessions');
  const chatTicketCol = chatSessionCols.has('ticket_id') ? 'ticket_id' : 'assignment_id';
  if (chatSessionCols.has(chatTicketCol)) {
    for (const [uuid, id] of maps.uuidToId) {
      counts.chatSessionsTicket += database
        .prepare(`UPDATE chat_sessions SET ${chatTicketCol} = ? WHERE ${chatTicketCol} = ?`)
        .run(id, uuid).changes;
    }
    const sessions = database
      .prepare('SELECT session_key FROM chat_sessions')
      .all() as Array<{ session_key: string }>;
    for (const row of sessions) {
      const next = migrateSessionKey(row.session_key, maps.uuidToId);
      if (next !== row.session_key) {
        counts.chatSessionsKey += database
          .prepare('UPDATE chat_sessions SET session_key = ? WHERE session_key = ?')
          .run(next, row.session_key).changes;
      }
    }
  }

  const chatItemCols = tableColumns(database, 'chat_items');
  const chatItemTicketCol = chatItemCols.has('ticket_id') ? 'ticket_id' : 'assignment_id';
  if (chatItemCols.has(chatItemTicketCol)) {
    for (const [uuid, id] of maps.uuidToId) {
      counts.chatItemsTicket += database
        .prepare(`UPDATE chat_items SET ${chatItemTicketCol} = ? WHERE ${chatItemTicketCol} = ?`)
        .run(id, uuid).changes;
    }
    const items = database
      .prepare('SELECT item_id, session_key FROM chat_items')
      .all() as Array<{ item_id: string; session_key: string }>;
    for (const row of items) {
      const nextItem = migrateItemId(row.item_id, maps.uuidToId, maps.itemIdMap);
      maps.itemIdMap.set(row.item_id, nextItem);
      const nextKey = migrateSessionKey(row.session_key, maps.uuidToId);
      if (nextItem !== row.item_id || nextKey !== row.session_key) {
        database
          .prepare(
            'UPDATE chat_items SET item_id = ?, session_key = ? WHERE item_id = ?',
          )
          .run(nextItem, nextKey, row.item_id);
        if (nextKey !== row.session_key) counts.chatItemsSessionKey += 1;
      }
    }
  }

  const usageEventCols = tableColumns(database, 'usage_events');
  const usageTicketCol = usageEventCols.has('ticket_id')
    ? 'ticket_id'
    : usageEventCols.has('assignment_slug')
      ? 'assignment_slug'
      : null;
  if (usageTicketCol) {
    for (const [uuid, id] of maps.uuidToId) {
      counts.usageEvents += database
        .prepare(`UPDATE usage_events SET ${usageTicketCol} = ? WHERE ${usageTicketCol} = ?`)
        .run(id, uuid).changes;
    }
    for (const [key, id] of maps.slugToId) {
      const [project, slug] = key.split(':');
      if (project === 'scratch' && maps.duplicateStandaloneSlugs.has(slug)) {
        if (!skippedStandaloneSlugRekeys.includes(slug)) {
          skippedStandaloneSlugRekeys.push(slug);
        }
        continue;
      }
      counts.usageEvents += database
        .prepare(
          `UPDATE usage_events SET ${usageTicketCol} = ? WHERE project_slug = ? AND ${usageTicketCol} = ?`,
        )
        .run(id, dbProjectSlugForMapKey(project), slug).changes;
    }
  }

  const usageDailyCols = tableColumns(database, 'usage_daily');
  const dailyTicketCol = usageDailyCols.has('ticket_id')
    ? 'ticket_id'
    : usageDailyCols.has('assignment_slug')
      ? 'assignment_slug'
      : null;
  if (dailyTicketCol) {
    for (const [uuid, id] of maps.uuidToId) {
      counts.usageDaily += database
        .prepare(`UPDATE usage_daily SET ${dailyTicketCol} = ? WHERE ${dailyTicketCol} = ?`)
        .run(id, uuid).changes;
    }
    for (const [key, id] of maps.slugToId) {
      const [project, slug] = key.split(':');
      if (project === 'scratch' && maps.duplicateStandaloneSlugs.has(slug)) {
        if (!skippedStandaloneSlugRekeys.includes(slug)) {
          skippedStandaloneSlugRekeys.push(slug);
        }
        continue;
      }
      const dbProject = dbProjectSlugForMapKey(project);
      const sources = database
        .prepare(
          `SELECT day, tool, model, project_slug FROM usage_daily WHERE project_slug = ? AND ${dailyTicketCol} = ?`,
        )
        .all(dbProject, slug) as Array<{
        day: string;
        tool: string;
        model: string;
        project_slug: string;
      }>;
      for (const source of sources) {
        const collision = database
          .prepare(
            `SELECT 1 AS ok FROM usage_daily WHERE day = ? AND tool = ? AND model = ? AND project_slug = ? AND ${dailyTicketCol} = ?`,
          )
          .get(source.day, source.tool, source.model, source.project_slug, id) as
          | { ok: number }
          | undefined;
        if (collision) {
          mergeUsageDailyRows(
            database,
            usageDailyCols,
            dailyTicketCol,
            id,
            slug,
            source.day,
            source.tool,
            source.model,
            source.project_slug,
          );
          counts.usageDailyMerged += 1;
          counts.usageDaily += 1;
        } else {
          counts.usageDaily += database
            .prepare(
              `UPDATE usage_daily SET ${dailyTicketCol} = ? WHERE day = ? AND tool = ? AND model = ? AND project_slug = ? AND ${dailyTicketCol} = ?`,
            )
            .run(
              id,
              source.day,
              source.tool,
              source.model,
              source.project_slug,
              slug,
            ).changes;
        }
      }
    }
  }

    database.exec('COMMIT');
  } catch (err) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // ignore rollback failure
    }
    throw err;
  } finally {
    database.close();
  }
  return counts;
}

async function createBackup(home: string): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = `${home}.bak-v2-${ts}`;
  await cp(home, backupDir, { recursive: true });
  const dbPath = resolve(home, 'syntaur.db');
  if (await fileExists(dbPath)) {
    const db = new Database(dbPath);
    await db.backup(resolve(backupDir, 'syntaur.db.pre-v2.bak'));
    db.close();
    await rm(resolve(home, 'syntaur.db-wal'), { force: true });
    await rm(resolve(home, 'syntaur.db-shm'), { force: true });
  }
  return backupDir;
}

async function ensureScratchProject(
  projectsDir: string,
  prefix: string,
  nextTicket: number,
): Promise<void> {
  const scratchDir = resolve(projectsDir, 'scratch');
  const projectMd = resolve(scratchDir, 'project.md');
  if (await fileExists(projectMd)) {
    await writeProjectScaffold(
      scratchDir,
      {
        slug: 'scratch',
        title: 'Scratch',
        prefix,
        nextTicket,
      },
      { onlyMissing: true },
    );
    return;
  }
  await writeProjectScaffold(scratchDir, {
    slug: 'scratch',
    title: 'Scratch',
    prefix,
    nextTicket,
    id: randomUUID(),
  });
}

function retargetTicketDir(ticket: DiscoveredTicket, fromSub: string, toSub: string): void {
  const from = `${fromSub}/`;
  const to = `${toSub}/`;
  if (!ticket.ticketDir.includes(from)) return;
  ticket.ticketDir = ticket.ticketDir.replace(from, to);
  ticket.ticketMdPath = resolve(ticket.ticketDir, basename(ticket.ticketMdPath));
}

async function applyFilesystemMigration(
  home: string,
  plans: ProjectPlan[],
  standalone: DiscoveredTicket[],
  maps: MigrationMaps,
  scratchPrefix: string,
): Promise<void> {
  const projectsDir = resolve(home, 'projects');

  for (const plan of plans) {
    const assignmentsDir = resolve(plan.projectDir, 'assignments');
    const ticketsPath = resolve(plan.projectDir, 'tickets');
    if (await fileExists(assignmentsDir) && !(await fileExists(ticketsPath))) {
      await rename(assignmentsDir, ticketsPath);
      for (const ticket of plan.tickets) {
        retargetTicketDir(ticket, 'assignments', 'tickets');
      }
    }

    const indexAssignments = resolve(plan.projectDir, '_index-assignments.md');
    const indexTickets = resolve(plan.projectDir, '_index-tickets.md');
    if (await fileExists(indexAssignments) && !(await fileExists(indexTickets))) {
      await rename(indexAssignments, indexTickets);
    }

    let projectMd = await readFile(resolve(plan.projectDir, 'project.md'), 'utf-8');
    projectMd = updateProjectMd(projectMd, plan.prefix, plan.nextTicket);
    await writeFileForce(resolve(plan.projectDir, 'project.md'), projectMd);

    for (const ticket of plan.tickets) {
      let content = await readFile(ticket.ticketMdPath, 'utf-8');
      content = replaceFrontmatterScalar(content, 'id', ticket.newId);
      content = mapListField(content, 'dependsOn', (ref) =>
        mapTicketRef(ref, plan.slug, maps),
      );
      content = mapListField(content, 'links', (ref) => mapTicketRef(ref, plan.slug, maps));
      await writeFileForce(ticket.ticketMdPath, content);

      const ticketMdPath = resolve(ticket.ticketDir, 'ticket.md');
      if (ticket.ticketMdPath !== ticketMdPath && (await fileExists(ticket.ticketMdPath))) {
        await rename(ticket.ticketMdPath, ticketMdPath);
      }

      const parentDir = resolve(ticket.ticketDir, '..');
      const newDir = resolve(parentDir, ticket.newFolder);
      if (ticket.ticketDir !== newDir) {
        await rename(ticket.ticketDir, newDir);
        ticket.ticketDir = newDir;
        ticket.ticketMdPath = resolve(newDir, 'ticket.md');
      }

      for (const sidecar of SIDECAR_FILES) {
        await rewriteSidecarTicketField(resolve(ticket.ticketDir, sidecar), plan.slug, maps);
      }
      await rewriteCommentsItemMarkers(resolve(ticket.ticketDir, 'comments.md'), maps);
    }
  }

  if (standalone.length > 0) {
    const maxNum = standalone.reduce((max, t) => {
      const n = Number.parseInt(t.newId.split('-')[1] ?? '0', 10);
      return Math.max(max, n);
    }, 0);
    await ensureScratchProject(projectsDir, scratchPrefix, maxNum + 1);
    const scratchTickets = resolve(projectsDir, 'scratch', 'tickets');
    await ensureDir(scratchTickets);

    for (const ticket of standalone) {
      let content = await readFile(ticket.ticketMdPath, 'utf-8');
      content = replaceFrontmatterScalar(content, 'id', ticket.newId);
      content = replaceFrontmatterScalar(content, 'project', 'scratch');
      content = mapListField(content, 'dependsOn', (ref) => mapTicketRef(ref, 'scratch', maps));
      content = mapListField(content, 'links', (ref) => mapTicketRef(ref, 'scratch', maps));
      await writeFileForce(ticket.ticketMdPath, content);

      const ticketMdPath = resolve(ticket.ticketDir, 'ticket.md');
      if (ticket.ticketMdPath !== ticketMdPath) {
        await rename(ticket.ticketMdPath, ticketMdPath);
      }

      const dest = resolve(scratchTickets, ticket.newFolder);
      await rename(ticket.ticketDir, dest);
      ticket.ticketDir = dest;
      ticket.ticketMdPath = resolve(dest, 'ticket.md');

      for (const sidecar of SIDECAR_FILES) {
        await rewriteSidecarTicketField(resolve(ticket.ticketDir, sidecar), 'scratch', maps);
      }
      await rewriteCommentsItemMarkers(resolve(ticket.ticketDir, 'comments.md'), maps);
    }

    for (const sub of ['assignments', 'tickets'] as const) {
      const base = resolve(home, sub);
      if (!(await fileExists(base))) continue;
      const remaining = (await readdir(base)).filter((e) => !e.startsWith('.'));
      if (remaining.length === 0) {
        await rm(base, { recursive: true, force: true });
      }
    }

    await rebuildProjectTicketIndex(resolve(projectsDir, 'scratch'));
  }
}

async function migrateChatAndRebuild(
  tickets: DiscoveredTicket[],
  maps: MigrationMaps,
): Promise<void> {
  const dbPath = resolve(syntaurRoot(), 'syntaur.db');
  resetSessionDb();
  resetEventsDb();
  resetUsageDb();
  initSessionDb(dbPath);
  initEventsDb(dbPath);
  initUsageDb(dbPath);

  for (const ticket of tickets) {
    const hadEvents = await migrateChatEventsFile(ticket.ticketDir, maps);
    if (hadEvents) {
      await rebuildChatIndex(ticket.ticketDir, ticket.newId);
    }
  }

  closeSessionDb();
  closeEventsDb();
  closeUsageDb();
  resetSessionDb();
  resetEventsDb();
  resetUsageDb();
}

async function rewriteInboxSnoozes(home: string, maps: MigrationMaps): Promise<void> {
  const path = resolve(home, 'inbox-snoozes.json');
  if (!(await fileExists(path))) return;
  const raw = await readFile(path, 'utf-8');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    const migrated = migrateSnoozeKey(key, maps.uuidToId, maps.itemIdMap);
    if (!key.includes(':') || COMPACT_TS_RE.test(key.split(':')[1] ?? '')) {
      maps.itemIdMap.set(key, migrated);
    }
    next[migrated] = value;
  }
  await writeFileForce(path, `${JSON.stringify(next, null, 2)}\n`);
}

async function rewriteConfigDefaultProjectDir(home: string, root: string): Promise<void> {
  const configPath = resolve(home, 'config.md');
  if (!(await fileExists(configPath))) return;
  const content = await readFile(configPath, 'utf-8');
  const target = resolve(root, 'projects');
  const next = content.replace(
    /^defaultProjectDir:\s*.*$/m,
    `defaultProjectDir: ${target}`,
  );
  if (next !== content) await writeFileForce(configPath, next);
}

async function runRenameIdsStep(
  home: string,
  options: MigrateV2Options,
  lines: string[],
  mode: string,
): Promise<void> {
  const projectsDir = resolve(home, 'projects');

  if (options.apply && (await hasHalfAppliedTicketFolders(projectsDir))) {
    throw new Error(
      'Refusing apply: id-prefixed ticket folders found without v2-migrated marker (possible half-applied migration). ' +
        'Restore from your .bak-v2-* backup before retrying.',
    );
  }

  const prefixOverrides = parsePrefixOverrides(options.prefix);
  const usedPrefixes = new Set<string>(prefixOverrides.values());

  const plans: ProjectPlan[] = [];
  if (await fileExists(projectsDir)) {
    const entries = await readdir(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectDir = resolve(projectsDir, entry.name);
      if (!(await fileExists(resolve(projectDir, 'project.md')))) continue;
      const tickets = await discoverProjectTickets(entry.name, projectDir);
      let prefix = prefixOverrides.get(entry.name);
      if (!prefix) {
        prefix = derivePrefix(entry.name, usedPrefixes);
      }
      usedPrefixes.add(prefix);
      plans.push({ slug: entry.name, projectDir, prefix, nextTicket: 1, tickets });
    }
  }

  let standalone = await discoverStandaloneTickets(home);
  let scratchPrefix = 'SCR';
  if (standalone.length > 0) {
    scratchPrefix = prefixOverrides.get('scratch') ?? derivePrefix('scratch', usedPrefixes);
    usedPrefixes.add(scratchPrefix);
    const sorted = [...standalone].sort((a, b) =>
      a.created.localeCompare(b.created) || a.slug.localeCompare(b.slug),
    );
    let n = 1;
    for (const t of sorted) {
      t.newId = `${scratchPrefix}-${n}`;
      t.newFolder = formatTicketFolderName(t.newId, t.slug);
      n += 1;
    }
  }

  for (const plan of plans) {
    const sorted = [...plan.tickets].sort(
      (a, b) => a.created.localeCompare(b.created) || a.slug.localeCompare(b.slug),
    );
    let n = 1;
    for (const t of sorted) {
      t.newId = `${plan.prefix}-${n}`;
      t.newFolder = formatTicketFolderName(t.newId, t.slug);
      n += 1;
    }
    plan.nextTicket = n;
  }

  const maps = buildMaps(plans, standalone);
  const allTickets = [...plans.flatMap((p) => p.tickets), ...standalone];

  for (const plan of plans) {
    logLine(lines, mode, `project ${plan.slug}: prefix ${plan.prefix}, ${plan.tickets.length} tickets`);
    for (const t of plan.tickets) {
      logLine(
        lines,
        mode,
        `${t.oldFolder} → ${t.newFolder} · ${t.newId} · ${t.status}→${t.status}`,
      );
    }
  }

  if (standalone.length > 0) {
    logLine(lines, mode, `standalone: ${standalone.length} tickets → scratch`);
    for (const t of standalone) {
      logLine(
        lines,
        mode,
        `${t.oldFolder} → ${t.newFolder} · ${t.newId} · ${t.status}→${t.status}`,
      );
    }
  }

  for (const t of allTickets) {
    logLine(lines, mode, `UUID ${t.uuid} → ${t.newId}`);
  }
  for (const [key, id] of maps.slugToId) {
    const [project, slug] = key.split(':');
    logLine(lines, mode, `(${project}, ${slug}) → ${id}`);
  }
  for (const slug of maps.duplicateStandaloneSlugs) {
    logLine(
      lines,
      mode,
      `skipped standalone slug re-key: ${slug} (duplicate slug among standalone tickets)`,
    );
  }

  const dbPath = resolve(home, 'syntaur.db');
  if (await fileExists(dbPath)) {
    const database = new Database(dbPath, { readonly: true });
    const unmatched = analyzeUnmatched(database, maps);
    logUnmatchedReport(lines, mode, unmatched);
    const backfillKeys = countBackfillSourceKeyRewrites(database, maps);
    if (backfillKeys > 0) {
      logLine(lines, mode, `re-keyed events.source_key: ${backfillKeys}`);
    }
    const dailyMerges = countUsageDailyMerges(database, maps);
    if (dailyMerges > 0) {
      logLine(lines, mode, `merged usage_daily rows: ${dailyMerges}`);
    }
    database.close();
  }

  const projectCount = plans.length + (standalone.length > 0 ? 1 : 0);

  if (!options.apply) {
    logLine(lines, mode, `totals: ${projectCount} projects, ${allTickets.length} tickets`);
    return;
  }

  if (await fileExists(dbPath)) {
    if (options.injectDbFailure) options.injectDbFailure();
    const counts = rekeyDatabase(dbPath, maps);
    logLine(lines, mode, `re-keyed events.ticket_id: ${counts.events}  (project_slug dropped)`);
    if (counts.eventsSourceKey > 0) {
      logLine(lines, mode, `re-keyed events.source_key: ${counts.eventsSourceKey}`);
    }
    logLine(
      lines,
      mode,
      `re-keyed engagement.ticket_id: ${counts.engagementByUuid}  (project_slug, assignment_slug dropped)`,
    );
    if (counts.engagementBySlug > 0) {
      logLine(
        lines,
        mode,
        `re-keyed engagement.ticket_id (by slug): ${counts.engagementBySlug}`,
      );
    }
    logLine(
      lines,
      mode,
      `re-keyed chat_sessions.ticket_id: ${counts.chatSessionsTicket}  (project_slug, assignment_slug dropped)`,
    );
    logLine(lines, mode, `re-keyed chat_sessions.session_key: ${counts.chatSessionsKey}`);
    logLine(lines, mode, `re-keyed chat_items.session_key: ${counts.chatItemsSessionKey}`);
    logLine(lines, mode, `re-keyed chat_items.ticket_id: ${counts.chatItemsTicket}`);
    logLine(
      lines,
      mode,
      `re-keyed usage_events.ticket_id: ${counts.usageEvents}  (assignment_slug dropped; project_slug kept)`,
    );
    logLine(
      lines,
      mode,
      `re-keyed usage_daily.ticket_id: ${counts.usageDaily}  (assignment_slug dropped; project_slug kept)`,
    );
    if (counts.usageDailyMerged > 0) {
      logLine(lines, mode, `merged usage_daily rows: ${counts.usageDailyMerged}`);
    }
    for (const slug of counts.skippedStandaloneSlugRekeys) {
      logLine(
        lines,
        mode,
        `skipped standalone slug re-key: ${slug} (duplicate slug among standalone tickets)`,
      );
    }
  }

  await applyFilesystemMigration(home, plans, standalone, maps, scratchPrefix);

  for (const warning of maps.refWarnings) {
    logLine(lines, mode, warning);
  }

  await migrateChatAndRebuild(allTickets, maps);
  await rewriteInboxSnoozes(home, maps);
  logLine(lines, mode, `totals: ${projectCount} projects, ${allTickets.length} tickets`);
}

export async function migrateV2Command(
  options: MigrateV2Options,
): Promise<MigrateV2Transcript> {
  process.env.SYNTAUR_HOME = resolve(expandHome(options.root ?? syntaurRoot()));
  const home = syntaurRoot();
  const mode = options.apply ? '[apply] ' : '[dry-run] ';
  const lines: string[] = [];

  const markerPath = resolve(home, V2_MIGRATED_MARKER);
  const markerState = await readMarkerSteps(markerPath);
  const pending = pendingMigrationSteps(markerState);

  if (pending.length === 0) {
    throw new Error(
      'v2 migration already completed (v2-migrated marker present). Remove the marker only if you have restored from backup.',
    );
  }

  let backupPath = '';
  if (options.apply) {
    try {
      backupPath = await createBackup(home);
      logLine(lines, mode, `backup: ${backupPath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${msg}\nMigration aborted. Restore from backup at ${backupPath || '<none>'}.`,
      );
    }
  }

  if (options.root) {
    logLine(lines, mode, `config defaultProjectDir → ${resolve(home, 'projects')}`);
    if (options.apply) {
      await rewriteConfigDefaultProjectDir(home, home);
    }
  }

  try {
    for (const step of pending) {
      if (step === 'rename-ids') {
        await runRenameIdsStep(home, options, lines, mode);
        if (options.apply) {
          await appendMarkerStep(markerPath, 'rename-ids');
        }
      } else if (step === 'templates') {
        await runTemplatesStep(home, options.apply ?? false, lines, mode);
        if (options.apply) {
          await appendMarkerStep(markerPath, 'templates');
        }
      } else if (step === 'statuses') {
        await runStatusesStep(home, options.apply ?? false, lines, mode);
        if (options.apply) {
          await appendMarkerStep(markerPath, 'statuses');
        }
      }
    }
    return { lines };
  } catch (err) {
    if (backupPath && options.apply) {
      await rm(home, { recursive: true, force: true });
      await cp(backupPath, home, { recursive: true });
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${msg}\nMigration aborted. Restore from backup at ${backupPath || '<none>'}.`,
    );
  }
}

export const v2MigrateCommand = new Command('v2')
  .description(
    'Migrate v1 / Phase-A ticket layout to v2 id-prefixed folders and colon-free keys',
  )
  .option('--apply', 'Apply changes (default is dry-run)')
  .option('--root <path>', 'Syntaur home to migrate (default ~/.syntaur)')
  .option('--prefix <pairs...>', 'Project prefix override as slug=PFX (repeatable)')
  .action(async (opts: { apply?: boolean; root?: string; prefix?: string[] }) => {
    try {
      await migrateV2Command({
        apply: opts.apply,
        root: opts.root,
        prefix: opts.prefix,
      });
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });
