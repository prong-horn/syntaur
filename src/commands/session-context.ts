import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { initSessionDb } from '../dashboard/session-db.js';
import { getOpenEngagement } from '../db/engagement-db.js';
import { buildShow } from '../ticket-templates/show.js';
import { listTemplates } from '../ticket-templates/registry.js';
import { fileExists } from '../utils/fs.js';
import { readConfig } from '../utils/config.js';
import { rowToBinding } from '../utils/engagement-binding.js';
import { playbooksDir, syntaurRoot } from '../utils/paths.js';
import {
  listPlaybookSlugs,
  loadEnabledPlaybook,
} from '../utils/playbooks.js';
import { isSafeSessionId } from '../utils/session-id.js';
import { resolveTicketTarget } from '../utils/ticket-target.js';
import { touchSession } from '../dashboard/agent-sessions.js';

export interface BuildPromptContextInput {
  root?: string;
  cwd: string;
  sessionId?: string | null;
}

export interface PromptContextResult {
  text: string;
  bytes: number;
  ticketId: string | null;
  stage: string | null;
  playbooks: string[];
}

interface ContextFile {
  sessionId?: string;
}

async function readContextSessionId(cwd: string): Promise<string | null> {
  const path = resolve(cwd, '.syntaur', 'context.json');
  if (!(await fileExists(path))) return null;
  try {
    const raw = await readFile(path, 'utf-8');
    const ctx = JSON.parse(raw) as ContextFile;
    return isSafeSessionId(ctx.sessionId) ? ctx.sessionId! : null;
  } catch {
    return null;
  }
}

/**
 * Enabled playbooks whose slug is not listed in any template manifest's
 * `playbooks` field (home copies first, shipped built-ins for missing ids).
 */
export async function crossTemplatePlaybooks(root: string): Promise<string[]> {
  const templates = await listTemplates(root);
  const claimed = new Set<string>();
  for (const template of templates) {
    for (const slug of template.manifest.playbooks ?? []) {
      claimed.add(slug);
    }
  }

  const config = await readConfig();
  const disabled = new Set(config.playbooks.disabled);
  const dir = playbooksDir();
  const slugs = await listPlaybookSlugs(dir);
  const cross: string[] = [];
  for (const slug of slugs) {
    if (disabled.has(slug)) continue;
    if (claimed.has(slug)) continue;
    cross.push(slug);
  }
  cross.sort((a, b) => a.localeCompare(b));
  return cross;
}

/** Drop a leading document H1 and the blank line after it when present. */
function stripLeadingDocumentH1(body: string): string {
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length) return body.trim();

  const first = lines[i].trim();
  if (/^#[^#]/.test(first)) {
    i++;
    while (i < lines.length && lines[i].trim() === '') i++;
    return lines.slice(i).join('\n').trim();
  }
  return body.trim();
}

async function formatPlaybooksSection(root: string): Promise<string[]> {
  const slugs = await crossTemplatePlaybooks(root);
  if (slugs.length === 0) return [];

  const lines: string[] = ['## Playbooks'];
  const dir = playbooksDir();
  for (const slug of slugs) {
    const parsed = await loadEnabledPlaybook(dir, slug);
    if (!parsed) continue;
    const name = parsed.name || slug;
    lines.push(`### ${name}`);
    if (parsed.body.trim()) {
      lines.push(stripLeadingDocumentH1(parsed.body));
    }
    lines.push('');
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

async function formatTicketBlock(
  root: string,
  cwd: string,
  sessionId: string,
): Promise<{ lines: string[]; ticketId: string | null; stage: string | null }> {
  initSessionDb();
  const row = getOpenEngagement(sessionId);
  if (!row) {
    return { lines: [], ticketId: null, stage: null };
  }

  const binding = rowToBinding(row);
  const target = await resolveTicketTarget(undefined, {
    cwd,
    resolveEngagement: async () => binding,
  });
  const show = await buildShow(root, target.ticketDir);
  const { ticket, stage, next } = show;

  const lines: string[] = ['# Syntaur'];
  lines.push(
    `Ticket: ${ticket.id} · ${ticket.title} · ${ticket.template} · stage: ${stage.id}`,
  );

  if (stage.offTemplate) {
    lines.push(`Stage: ${stage.id} (not declared by template ${ticket.template})`);
  } else if (stage.instructions) {
    lines.push(`Stage instructions: ${stage.instructions}`);
  }

  lines.push(`Next: ${next}`);
  lines.push(`Run \`syntaur show ${ticket.id}\` for files, gates and commands.`);

  return { lines, ticketId: ticket.id, stage: stage.id };
}

export async function buildPromptContext(
  input: BuildPromptContextInput,
): Promise<PromptContextResult> {
  const root = input.root ?? syntaurRoot();
  const lines: string[] = [];

  let ticketId: string | null = null;
  let stage: string | null = null;

  const sessionId =
    input.sessionId && isSafeSessionId(input.sessionId) ? input.sessionId : null;

  if (sessionId) {
    const ticketBlock = await formatTicketBlock(root, input.cwd, sessionId);
    if (ticketBlock.lines.length > 0) {
      lines.push(...ticketBlock.lines);
      ticketId = ticketBlock.ticketId;
      stage = ticketBlock.stage;
    }
  }

  const playbookLines = await formatPlaybooksSection(root);
  if (playbookLines.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(...playbookLines);
  }

  const text = lines.join('\n');
  return {
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
    ticketId,
    stage,
    playbooks: playbookLines.length > 0
      ? await crossTemplatePlaybooks(root)
      : [],
  };
}

export interface RunSessionContextInput {
  cwd: string;
  sessionId?: string | null;
  fromHook?: boolean;
}

export async function runSessionContext(
  rawStdin: string,
  input: RunSessionContextInput,
): Promise<PromptContextResult | null> {
  let sessionId = input.sessionId ?? null;
  let cwd = input.cwd;

  if (input.fromHook) {
    try {
      const parsed: unknown = JSON.parse(rawStdin);
      if (parsed && typeof parsed === 'object') {
        const payload = parsed as Record<string, unknown>;
        if (typeof payload.cwd === 'string' && payload.cwd) {
          cwd = payload.cwd;
        }
        if (!sessionId && typeof payload.session_id === 'string' && isSafeSessionId(payload.session_id)) {
          sessionId = payload.session_id;
        }
      }
    } catch {
      return null;
    }
  }

  if (!sessionId) {
    sessionId = await readContextSessionId(cwd);
  }

  if (sessionId && isSafeSessionId(sessionId)) {
    try {
      initSessionDb();
      touchSession(sessionId);
    } catch {
      // Touch is best-effort; never affects hook output or exit code.
    }
  }

  return buildPromptContext({ cwd, sessionId });
}

export function formatHookOutput(text: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: text,
    },
  });
}
