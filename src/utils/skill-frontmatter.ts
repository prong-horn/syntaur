import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// Doctor-scoped SKILL.md frontmatter reader. Intentionally LIGHTER than the
// generator's parser (scripts/build-skills-index.mjs): the cross-agent doctor
// check only needs the `name` and whether a non-empty `description` exists — it
// never needs the folded description text. Kept separate from the generator so
// there is no `.mjs`↔`.ts` import across the build/runtime boundary (see the
// Phase-2 decision record, Decision 5).

export interface SkillIdentity {
  /** The `name:` value, or null if absent/empty/unparseable. */
  name: string | null;
  /** Whether a non-empty `description:` (inline or block scalar) is present. */
  hasDescription: boolean;
}

function stripQuotes(raw: string): string {
  const t = raw.trim();
  if (
    t.length >= 2 &&
    ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

const indentOf = (line: string): number => line.length - line.replace(/^ +/, '').length;

/**
 * Extract `name` + description-presence from a SKILL.md's `---` frontmatter.
 * Operates on top-level keys only; for a block-scalar `description:` it treats
 * the presence of any non-blank, more-indented body line as a non-empty
 * description. Never splits a body line on `:`.
 */
export function readSkillIdentity(skillMdText: string): SkillIdentity {
  const m = skillMdText.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return { name: null, hasDescription: false };
  const lines = m[1].split('\n');
  let name: string | null = null;
  let hasDescription = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (indentOf(line) !== 0) continue;

    const nameMatch = line.match(/^name:\s*(.*)$/);
    if (nameMatch) {
      const v = stripQuotes(nameMatch[1]);
      name = v.length > 0 ? v : null;
      continue;
    }

    const descMatch = line.match(/^description:\s*(.*)$/);
    if (descMatch) {
      const rest = descMatch[1].trim();
      const isBlockIndicator = /^[|>][+-]?\s*$/.test(rest);
      if (rest && !isBlockIndicator) {
        hasDescription = stripQuotes(rest).length > 0;
      } else if (isBlockIndicator) {
        for (let j = i + 1; j < lines.length; j++) {
          const bl = lines[j];
          if (bl.trim() === '') continue;
          if (indentOf(bl) <= 0) break;
          hasDescription = true;
          break;
        }
      }
    }
  }

  return { name, hasDescription };
}

/** sha256 (hex) of a file's raw bytes. */
export async function sha256File(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}
