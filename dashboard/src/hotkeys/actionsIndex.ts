import type { NavigateFunction } from 'react-router-dom';
import type { PlaybookSummary } from '../types';

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

  // --- Create group ---

  out.push({
    id: 'create-project',
    title: 'New Project',
    group: 'Create',
    keywords: ['new', 'create', 'project'],
    run: () => navigate(`${wsPrefix}/create/project`),
  });

  out.push({
    id: 'create-standalone-assignment',
    title: 'New Standalone Assignment',
    subtitle: 'Not attached to a project',
    group: 'Create',
    keywords: ['new', 'create', 'assignment', 'standalone', 'one-off'],
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
    title: 'New Todo (global)',
    subtitle: 'Ungrouped',
    group: 'Create',
    keywords: ['new', 'create', 'todo', 'global', 'ungrouped'],
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
