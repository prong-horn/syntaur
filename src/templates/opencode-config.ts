export interface OpenCodeConfigParams {
  projectDir: string;
}

export function renderOpenCodeConfig(params: OpenCodeConfigParams): string {
  const config = {
    instructions: [
      `Read AGENTS.md in this directory for Syntaur protocol instructions.`,
      `Also read ${params.projectDir}/agent.md for universal agent conventions.`,
    ],
  };
  return JSON.stringify(config, null, 2) + '\n';
}
