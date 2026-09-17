import { parse as yamlParse } from 'yaml';

/** Fixed stage ids from §3.5 (excluding dropped). */
export const STAGE_IDS = [
  'backlog',
  'planning',
  'ready',
  'in_progress',
  'review',
  'done',
] as const;

/** Includes `dropped` for parse/validate (rule 16); not a valid template stage id. */
export const PARSEABLE_STAGE_IDS = [...STAGE_IDS, 'dropped'] as const;

export type StageId = (typeof STAGE_IDS)[number];

export const FILE_ROLES = ['plan', 'log', 'notes', 'deliverable'] as const;
export type FileRole = (typeof FILE_ROLES)[number];

export const FILE_WRITERS = ['agent', 'cli', 'human'] as const;
export type FileWriter = (typeof FILE_WRITERS)[number];

export const WORKSPACE_MODES = ['required', 'optional', 'none'] as const;
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

export const PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const LOG_ENTRY_TYPES = [
  'progress',
  'decision',
  'handoff',
  'note',
  'question',
  'answer',
  'review',
] as const;
export type LogEntryType = (typeof LOG_ENTRY_TYPES)[number];

export const GATE_IDS = [
  'plan-exists',
  'plan-approved',
  'deps-done',
  'workspace-set',
  'criteria-checked',
  'handoff-logged',
  'review-clean',
  'deliverable-present',
] as const;
export type GateId = (typeof GATE_IDS)[number];

export const VERBS_WITH_GATES = ['plan', 'approve', 'start', 'review', 'done'] as const;
export type VerbWithGates = (typeof VERBS_WITH_GATES)[number];

export const CREATE_ON_VALUES = ['ticket-creation', 'never', ...STAGE_IDS] as const;
export type CreateOn = (typeof CREATE_ON_VALUES)[number];

export interface TemplateStage {
  id: StageId;
  label: string;
  instructions: string;
  agent?: string;
  reviewer?: string;
  auto?: boolean;
}

export interface TemplateFile {
  path: string;
  role?: FileRole;
  writer: FileWriter;
  createOn: CreateOn;
  description: string;
  entryTypes: LogEntryType[];
}

export interface TemplateManifest {
  id: string;
  version: number;
  builtin?: string;
  description: string;
  whenToUse: string;
  stages: TemplateStage[];
  files: TemplateFile[];
  gates: Partial<Record<VerbWithGates, GateId[]>>;
  playbooks: string[];
  workspace: WorkspaceMode;
  defaultPriority: Priority;
}

export class TemplateManifestError extends Error {
  constructor(
    public readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = 'TemplateManifestError';
  }
}

const MANIFEST_KEYS = [
  'id',
  'version',
  'builtin',
  'description',
  'whenToUse',
  'stages',
  'files',
  'gates',
  'playbooks',
  'workspace',
  'defaultPriority',
] as const;

const STAGE_KEYS = ['id', 'label', 'instructions', 'agent', 'reviewer', 'auto'] as const;
const FILE_KEYS = ['path', 'role', 'writer', 'createOn', 'description', 'entryTypes'] as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function collectUnknown(
  obj: Record<string, unknown>,
  known: readonly string[],
): Record<string, unknown> | undefined {
  const raw: Record<string, unknown> = {};
  let has = false;
  for (const k of Object.keys(obj)) {
    if (!known.includes(k)) {
      raw[k] = obj[k];
      has = true;
    }
  }
  return has ? raw : undefined;
}

