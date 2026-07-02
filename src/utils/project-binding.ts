import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileExists } from './fs.js';

/**
 * Node-safe reader for a project's workflow binding (`defaultWorkflow` scalar +
 * `workflowByType` map) from its `project.md` frontmatter.
 *
 * Lifecycle / CLI / doctor code cannot import the dashboard parser (`dashboard/`
 * is unreachable from there), so this is a small self-contained parser — no
 * `dashboard/` imports, independently tested — used by recompute/doctor/CLI and
 * the central `resolveAssignmentWorkflowContext` helper.
 */
export interface ProjectWorkflowBinding {
  defaultWorkflow: string | null;
  workflowByType: Record<string, string>;
}

const EMPTY_BINDING: ProjectWorkflowBinding = { defaultWorkflow: null, workflowByType: {} };

/** Strip surrounding matched quotes and treat `null`/`~`/empty as null. */
function parseScalar(raw: string): string | null {
  const t = raw.trim();
  if (t === '' || t === 'null' || t === '~') return null;
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Read `<projectDir>/project.md` and extract the workflow binding. Missing file,
 * missing frontmatter, or absent fields all yield the empty binding
 * (`{ defaultWorkflow: null, workflowByType: {} }`) — callers then resolve via
 * the global default.
 */
export async function readProjectBinding(projectDir: string): Promise<ProjectWorkflowBinding> {
  const projectMd = resolve(projectDir, 'project.md');
  if (!(await fileExists(projectMd))) return { ...EMPTY_BINDING, workflowByType: {} };

  let content: string;
  try {
    content = await readFile(projectMd, 'utf-8');
  } catch {
    return { ...EMPTY_BINDING, workflowByType: {} };
  }

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return { ...EMPTY_BINDING, workflowByType: {} };
  const fm = fmMatch[1];

  // defaultWorkflow scalar
  const defaultMatch = fm.match(/^defaultWorkflow:\s*(.*)$/m);
  const defaultWorkflow = defaultMatch ? parseScalar(defaultMatch[1]) : null;

  // workflowByType map — indented `type: workflow` lines under the block header,
  // ending at the next top-level (non-indented) key.
  const workflowByType: Record<string, string> = {};
  const headerMatch = fm.match(/^workflowByType:\s*$/m);
  if (headerMatch) {
    const start = (headerMatch.index ?? fm.indexOf(headerMatch[0])) + headerMatch[0].length + 1;
    for (const line of fm.slice(start).split('\n')) {
      if (line.length === 0) continue;
      if (line[0] !== ' ' && line[0] !== '\t') break; // sibling top-level key
      const colonIdx = line.indexOf(':');
      if (colonIdx < 0) continue;
      const key = line.slice(0, colonIdx).trim();
      if (!key) continue;
      const value = parseScalar(line.slice(colonIdx + 1));
      if (value !== null) workflowByType[key] = value;
    }
  }

  return { defaultWorkflow, workflowByType };
}
