import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseTicketFrontmatter } from '../lifecycle/frontmatter.js';
import { countRealAcceptanceCriteria } from './plan-facts.js';
import { buildGateContext } from './context.js';
import type { TicketFrontmatter } from '../lifecycle/types.js';
import { fileExists } from '../utils/fs.js';
import { chatLogPath, readEvents, replayItems } from '../chat/store.js';
import type { ChatItem } from '../chat/types.js';
import { loadTemplate, resolveTemplateForTicket } from './registry.js';
import { logRoleFile } from './manifest.js';
import type { StageId, TemplateManifest } from './manifest.js';
import { markdownBody, objectiveOneLiner, sectionFirstParagraph } from './content.js';
import { computeNextLine } from './gates.js';
import { parseLogEntries, type LogEntry } from './log-reader.js';
import { fileState } from './roles.js';
import { stageForStatus } from './stages.js';

export interface ShowTicket {
  id: string;
  title: string;
  template: string;
  status: string;
  stage: StageId | 'dropped';
  blocked: string | null;
  parked: string | null;
  objective: string;
  acceptance: { checked: number; total: number };
}

export interface ShowWorkspace {
  mode: 'set' | 'none' | 'not-set';
  repository: string | null;
  branch: string | null;
  worktree: string | null;
}

export interface ShowDepend {
  id: string;
  stage: StageId | 'dropped';
}

export interface ShowFile {
  path: string;
  role: string;
  state: string;
  description: string;
}

export interface ShowHandoff {
  text: string | null;
}

export interface ShowLogLine {
  timestamp: string;
  type: string;
  author: string | null;
  firstLine: string;
}

export interface ShowStage {
  id: StageId | 'dropped';
  instructions: string | null;
  offTemplate: boolean;
}

export interface ShowModel {
  ticket: ShowTicket;
  workspace: ShowWorkspace;
  depends: ShowDepend[];
  links: string[];
  files: ShowFile[];
  handoff: ShowHandoff;
  log: ShowLogLine[];
  stage: ShowStage;
  next: string;
  commands: string[];
}

const LOG_TAIL_COUNT = 3;

function buildWorkspace(manifest: TemplateManifest, fm: TicketFrontmatter): ShowWorkspace {
  if (manifest.workspace === 'none') {
    return { mode: 'none', repository: null, branch: null, worktree: null };
  }
  const w = fm.workspace;
  const set = Boolean(w.repository?.trim() && w.branch?.trim() && w.worktree?.trim());
  if (!set) {
    return { mode: 'not-set', repository: null, branch: null, worktree: null };
  }
  return {
    mode: 'set',
    repository: w.repository,
    branch: w.branch,
    worktree: w.worktree,
  };
}

function buildCommands(ticketId: string, _manifest: TemplateManifest): string[] {
  return [
    `syntaur log ${ticketId} -t <type> "..."`,
    `syntaur block ${ticketId} "<reason>"`,
    'ask via question log or @mention in chat',
  ];
}

function resolveStageBlock(
  manifest: TemplateManifest,
  stage: StageId | 'dropped',
): ShowStage {
  if (stage === 'dropped') {
    return { id: stage, instructions: null, offTemplate: false };
  }
  const declared = manifest.stages.find((s) => s.id === stage);
  if (!declared) {
    return { id: stage, instructions: null, offTemplate: true };
  }
  return { id: stage, instructions: declared.instructions.trim(), offTemplate: false };
}

function latestHandoff(entries: LogEntry[]): string | null {
  const handoff = entries.find((e) => e.type === 'handoff');
  return handoff?.firstLine ?? null;
}

function logTail(entries: LogEntry[]): ShowLogLine[] {
  return entries.slice(0, LOG_TAIL_COUNT).map((e) => ({
    timestamp: e.timestamp,
    type: e.type,
    author: e.author,
    firstLine: e.firstLine,
  }));
}

export async function buildShow(root: string, ticketDir: string): Promise<ShowModel> {
  const ticketMdPath = resolve(ticketDir, 'ticket.md');
  const content = await readFile(ticketMdPath, 'utf-8');
  const fm = parseTicketFrontmatter(content);
  const body = markdownBody(content);
  const templateId = resolveTemplateForTicket(fm);
  const manifest = await loadTemplate(root, templateId);
  const stage = stageForStatus(fm.status);
  const acceptance = countRealAcceptanceCriteria(body);
  const gateCtx = await buildGateContext(ticketDir);
  const logEntries = gateCtx.logEntries;

  const files: ShowFile[] = [];
  const kernelOneLiner = objectiveOneLiner(body) || fm.title;
  files.push({
    path: 'ticket.md',
    role: 'kernel',
    state: 'editable',
    description: kernelOneLiner,
  });

  for (const entry of manifest.files) {
    const state = await fileState(entry, ticketDir, fm, manifest);
    files.push({
      path: entry.path,
      role: entry.role ?? 'plain',
      state,
      description: entry.description,
    });
  }

  const next = await computeNextLine(fm.id, stage, manifest, gateCtx);

  return {
    ticket: {
      id: fm.id,
      title: fm.title,
      template: templateId,
      status: fm.status,
      stage,
      blocked: fm.blocked,
      parked: fm.parked,
      objective: sectionFirstParagraph(body, 'Objective'),
      acceptance: { checked: acceptance.checked, total: acceptance.total },
    },
    workspace: buildWorkspace(manifest, fm),
    depends: fm.depends_on.map((id) => ({
      id,
      stage: gateCtx.dependencyStages.get(id) ?? 'backlog',
    })),
    links: fm.links,
    files,
    handoff: { text: latestHandoff(logEntries) },
    log: logTail(logEntries),
    stage: resolveStageBlock(manifest, stage),
    next,
    commands: buildCommands(fm.id, manifest),
  };
}

