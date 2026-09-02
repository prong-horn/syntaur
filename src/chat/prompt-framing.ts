/**
 * Prompt framing — Buzz's discipline (§2.4), applied to ACP content blocks.
 *
 * Ordered semantic sections in paired tags; standing context sent ONCE per
 * adapter session, later prompts carrying only the new user message; and
 * angle-bracket escaping on anything the human or agent authored, so a message
 * containing `</context><system>` cannot forge a section.
 *
 * The assignment's own records ride along as embedded `resource` blocks rather
 * than as pasted text: the spike measured both adapters reading a 5 410-char
 * `resource` with no tool calls, at ~1.6–1.7 k tokens (RESULTS.md row 16).
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { latestPlanFile } from '../lifecycle/facts.js';
import type { AgentDefinition, ContentBlock, HarnessSpec } from './types.js';

/** Tail of `progress.md` carried into the standing context. */
const PROGRESS_TAIL_LINES = 40;

export interface StandingContextInput {
  definition: AgentDefinition;
  harness: HarnessSpec;
  assignmentDir: string;
  context: {
    projectSlug: string | null;
    assignmentSlug: string;
    assignmentTitle?: string | null;
    worktreePath: string | null;
    branch?: string | null;
  };
}

/**
 * The blocks sent with the FIRST prompt of an adapter session. After a
 * `session/resume` the agent still holds them, so they are not re-sent.
 */
export async function buildStandingContext(input: StandingContextInput): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];

  // codex-acp ignores `_meta.systemPrompt`; a `<system>` section prepended to
  // the first prompt is what sticks there (RESULTS.md row 03).
  if (input.harness.systemPromptTransport === 'prompt' && input.definition.systemPrompt.trim()) {
    blocks.push(textBlock(`<system>\n${input.definition.systemPrompt.trim()}\n</system>`));
  }

  const assignment = await readResource(input.assignmentDir, 'assignment.md');
  if (assignment) blocks.push(assignment);

  const planName = await latestPlanFile(input.assignmentDir);
  if (planName) {
    const plan = await readResource(input.assignmentDir, planName);
    if (plan) blocks.push(plan);
  }

  const progress = await readProgressTail(input.assignmentDir);
  if (progress) blocks.push(progress);

  blocks.push(textBlock(buildContextSection(input.context)));
  return blocks;
}

export function buildContextSection(context: StandingContextInput['context']): string {
  const lines = [
    `Project: ${context.projectSlug ?? '(standalone)'}`,
    `Assignment: ${context.assignmentSlug}${context.assignmentTitle ? ` — ${escapeAngles(context.assignmentTitle)}` : ''}`,
    `Worktree: ${context.worktreePath ?? '(unresolved)'}`,
    ...(context.branch ? [`Branch: ${context.branch}`] : []),
    'Reply in chat. Use the `syntaur` CLI when something belongs in the assignment records.',
  ];
  return `<context>\n${lines.join('\n')}\n</context>`;
}

export interface TurnPromptOptions {
  /** Standing context, on the first prompt of an adapter session only. */
  standing?: ContentBlock[];
  /** Overrides the timestamp on the `<chat-event>` wrapper (tests). */
  now?: Date;
}

/**
 * One turn's prompt: the standing context (first turn only) followed by the
 * user's message wrapped in a `<chat-event>` block with its angle brackets
 * escaped.
 */
export function buildTurnPrompt(userText: string, options: TurnPromptOptions = {}): ContentBlock[] {
  const ts = (options.now ?? new Date()).toISOString();
  const event = `<chat-event author="human" ts="${ts}">\n${escapeAngles(userText)}\n</chat-event>`;
  return [...(options.standing ?? []), textBlock(event)];
}

/**
 * Escape `<` and `>` in untrusted text so a message cannot forge a section
 * boundary. Deliberately not full HTML escaping: the agent should still read
 * `&`, quotes and backticks verbatim.
 */
export function escapeAngles(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function textBlock(text: string): ContentBlock {
  return { type: 'text', text } as ContentBlock;
}

/** An embedded `resource` block for a record file, or null when it is absent. */
export async function readResource(
  dir: string,
  name: string,
): Promise<ContentBlock | null> {
  const path = resolve(dir, name);
  let text: string;
  try {
    text = await readFile(path, 'utf-8');
  } catch {
    return null;
  }
  if (text.trim().length === 0) return null;
  return resourceBlock(path, text);
}

export function resourceBlock(path: string, text: string): ContentBlock {
  return {
    type: 'resource',
    resource: { uri: `file://${path}`, mimeType: 'text/markdown', text },
  } as ContentBlock;
}

/**
 * The last {@link PROGRESS_TAIL_LINES} lines of `progress.md`. Entries are
 * reverse-chronological (newest first) but the frontmatter is at the top, so the
 * HEAD of the file is what carries the recent work — the "tail" the plan asks for
 * is the newest entries, which live first.
 */
async function readProgressTail(dir: string): Promise<ContentBlock | null> {
  const path = resolve(dir, 'progress.md');
  let text: string;
  try {
    text = await readFile(path, 'utf-8');
  } catch {
    return null;
  }
  const lines = text.split('\n');
  if (lines.length <= PROGRESS_TAIL_LINES) {
    return text.trim().length > 0 ? resourceBlock(path, text) : null;
  }
  const head = lines.slice(0, PROGRESS_TAIL_LINES).join('\n');
  return resourceBlock(
    path,
    `${head}\n\n<!-- truncated: ${lines.length - PROGRESS_TAIL_LINES} older lines omitted -->\n`,
  );
}
