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
sync:
  enabled: false
  endpoint: null
  interval: 300
---

# Syntaur Configuration

Global configuration for the Syntaur CLI.
`;
}
