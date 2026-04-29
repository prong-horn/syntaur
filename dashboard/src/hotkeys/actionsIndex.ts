import type { NavigateFunction } from 'react-router-dom';
import type { PlaybookSummary } from '../types';
import { slugify } from '../lib/slug';
import { addTodo } from '../hooks/useTodos';
import type { BindableActionKind } from './bindableActions';

export interface FlowOption {
  value: string;
  label: string;
  hint?: string;
}

export interface TextFlowStep {
  kind: 'text';
  id: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  pattern?: { regex: RegExp; message: string };
}

export interface PickerFlowStep {
  kind: 'picker';
  id: string;
  label: string;
  /** Resolves the options. Called when the step is entered. */
  loadOptions: () => FlowOption[] | Promise<FlowOption[]>;
  emptyMessage?: string;
}

export type PaletteFlowStep = TextFlowStep | PickerFlowStep;

export interface PaletteFlowSubmitHelpers {
  navigate: NavigateFunction;
}

export interface PaletteFlow {
  steps: PaletteFlowStep[];
  submit: (
    values: Record<string, string>,
    helpers: PaletteFlowSubmitHelpers,
  ) => Promise<void>;
}

export interface Action {
  id: string;
  title: string;
  subtitle?: string;
  keywords?: string[];
  group: string;
  run?: () => void | Promise<void>;
  requiresInput?: {
    placeholder: string;
    runWithInput: (value: string) => void | Promise<void>;
  };
  flow?: PaletteFlow;
  /** When set, this action is bindable to a user-defined hotkey. */
  bindableKind?: BindableActionKind;
}

interface BuildActionsInput {
  playbooks: PlaybookSummary[];
  projectSlug: string | null;
  currentProjectTitle: string | null;
  currentProjectWorkspace: string | null;
  wsPrefix: string;
  refetchPlaybooks: () => void;
  navigate: NavigateFunction;
  toggleTheme: () => void;
}

