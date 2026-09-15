import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { expandHome } from '../utils/paths.js';
import { resolveTicketById } from '../utils/ticket-resolver.js';
import { isTicketId } from '../utils/ticket-ids.js';
import { fileExists } from '../utils/fs.js';
import { readConfig } from '../utils/config.js';
import { derivePathFromTranscript } from '../utils/transcript.js';
import { captureHeadSha } from '../utils/git-worktree.js';
import { resolveOwnSessionId, isSafeSessionId, assertMayMutate } from '../utils/session-id.js';
import type { ResolvedSession } from '../utils/session-id.js';
import { isExistingDir } from '../utils/workspace-cwd.js';
import { initSessionDb } from '../dashboard/session-db.js';
import { appendSession } from '../dashboard/agent-sessions.js';
import type { AgentSessionStatus } from '../dashboard/types.js';
import { getOpenEngagement } from '../db/engagement-db.js';
import { parseTicketFrontmatter } from '../lifecycle/frontmatter.js';
import { switchSessionStage } from '../utils/engagement-binding.js';
import type { ResolvedTicket } from '../utils/ticket-resolver.js';

export interface TrackSessionOptions {
  project?: string;
  ticket?: string;
  agent: string;
  sessionId?: string;
  path?: string;
  dir?: string;
  description?: string;
  transcriptPath?: string;
}

/** Injectable seams for tests; production callers pass nothing. */
export interface TrackSessionDeps {
  resolveSessionId?: typeof resolveOwnSessionId;
}

export async function trackSessionCommand(
  options: TrackSessionOptions,
  deps: TrackSessionDeps = {},
): Promise<void> {
  if (!options.agent) {
    throw new Error('--agent <name> is required.');
  }

  // Self-resolve the calling session's id when not passed explicitly: env →
  // process-tree markers → transcript scan, with the cwd context.json scalar
  // only as the last-resort legacy hint. Never synthesized.
  let resolved: ResolvedSession | undefined;
  if (options.sessionId !== undefined) {
    if (!isSafeSessionId(options.sessionId)) {
      throw new Error(
        'Could not resolve a session id. Pass --session-id <id> with the real agent-generated session id — do not synthesize one.',
      );
    }
    resolved = { id: options.sessionId, provenance: 'EXPLICIT' };
  } else {
    const cwd = process.cwd();
    let legacyHint: string | undefined;
    try {
      // Read ONLY the legacy sessionId hint from context.json — NOT the demoted
      // ticket scalars (projectSlug/ticketSlug/ticketDir). This is
      // the bootstrap path: the ticket binding comes from the explicit
      // --project/--ticket CLI args (see appendSession below), never from
      // context.json. context.json's sessionId is a last-resort identity hint only.
      const raw = await readFile(resolve(cwd, '.syntaur', 'context.json'), 'utf-8');
      const parsed = JSON.parse(raw) as { sessionId?: string };
      if (typeof parsed.sessionId === 'string') legacyHint = parsed.sessionId;
    } catch {
      // No context.json — fine; the resolver has five other layers.
    }
    resolved = await (deps.resolveSessionId ?? resolveOwnSessionId)({ cwd, legacyHint });
  }
  if (!resolved) {
    throw new Error(
      'Could not resolve a session id. Pass --session-id <id> with the real agent-generated session id — do not synthesize one.',
    );
  }
  const sessionId = resolved.id;

  // Gate BEFORE any side effect (DB init, git/ps probes, the appendSession
  // write): a WEAK id (transcript scan or legacy context.json hint) may not
  // mutate state unless an explicit --ticket selector is present.
  assertMayMutate(resolved, { hasSelector: Boolean(options.ticket) });

  let ticketId: string | null = null;
  let resolvedTicket: ResolvedTicket | null = null;
  if (options.project || options.ticket) {
    const config = await readConfig();
    const baseDir = options.dir
      ? expandHome(options.dir)
      : config.defaultProjectDir;

    if (options.project) {
      const projectDir = resolve(baseDir, options.project);
      if (!(await fileExists(projectDir))) {
        throw new Error(
          `Project "${options.project}" not found at ${projectDir}.`,
        );
      }
    }

    // M1: resolve the ticket's frontmatter id from its slugs so the opened
    // engagement carries `ticket_id` up front — a later `implement` stage
    // assertion then won't split the interval merely to repair the id.
    if (options.ticket) {
      if (!isTicketId(options.ticket)) {
        throw new Error(
          `--ticket must be a ticket id (<PREFIX>-<n>), got "${options.ticket}".`,
        );
      }
      resolvedTicket = await resolveTicketById(baseDir, options.ticket);
      ticketId = resolvedTicket?.id ?? null;
    }
  }

  initSessionDb();

  // Prefer the launch cwd recorded in the transcript itself — that's the
  // directory Claude Code uses to file the transcript, and the only one from
  // which `claude --resume <id>` can find it. Falls through to the explicit
  // --path or the registering process's cwd when no transcript is supplied
  // (or it isn't readable yet).
  const derivedPath = await derivePathFromTranscript(options.transcriptPath);
  const recordedPath = derivedPath ?? options.path ?? process.cwd();

  // Best-effort capture of the worktree's HEAD sha so a later recreate of a
  // deleted worktree can be exact. Never blocks registration on git.
  const originalHeadSha = isExistingDir(recordedPath)
    ? await captureHeadSha(recordedPath)
    : null;

  // Bootstrap binding: the session→ticket engagement edge is opened from the
  // EXPLICIT --project/--ticket CLI args (appendSession opens an engagement
  // from these). Never sourced from the demoted context.json ticket scalar.
  await appendSession('', {
    projectSlug: options.project || null,
    ticketSlug: options.ticket || null,
    ticketId: ticketId,
    agent: options.agent,
    sessionId,
    started: new Date().toISOString(),
    status: 'active' as AgentSessionStatus,
    path: recordedPath,
    description: options.description || null,
    transcriptPath: options.transcriptPath ?? null,
    originalHeadSha,
  });

  if (options.ticket && ticketId && resolvedTicket) {
    const open = getOpenEngagement(sessionId);
    if (!open || open.ticket_id !== ticketId) {
      const oldTicketId = open?.ticket_id ?? null;
      let stage = 'implement';
      try {
        const ticketMd = await readFile(resolve(resolvedTicket.ticketDir, 'ticket.md'), 'utf-8');
        stage = parseTicketFrontmatter(ticketMd).status || stage;
      } catch {
        /* keep implement */
      }
      await switchSessionStage({
        sessionId,
        ticketId,
        projectSlug: options.project ?? resolvedTicket.projectSlug,
        ticketSlug: resolvedTicket.ticketSlug,
        stage,
      });
      console.log(
        `Re-bound session ${sessionId} from ${oldTicketId ?? 'none'} to ${ticketId}.`,
      );
    }
  }

  if (options.project && options.ticket) {
    console.log(
      `Registered agent session ${sessionId} for ${options.ticket} in ${options.project}.`,
    );
  } else {
    console.log(`Registered standalone agent session ${sessionId}.`);
  }
}
