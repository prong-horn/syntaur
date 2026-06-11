/**
 * Fact computation (derived-status design v3, Piece 1) — Node-side.
 *
 * Materializes an assignment's objective facts from the files already on disk
 * (assignment.md body, sibling plan files, comments.md) plus the asserted
 * frontmatter facts. The browser never runs this — the dashboard ships the
 * result in payloads (loader-derived, NOT stored), mirroring the
 * `deriveStatusVirtuals` pattern.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileExists } from '../utils/fs.js';
import { captureHeadSha } from '../utils/git-worktree.js';
import { type AssignmentFacts, factFieldNames } from './derive.js';
import type { AssignmentFrontmatter, AttestationRecord } from './types.js';
import type { FactDeclaration } from '../utils/config.js';

/** Matches the assignment template's placeholder list items / comments. */
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

/** Extract the body of a `## <heading>` section (up to the next `## `). */
function sectionBody(body: string, heading: string): string | null {
  const re = new RegExp(`^##\\s+${heading}\\s*$`, 'm');
  const m = body.match(re);
  if (!m || m.index === undefined) return null;
  const start = m.index + m[0].length;
  const rest = body.slice(start);
  const next = rest.search(/^##\s+/m);
  return next >= 0 ? rest.slice(0, next) : rest;
}

/** Objective filled with real content (template placeholder comments stripped). */
export function hasRealObjective(body: string): boolean {
  const section = sectionBody(body, 'Objective');
  if (section === null) return false;
  return section.replace(HTML_COMMENT_RE, '').trim().length > 0;
}

/**
 * Count non-placeholder acceptance criteria. The template seeds
 * `- [ ] <!-- criterion N -->` rows — those don't count (a naive `acTotal > 0`
 * would promote every fresh draft; codex design-review finding).
 */
export function countRealAcceptanceCriteria(body: string): { total: number; checked: number } {
  const section = sectionBody(body, 'Acceptance Criteria');
  if (section === null) return { total: 0, checked: 0 };
  let total = 0;
  let checked = 0;
  for (const line of section.split('\n')) {
    const m = line.match(/^\s*-\s*\[([ xX])\]\s*(.*)$/);
    if (!m) continue;
    const content = m[2].replace(HTML_COMMENT_RE, '').trim();
    if (content.length === 0) continue; // placeholder or empty
    total++;
    if (m[1].toLowerCase() === 'x') checked++;
  }
  return { total, checked };
}

const PLAN_FILE_RE = /^plan(?:-v(\d+))?\.md$/;

/** Latest plan revision in an assignment dir (`plan.md` = v1 < `plan-v2.md` < …). */
export async function latestPlanFile(assignmentDir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(assignmentDir);
  } catch {
    return null;
  }
  let best: { name: string; version: number } | null = null;
  for (const name of entries) {
    const m = name.match(PLAN_FILE_RE);
    if (!m) continue;
    const version = m[1] ? parseInt(m[1], 10) : 1;
    if (!best || version > best.version) best = { name, version };
  }
  return best?.name ?? null;
}

