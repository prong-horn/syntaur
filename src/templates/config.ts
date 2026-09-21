export interface ConfigParams {
  defaultProjectDir: string;
}

export function renderConfig(params: ConfigParams): string {
  return `---
version: "2.0"
defaultProjectDir: ${params.defaultProjectDir}
agentDefaults:
  trustLevel: medium
  autoApprove: false
session:
  idleSweepHours: 6
---

# Syntaur Configuration

Global configuration for the Syntaur CLI.
`;
}
