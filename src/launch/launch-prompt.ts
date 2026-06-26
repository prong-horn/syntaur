import { isValidSlug } from '../utils/slug.js';

/**
 * Editable launch-prompt resolution.
 *
 * An agent profile may carry an editable `launchPrompt` template whose
 * `@`-tokens are expanded at launch time. This module is the single, pure home
 * for that expansion plus the low-level seed builders shared with the
 * (deprecated) `INITIAL_PROMPT`. It deliberately imports nothing from
 * `../tui/launch.js` so there is no import cycle (`argv.ts` imports `tui/launch`,
 * and `launch/index.ts` re-exports `argv.ts`) — callers import this module
 * directly, not via the `launch/index.js` barrel.
 */

/**
 * The bare `/grab-assignment` seed — today's zero-config launch behavior. This
 * is the single source of these strings, shared by `resolveLaunchPrompt`'s
 * no-template fallback and `INITIAL_PROMPT`'s no-playbook branch (kept
 * byte-identical for back-compat).
 */
export function bareGrabSeed(params: {
  projectSlug: string | null;
  assignmentSlug: string;
  id?: string;
}): string {
  if (params.projectSlug) {
    return `/grab-assignment ${params.projectSlug} ${params.assignmentSlug}`;
  }
  if (params.id) {
    return `/grab-assignment --id ${params.id}`;
  }
  // No project and no id — fall back to the slug. Should be rare; only happens
  // if a caller forgot to pass the id for a standalone assignment.
  return `/grab-assignment ${params.assignmentSlug}`;
}

/**
 * The noun phrase a `@<playbook-slug>` token resolves to. The template author
 * writes the surrounding verbs. NOTE: this is the new "via the /run-playbook
 * skill" wording used ONLY by the resolver — `INITIAL_PROMPT`'s legacy playbook
 * branch keeps its own "using the /run-playbook skill" sentence.
 */
export function runPlaybookClause(slug: string): string {
  return `the \`${slug}\` playbook via the /run-playbook skill`;
}

/** The `@assignment` expansion: a pointer to the records dir, not a snapshot. */
function assignmentPointer(id: string | undefined, assignmentDir: string): string {
  const subject = id
    ? `This session is Syntaur assignment ${id}, with records at ${assignmentDir}.`
    : `This session's Syntaur assignment records are at ${assignmentDir}.`;
  return (
    `${subject} Claim and bind it with the /grab-assignment skill if available; ` +
    `otherwise read assignment.md, plan*.md, and progress.md in that directory for full context.`
  );
}

export interface ResolveLaunchPromptInput {
  /** The agent's editable launch prompt template (may contain `@`-tokens). */
  template?: string | null;
  /** Back-compat playbook slug; used only when `template` is empty. */
  playbook?: string | null;
  /** Assignment id (optional only to represent the rare slug-fallback seed). */
  id?: string;
  /**
   * Records directory (where assignment.md lives), for `@assignment`. Optional:
   * standalone launches have no assignment, so `@assignment` warns + stays
   * literal when this is absent.
   */
  assignmentDir?: string;
  /** Null for a standalone assignment (required-but-nullable — pass `null`). */
  projectSlug: string | null;
  /** Optional: absent for standalone launches (no assignment). */
  assignmentSlug?: string;
  /**
   * Absolute worktree path, for the `@worktree` token and the directory-agent
   * (`workdir`) default seed. Absent for standalone launches and for plain
   * launches with no worktree; `@worktree` warns + stays literal when absent.
   */
  worktreePath?: string;
  /**
   * The directory the agent process is actually spawned from. When it differs
   * from `worktreePath` the agent is a directory-agent (`workdir` set), which
   * triggers the worktree-injecting default seed. Absent → no workdir agent.
   */
  spawnCwd?: string;
  /**
   * Installed playbook slugs, injected by the call site. When provided, a
   * well-formed `@<slug>` not in this set warns and is left literal. When
   * undefined, every well-formed slug resolves without validation.
   */
  knownPlaybookSlugs?: ReadonlySet<string>;
}

export interface ResolveLaunchPromptResult {
  prompt: string;
  /** Non-fatal warnings (unknown/malformed `@`-tokens). Never throws. */
  warnings: string[];
}

/** `@` at start-of-string or after whitespace, then a maximal token run. */
const TOKEN_RE = /(^|\s)@([A-Za-z0-9_-]+)/g;

function resolveTemplate(
  template: string,
  ctx: {
    id?: string;
    assignmentDir?: string;
    worktreePath?: string;
    knownPlaybookSlugs?: ReadonlySet<string>;
  },
): ResolveLaunchPromptResult {
  const warnings: string[] = [];
  const prompt = template.replace(TOKEN_RE, (_match, boundary: string, token: string) => {
    if (token === 'assignment') {
      if (!ctx.assignmentDir) {
        warnings.push(`launchPrompt: "@assignment" has no assignment context here — left as literal text.`);
        return boundary + '@assignment';
      }
      return boundary + assignmentPointer(ctx.id, ctx.assignmentDir);
    }
    if (token === 'worktree') {
      if (!ctx.worktreePath) {
        warnings.push(`launchPrompt: "@worktree" has no worktree path here — left as literal text.`);
        return boundary + '@worktree';
      }
      return boundary + ctx.worktreePath;
    }
    if (!isValidSlug(token)) {
      warnings.push(`launchPrompt: "@${token}" is not a valid playbook token — left as literal text.`);
      return boundary + '@' + token;
    }
    if (ctx.knownPlaybookSlugs !== undefined && !ctx.knownPlaybookSlugs.has(token)) {
      warnings.push(`launchPrompt: playbook "${token}" (from "@${token}") is not installed — left as literal text.`);
      return boundary + '@' + token;
    }
    return boundary + runPlaybookClause(token);
  });
  return { prompt, warnings };
}