async function togglePlaybook(
  slug: string,
  currentlyEnabled: boolean,
  refetch: () => void,
): Promise<void> {
  const action = currentlyEnabled ? 'disable' : 'enable';
  const response = await fetch(`/api/playbooks/${encodeURIComponent(slug)}/${action}`, {
    method: 'POST',
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Failed to ${action} playbook`);
  }
  refetch();
}

async function createTodo(workspace: string, description: string): Promise<void> {
  const response = await fetch(`/api/todos/${encodeURIComponent(workspace)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Failed to create todo (HTTP ${response.status})`);
  }
}

// --- Helpers used by the canonical create flows ---

interface WorkspaceListResponse {
  workspaces: string[];
  hasUngrouped: boolean;
}

interface ProjectSummaryShape {
  slug: string;
  title: string;
  workspace?: string | null;
}

async function fetchWorkspaces(): Promise<WorkspaceListResponse> {
  const res = await fetch('/api/workspaces');
  if (!res.ok) throw new Error(`Failed to load workspaces (HTTP ${res.status})`);
  const data = (await res.json()) as Partial<WorkspaceListResponse>;
  return {
    workspaces: Array.isArray(data.workspaces) ? data.workspaces : [],
    hasUngrouped: data.hasUngrouped === true,
  };
}

async function fetchProjects(): Promise<ProjectSummaryShape[]> {
  const res = await fetch('/api/projects');
  if (!res.ok) throw new Error(`Failed to load projects (HTTP ${res.status})`);
  const data = (await res.json()) as ProjectSummaryShape[];
  return Array.isArray(data) ? data : [];
}

async function fetchTemplate(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load template (HTTP ${res.status})`);
  const data = (await res.json()) as { content?: string };
  if (!data.content) throw new Error('Template returned no content');
  return data.content;
}

/**
 * Replace a top-level frontmatter scalar field. Only operates on the
 * frontmatter block at the top of a markdown document. If the field is missing
 * it is appended just before the closing `---`.
 */
function setFrontmatterField(content: string, key: string, value: string): string {
  const fmMatch = content.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!fmMatch) {
    return `---\n${key}: ${JSON.stringify(value)}\n---\n${content}`;
  }
  const fmOpen = fmMatch[1];
  const fmBody = fmMatch[2];
  const fmClose = fmMatch[3];
  const after = content.slice(fmMatch[0].length);

  const escaped = JSON.stringify(value);
  const lineRe = new RegExp(`^${key}:\\s*.*$`, 'm');
  let newBody: string;
  if (lineRe.test(fmBody)) {
    newBody = fmBody.replace(lineRe, `${key}: ${escaped}`);
  } else {
    newBody = `${fmBody}\n${key}: ${escaped}`;
  }
  return `${fmOpen}${newBody}${fmClose}${after}`;
}

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*$/;

export function buildActionsIndex(input: BuildActionsInput): Action[] {
  const {
    playbooks,
    projectSlug,
    currentProjectTitle,
    currentProjectWorkspace,
    wsPrefix,
    refetchPlaybooks,
    navigate,
    toggleTheme,
  } = input;

  const out: Action[] = [];

  // --- Canonical (bindable) create actions ---
  // These always exist and live alongside the contextual variants below.

  out.push({
    id: 'new-workspace',
    title: 'New Workspace',
    subtitle: 'Create a Syntaur workspace',
    group: 'Create',
    keywords: ['new', 'create', 'workspace'],
    bindableKind: 'new-workspace',
    flow: {
      steps: [
        {
          kind: 'text',
          id: 'name',
          label: 'Workspace name',
          placeholder: 'lowercase, hyphenated (e.g. acme-app)',
          required: true,
          pattern: {
            regex: SLUG_REGEX,
            message:
              'Use lowercase letters, digits, and hyphens (e.g. acme-app). Must start with a letter or digit.',
          },
        },
      ],
      submit: async (values, helpers) => {
        const name = (values.name ?? '').trim();
        if (!name) throw new Error('Name is required');
        const res = await fetch('/api/workspaces', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `Failed to create workspace (HTTP ${res.status})`);
        }
        helpers.navigate(`/w/${name}/projects`);
      },
    },
  });

  out.push({
    id: 'new-project',
    title: 'New Project',
    subtitle: 'Create a project (pick workspace)',
    group: 'Create',
    keywords: ['new', 'create', 'project'],
    bindableKind: 'new-project',
    flow: {
      steps: [
        {
          kind: 'picker',
          id: 'workspace',
          label: 'Workspace',
          emptyMessage: 'No workspaces yet — create one with "New Workspace"',
          loadOptions: async () => {
            const { workspaces, hasUngrouped } = await fetchWorkspaces();
            const options: FlowOption[] = [
              { value: '_ungrouped', label: 'Ungrouped', hint: 'no workspace' },
            ];
            for (const ws of workspaces) {
              options.push({ value: ws, label: ws, hint: 'workspace' });
            }
            // hasUngrouped is informational; ungrouped is always offered.
            void hasUngrouped;
            return options;
          },
        },
        {
          kind: 'text',
          id: 'title',
          label: 'Project title',
          placeholder: 'e.g. Marketing site rebuild',
          required: true,
        },
      ],
      submit: async (values, helpers) => {
        const workspace = (values.workspace ?? '').trim();
        const title = (values.title ?? '').trim();
        if (!title) throw new Error('Title is required');
        const slug = slugify(title);
        if (!slug) throw new Error('Title must contain at least one alphanumeric character');

        let template = await fetchTemplate('/api/templates/project');
        template = setFrontmatterField(template, 'slug', slug);
        template = setFrontmatterField(template, 'title', title);
        if (workspace && workspace !== '_ungrouped') {
          template = setFrontmatterField(template, 'workspace', workspace);
        }

        const res = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: template }),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(payload.error || `Failed to create project (HTTP ${res.status})`);
        }

        const navTarget =
          workspace && workspace !== '_ungrouped'
            ? `/w/${workspace}/projects/${payload.slug ?? slug}`
            : `/projects/${payload.slug ?? slug}`;
        helpers.navigate(navTarget);
      },
    },
  });

  out.push({
    id: 'new-todo',
    title: 'New Todo',
    subtitle: 'Pick scope (global / workspace / project)',
    group: 'Create',
    keywords: ['new', 'create', 'todo', 'task'],
    bindableKind: 'new-todo',
    flow: {
      steps: [
        {
          kind: 'picker',
          id: 'scope',
          label: 'Scope',
          loadOptions: async () => {
            const [{ workspaces }, projects] = await Promise.all([
              fetchWorkspaces(),
              fetchProjects(),
            ]);
            const options: FlowOption[] = [
              { value: '_ungrouped', label: 'Global', hint: 'no workspace' },
            ];
            for (const ws of workspaces) {
              options.push({ value: ws, label: ws, hint: 'workspace' });
            }
            for (const p of projects) {
              const target = p.workspace ?? '_ungrouped';
              options.push({
                value: target,
                label: `${p.title}`,
                hint: `project · ${p.workspace ?? 'ungrouped'}`,
              });
            }
            return options;
          },
        },
        {
          kind: 'text',
          id: 'description',
          label: 'Description',
          placeholder: 'Describe the todo…',
          required: true,
        },
      ],
      submit: async (values) => {
        const scope = (values.scope ?? '_ungrouped').trim() || '_ungrouped';
        const description = (values.description ?? '').trim();
        if (!description) throw new Error('Description is required');
        await addTodo(scope, description);
      },
    },
  });

  out.push({
    id: 'new-assignment',
    title: 'New Assignment',
    subtitle: 'Pick standalone or a project',
    group: 'Create',
    keywords: ['new', 'create', 'assignment'],
    bindableKind: 'new-assignment',
    flow: {
      steps: [
        {
          kind: 'picker',
          id: 'project',
          label: 'Project',
          loadOptions: async () => {
            const projects = await fetchProjects();
            const options: FlowOption[] = [
              { value: '_standalone', label: 'Standalone', hint: 'one-off / not in a project' },
            ];
            for (const p of projects) {
              options.push({
                value: p.slug,
                label: p.title,
                hint: p.workspace ? `workspace · ${p.workspace}` : 'ungrouped',
              });
            }
            return options;
          },
        },
        {
          kind: 'text',
          id: 'title',
          label: 'Assignment title',
          placeholder: 'What needs to get done?',
          required: true,
        },
      ],
      submit: async (values, helpers) => {
        const projectChoice = (values.project ?? '_standalone').trim() || '_standalone';
        const title = (values.title ?? '').trim();
        if (!title) throw new Error('Title is required');
        const slug = slugify(title);
        if (!slug) throw new Error('Title must contain at least one alphanumeric character');

        if (projectChoice === '_standalone') {
          let template = await fetchTemplate('/api/templates/assignment?standalone=1');
          template = setFrontmatterField(template, 'slug', slug);
          template = setFrontmatterField(template, 'title', title);

          const res = await fetch('/api/assignments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: template }),
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            throw new Error(payload.error || `Failed to create assignment (HTTP ${res.status})`);
          }
          const id = payload?.assignment?.id ?? payload?.id;
          if (id) {
            helpers.navigate(`/assignments/${id}`);
          } else {
            helpers.navigate('/assignments');
          }
          return;
        }

        let template = await fetchTemplate('/api/templates/assignment');
        template = setFrontmatterField(template, 'slug', slug);
        template = setFrontmatterField(template, 'title', title);

        const res = await fetch(
          `/api/projects/${encodeURIComponent(projectChoice)}/assignments`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: template }),
          },
        );
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(payload.error || `Failed to create assignment (HTTP ${res.status})`);
        }
        const aslug = payload.slug ?? slug;
        helpers.navigate(`/projects/${projectChoice}/assignments/${aslug}`);
      },
    },
  });

  // --- Existing route-based + contextual variants (unchanged) ---

  out.push({
    id: 'create-project-route',
    title: 'New Project (advanced editor)',
    subtitle: 'Open the markdown editor',
    group: 'Create',
    keywords: ['new', 'create', 'project', 'advanced', 'editor'],
    run: () => navigate(`${wsPrefix}/create/project`),
  });

  out.push({
    id: 'create-standalone-assignment',
    title: 'New Standalone Assignment (editor)',
    subtitle: 'Open the markdown editor',
    group: 'Create',
    keywords: ['new', 'create', 'assignment', 'standalone', 'one-off', 'editor'],
    run: () => navigate(`${wsPrefix}/assignments/new`),
  });

  if (projectSlug) {
    out.push({
      id: `create-assignment-in-${projectSlug}`,
      title: `New Assignment in ${currentProjectTitle ?? projectSlug}`,
      subtitle: projectSlug,
      group: 'Create',
      keywords: ['new', 'create', 'assignment', projectSlug],
      run: () => navigate(`${wsPrefix}/projects/${projectSlug}/create/assignment`),
    });
  }

  out.push({
    id: 'create-playbook',
    title: 'New Playbook',
    group: 'Create',
    keywords: ['new', 'create', 'playbook'],
    run: () => navigate('/playbooks/create'),
  });

  out.push({
    id: 'create-todo-global',
    title: 'New Todo (global, quick)',
    subtitle: 'Ungrouped, single-step',
    group: 'Create',
    keywords: ['new', 'create', 'todo', 'global', 'ungrouped', 'quick'],
    requiresInput: {
      placeholder: 'Describe the todo…',
      runWithInput: async (value) => {
        const desc = value.trim();
        if (!desc) return;
        await createTodo('_ungrouped', desc);
      },
    },
  });

  if (wsPrefix) {
    const wsName = wsPrefix.replace(/^\/w\//, '');
    out.push({
      id: `create-todo-workspace-${wsName}`,
      title: `New Todo in workspace ${wsName}`,
      subtitle: wsName,
      group: 'Create',
      keywords: ['new', 'create', 'todo', 'workspace', wsName],
      requiresInput: {
        placeholder: `Describe the todo for workspace ${wsName}…`,
        runWithInput: async (value) => {
          const desc = value.trim();
          if (!desc) return;
          await createTodo(wsName, desc);
        },
      },
    });
  }

  if (projectSlug && currentProjectWorkspace) {
    out.push({
      id: `create-todo-project-${projectSlug}`,
      title: `New Todo in project ${currentProjectTitle ?? projectSlug}`,
      subtitle: `${projectSlug} · workspace ${currentProjectWorkspace}`,
      group: 'Create',
      keywords: ['new', 'create', 'todo', 'project', projectSlug, currentProjectWorkspace],
      requiresInput: {
        placeholder: `Describe the todo for project ${currentProjectTitle ?? projectSlug}…`,
        runWithInput: async (value) => {
          const desc = value.trim();
          if (!desc) return;
          await createTodo(currentProjectWorkspace, desc);
        },
      },
    });
  }

  // --- Toggle group ---

  for (const p of playbooks) {
    out.push({
      id: `toggle-playbook-${p.slug}`,
      title: `Toggle Playbook: ${p.name}`,
      subtitle: p.enabled ? 'enabled' : 'disabled',
      group: 'Toggle',
      keywords: ['toggle', 'playbook', p.slug, ...(p.tags ?? [])],
      run: () => togglePlaybook(p.slug, p.enabled, refetchPlaybooks),
    });
  }

  // --- Theme group ---

  out.push({
    id: 'toggle-theme',
    title: 'Toggle theme',
    subtitle: 'Light / dark',
    group: 'Theme',
    keywords: ['theme', 'toggle', 'light', 'dark', 'appearance'],
    run: () => toggleTheme(),
  });

  return out;
}
