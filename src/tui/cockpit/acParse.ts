/**
 * Extract checkbox lines (`- [ ] text` / `- [x] text`) that appear under an
 * "Acceptance Criteria" heading in an assignment body. `AssignmentDetail` has
 * no dedicated field for these — they live inline in markdown `body`, so the
 * DetailPane parses them on render.
 */
export function parseAcceptanceCriteria(body: string): { text: string; checked: boolean }[] {
  const lines = body.split('\n');
  const out: { text: string; checked: boolean }[] = [];
  let inSection = false;
  for (const line of lines) {
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      inSection = /acceptance criteria/i.test(heading[1]);
      continue;
    }
    if (!inSection) continue;
    const cb = line.match(/^\s*-\s*\[( |x|X)\]\s+(.*)$/);
    if (cb) out.push({ text: cb[2].trim(), checked: cb[1].toLowerCase() === 'x' });
  }
  return out;
}
