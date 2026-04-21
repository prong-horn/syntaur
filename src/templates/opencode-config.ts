export interface OpenCodeConfigParams {
  projectDir: string;
}

export function renderOpenCodeConfig(params: OpenCodeConfigParams): string {
  const config = {
    instructions: [
      `Read AGENTS.md in this directory for Syntaur protocol (v2.0) instructions.`,
      `Read ${params.projectDir}/project.md for project overview (project-nested assignments only).`,
      `Append timestamped progress entries to the assignment's progress.md (not to assignment.md).`,
      `Use 'syntaur comment <slug-or-uuid> "body" --type question|note|feedback' to append to comments.md — never edit it directly.`,
      `Use 'syntaur request <source> <target> "text"' to append a todo to another assignment's ## Todos.`,
      `Assignment folders are project-nested at ~/.syntaur/projects/<slug>/assignments/<aslug>/ or standalone at ~/.syntaur/assignments/<uuid>/ (project: null, slug display-only).`,
    ],
  };
  return JSON.stringify(config, null, 2) + '\n';
}