/**
 * Resolve the launch seed for a fresh "Open in agent" launch. Pure: never reads
 * the filesystem, never prints. The caller owns warning output.
 *
 * Fallback chain:
 *   1. `template` (trimmed non-empty) → resolve its `@`-tokens.
 *   2. else `playbook` set → synthesize `<@assignment pointer> Run <clause> end-to-end.`
 *      (built directly — no `@`-token re-resolution, so a playbook literally named
 *      `assignment` cannot collide with the reserved token).
 *   3. else directory-agent (`worktreePath` set and != `spawnCwd`) → a plain-language
 *      seed pointing at the worktree + a `cd`/grab instruction (plain language
 *      because a single message fires only one leading slash-command).
 *   4. else assignment context present → today's bare `/grab-assignment` seed.
 *   5. else (standalone, no template/playbook) → empty prompt.
 * `template` wins over `playbook`.
 */
export function resolveLaunchPrompt(input: ResolveLaunchPromptInput): ResolveLaunchPromptResult {
  const {
    template,
    playbook,
    id,
    assignmentDir,
    projectSlug,
    assignmentSlug,
    worktreePath,
    spawnCwd,
    knownPlaybookSlugs,
  } = input;

  if (template && template.trim()) {
    return resolveTemplate(template, { id, assignmentDir, worktreePath, knownPlaybookSlugs });
  }

  const pb = playbook?.trim();
  if (pb) {
    const clause = runPlaybookClause(pb);
    const prompt = assignmentDir
      ? `${assignmentPointer(id, assignmentDir)} Run ${clause} end-to-end.`
      : `Run ${clause} end-to-end.`;
    return { prompt, warnings: [] };
  }

  // Directory-agent default seed: the agent process starts in its own `workdir`,
  // so tell it where the assignment's worktree is and how to pick the work up.
  if (worktreePath && spawnCwd && worktreePath !== spawnCwd) {
    const grab = bareGrabSeed({ projectSlug, assignmentSlug: assignmentSlug ?? '', id });
    return {
      prompt:
        `The assignment's worktree is at ${worktreePath}. cd there, then grab the ` +
        `assignment with ${grab} and work it end-to-end.`,
      warnings: [],
    };
  }

  // Standalone launch (no assignment context at all) → empty seed rather than a
  // bogus `/grab-assignment` with no slug/id.
  if (!assignmentSlug && !id) {
    return { prompt: '', warnings: [] };
  }

  return { prompt: bareGrabSeed({ projectSlug, assignmentSlug: assignmentSlug ?? '', id }), warnings: [] };
}

/**
 * The editable **template** to prefill the dashboard's "Open in agent" prompt
 * box — NOT the resolved text. Returns:
 *   - `launchPrompt` verbatim when set (non-empty after trim); else
 *   - a synth template `@assignment Run <runPlaybookClause(playbook)> end-to-end.`
 *     when `playbook` is set — the playbook clause is LITERAL (only `@assignment`
 *     is a token), so re-resolving this through `resolveLaunchPrompt` reproduces
 *     this module's playbook synth (above) byte-for-byte for ANY playbook
 *     (installed / disabled / uninstalled / the reserved `assignment`); else
 *   - the bare `/grab-assignment` seed (no `@`-tokens).
 *
 * Prefilling the template (not resolved text) and resolving exactly once at
 * launch avoids re-tokenizing an `@<slug>` that may appear inside an expanded
 * records-dir path.
 */
export function effectiveLaunchTemplate(input: {
  launchPrompt?: string | null;
  playbook?: string | null;
  projectSlug: string | null;
  assignmentSlug: string;
  id?: string;
  /**
   * Set when the agent is a directory-agent (`workdir`). With no explicit
   * `launchPrompt`/`playbook`, the box prefills a `@worktree`-based seed so that
   * re-resolving it at launch (as `promptOverride`) injects the worktree path —
   * a plain bare seed would drop it. The token (not the resolved path) is used
   * so the single resolve at launch fills it in.
   */
  workdir?: string | null;
}): string {
  if (input.launchPrompt && input.launchPrompt.trim()) {
    return input.launchPrompt;
  }
  const pb = input.playbook?.trim();
  if (pb) {
    return `@assignment Run ${runPlaybookClause(pb)} end-to-end.`;
  }
  if (input.workdir && input.workdir.trim()) {
    const grab = bareGrabSeed({
      projectSlug: input.projectSlug,
      assignmentSlug: input.assignmentSlug,
      id: input.id,
    });
    return (
      `The assignment's worktree is at @worktree. cd there, then grab the ` +
      `assignment with ${grab} and work it end-to-end.`
    );
  }
  return bareGrabSeed({
    projectSlug: input.projectSlug,
    assignmentSlug: input.assignmentSlug,
    id: input.id,
  });
}
