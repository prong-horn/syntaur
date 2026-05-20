import { escapeYamlString } from '../utils/yaml.js';

export interface ProjectParams {
  id: string;
  slug: string;
  title: string;
  timestamp: string;
  workspace?: string;
  /**
   * Repository paths the project spans. Each entry is YAML-escaped on
   * render so paths with spaces / colons / quotes don't corrupt the
   * frontmatter. Empty by default for new projects.
   */
  repositories?: string[];
}

function renderRepositoriesBlock(repos: string[] | undefined): string {
  if (!repos || repos.length === 0) {
    return 'repositories: []';
  }
  return ['repositories:', ...repos.map((p) => `  - ${escapeYamlString(p)}`)].join('\n');
}

export function renderProject(params: ProjectParams): string {
  const safeTitle = escapeYamlString(params.title);
  const workspaceLine = params.workspace ? `\nworkspace: ${params.workspace}` : '';
  const repositoriesBlock = renderRepositoriesBlock(params.repositories);
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
${repositoriesBlock}${workspaceLine}
---

# ${params.title}

## Overview

<!-- Describe the project goal, context, and success criteria here. -->

## Notes

<!-- Optional human notes, updates, or context. -->
`;
}
