/** Matches HTML comments in markdown bodies. */
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

/** Body after optional YAML frontmatter. */
export function markdownBody(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  const fmMatch = normalized.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  return fmMatch ? fmMatch[1] : normalized;
}

/** Bold-label metadata line: `**Key:** value` */
function isBoldLabelMetadata(line: string): boolean {
  return /^\*\*[^*]+:\*\*\s*.+$/.test(line);
}

function isTableSeparatorRow(line: string): boolean {
  return /^\|[\s\-:|]+\|$/.test(line);
}

function lineHasRealContent(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('#')) return false;
  if (isBoldLabelMetadata(trimmed)) return false;
  const withoutComments = trimmed.replace(HTML_COMMENT_RE, '').trim();
  if (!withoutComments) return false;

  const listMatch = withoutComments.match(/^(?:[-*+]|\d+\.)\s+(.*)$/);
  if (listMatch) {
    const itemContent = listMatch[1].replace(HTML_COMMENT_RE, '').trim();
    return itemContent.length > 0;
  }

  if (withoutComments.startsWith('|') && withoutComments.endsWith('|')) {
    return !isTableSeparatorRow(withoutComments);
  }

  return true;
}

/**
 * True when the markdown body has at least one paragraph, list item, or table row
 * of real text. Headings, HTML comments, and bold-label metadata lines are scaffold.
 */
export function nonEmptyBeyondScaffold(content: string): boolean {
  for (const line of markdownBody(content).split('\n')) {
    if (lineHasRealContent(line)) return true;
  }
  return false;
}

/** First paragraph of a `## <heading>` section (single line). */
export function sectionFirstParagraph(body: string, heading: string): string {
  const re = new RegExp(`^##\\s+${heading}\\s*$`, 'm');
  const m = body.match(re);
  if (!m || m.index === undefined) return '';
  const start = m.index + m[0].length;
  const rest = body.slice(start);
  const next = rest.search(/^##\s+/m);
  const section = (next >= 0 ? rest.slice(0, next) : rest)
    .replace(HTML_COMMENT_RE, '')
    .trim();
  if (!section) return '';
  const paragraph = section.split(/\n\s*\n/)[0]?.trim() ?? section;
  return paragraph.split('\n')[0]?.trim() ?? '';
}

/**
 * Kernel one-liner for the Files block (§7.1): first sentence of Objective
 * (through the first `. ` or end of paragraph), capped at 100 characters.
 */
export function objectiveOneLiner(body: string): string {
  const paragraph = sectionFirstParagraph(body, 'Objective');
  if (!paragraph) return '';
  const dotSpace = paragraph.indexOf('. ');
  const sentence = dotSpace >= 0 ? paragraph.slice(0, dotSpace + 1) : paragraph;
  if (sentence.length <= 100) return sentence;
  return `${sentence.slice(0, 99)}…`;
}