function str(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

function extractFrontmatter(content: string): [string, string] {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return ['', normalized];
  return [match[1], match[2]];
}

function parseStage(entry: unknown, file: string, index: number): TemplateStage {
  if (!isObject(entry)) {
    throw new TemplateManifestError(file, `stages[${index}] must be a mapping`);
  }
  const unknown = collectUnknown(entry, STAGE_KEYS);
  if (unknown) {
    throw new TemplateManifestError(
      file,
      `stages[${index}] has unknown keys: ${Object.keys(unknown).join(', ')}`,
    );
  }
  const id = str(entry, 'id');
  if (!id) throw new TemplateManifestError(file, `stages[${index}] is missing 'id'`);
  if (!(PARSEABLE_STAGE_IDS as readonly string[]).includes(id)) {
    throw new TemplateManifestError(file, `stages[${index}].id "${id}" is not a valid stage id`);
  }
  const instructions = str(entry, 'instructions');
  if (!instructions) {
    throw new TemplateManifestError(file, `stages[${index}] is missing 'instructions'`);
  }
  const label = str(entry, 'label') ?? id;
  const agentRaw = str(entry, 'agent');
  const reviewerRaw = str(entry, 'reviewer');
  if (agentRaw !== undefined && (typeof agentRaw !== 'string' || agentRaw.trim() === '')) {
    throw new TemplateManifestError(file, `stages[${index}].agent must be a non-empty string`);
  }
  if (
    reviewerRaw !== undefined &&
    (typeof reviewerRaw !== 'string' || reviewerRaw.trim() === '')
  ) {
    throw new TemplateManifestError(file, `stages[${index}].reviewer must be a non-empty string`);
  }
  const agent = agentRaw?.trim();
  const reviewer = reviewerRaw?.trim();
  if (agent && reviewer) {
    throw new TemplateManifestError(
      file,
      `stages[${index}] declares both agent and reviewer; only one target is allowed per stage`,
    );
  }
  let auto: boolean | undefined;
  if (entry.auto !== undefined) {
    if (typeof entry.auto !== 'boolean') {
      throw new TemplateManifestError(file, `stages[${index}].auto must be a boolean`);
    }
    auto = entry.auto;
  } else if (agent) {
    auto = true;
  } else if (reviewer) {
    auto = false;
  }
  return { id: id as StageId, label, instructions, agent, reviewer, auto };
}

function parseFile(entry: unknown, file: string, index: number): TemplateFile {
  if (!isObject(entry)) {
    throw new TemplateManifestError(file, `files[${index}] must be a mapping`);
  }
  const unknown = collectUnknown(entry, FILE_KEYS);
  if (unknown) {
    throw new TemplateManifestError(
      file,
      `files[${index}] has unknown keys: ${Object.keys(unknown).join(', ')}`,
    );
  }
  const path = str(entry, 'path');
  if (!path) throw new TemplateManifestError(file, `files[${index}] is missing 'path'`);
  const writer = str(entry, 'writer');
  if (!writer) throw new TemplateManifestError(file, `files[${index}] is missing 'writer'`);
  if (!(FILE_WRITERS as readonly string[]).includes(writer)) {
    throw new TemplateManifestError(file, `files[${index}].writer "${writer}" is invalid`);
  }
  const description = str(entry, 'description');
  if (!description) {
    throw new TemplateManifestError(file, `files[${index}] is missing 'description'`);
  }
  const roleRaw = str(entry, 'role');
  let role: FileRole | undefined;
  if (roleRaw !== undefined) {
    if (!(FILE_ROLES as readonly string[]).includes(roleRaw)) {
      throw new TemplateManifestError(file, `files[${index}].role "${roleRaw}" is invalid`);
    }
    role = roleRaw as FileRole;
  }
  const createOn = (str(entry, 'createOn') ?? 'ticket-creation') as CreateOn;
  let entryTypes: LogEntryType[] = [...LOG_ENTRY_TYPES];
  if (entry.entryTypes !== undefined) {
    if (!Array.isArray(entry.entryTypes)) {
      throw new TemplateManifestError(file, `files[${index}].entryTypes must be a list`);
    }
    entryTypes = entry.entryTypes.map((t, i) => {
      if (typeof t !== 'string' || !(LOG_ENTRY_TYPES as readonly string[]).includes(t)) {
        throw new TemplateManifestError(file, `files[${index}].entryTypes[${i}] is invalid`);
      }
      return t as LogEntryType;
    });
  }
  return {
    path,
    role,
    writer: writer as FileWriter,
    createOn,
    description,
    entryTypes,
  };
}

function parseGates(
  entry: unknown,
  file: string,
): Partial<Record<VerbWithGates, GateId[]>> {
  if (entry === undefined || entry === null) return {};
  if (!isObject(entry)) {
    throw new TemplateManifestError(file, 'gates must be a mapping');
  }
  const gates: Partial<Record<VerbWithGates, GateId[]>> = {};
  for (const [verb, gateList] of Object.entries(entry)) {
    if (!Array.isArray(gateList)) {
      throw new TemplateManifestError(file, `gates.${verb} must be a list`);
    }
    gates[verb as VerbWithGates] = gateList.map((g) => String(g)) as GateId[];
  }
  return gates;
}

/**
 * Parse a template.md manifest from YAML frontmatter. The markdown body is ignored.
 */
export function parseTemplateManifest(
  file: string,
  expectedId: string,
  content: string,
): TemplateManifest {
  const [frontmatter] = extractFrontmatter(content.replace(/\r\n/g, '\n'));
  if (!frontmatter.trim()) {
    throw new TemplateManifestError(file, 'no frontmatter block');
  }

  let doc: Record<string, unknown>;
  try {
    const parsed = yamlParse(frontmatter) as unknown;
    if (!isObject(parsed)) {
      throw new Error('frontmatter is not a mapping');
    }
    doc = parsed;
  } catch (err) {
    throw new TemplateManifestError(
      file,
      `invalid YAML frontmatter (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  const unknown = collectUnknown(doc, MANIFEST_KEYS);
  if (unknown) {
    throw new TemplateManifestError(
      file,
      `unknown top-level keys: ${Object.keys(unknown).join(', ')}`,
    );
  }

  const id = str(doc, 'id');
  if (!id) throw new TemplateManifestError(file, 'missing `id`');
  if (id !== expectedId) {
    throw new TemplateManifestError(
      file,
      `\`id\` is ${JSON.stringify(id)} but expected ${JSON.stringify(expectedId)}`,
    );
  }

  const version = doc.version;
  if (typeof version !== 'number') {
    throw new TemplateManifestError(file, '`version` must be a number');
  }

  const description = str(doc, 'description');
  if (!description) throw new TemplateManifestError(file, 'missing `description`');
  const whenToUse = str(doc, 'whenToUse');
  if (!whenToUse) throw new TemplateManifestError(file, 'missing `whenToUse`');

  if (!Array.isArray(doc.stages)) {
    throw new TemplateManifestError(file, '`stages` must be a list');
  }
  const stages = doc.stages.map((s, i) => parseStage(s, file, i));

  const files = Array.isArray(doc.files)
    ? doc.files.map((f, i) => parseFile(f, file, i))
    : [];

  const gates = parseGates(doc.gates, file);

  let playbooks: string[] = [];
  if (doc.playbooks !== undefined) {
    if (!Array.isArray(doc.playbooks)) {
      throw new TemplateManifestError(file, '`playbooks` must be a list');
    }
    playbooks = doc.playbooks.map((p, i) => {
      if (typeof p !== 'string') {
        throw new TemplateManifestError(file, `playbooks[${i}] must be a string`);
      }
      return p;
    });
  }

  const workspace = (str(doc, 'workspace') ?? 'optional') as WorkspaceMode;
  const defaultPriority = (str(doc, 'defaultPriority') ?? 'medium') as Priority;

  const builtin = str(doc, 'builtin');

  return {
    id,
    version,
    builtin,
    description,
    whenToUse,
    stages,
    files,
    gates,
    playbooks,
    workspace,
    defaultPriority,
  };
}

export function planRoleFile(manifest: TemplateManifest): TemplateFile | undefined {
  return manifest.files.find((f) => f.role === 'plan');
}

export function logRoleFile(manifest: TemplateManifest): TemplateFile | undefined {
  return manifest.files.find((f) => f.role === 'log');
}

export function deliverableRoleFile(manifest: TemplateManifest): TemplateFile | undefined {
  return manifest.files.find((f) => f.role === 'deliverable');
}

export function stageIds(manifest: TemplateManifest): StageId[] {
  return manifest.stages.map((s) => s.id);
}
