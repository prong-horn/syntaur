import { escapeYamlString } from '../utils/yaml.js';

export interface MissionParams {
  id: string;
  slug: string;
  title: string;
  timestamp: string;
}

export function renderMission(params: MissionParams): string {
  const safeTitle = escapeYamlString(params.title);
  return `---
id: ${params.id}
slug: ${params.slug}
title: ${safeTitle}
archived: false
archivedAt: null
archivedReason: null
created: "${params.timestamp}"
updated: "${params.timestamp}"
externalIds: []
tags: []
---

# ${params.title}

## Overview

<!-- Describe the mission goal, context, and success criteria here. -->

## Notes

<!-- Optional human notes, updates, or context. -->
`;
}
