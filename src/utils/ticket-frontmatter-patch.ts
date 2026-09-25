const LIST_ITEM_LINE = /^([ \t]+-[ \t]+)(.*)$/;

/** Block or inline-empty YAML list (`field: []` or `field:\n  - a`). */
export function parseYamlBlockList(frontmatter: string, fieldName: string): string[] {
  const lines = frontmatter.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const inline = line.match(new RegExp(`^${fieldName}:[ \\t]*\\[[ \\t]*\\][ \\t]*$`));
    if (inline) return [];
    const header = line.match(new RegExp(`^${fieldName}:[ \\t]*$`));
    if (!header) continue;
    const results: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const itemLine = lines[j];
      if (itemLine.length === 0) break;
      if (itemLine[0] !== ' ' && itemLine[0] !== '\t') break;
      const m = itemLine.match(LIST_ITEM_LINE);
      if (!m) break;
      results.push(m[2].trim());
    }
    return results;
  }
  return [];
}

export function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Replace one scalar top-level key line; preserves the rest of the file byte-for-byte. */
export function replaceScalarField(frontmatter: string, key: string, value: string): string {
  const re = new RegExp(`^${key}:[ \\t]*.*$`, 'm');
  if (re.test(frontmatter)) {
    return frontmatter.replace(re, `${key}: ${value}`);
  }
  return `${frontmatter}\n${key}: ${value}`;
}

/** Replace quoted scalar fields like `updated: "…"`. */
export function replaceQuotedScalarField(frontmatter: string, key: string, quotedValue: string): string {
  const re = new RegExp(`^${key}:[ \\t]*.*$`, 'm');
  if (re.test(frontmatter)) {
    return frontmatter.replace(re, `${key}: ${quotedValue}`);
  }
  return `${frontmatter}\n${key}: ${quotedValue}`;
}

/**
 * Rewrite list item text in place (one line per entry). Returns null when nothing changed.
 */
export function rewriteYamlBlockListItems(
  frontmatter: string,
  fieldName: string,
  mapItem: (item: string) => string,
): string | null {
  const lines = frontmatter.split('\n');
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const inline = line.match(new RegExp(`^${fieldName}:[ \\t]*\\[[ \\t]*\\][ \\t]*$`));
    if (inline) continue;
    const header = line.match(new RegExp(`^${fieldName}:[ \\t]*$`));
    if (!header) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const itemLine = lines[j];
      if (itemLine.length === 0) break;
      if (itemLine[0] !== ' ' && itemLine[0] !== '\t') break;
      const m = itemLine.match(LIST_ITEM_LINE);
      if (!m) break;
      const prev = m[2].trim();
      const next = mapItem(prev);
      if (next !== prev) {
        lines[j] = `${m[1]}${next}`;
        changed = true;
      }
    }
    break;
  }
  return changed ? lines.join('\n') : null;
}

/** Append a block-list entry under `movedFrom`, keeping the next top-level key on its own line. */
export function appendMovedFromEntry(frontmatter: string, entry: string): string {
  const lines = frontmatter.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.match(/^movedFrom:[ \t]*\[[ \t]*\][ \t]*$/)) {
      lines[i] = 'movedFrom:';
      lines.splice(i + 1, 0, `  - ${entry}`);
      return lines.join('\n');
    }
    if (line.match(/^movedFrom:[ \t]*$/)) {
      let insertAt = i + 1;
      while (insertAt < lines.length) {
        const next = lines[insertAt];
        if (next.length === 0) break;
        if (next[0] !== ' ' && next[0] !== '\t') break;
        if (!LIST_ITEM_LINE.test(next)) break;
        insertAt += 1;
      }
      lines.splice(insertAt, 0, `  - ${entry}`);
      return lines.join('\n');
    }
  }
  return `${frontmatter}\nmovedFrom:\n  - ${entry}`;
}
