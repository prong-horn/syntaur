import { escapeYamlString } from '../utils/yaml.js';

export interface PlaybookParams {
  slug: string;
  name: string;
  description: string;
  whenToUse?: string;
  timestamp: string;
}

export function renderPlaybook(params: PlaybookParams): string {
  const whenToUse = params.whenToUse
    ? escapeYamlString(params.whenToUse)
    : 'null';
  return `---
name: ${escapeYamlString(params.name)}
slug: ${params.slug}
description: ${escapeYamlString(params.description)}
when_to_use: ${whenToUse}
created: "${params.timestamp}"
updated: "${params.timestamp}"
tags: []
---

# ${params.name}

<!-- Write imperative rules and workflows here. Keep it under 50 lines. -->
`;
}
