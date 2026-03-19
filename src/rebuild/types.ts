/**
 * Parsed session row from an assignment.md Sessions table.
 */
export interface ParsedSession {
  sessionId: string;
  agent: string;
  started: string;
  ended: string | null;
  status: string;
}

/**
 * The latest decision extracted from a decision-record.md body.
 */
export interface ParsedDecision {
  title: string;
  status: string;
}

/**
 * Parsed data from a single assignment folder (assignment.md + plan.md + decision-record.md).
 */
export interface ParsedAssignment {
  slug: string;
  title: string;
  status: string;
  priority: string;
  assignee: string | null;
  dependsOn: string[];
  updated: string;
  sessions: ParsedSession[];
  unansweredQuestions: number;
  plan: ParsedPlan;
  decisionRecord: ParsedDecisionRecord;
}

/**
 * Parsed data from a plan.md file.
 */
export interface ParsedPlan {
  assignmentSlug: string;
  status: string;
  updated: string;
}

/**
 * Parsed data from a decision-record.md file.
 */
export interface ParsedDecisionRecord {
  assignmentSlug: string;
  decisionCount: number;
  latestDecision: ParsedDecision | null;
  updated: string;
}

/**
 * Parsed data from a resource file in resources/.
 */
export interface ParsedResource {
  fileName: string;
  name: string;
  category: string;
  source: string;
  relatedAssignments: string[];
  updated: string;
}

/**
 * Parsed data from a memory file in memories/.
 */
export interface ParsedMemory {
  fileName: string;
  name: string;
  source: string;
  scope: string;
  sourceAssignment: string | null;
  updated: string;
}

/**
 * Top-level parsed mission data returned by the scanner.
 */
export interface MissionData {
  slug: string;
  title: string;
  archived: boolean;
  assignments: ParsedAssignment[];
  resources: ParsedResource[];
  memories: ParsedMemory[];
}

/**
 * Status counts by assignment status.
 */
export interface StatusCounts {
  total: number;
  pending: number;
  in_progress: number;
  blocked: number;
  review: number;
  completed: number;
  failed: number;
}

/**
 * Items requiring human attention.
 */
export interface NeedsAttention {
  blockedCount: number;
  failedCount: number;
  unansweredQuestions: number;
}

/**
 * Computed mission status result.
 */
export type MissionStatusValue =
  | 'pending'
  | 'active'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'archived';

/**
 * Full computed status for a mission.
 */
export interface ComputedStatus {
  status: MissionStatusValue;
  progress: StatusCounts;
  needsAttention: NeedsAttention;
}

/**
 * Result of rebuilding a single mission.
 */
export interface RebuildResult {
  missionSlug: string;
  assignmentCount: number;
  filesWritten: number;
}
