export interface OpenCodeConfigParams {
  projectDir: string;
}

export function renderOpenCodeConfig(params: OpenCodeConfigParams): string {
  const config = {
    instructions: [
      `Read AGENTS.md in this directory for Syntaur protocol (v2.0) instructions.`,
      `Read ${params.projectDir}/project.md for project overview (project-nested tickets only).`,
      `Run syntaur show at the start of work and after every lifecycle verb; edit only files show lists with writer agent.`,
      `Use syntaur log <ticket-id> -t <type> "body" for the log role (journal.md); never edit it directly. syntaur progress log aliases -t progress.`,
      `Ticket folders are project-nested at ~/.syntaur/projects/<slug>/tickets/<aslug>/ or standalone at ~/.syntaur/tickets/<uuid>/ (project: null, slug display-only).`,
    ],
  };
  return JSON.stringify(config, null, 2) + '\n';
}