export function planDigest(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Revision-bound approval check: the `planApproval` record must name the
 * CURRENT latest plan file AND its digest must match that file's current
 * content. A replan (new plan-vN) or a post-approval edit auto-invalidates.
 */
export async function isPlanApproved(
  assignmentDir: string,
  frontmatter: Pick<AssignmentFrontmatter, 'planApproval'>,
): Promise<boolean> {
  const approval = frontmatter.planApproval;
  if (!approval) return false;
  const latest = await latestPlanFile(assignmentDir);
  if (!latest || latest !== approval.file) return false;
  try {
    const content = await readFile(resolve(assignmentDir, latest), 'utf-8');
    return planDigest(content) === approval.digest;
  } catch {
    return false;
  }
}

/** Count open (unresolved) question comments in comments.md. Parity with the
 * dashboard's countOpenQuestions, kept dependency-light for the lifecycle layer. */
export async function countUnresolvedQuestions(assignmentDir: string): Promise<number> {
  const commentsPath = resolve(assignmentDir, 'comments.md');
  if (!(await fileExists(commentsPath))) return 0;
  try {
    const content = await readFile(commentsPath, 'utf-8');
    // Each entry: "## <id>" block with "**Type:** question" and "**Resolved:** false"
    let count = 0;
    for (const block of content.split(/^##\s+/m).slice(1)) {
      if (/^\*\*Type:\*\*\s*question\s*$/m.test(block) && /^\*\*Resolved:\*\*\s*false\s*$/m.test(block)) {
        count++;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

/** All `dependsOn` targets terminal? Standalone assignments (no project dir)
 * and empty dependency lists are trivially satisfied. */
export async function areDependenciesSatisfied(
  projectDir: string | null,
  dependsOn: string[],
  terminalStatuses: ReadonlySet<string>,
): Promise<boolean> {
  if (dependsOn.length === 0 || projectDir === null) return true;
  for (const depSlug of dependsOn) {
    const depPath = resolve(projectDir, 'assignments', depSlug, 'assignment.md');
    if (!(await fileExists(depPath))) return false;
    try {
      const content = await readFile(depPath, 'utf-8');
      const m = content.match(/^status:\s*(.+)$/m);
      const status = m ? m[1].trim() : '';
      if (!terminalStatuses.has(status)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export interface ComputeFactsInput {
  assignmentDir: string;
  frontmatter: AssignmentFrontmatter;
  body: string;
  /** Project dir for dependency checks; null for standalone assignments. */
  projectDir: string | null;
  terminalStatuses: ReadonlySet<string>;
  /** The ACCEPTED custom-fact declarations (normalize→accept output). Absent →
   * only the 14 built-ins materialize. */
  declarations?: FactDeclaration[];
}

/**
 * Canonical fact-value coercion (Locked Decisions — used by BOTH facts.ts and
 * the CLI). bool → case-insensitive `true`/`false` only; number → trimmed,
 * `Number(value)` finite (rejects NaN/Infinity/empty). Returns the canonical
 * stored form (`'true'`/`'false'` or `String(n)`) or null if invalid. The CLI
 * rejects null with the declared type; computeFacts treats null as absent.
 */
export function canonicalizeFactValue(type: 'bool' | 'number', raw: string): string | null {
  const t = raw.trim();
  if (type === 'bool') {
    const low = t.toLowerCase();
    if (low === 'true') return 'true';
    if (low === 'false') return 'false';
    return null;
  }
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? String(n) : null;
}

/** Read a stored bool fact, degrading absent/invalid to false (never throws). */
function readBoolFact(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return canonicalizeFactValue('bool', raw) === 'true';
}

/** Read a stored number fact, degrading absent/invalid to 0 (never throws). */
function readNumberFact(raw: string | undefined): number {
  if (typeof raw !== 'string') return 0;
  const c = canonicalizeFactValue('number', raw);
  return c === null ? 0 : Number(c);
}

/** Per-attestation-fact validity detail (one record list per declared fact). */
export interface AttestationDetail {
  fact: string;
  binds: 'plan' | 'commit' | 'none';
  records: Array<{ record: AttestationRecord; valid: boolean }>;
}

export interface ComputeFactsResult {
  facts: AssignmentFacts;
  attestations: AttestationDetail[];
}

/** Resolved-once binding environment for attestation validity. */
interface AttestationEnv {
  latestPlanFile: string | null;
  /** Digest of the latest plan file's CURRENT content (null when no plan). */
  planDigest: string | null;
  /** Workspace HEAD sha (null when no workspace / not a git dir). */
  headSha: string | null;
}

function isAttestationValid(
  record: AttestationRecord,
  binds: 'plan' | 'commit' | 'none',
  env: AttestationEnv,
): boolean {
  if (binds === 'none') return true;
  if (binds === 'plan') {
    if (!record.file || !env.latestPlanFile || record.file !== env.latestPlanFile) return false;
    if (!record.digest || !env.planDigest) return false;
    return record.digest === env.planDigest;
  }
  // binds:commit
  if (!record.commit || !env.headSha) return false;
  return record.commit === env.headSha;
}

/**
 * Materialize the full fact set PLUS per-attestation validity in ONE pass —
 * the dashboard (Task 9) calls this once per detail request so facts and
 * record-level staleness come from the same plan-file / HEAD reads. `computeFacts`
 * is a thin delegate returning just `.facts`.
 */
export async function computeFactsDetailed(input: ComputeFactsInput): Promise<ComputeFactsResult> {
  const { assignmentDir, frontmatter, body, projectDir, terminalStatuses } = input;
  const declarations = input.declarations ?? [];

  const ac = countRealAcceptanceCriteria(body);
  // Resolve the plan environment ONCE — a single read of the latest plan file's
  // content drives BOTH the built-in `planApproved` fact AND binds:plan
  // attestation validity, so a concurrent replan can't make the two disagree
  // and the plan is read at most once. Read only when something needs the digest.
  const needsPlanDigest =
    frontmatter.planApproval !== null ||
    declarations.some((d) => d.type === 'attestation' && d.binds === 'plan');
  const planFile = await latestPlanFile(assignmentDir);
  const [planFileContent, unresolvedQuestions, depsSatisfied] = await Promise.all([
    needsPlanDigest && planFile
      ? readFile(resolve(assignmentDir, planFile), 'utf-8').catch(() => null)
      : Promise.resolve(null),
    countUnresolvedQuestions(assignmentDir),
    areDependenciesSatisfied(projectDir, frontmatter.dependsOn, terminalStatuses),
  ]);
  const planFileDigest = planFileContent !== null ? planDigest(planFileContent) : null;
  const approval = frontmatter.planApproval;
  const planApproved =
    approval !== null &&
    approval.file === planFile &&
    planFileDigest !== null &&
    approval.digest === planFileDigest;

  const facts: AssignmentFacts = {
    hasRealObjective: hasRealObjective(body),
    acRealTotal: ac.total,
    acRealChecked: ac.checked,
    acAllChecked: ac.total > 0 && ac.checked === ac.total,
    planExists: planFile !== null,
    planApproved,
    workspaceSet: frontmatter.workspace.repository !== null && frontmatter.workspace.branch !== null,
    implementationStarted: frontmatter.implementationStarted,
    depsSatisfied,
    unresolvedQuestions,
    blocked: frontmatter.blockedReason !== null,
    parked: frontmatter.parked,
    reviewRequested: frontmatter.reviewRequested,
    pinned: frontmatter.override !== null,
  };

  const attestations: AttestationDetail[] = [];
  if (declarations.length > 0) {
    const storedFacts = frontmatter.facts ?? {};
    const records = frontmatter.attestations ?? [];

    // Custom bool/number facts (absent/invalid stored values degrade, no throw).
    for (const decl of declarations) {
      if (decl.type === 'bool') facts[decl.name] = readBoolFact(storedFacts[decl.name]);
      else if (decl.type === 'number') facts[decl.name] = readNumberFact(storedFacts[decl.name]);
    }

    // Attestation facts — resolve the binding env ONCE, then evaluate each.
    const attestationDecls = declarations.filter(
      (d): d is Extract<FactDeclaration, { type: 'attestation' }> => d.type === 'attestation',
    );
    if (attestationDecls.length > 0) {
      const needsCommit = attestationDecls.some((d) => d.binds === 'commit');
      let headSha: string | null = null;
      if (needsCommit) {
        const dir = frontmatter.workspace.worktreePath ?? frontmatter.workspace.repository;
        headSha = dir ? await captureHeadSha(dir) : null;
      }
      // planFile + planFileDigest were resolved once above (shared with the
      // built-in planApproved fact) — no second read, one consistent snapshot.
      const env: AttestationEnv = { latestPlanFile: planFile, planDigest: planFileDigest, headSha };

      for (const decl of attestationDecls) {
        const detailRecords = records
          .filter((r) => r.fact === decl.name)
          .map((record) => ({ record, valid: isAttestationValid(record, decl.binds, env) }));
        attestations.push({ fact: decl.name, binds: decl.binds, records: detailRecords });

        const valid = detailRecords.filter((r) => r.valid).map((r) => r.record);
        const validApproved = valid.filter((r) => r.verdict === 'approved');
        const validChanges = valid.filter((r) => r.verdict === 'changes-requested');
        const names = factFieldNames(decl);
        facts[names.exports.fact] = valid.length > 0;
        facts[names.exports.approved] = validApproved.length > 0;
        facts[names.exports.changesRequested] = validChanges.length > 0;
        facts[names.exports.by] = valid.map((r) => r.actor);
        facts[names.exports.approvedBy] = validApproved.map((r) => r.actor);
      }
    }
  }

  return { facts, attestations };
}

/** Materialize the full fact set for one assignment (thin delegate). */
export async function computeFacts(input: ComputeFactsInput): Promise<AssignmentFacts> {
  return (await computeFactsDetailed(input)).facts;
}
