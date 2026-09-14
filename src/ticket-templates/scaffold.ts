import { resolve, basename } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileExists, writeFileForce } from '../utils/fs.js';
import type { CreateOn, TemplateFile, TemplateManifest } from './manifest.js';
import { planRoleFile } from './manifest.js';
import { stageAtOrBefore, stageForStatus } from './stages.js';
import type { StageId } from './manifest.js';
import { renderPlanStub } from '../templates/plan.js';
import {
  renderProgress,
  renderScratchpad,
  renderHandoff,
  renderDecisionRecord,
  renderComments,
} from '../templates/index.js';

export interface ScaffoldTemplateFilesInput {
  ticketDir: string;
  templateDir: string;
  template: TemplateManifest;
  ticketSlug: string;
  ticketTitle?: string;
  timestamp: string;
  /** Match files whose createOn equals this value. */
  when?: CreateOn | StageId;
  /** Scaffold only these paths (ignores createOn, including `never`). */
  only?: string[];
  /** Ticket status for retemplate stage-scoped scaffolding. */
  ticketStatus?: string;
}

function yamlScalar(value: string): string {
  if (/[:#\n\r]/.test(value) || value.startsWith(' ') || value.endsWith(' ')) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}

/** Insert or replace `purpose:` as the first frontmatter key. */
export function injectPurpose(content: string, purpose: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  const fmMatch = normalized.match(/^(---\n)([\s\S]*?)(\n---\n?)([\s\S]*)$/);
  const purposeLine = `purpose: ${yamlScalar(purpose)}`;

  if (fmMatch) {
    const [, open, fmBody, close, body] = fmMatch;
    let newFm = fmBody;
    if (/^purpose:\s/m.test(newFm)) {
      newFm = newFm.replace(/^purpose:\s.*$/m, purposeLine);
    } else {
      newFm = newFm.trimEnd().length > 0 ? `${purposeLine}\n${newFm}` : purposeLine;
    }
    return `${open}${newFm}${close}${body}`;
  }

  const trimmed = normalized.trimStart();
  return `---\n${purposeLine}\n---\n\n${trimmed.length > 0 ? trimmed : ''}`;
}

function stemFromPath(filePath: string): string {
  return basename(filePath).replace(/\.md$/i, '');
}

function legacyV1Content(
  filePath: string,
  input: Pick<ScaffoldTemplateFilesInput, 'ticketSlug' | 'ticketTitle' | 'timestamp'>,
): string | null {
  switch (filePath) {
    case 'progress.md':
      return renderProgress({ ticket: input.ticketSlug, timestamp: input.timestamp });
    case 'plan.md':
      return renderPlanStub({
        ticketSlug: input.ticketSlug,
        title: input.ticketTitle,
        timestamp: input.timestamp,
      });
    case 'scratchpad.md':
      return renderScratchpad({ ticketSlug: input.ticketSlug, timestamp: input.timestamp });
    case 'handoff.md':
      return renderHandoff({ ticketSlug: input.ticketSlug, timestamp: input.timestamp });
    case 'decision-record.md':
      return renderDecisionRecord({ ticketSlug: input.ticketSlug, timestamp: input.timestamp });
    case 'comments.md':
      return renderComments({ ticket: input.ticketSlug, timestamp: input.timestamp });
    default:
      return null;
  }
}

function defaultRoleContent(
  entry: TemplateFile,
  input: Pick<ScaffoldTemplateFilesInput, 'ticketSlug' | 'ticketTitle' | 'timestamp' | 'template'>,
): string {
  if (input.template.id === 'legacy') {
    const legacy = legacyV1Content(entry.path, input);
    if (legacy) return legacy;
  }

  if (entry.role === 'plan') {
    return renderPlanStub({
      ticketSlug: input.ticketSlug,
      title: input.ticketTitle,
      timestamp: input.timestamp,
    });
  }

  if (entry.role === 'log') {
    if (entry.path === 'progress.md') {
      return renderProgress({ ticket: input.ticketSlug, timestamp: input.timestamp });
    }
    return `---\n---\n`;
  }

  const stem = stemFromPath(entry.path);
  return `# ${stem}\n`;
}

async function resolveFileContent(
  entry: TemplateFile,
  input: ScaffoldTemplateFilesInput,
): Promise<string> {
  const skeletonPath = resolve(input.templateDir, entry.path);
  let content: string;
  if (await fileExists(skeletonPath)) {
    content = await readFile(skeletonPath, 'utf-8');
  } else {
    content = defaultRoleContent(entry, input);
  }
  return injectPurpose(content, entry.description);
}

function matchesWhen(
  entry: TemplateFile,
  input: ScaffoldTemplateFilesInput,
): boolean {
  if (input.only) {
    return input.only.includes(entry.path);
  }

  if (entry.createOn === 'never') return false;

  if (input.when !== undefined) {
    return entry.createOn === input.when;
  }

  if (input.ticketStatus !== undefined) {
    if (entry.createOn === 'ticket-creation') return true;
    const stage = stageForStatus(input.ticketStatus);
    if ((['backlog', 'planning', 'ready', 'in_progress', 'review', 'done'] as const).includes(
      entry.createOn as StageId,
    )) {
      return stageAtOrBefore(entry.createOn as StageId, stage);
    }
  }

  return false;
}

/**
 * Write template-declared files that match `when`, `only`, or retemplate rules.
 * Skips paths that already exist. Returns relative paths written.
 */
export async function scaffoldTemplateFiles(
  input: ScaffoldTemplateFilesInput,
): Promise<string[]> {
  const written: string[] = [];

  for (const entry of input.template.files) {
    if (!matchesWhen(entry, input)) continue;

    const dest = resolve(input.ticketDir, entry.path);
    if (await fileExists(dest)) continue;

    const content = await resolveFileContent(entry, input);
    await writeFileForce(dest, content);
    written.push(entry.path);
  }

  return written;
}

/** Paths written for a plan-role scaffold (caller should set plan.file). */
export function scaffoldedPlanPaths(
  written: string[],
  template: TemplateManifest,
): string[] {
  const planPath = planRoleFile(template)?.path;
  if (!planPath) return [];
  return written.filter((p) => p === planPath);
}
