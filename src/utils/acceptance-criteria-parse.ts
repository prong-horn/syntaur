export interface ParsedAcceptanceCriterion {
  index: number;
  text: string;
  checked: boolean;
}

const SECTION_HEADING = /^##\s+Acceptance Criteria\s*$/i;
const NEXT_HEADING = /^#{1,2}\s+\S/;
const CHECKBOX_LINE = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/;

/**
 * Parse the `## Acceptance Criteria` section out of an assignment.md body
 * into an ordered list of criteria. Returns [] when the section is missing
 * (deliberately tolerant — `proof build` should render an empty page rather
 * than error).
 *
 * Mirrors the section-walking and regex from `src/dashboard/acceptance-criteria.ts`.
 */
export function parseAcceptanceCriteria(content: string): ParsedAcceptanceCriterion[] {
  // Strip frontmatter so a `## …` heading inside it can't anchor the section.
  const fmMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  const body = fmMatch ? content.slice(fmMatch[0].length) : content;

  const lines = body.split('\n');
  const sectionStart = lines.findIndex((line) => SECTION_HEADING.test(line.trim()));
  if (sectionStart === -1) return [];

  let sectionEnd = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i += 1) {
    if (NEXT_HEADING.test(lines[i].trim())) {
      sectionEnd = i;
      break;
    }
  }

  const criteria: ParsedAcceptanceCriterion[] = [];
  for (let i = sectionStart + 1; i < sectionEnd; i += 1) {
    const m = lines[i].match(CHECKBOX_LINE);
    if (!m) continue;
    const checked = m[1].toLowerCase() === 'x';
    const text = m[2].trim();
    criteria.push({ index: criteria.length, text, checked });
  }
  return criteria;
}
