export interface OpenCodeConfigParams {
  projectDir: string;
}

export function renderOpenCodeConfig(params: OpenCodeConfigParams): string {
  const config = {
    instructions: [
      `Read AGENTS.md in this directory for Syntaur protocol (v2.0) instructions.`,
      `Read ${params.projectDir}/project.md for project overview (project-nested tickets only).`,
      `Append timestamped progress entries to the ticket's progress.md (not to ticket.md).`,
      `Use 'syntaur comment <slug-or-uuid> "body" --type question|note|feedback' to append to comments.md — never edit it directly.`,
      `Ticket folders are project-nested at ~/.syntaur/projects/<slug>/tickets/<aslug>/ or standalone at ~/.syntaur/tickets/<uuid>/ (project: null, slug display-only).`,
    ],
  };
  return JSON.stringify(config, null, 2) + '\n';
}
