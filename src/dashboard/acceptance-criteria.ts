export interface ToggleAcceptanceCriterionResult {
  content: string;
}

export interface ToggleAcceptanceCriterionError {
  error: string;
}

function splitFrontmatter(content: string): { prefix: string; body: string } {
  const match = content.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n?)([\s\S]*)$/);
  if (!match) {
    return { prefix: '', body: content };
  }

  return {
    prefix: match[1],
    body: match[2],
  };
}

export function toggleAcceptanceCriterion(
  content: string,
  index: number,
  checked: boolean,
): ToggleAcceptanceCriterionResult | ToggleAcceptanceCriterionError {
  if (!Number.isInteger(index) || index < 0) {
    return { error: 'acceptance criteria index must be a non-negative integer' };
  }

  const { prefix, body } = splitFrontmatter(content);
  const lines = body.split('\n');
  const sectionStart = lines.findIndex((line) => /^##\s+Acceptance Criteria\s*$/i.test(line.trim()));

  if (sectionStart === -1) {
    return { error: 'Acceptance Criteria section not found.' };
  }

  let sectionEnd = lines.length;
  for (let lineIndex = sectionStart + 1; lineIndex < lines.length; lineIndex += 1) {
    if (/^#{1,2}\s+\S/.test(lines[lineIndex].trim())) {
      sectionEnd = lineIndex;
      break;
    }
  }

  const checklistLines = lines
    .map((line, lineIndex) => ({ line, lineIndex }))
    .filter(({ lineIndex, line }) =>
      lineIndex > sectionStart
      && lineIndex < sectionEnd
      && /^\s*[-*]\s+\[( |x|X)\]\s+.*$/.test(line),
    );

  const target = checklistLines[index];
  if (!target) {
    return { error: `Acceptance criteria item ${index} not found.` };
  }

  const nextLine = target.line.replace(
    /^(\s*[-*]\s+\[)( |x|X)(\]\s+.*)$/,
    `$1${checked ? 'x' : ' '}$3`,
  );

  lines[target.lineIndex] = nextLine;
  return {
    content: `${prefix}${lines.join('\n')}`,
  };
}
