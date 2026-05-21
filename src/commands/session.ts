import { Command } from 'commander';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileExists } from '../utils/fs.js';

interface ContextFile {
  sessionId?: string;
  projectSlug?: string;
  assignmentSlug?: string;
  projectDir?: string;
  assignmentDir?: string;
  workspaceRoot?: string;
  title?: string;
  branch?: string;
  // Bundle-scoped fields tolerated for forward-compat; this reader only
  // surfaces assignment-scoped fields.
  bundleId?: string;
  bundleSlug?: string;
  bundleScope?: string;
  bundleScopeId?: string;
  todoIds?: string[];
  planDir?: string;
  worktreePath?: string;
  repository?: string;
  boundAt?: string;
}

async function readContext(cwd: string): Promise<ContextFile | null> {
  const path = resolve(cwd, '.syntaur', 'context.json');
  if (!(await fileExists(path))) return null;
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as ContextFile;
  } catch {
    return null;
  }
}

async function findLatestSessionSummary(
  assignmentDir: string,
): Promise<{ sessionId: string; path: string; mtime: Date } | null> {
  const sessionsRoot = resolve(assignmentDir, 'sessions');
  if (!(await fileExists(sessionsRoot))) return null;
  const entries = await readdir(sessionsRoot, { withFileTypes: true });
  let best: { sessionId: string; path: string; mtime: Date } | null = null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const summaryPath = resolve(sessionsRoot, entry.name, 'summary.md');
    if (!(await fileExists(summaryPath))) continue;
    const st = await stat(summaryPath);
    if (best === null || st.mtime.getTime() > best.mtime.getTime()) {
      best = { sessionId: entry.name, path: summaryPath, mtime: st.mtime };
    }
  }
  return best;
}

async function findOpenHandoff(assignmentDir: string): Promise<string | null> {
  // The Syntaur protocol uses a single root handoff.md per assignment (managed
  // by complete-assignment). Surface it whenever it exists and has any body
  // content beyond the placeholder so the resuming agent reads the latest
  // outbound baton. We treat any non-empty handoff.md as a signal — there is
  // currently no per-handoff `status: open` flag in the canonical schema.
  const handoffPath = resolve(assignmentDir, 'handoff.md');
  if (!(await fileExists(handoffPath))) return null;
  const content = await readFile(handoffPath, 'utf-8');
  const body = content.replace(/^---[\s\S]*?\n---\n?/, '').trim();
  if (body.length === 0) return null;
  // Skip the placeholder body that create-assignment scaffolds.
  if (/^<!--[\s\S]*-->$/.test(body)) return null;
  return handoffPath;
}

interface ResumeOptions {
  json?: boolean;
}

interface ResumeOutput {
  ok: boolean;
  context: ContextFile | null;
  latestSession: { sessionId: string; path: string } | null;
  openHandoff: string | null;
  warnings: string[];
}

async function buildResumeOutput(cwd: string): Promise<ResumeOutput> {
  const warnings: string[] = [];
  const context = await readContext(cwd);
  if (!context) {
    return {
      ok: false,
      context: null,
      latestSession: null,
      openHandoff: null,
      warnings: [
        'No .syntaur/context.json in current directory. Run grab-assignment first.',
      ],
    };
  }
  if (!context.assignmentDir) {
    return {
      ok: false,
      context,
      latestSession: null,
      openHandoff: null,
      warnings: [
        'context.json present but no assignmentDir field — only a session record exists. Nothing to resume.',
      ],
    };
  }

  const latestSession = await findLatestSessionSummary(context.assignmentDir);
  if (!latestSession) {
    warnings.push(
      `No session summary found under ${context.assignmentDir}/sessions/. Run /save-session-summary in a prior session to leave a resume baton.`,
    );
  }
  const openHandoff = await findOpenHandoff(context.assignmentDir);

  return {
    ok: true,
    context,
    latestSession: latestSession
      ? { sessionId: latestSession.sessionId, path: latestSession.path }
      : null,
    openHandoff,
    warnings,
  };
}

function renderHumanOutput(out: ResumeOutput): string {
  const lines: string[] = [];
  if (!out.ok) {
    lines.push('Cannot resume:');
    for (const w of out.warnings) lines.push(`  - ${w}`);
    return lines.join('\n');
  }
  const ctx = out.context!;
  lines.push('Resuming Syntaur session');
  lines.push('');
  lines.push(`  Project:        ${ctx.projectSlug ?? '(standalone)'}`);
  lines.push(`  Assignment:     ${ctx.assignmentSlug ?? '(unknown)'}`);
  if (ctx.title) lines.push(`  Title:          ${ctx.title}`);
  if (ctx.branch) lines.push(`  Branch:         ${ctx.branch}`);
  if (ctx.workspaceRoot) lines.push(`  Workspace root: ${ctx.workspaceRoot}`);
  lines.push(`  Assignment dir: ${ctx.assignmentDir}`);
  lines.push('');
  if (out.latestSession) {
    lines.push(`Latest session summary: ${out.latestSession.path}`);
    lines.push(`Read it next to load What’s Next + Open Questions.`);
  } else {
    lines.push('No prior session summary on disk.');
  }
  if (out.openHandoff) {
    lines.push('');
    lines.push(`Open handoff: ${out.openHandoff}`);
    lines.push('Read it before continuing — there is an outstanding baton.');
  }
  if (out.warnings.length > 0) {
    lines.push('');
    lines.push('Warnings:');
    for (const w of out.warnings) lines.push(`  - ${w}`);
  }
  return lines.join('\n');
}

export async function runSessionResume(
  options: ResumeOptions,
  cwd: string = process.cwd(),
): Promise<ResumeOutput> {
  const out = await buildResumeOutput(cwd);
  if (options.json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(renderHumanOutput(out));
  }
  return out;
}

export const sessionCommand = new Command('session')
  .description('Manage agent sessions for the active assignment');

sessionCommand
  .command('resume')
  .description(
    'Re-orient a fresh session: print active assignment context, latest saved session summary, and any open handoff. Idempotent — does not mutate state.',
  )
  .option('--json', 'Emit machine-readable JSON instead of human-readable text')
  .action(async (options: ResumeOptions) => {
    try {
      const out = await runSessionResume(options);
      if (!out.ok) process.exit(1);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

export const _internal = {
  buildResumeOutput,
  findLatestSessionSummary,
  findOpenHandoff,
  readContext,
};
