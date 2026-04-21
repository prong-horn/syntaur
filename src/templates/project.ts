import { escapeYamlString } from '../utils/yaml.js';

export interface ProjectParams {
  id: string;
  slug: string;
  title: string;
  timestamp: string;
  workspace?: string;
}

export function renderProject(params: ProjectParams): string {
  const safeTitle = escapeYamlString(params.title);
  const workspaceLine = params.workspace ? `\nworkspace: ${params.workspace}` : '';
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
tags: []${workspaceLine}
---

# ${params.title}

## Overview

<!-- Describe the project goal, context, and success criteria here. -->

## Notes

<!-- Optional human notes, updates, or context. -->
`;
}
