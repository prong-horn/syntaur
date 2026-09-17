import type { StageId, TemplateManifest } from './manifest.js';
import { isTerminalStage } from './stages.js';

export type StageDispatchRole = 'agent' | 'reviewer';

export interface StageDispatchTarget {
  stage: StageId;
  role: StageDispatchRole;
  agentId: string;
  auto: boolean;
  instructions: string;
}

export class StageDispatchPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StageDispatchPolicyError';
  }
}

function stageEntry(
  manifest: TemplateManifest,
  stage: StageId,
): TemplateManifest['stages'][number] | undefined {
  return manifest.stages.find((s) => s.id === stage);
}

/**
 * Pure stage dispatch policy resolver. Unknown override ids are returned as a
 * synthetic target with role=agent for validation by the caller (exact lookup,
 * no resolveAgent fallback here).
 */
export function resolveStageDispatch(
  manifest: TemplateManifest,
  stage: StageId | 'dropped',
  overrideAgentId?: string,
): StageDispatchTarget | null {
  if (isTerminalStage(stage)) return null;

  const entry = stageEntry(manifest, stage as StageId);
  if (!entry) return null;

  const defaultAgent = entry.agent?.trim();
  const defaultReviewer = entry.reviewer?.trim();
  const override = overrideAgentId?.trim();

  let role: StageDispatchRole;
  let agentId: string | undefined;
  let auto: boolean;

  if (override) {
    role = defaultAgent ? 'agent' : defaultReviewer ? 'reviewer' : 'agent';
    agentId = override;
    auto = entry.auto ?? (role === 'agent');
    // Explicit override requests dispatch even when auto=false.
    return {
      stage: entry.id,
      role,
      agentId,
      auto: true,
      instructions: entry.instructions,
    };
  }

  if (defaultAgent && defaultReviewer) {
    throw new StageDispatchPolicyError(
      `stage ${entry.id} declares both agent and reviewer; template must declare only one target per stage`,
    );
  }

  if (defaultAgent) {
    role = 'agent';
    agentId = defaultAgent;
    auto = entry.auto ?? true;
  } else if (defaultReviewer) {
    role = 'reviewer';
    agentId = defaultReviewer;
    auto = entry.auto ?? false;
  } else {
    return null;
  }

  if (!agentId) return null;

  return {
    stage: entry.id,
    role,
    agentId,
    auto,
    instructions: entry.instructions,
  };
}

/** Validate manifest stage target declarations at parse/validation time. */
export function validateStageTargetDeclarations(
  manifest: TemplateManifest,
): string[] {
  const issues: string[] = [];
  for (const stage of manifest.stages) {
    const agent = stage.agent?.trim();
    const reviewer = stage.reviewer?.trim();
    if (agent && reviewer) {
      issues.push(
        `stages[].${stage.id} declares both agent and reviewer; only one target is allowed per stage`,
      );
    }
    if (stage.agent !== undefined && (typeof stage.agent !== 'string' || stage.agent.trim() === '')) {
      issues.push(`stages[].${stage.id}.agent must be a non-empty string`);
    }
    if (
      stage.reviewer !== undefined &&
      (typeof stage.reviewer !== 'string' || stage.reviewer.trim() === '')
    ) {
      issues.push(`stages[].${stage.id}.reviewer must be a non-empty string`);
    }
  }
  return issues;
}
