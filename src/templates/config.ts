export interface ConfigParams {
  defaultMissionDir: string;
}

export function renderConfig(params: ConfigParams): string {
  return `---
version: "1.0"
defaultMissionDir: ${params.defaultMissionDir}
onboarding:
  completed: false
agentDefaults:
  trustLevel: medium
  autoApprove: false
backup:
  repo: null
  categories: missions, playbooks, todos, servers, config
  lastBackup: null
  lastRestore: null
---

# Syntaur Configuration

Global configuration for the Syntaur CLI.
`;
}
