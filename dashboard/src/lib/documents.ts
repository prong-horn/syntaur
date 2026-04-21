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
  if (
    (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
    (rawValue.startsWith("'") && rawValue.endsWith("'"))
  ) {
    return rawValue.slice(1, -1);
  }
  return rawValue;
}

function getBoolean(model: FrontmatterModel, key: string): boolean {
  return getScalar(model, key) === 'true';
}

function getStringList(model: FrontmatterModel, key: string): string[] {
  const block = model.blocks.get(key);
  if (!block?.length) {
    return [];
  }

  if (block[0].trim().endsWith('[]')) {
    return [];
  }

  return block
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim());
}

function formatYamlValue(value: string | null | boolean): string {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (value === null || value === '') {
    return 'null';
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return `"${value}"`;
  }
  if (/[:#{}[\],&*?|>!%@`]/.test(value) || /^\s|\s$/.test(value)) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
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

  model.blocks.set(key, [`${key}:`, ...values.map((value) => `  - ${value}`)]);
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
    default:
      return content;
  }
}
