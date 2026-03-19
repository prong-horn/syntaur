/**
 * Extract the YAML frontmatter block from a markdown file.
 * Returns the raw YAML string between the opening and closing `---` delimiters.
 * Returns null if no valid frontmatter is found.
 */
export function extractFrontmatterBlock(content: string): string | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  return match ? match[1] : null;
}

/**
 * Parse a YAML value string into a typed JavaScript value.
 * Handles: quoted strings, unquoted strings, numbers, booleans, null, inline empty array.
 */
function parseYamlValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === undefined) return '';
  if (trimmed === 'null') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === '[]') return [];
  // Quoted string — strip quotes
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  // Number
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  // URL or path — return as string (do not attempt number parsing on colons/slashes)
  return trimmed;
}

/**
 * Parse YAML frontmatter into a Record<string, unknown>.
 *
 * Handles the Syntaur YAML subset:
 * - Scalar values: strings (quoted/unquoted), numbers, booleans, null
 * - Inline empty arrays: `field: []`
 * - Block arrays of scalars: `field:\n  - item1\n  - item2`
 * - Block arrays of objects: `field:\n  - key1: val1\n    key2: val2\n  - key1: val3`
 * - One-level nested objects: `parent:\n  child1: val1\n  child2: val2`
 */
export function parseFrontmatter(content: string): Record<string, unknown> {
  const block = extractFrontmatterBlock(content);
  if (!block) return {};

  const lines = block.split('\n');
  const result: Record<string, unknown> = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip blank lines
    if (line.trim() === '') {
      i++;
      continue;
    }

    const indent = line.length - line.trimStart().length;

    // Only process top-level keys (indent 0)
    if (indent > 0) {
      i++;
      continue;
    }

    const colonIndex = line.indexOf(':');
    if (colonIndex < 0) {
      i++;
      continue;
    }

    const key = line.slice(0, colonIndex).trim();
    const valueRaw = line.slice(colonIndex + 1).trim();

    // Case 1: Key has an inline value (scalar or [])
    if (valueRaw !== '') {
      result[key] = parseYamlValue(valueRaw);
      i++;
      continue;
    }

    // Case 2: Key has no inline value — look ahead for nested content
    // Peek at next non-blank line to determine if it's array items or nested object
    let nextI = i + 1;
    while (nextI < lines.length && lines[nextI].trim() === '') {
      nextI++;
    }

    if (nextI >= lines.length) {
      // No more content — treat as empty string
      result[key] = '';
      i++;
      continue;
    }

    const nextLine = lines[nextI];
    const nextTrimmed = nextLine.trimStart();

    if (nextTrimmed.startsWith('- ')) {
      // Block array — collect all `- ` items at indent 2
      const items: unknown[] = [];
      let j = nextI;

      while (j < lines.length) {
        const arrLine = lines[j];
        if (arrLine.trim() === '') {
          j++;
          continue;
        }

        const arrIndent = arrLine.length - arrLine.trimStart().length;

        // Stop if we've returned to top-level
        if (arrIndent === 0) break;

        const arrTrimmed = arrLine.trimStart();

        if (arrTrimmed.startsWith('- ')) {
          const itemValue = arrTrimmed.slice(2);
          const itemColonIndex = itemValue.indexOf(':');

          if (itemColonIndex >= 0) {
            // Array item is an object — parse first key-value pair
            const objKey = itemValue.slice(0, itemColonIndex).trim();
            const objVal = itemValue.slice(itemColonIndex + 1).trim();
            const obj: Record<string, unknown> = {
              [objKey]: parseYamlValue(objVal),
            };

            // Collect additional indented keys for this object
            j++;
            while (j < lines.length) {
              const subLine = lines[j];
              if (subLine.trim() === '') {
                j++;
                continue;
              }
              const subIndent =
                subLine.length - subLine.trimStart().length;
              const subTrimmed = subLine.trimStart();

              // Must be deeper than the `- ` line and NOT a new `- ` item
              if (subIndent <= arrIndent || subTrimmed.startsWith('- ')) {
                break;
              }

              const subColonIndex = subTrimmed.indexOf(':');
              if (subColonIndex >= 0) {
                const subKey = subTrimmed.slice(0, subColonIndex).trim();
                const subVal = subTrimmed.slice(subColonIndex + 1).trim();
                obj[subKey] = parseYamlValue(subVal);
              }
              j++;
            }

            items.push(obj);
          } else {
            // Array item is a scalar
            items.push(parseYamlValue(itemValue));
            j++;
          }
        } else {
          // Not an array item — stop collecting
          break;
        }
      }

      result[key] = items;
      i = j;
    } else {
      // Nested object — collect all indented key-value pairs
      const obj: Record<string, unknown> = {};
      let j = nextI;

      while (j < lines.length) {
        const nestedLine = lines[j];
        if (nestedLine.trim() === '') {
          j++;
          continue;
        }

        const nestedIndent =
          nestedLine.length - nestedLine.trimStart().length;

        // Stop if we've returned to top-level
        if (nestedIndent === 0) break;

        const nestedTrimmed = nestedLine.trimStart();
        const nestedColonIndex = nestedTrimmed.indexOf(':');
        if (nestedColonIndex >= 0) {
          const nestedKey = nestedTrimmed
            .slice(0, nestedColonIndex)
            .trim();
          const nestedVal = nestedTrimmed
            .slice(nestedColonIndex + 1)
            .trim();
          obj[nestedKey] = parseYamlValue(nestedVal);
        }
        j++;
      }

      result[key] = obj;
      i = j;
    }
  }

  return result;
}