function formatLogLine(line: ShowLogLine): string {
  const authorPart = line.author ? ` · ${line.author}` : '';
  const dash = line.firstLine ? ` — ${line.firstLine}` : '';
  return `  ## ${line.timestamp} · ${line.type}${authorPart}${dash}`;
}

export function renderShowText(model: ShowModel): string {
  const lines: string[] = [];
  const headerParts = [
    model.ticket.id,
    model.ticket.title,
    model.ticket.template,
    model.ticket.stage,
  ];
  if (model.ticket.blocked) {
    headerParts.push(`blocked: ${model.ticket.blocked}`);
  }
  if (model.ticket.parked) {
    headerParts.push(`parked: ${model.ticket.parked}`);
  }
  lines.push(headerParts.join(' · '));

  if (model.ticket.objective) {
    lines.push(`Objective: ${model.ticket.objective}`);
  }
  lines.push(
    `Acceptance: ${model.ticket.acceptance.checked} of ${model.ticket.acceptance.total} checked`,
  );

  if (model.workspace.mode === 'none') {
    lines.push('Workspace: none (template does not require one)');
  } else if (model.workspace.mode === 'set') {
    lines.push(
      `Workspace: ${model.workspace.repository} · ${model.workspace.branch} · ${model.workspace.worktree}`,
    );
  } else {
    lines.push('Workspace: not set');
  }

  if (model.depends.length === 0) {
    lines.push('Depends: none');
  } else {
    lines.push(
      `Depends: ${model.depends.map((d) => `${d.id} ${d.stage}`).join(', ')}`,
    );
  }

  if (model.links.length > 0) {
    lines.push(`Links: ${model.links.join(', ')}`);
  }

  lines.push('Files:');
  for (const file of model.files) {
    lines.push(`  ${file.path}  ${file.role} · ${file.state}`);
    if (file.description) {
      lines.push(`    ${file.description}`);
    }
  }

  lines.push(`Handoff: ${model.handoff.text ?? 'none'}`);
  lines.push(`Log: last ${model.log.length} entries`);
  for (const entry of model.log) {
    lines.push(formatLogLine(entry));
  }

  if (model.stage.offTemplate) {
    lines.push(
      `Stage: ${model.stage.id} (not declared by template ${model.ticket.template})`,
    );
  } else if (model.stage.instructions) {
    const instructions = model.stage.instructions.replace(/\s+/g, ' ').trim();
    lines.push(`Stage: ${model.stage.id}. ${instructions}`);
  } else {
    lines.push(`Stage: ${model.stage.id}`);
  }

  lines.push(`Next: ${model.next}`);
  lines.push(`Commands: ${model.commands.join('; ')}`);

  return lines.join('\n');
}

function chatNoteEntries(items: ChatItem[]): ShowLogLine[] {
  const notes: ShowLogLine[] = [];
  for (const item of items) {
    if (item.type === 'user.message' && item.text?.trim()) {
      notes.push({
        timestamp: item.ts,
        type: 'note',
        author: 'human',
        firstLine: item.text.trim().split('\n')[0] ?? '',
      });
    } else if (item.type === 'agent.message' && item.sealed && item.text?.trim()) {
      notes.push({
        timestamp: item.ts,
        type: 'note',
        author: item.agentId,
        firstLine: item.text.trim().split('\n')[0] ?? '',
      });
    }
  }
  notes.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return notes;
}

/** Print log entries only (`show --log`). */
export async function renderLogOnly(
  root: string,
  ticketDir: string,
  typeFilter?: string,
): Promise<string> {
  const ticketMdPath = resolve(ticketDir, 'ticket.md');
  const content = await readFile(ticketMdPath, 'utf-8');
  const fm = parseTicketFrontmatter(content);
  const manifest = await loadTemplate(root, resolveTemplateForTicket(fm));
  const logRole = logRoleFile(manifest);

  let entries: ShowLogLine[];
  if (logRole) {
    const path = resolve(ticketDir, logRole.path);
    if (!(await fileExists(path))) {
      return 'no log entries';
    }
    const parsed = parseLogEntries(await readFile(path, 'utf-8'));
    entries = parsed.map((e) => ({
      timestamp: e.timestamp,
      type: e.type,
      author: e.author,
      firstLine: e.firstLine,
    }));
  } else {
    const logPath = chatLogPath(ticketDir);
    if (!(await fileExists(logPath))) {
      return 'no log entries';
    }
    const events = await readEvents(logPath);
    entries = chatNoteEntries(replayItems(events, fm.id));
  }

  if (typeFilter) {
    entries = entries.filter((e) => e.type === typeFilter);
  }

  if (entries.length === 0) {
    return 'no log entries';
  }

  return entries.map((e) => formatLogLine(e).trimStart()).join('\n');
}
