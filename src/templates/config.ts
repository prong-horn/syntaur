export interface ConfigParams {
  defaultProjectDir: string;
}

export function renderConfig(params: ConfigParams): string {
  return `---
version: "1.0"
defaultProjectDir: ${params.defaultProjectDir}
onboarding:
  completed: false
agentDefaults:
  trustLevel: medium
  autoApprove: false
backup:
  repo: null
  categories: projects, playbooks, todos, servers, config
  lastBackup: null
  lastRestore: null
---

# Syntaur Configuration

Global configuration for the Syntaur CLI.
`;
}
