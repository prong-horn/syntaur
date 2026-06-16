import type { EditableDocumentType } from '../hooks/useProjects';

interface FrontmatterModel {
  order: string[];
  blocks: Map<string, string[]>;
  body: string;
}

export interface ProjectEditorState {
  title: string;
  slug: string;
  workspace: string;
  archived: boolean;
  archivedAt: string;
  archivedReason: string;
  tags: string;
  body: string;
}

export interface AssignmentEditorState {
  title: string;
  slug: string;
  status: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  assignee: string;
  dependsOn: string;
  links: string;
  blockedReason: string;
  tags: string;
  body: string;
}

export interface PlanEditorState {
  assignment: string;
  status: string;
  body: string;
}

export interface ScratchpadEditorState {
  assignment: string;
  body: string;
}

export interface PlaybookEditorState {
  name: string;
  slug: string;
  description: string;
  whenToUse: string;
  tags: string;
  body: string;
}

/** Body-only editor state. Frontmatter is preserved server-side on save. */
export interface MemoryEditorState {
  body: string;
}

export type ResourceEditorState = MemoryEditorState;

function parseFrontmatterModel(content: string): FrontmatterModel {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    return {
      order: [],
      blocks: new Map(),
      body: content,
    };
  }

  const frontmatter = match[1];
  const body = content.slice(match[0].length);
  const lines = frontmatter.split('\n');
  const order: string[] = [];
  const blocks = new Map<string, string[]>();

  let currentKey: string | null = null;
  let currentBlock: string[] = [];

  const flush = () => {
    if (currentKey) {
      order.push(currentKey);
      blocks.set(currentKey, currentBlock);
    }
  };

  for (const line of lines) {
    const keyMatch = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):/);
    if (keyMatch && !line.startsWith(' ')) {
      flush();
      currentKey = keyMatch[1];
      currentBlock = [line];
      continue;
    }

    if (currentKey) {
      currentBlock.push(line);
    }
  }

  flush();

  return { order, blocks, body };
}

function serializeFrontmatterModel(model: FrontmatterModel): string {
  const blockLines = model.order
    .map((key) => model.blocks.get(key))
    .filter((value): value is string[] => Boolean(value))
    .flat();

  return `---\n${blockLines.join('\n')}\n---\n\n${model.body.replace(/^\n+/, '')}`;
}

