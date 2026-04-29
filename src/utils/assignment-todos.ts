export interface AppendTodoLine {
  description: string;
  trace?: string;
}

function setTopLevelField(content: string, key: string, value: string): string {
  const fieldRegex = new RegExp(`^(${key}:)\\s*.*$`, 'm');
  if (fieldRegex.test(content)) {
    return content.replace(fieldRegex, `$1 ${value}`);
  }
  return content;
}

export function appendTodosToAssignmentBody(
  body: string,
  todos: AppendTodoLine[],
): string {
  if (todos.length === 0) return body;

  const lines = todos.map((t) => {
    const base = `- [ ] ${t.description.trim()}`;
    return t.trace ? `${base} <!-- ${t.trace} -->` : base;
  });
  const block = lines.join('\n');

  const todosHeading = /^## Todos\s*$/m;
  if (todosHeading.test(body)) {
    return body.replace(
      /(^## Todos[\s\S]*?)(\n## |\n*$)/m,
      (_m, section, nextHeading) => {
        return `${section.trimEnd()}\n${block}\n${nextHeading}`;
      },
    );
  }
  return `${body.trimEnd()}\n\n## Todos\n\n${block}\n`;
}

export function touchAssignmentUpdated(content: string, timestamp: string): string {
  return setTopLevelField(content, 'updated', `"${timestamp}"`);
}