/**
 * Extract the markdown body (everything after the closing `---`).
 */
export function extractBody(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  return match ? match[1] : content;
}

/**
 * Parse the Sessions table from an assignment.md body.
 * Returns an array of ParsedSession objects.
 *
 * Expected table format:
 *   | Session ID | Agent | Started | Ended | Status |
 *   |------------|-------|---------|-------|--------|
 *   | id | agent | timestamp | timestamp-or-null | status |
 */
export function parseSessionsTable(body: string): Array<{
  sessionId: string;
  agent: string;
  started: string;
  ended: string | null;
  status: string;
}> {
  const sessions: Array<{
    sessionId: string;
    agent: string;
    started: string;
    ended: string | null;
    status: string;
  }> = [];

  // Find the Sessions section
  const sessionsMatch = body.match(
    /## Sessions\s*\n\s*\|[^\n]+\|\s*\n\s*\|[-| ]+\|\s*\n([\s\S]*?)(?=\n## |\n*$)/,
  );
  if (!sessionsMatch) return sessions;

  const tableBody = sessionsMatch[1];
  const rows = tableBody.split('\n').filter((line) => line.trim().startsWith('|'));

  for (const row of rows) {
    const cells = row
      .split('|')
      .map((c) => c.trim())
      .filter((c) => c !== '');
    if (cells.length >= 5) {
      sessions.push({
        sessionId: cells[0],
        agent: cells[1],
        started: cells[2],
        ended: cells[3] === 'null' || cells[3] === '' ? null : cells[3],
        status: cells[4],
      });
    }
  }

  return sessions;
}

/**
 * Count unanswered questions in the Q&A section of an assignment.md body.
 * An unanswered question has `**A:** pending` as the answer line.
 */
export function countUnansweredQuestions(body: string): number {
  const matches = body.match(/\*\*A:\*\*\s*pending/g);
  return matches ? matches.length : 0;
}

/**
 * Parse the latest decision from a decision-record.md body.
 * Looks for `## Decision N: <title>` headings and `**Status:** <status>` lines.
 * Returns the last (highest-numbered) decision found, or null if none.
 */
export function parseLatestDecision(
  body: string,
): { title: string; status: string } | null {
  // Parse sequentially: each **Status:** is associated with the most recent ## Decision heading
  const decisions: Array<{ title: string; status: string }> = [];
  let currentTitle: string | null = null;

  const lines = body.split('\n');
  for (const line of lines) {
    const headingMatch = line.match(/^## Decision \d+:\s*(.+)/);
    if (headingMatch) {
      currentTitle = headingMatch[1].trim();
      continue;
    }

    if (currentTitle) {
      const statusMatch = line.match(/\*\*Status:\*\*\s*(\w+)/);
      if (statusMatch) {
        decisions.push({
          title: currentTitle,
          status: statusMatch[1].trim(),
        });
        currentTitle = null; // Only take the first **Status:** per decision
      }
    }
  }

  if (decisions.length === 0) return null;
  return decisions[decisions.length - 1];
}