/** Characters that force a YAML scalar to be quoted when serialized. */
const YAML_SPECIAL_CHARS = /[:#{}[\],&*?|>!%@`]/;

/**
 * Decode a raw YAML scalar token into its logical string value.
 *
 * If `raw` is YAML-quoted (`"..."` or `'...'`), strip the quotes and unescape
 * per YAML rules: inside double quotes `\"`→`"` and `\\`→`\`; inside single
 * quotes `''`→`'`. Otherwise the value is returned verbatim. This is the inverse
 * of `encodeScalar`.
 */
function decodeScalar(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw;
}

/**
 * Encode a logical string value into a YAML scalar token, quoting only when
 * required so plain values stay bare. Quotes when the value contains a YAML
 * special character, has leading/trailing whitespace, or itself begins/ends
 * with a quote character. When quoting, embedded `\` and `"` are escaped so the
 * token round-trips through `decodeScalar`.
 */
function encodeScalar(value: string): string {
  const needsQuoting =
    YAML_SPECIAL_CHARS.test(value) ||
    /^\s|\s$/.test(value) ||
    /^["']|["']$/.test(value);
  if (!needsQuoting) {
    return value;
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function getScalar(model: FrontmatterModel, key: string): string {
  const block = model.blocks.get(key);
  if (!block?.[0]) {
    return '';
  }

  const match = block[0].match(/^[^:]+:\s*(.*)$/);
  if (!match) {
    return '';
  }

  const rawValue = match[1].trim();
  if (rawValue === 'null') {
    return '';
  }
  return decodeScalar(rawValue);
}

function getBoolean(model: FrontmatterModel, key: string): boolean {
  return getScalar(model, key) === 'true';
}

/**
 * Split an inline-flow payload (the text inside `[...]`) on TOP-LEVEL commas,
 * ignoring commas nested inside quoted scalars. Returns raw element tokens.
 */
function splitTopLevelCommas(payload: string): string[] {
  const elements: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < payload.length; i += 1) {
    const ch = payload[i];
    if (quote) {
      current += ch;
      if (ch === '\\' && quote === '"' && i + 1 < payload.length) {
        // Preserve an escaped char inside double quotes verbatim.
        current += payload[i + 1];
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ',') {
      elements.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  elements.push(current);
  return elements;
}

function getStringList(model: FrontmatterModel, key: string): string[] {
  const block = model.blocks.get(key);
  if (!block?.length) {
    return [];
  }

  const firstLine = block[0].trim();
  if (firstLine.endsWith('[]')) {
    return [];
  }

  // Inline-flow list on the key line: `key: [a, b, "c, d"]`.
  const inlineMatch = block[0].match(/^[^:]+:\s*\[(.*)\]\s*$/);
  if (inlineMatch) {
    return splitTopLevelCommas(inlineMatch[1])
      .map((element) => decodeScalar(element.trim()))
      .filter((element) => element.length > 0);
  }

  // Multiline block list: `key:` followed by `  - value` lines.
  return block
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => decodeScalar(line.slice(2).trim()));
}

function formatYamlValue(value: string | null | boolean): string {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (value === null || value === '') {
    return 'null';
  }
  return encodeScalar(value);
}

function setScalar(model: FrontmatterModel, key: string, value: string | null | boolean): void {
  if (!model.blocks.has(key)) {
    model.order.push(key);
  }
  model.blocks.set(key, [`${key}: ${formatYamlValue(value)}`]);
}

function setStringList(model: FrontmatterModel, key: string, values: string[]): void {
  if (!model.blocks.has(key)) {
    model.order.push(key);
  }

  if (values.length === 0) {
    model.blocks.set(key, [`${key}: []`]);
    return;
  }

  model.blocks.set(key, [`${key}:`, ...values.map((value) => `  - ${encodeScalar(value)}`)]);
}

function commaListToArray(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseProjectEditorState(content: string): ProjectEditorState {
  const model = parseFrontmatterModel(content);
  return {
    title: getScalar(model, 'title'),
    slug: getScalar(model, 'slug'),
    workspace: getScalar(model, 'workspace'),
    archived: getBoolean(model, 'archived'),
    archivedAt: getScalar(model, 'archivedAt'),
    archivedReason: getScalar(model, 'archivedReason'),
    tags: getStringList(model, 'tags').join(', '),
    body: model.body,
  };
}

export function updateProjectContent(
  content: string,
  updates: Partial<ProjectEditorState>,
): string {
  const model = parseFrontmatterModel(content);
  const next = { ...parseProjectEditorState(content), ...updates };

  setScalar(model, 'title', next.title);
  setScalar(model, 'slug', next.slug);
  setScalar(model, 'workspace', next.workspace || null);
  setScalar(model, 'archived', next.archived);
  setScalar(model, 'archivedAt', next.archivedAt || null);
  setScalar(model, 'archivedReason', next.archivedReason || null);
  setStringList(model, 'tags', commaListToArray(next.tags));
  model.body = next.body;

  return serializeFrontmatterModel(model);
}

export function parseAssignmentEditorState(content: string): AssignmentEditorState {
  const model = parseFrontmatterModel(content);
  return {
    title: getScalar(model, 'title'),
    slug: getScalar(model, 'slug'),
    status: getScalar(model, 'status'),
    priority: (getScalar(model, 'priority') || 'medium') as AssignmentEditorState['priority'],
    assignee: getScalar(model, 'assignee'),
    dependsOn: getStringList(model, 'dependsOn').join(', '),
    links: getStringList(model, 'links').join(', '),
    blockedReason: getScalar(model, 'blockedReason'),
    tags: getStringList(model, 'tags').join(', '),
    body: model.body,
  };
}

export function updateAssignmentContent(
  content: string,
  updates: Partial<AssignmentEditorState>,
): string {
  const model = parseFrontmatterModel(content);
  const next = { ...parseAssignmentEditorState(content), ...updates };

  setScalar(model, 'title', next.title);
  setScalar(model, 'slug', next.slug);
  setScalar(model, 'status', next.status);
  setScalar(model, 'priority', next.priority);
  setScalar(model, 'assignee', next.assignee || null);
  setStringList(model, 'dependsOn', commaListToArray(next.dependsOn));
  setStringList(model, 'links', commaListToArray(next.links));
  setScalar(model, 'blockedReason', next.blockedReason || null);
  setStringList(model, 'tags', commaListToArray(next.tags));
  model.body = next.body;

  return serializeFrontmatterModel(model);
}

export function parsePlanEditorState(content: string): PlanEditorState {
  const model = parseFrontmatterModel(content);
  return {
    assignment: getScalar(model, 'assignment'),
    status: getScalar(model, 'status'),
    body: model.body,
  };
}

export function updatePlanContent(
  content: string,
  updates: Partial<PlanEditorState>,
): string {
  const model = parseFrontmatterModel(content);
  const next = { ...parsePlanEditorState(content), ...updates };

  setScalar(model, 'assignment', next.assignment);
  setScalar(model, 'status', next.status);
  model.body = next.body;

  return serializeFrontmatterModel(model);
}

export function parseScratchpadEditorState(content: string): ScratchpadEditorState {
  const model = parseFrontmatterModel(content);
  return {
    assignment: getScalar(model, 'assignment'),
    body: model.body,
  };
}

export function updateScratchpadContent(
  content: string,
  updates: Partial<ScratchpadEditorState>,
): string {
  const model = parseFrontmatterModel(content);
  const next = { ...parseScratchpadEditorState(content), ...updates };

  setScalar(model, 'assignment', next.assignment);
  model.body = next.body;

  return serializeFrontmatterModel(model);
}

export function parsePlaybookEditorState(content: string): PlaybookEditorState {
  const model = parseFrontmatterModel(content);
  return {
    name: getScalar(model, 'name'),
    slug: getScalar(model, 'slug'),
    description: getScalar(model, 'description'),
    whenToUse: getScalar(model, 'when_to_use'),
    tags: getStringList(model, 'tags').join(', '),
    body: model.body,
  };
}

export function updatePlaybookContent(
  content: string,
  updates: Partial<PlaybookEditorState>,
): string {
  const model = parseFrontmatterModel(content);
  const next = { ...parsePlaybookEditorState(content), ...updates };

  setScalar(model, 'name', next.name);
  setScalar(model, 'slug', next.slug);
  setScalar(model, 'description', next.description || null);
  setScalar(model, 'when_to_use', next.whenToUse || null);
  setStringList(model, 'tags', commaListToArray(next.tags));
  model.body = next.body;

  return serializeFrontmatterModel(model);
}

export function parseMemoryEditorState(content: string): MemoryEditorState {
  const model = parseFrontmatterModel(content);
  return { body: model.body };
}

export function parseResourceEditorState(content: string): ResourceEditorState {
  return parseMemoryEditorState(content);
}

/** Body-only update — preserves frontmatter verbatim. Server enforces this; this is local parity. */
export function updateMemoryContent(
  content: string,
  updates: Partial<MemoryEditorState>,
): string {
  const model = parseFrontmatterModel(content);
  if (updates.body !== undefined) {
    model.body = updates.body;
  }
  return serializeFrontmatterModel(model);
}

export function updateResourceContent(
  content: string,
  updates: Partial<ResourceEditorState>,
): string {
  return updateMemoryContent(content, updates);
}

export function normalizeEditorContent(
  type: EditableDocumentType,
  content: string,
  updates: Record<string, string | boolean>,
): string {
  switch (type) {
    case 'project':
      return updateProjectContent(content, updates as Partial<ProjectEditorState>);
    case 'assignment':
      return updateAssignmentContent(content, updates as Partial<AssignmentEditorState>);
    case 'plan':
      return updatePlanContent(content, updates as Partial<PlanEditorState>);
    case 'scratchpad':
      return updateScratchpadContent(content, updates as Partial<ScratchpadEditorState>);
    case 'playbook':
      return updatePlaybookContent(content, updates as Partial<PlaybookEditorState>);
    case 'memory':
      return updateMemoryContent(content, updates as Partial<MemoryEditorState>);
    case 'resource':
      return updateResourceContent(content, updates as Partial<ResourceEditorState>);
    default:
      return content;
  }
}
