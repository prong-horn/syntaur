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
  /** Records directory (where assignment.md lives), for `@assignment`. */
  assignmentDir: string;
  /** Null for a standalone assignment. */
  projectSlug: string | null;
  assignmentSlug: string;
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
  ctx: { id?: string; assignmentDir: string; knownPlaybookSlugs?: ReadonlySet<string> },
): ResolveLaunchPromptResult {
  const warnings: string[] = [];
  const prompt = template.replace(TOKEN_RE, (_match, boundary: string, token: string) => {
    if (token === 'assignment') {
      return boundary + assignmentPointer(ctx.id, ctx.assignmentDir);
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
 *   3. else → today's bare `/grab-assignment` seed.
 * `template` wins over `playbook`.
 */
export function resolveLaunchPrompt(input: ResolveLaunchPromptInput): ResolveLaunchPromptResult {
  const { template, playbook, id, assignmentDir, projectSlug, assignmentSlug, knownPlaybookSlugs } =
    input;

  if (template && template.trim()) {
    return resolveTemplate(template, { id, assignmentDir, knownPlaybookSlugs });
  }

  const pb = playbook?.trim();
  if (pb) {
    const pointer = assignmentPointer(id, assignmentDir);
    return { prompt: `${pointer} Run ${runPlaybookClause(pb)} end-to-end.`, warnings: [] };
  }

  return { prompt: bareGrabSeed({ projectSlug, assignmentSlug, id }), warnings: [] };
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
}): string {
  if (input.launchPrompt && input.launchPrompt.trim()) {
    return input.launchPrompt;
  }
  const pb = input.playbook?.trim();
  if (pb) {
    return `@assignment Run ${runPlaybookClause(pb)} end-to-end.`;
  }
  return bareGrabSeed({
    projectSlug: input.projectSlug,
    assignmentSlug: input.assignmentSlug,
    id: input.id,
  });
}
