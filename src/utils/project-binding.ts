import { readFile, writeFile } from 'node:fs/promises';
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

/** Serialize a binding to frontmatter lines (empty string when nothing to
 * emit). `defaultWorkflow` is emitted only when non-null; `workflowByType` only
 * when non-empty, with keys sorted for stable output. */
function serializeBinding(binding: ProjectWorkflowBinding): string {
  const lines: string[] = [];
  if (binding.defaultWorkflow) lines.push(`defaultWorkflow: ${binding.defaultWorkflow}`);
  const types = Object.keys(binding.workflowByType).sort();
  if (types.length > 0) {
    lines.push('workflowByType:');
    for (const t of types) lines.push(`  ${t}: ${binding.workflowByType[t]}`);
  }
  return lines.join('\n');
}

/** Remove the existing `defaultWorkflow:` scalar and `workflowByType:` block
 * from a frontmatter body, leaving every other field intact. */
function stripBindingFromFrontmatter(fm: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of fm.split('\n')) {
    if (/^workflowByType:\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      if (line.length > 0 && (line[0] === ' ' || line[0] === '\t')) continue; // still inside block
      inBlock = false; // sibling key — fall through and keep it
    }
    if (/^defaultWorkflow:/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').replace(/\n+$/, '');
}

/**
 * Node-safe writer: replace a project's `defaultWorkflow` + `workflowByType`
 * binding in `<projectDir>/project.md`, preserving all other frontmatter and the
 * body. Used by `syntaur workflow bind-type` and the binding UI's server route.
 */
export async function setProjectWorkflowBinding(
  projectDir: string,
  binding: ProjectWorkflowBinding,
): Promise<void> {
  const projectMd = resolve(projectDir, 'project.md');
  const content = (await fileExists(projectMd)) ? await readFile(projectMd, 'utf-8') : '';
  const block = serializeBinding(binding);

  const fmMatch = content.match(/^(---\n)([\s\S]*?)\n(---)/);
  if (!fmMatch) {
    // No frontmatter yet — wrap the (possibly empty) body in one.
    const fmBody = block.length > 0 ? block : '';
    await writeFile(projectMd, `---\n${fmBody}\n---\n${content}`, 'utf-8');
    return;
  }

  const cleaned = stripBindingFromFrontmatter(fmMatch[2]);
  const after = content.slice(fmMatch[0].length);
  const newFm = block.length > 0 ? `${cleaned}\n${block}` : cleaned;
  await writeFile(projectMd, `---\n${newFm}\n---${after}`, 'utf-8');
}
