export interface AcceptanceCriterion {
  checked: boolean;
  text: string;
}

export interface AssignmentSummarySections {
  acceptanceCriteria: AcceptanceCriterion[];
  summaryBody: string;
}

export function splitAssignmentSummary(body: string): AssignmentSummarySections {
  const lines = body.split('\n');
  const sectionStart = lines.findIndex((line) => /^##\s+Acceptance Criteria\s*$/i.test(line.trim()));

  if (sectionStart === -1) {
    return {
      acceptanceCriteria: [],
      summaryBody: body,
    };
  }

  let sectionEnd = lines.length;
  for (let index = sectionStart + 1; index < lines.length; index += 1) {
    if (/^#{1,2}\s+\S/.test(lines[index].trim())) {
      sectionEnd = index;
      break;
    }
  }

  const acceptanceCriteria = lines
    .slice(sectionStart + 1, sectionEnd)
    .map((line) => line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({
      checked: match[1].toLowerCase() === 'x',
      text: match[2].trim(),
    }));

  const summaryBody = [...lines.slice(0, sectionStart), ...lines.slice(sectionEnd)]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    acceptanceCriteria,
    summaryBody,
  };
}

export interface TodosSection {
  hasSection: boolean;
  todosMarkdown: string;
  remaining: string;
}

export function splitTodosSection(body: string): TodosSection {
  const lines = body.split('\n');
  const sectionStart = lines.findIndex((line) => /^##\s+Todos\s*$/i.test(line.trim()));

  if (sectionStart === -1) {
    return {
      hasSection: false,
      todosMarkdown: '',
      remaining: body,
    };
  }

  let sectionEnd = lines.length;
  for (let index = sectionStart + 1; index < lines.length; index += 1) {
    if (/^#{1,2}\s+\S/.test(lines[index].trim())) {
      sectionEnd = index;
      break;
    }
  }

  const todosMarkdown = lines
    .slice(sectionStart + 1, sectionEnd)
    .join('\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const remaining = [...lines.slice(0, sectionStart), ...lines.slice(sectionEnd)]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    hasSection: true,
    todosMarkdown,
    remaining,
  };
}
