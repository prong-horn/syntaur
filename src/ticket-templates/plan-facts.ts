/**
 * Plan and ticket-body predicates used by gate evaluation and show rendering.
 * Kept separate from lifecycle/facts.ts (derive computation) so the template
 * kernel can depend on these without pulling in the full fact engine.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { TicketFrontmatter } from '../lifecycle/types.js';

/** Matches the ticket template's placeholder list items / comments. */
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
 * `- [ ] <!-- criterion N -->` rows — those don't count.
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
    if (content.length === 0) continue;
    total++;
    if (m[1].toLowerCase() === 'x') checked++;
  }
  return { total, checked };
}

export function planDigest(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Revision-bound approval check: the `plan` record must name the plan file
 * AND its digest must match that file's current content.
 */
export async function isPlanApproved(
  ticketDir: string,
  frontmatter: Pick<TicketFrontmatter, 'plan'>,
): Promise<boolean> {
  const plan = frontmatter.plan;
  if (!plan.file || !plan.approvedDigest) return false;
  try {
    const content = await readFile(resolve(ticketDir, plan.file), 'utf-8');
    return planDigest(content) === plan.approvedDigest;
  } catch {
    return false;
  }
}
