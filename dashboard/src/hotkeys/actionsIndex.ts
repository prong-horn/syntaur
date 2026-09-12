import type { NavigateFunction } from 'react-router-dom';
import type { PlaybookSummary } from '../types';
import { slugify } from '../lib/slug';
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

// --- Helpers used by the canonical create flows ---

interface ProjectSummaryShape {
  slug: string;
  title: string;
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

export function buildActionsIndex(input: BuildActionsInput): Action[] {
  const {
    playbooks,
    projectSlug,
    currentProjectTitle,
    refetchPlaybooks,
    navigate,
    toggleTheme,
  } = input;

  const out: Action[] = [];

  // --- Canonical (bindable) create actions ---
  // These always exist and live alongside the contextual variants below.

  out.push({
    id: 'new-project',
    title: 'New Project',
    subtitle: 'Create a project',
    group: 'Create',
    keywords: ['new', 'create', 'project'],
    bindableKind: 'new-project',
    flow: {
      steps: [
        {
          kind: 'text',
          id: 'title',
          label: 'Project title',
          placeholder: 'e.g. Marketing site rebuild',
          required: true,
        },
      ],
      submit: async (values, helpers) => {
        const title = (values.title ?? '').trim();
        if (!title) throw new Error('Title is required');
        const slug = slugify(title);
        if (!slug) throw new Error('Title must contain at least one alphanumeric character');

        let template = await fetchTemplate('/api/templates/project');
        template = setFrontmatterField(template, 'slug', slug);
        template = setFrontmatterField(template, 'title', title);

        const res = await fetch('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: template }),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(payload.error || `Failed to create project (HTTP ${res.status})`);
        }

        helpers.navigate(`/projects/${payload.slug ?? slug}`);
      },
    },
  });

  out.push({
    id: 'new-ticket',
    title: 'New Ticket',
    subtitle: 'Pick standalone or a project',
    group: 'Create',
    keywords: ['new', 'create', 'ticket'],
    bindableKind: 'new-ticket',
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
              });
            }
            return options;
          },
        },
        {
          kind: 'text',
          id: 'title',
          label: 'Ticket title',
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
          let template = await fetchTemplate('/api/templates/ticket?standalone=1');
          template = setFrontmatterField(template, 'slug', slug);
          template = setFrontmatterField(template, 'title', title);

          const res = await fetch('/api/tickets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: template }),
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            throw new Error(payload.error || `Failed to create ticket (HTTP ${res.status})`);
          }
          const id = payload?.ticket?.id ?? payload?.id;
          if (id) {
            helpers.navigate(`/t/${id}`);
          } else {
            helpers.navigate('/tickets');
          }
          return;
        }

        let template = await fetchTemplate('/api/templates/ticket');
        template = setFrontmatterField(template, 'slug', slug);
        template = setFrontmatterField(template, 'title', title);

        const res = await fetch(
          `/api/projects/${encodeURIComponent(projectChoice)}/tickets`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: template }),
          },
        );
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(payload.error || `Failed to create ticket (HTTP ${res.status})`);
        }
        const aslug = payload.slug ?? slug;
        const projectRes = await fetch(`/api/projects/${encodeURIComponent(projectChoice)}`);
        const projectPayload = await projectRes.json().catch(() => ({}));
        const created = (projectPayload.tickets as Array<{ id: string; slug: string }> | undefined)
          ?.find((ticket) => ticket.slug === aslug);
        helpers.navigate(created ? `/t/${created.id}` : `/projects/${projectChoice}`);
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
    run: () => navigate('/create/project'),
  });

  out.push({
    id: 'create-standalone-ticket',
    title: 'New Standalone Ticket (editor)',
    subtitle: 'Open the markdown editor',
    group: 'Create',
    keywords: ['new', 'create', 'ticket', 'standalone', 'one-off', 'editor'],
    run: () => navigate('/tickets/new'),
  });

  if (projectSlug) {
    out.push({
      id: `create-ticket-in-${projectSlug}`,
      title: `New Ticket in ${currentProjectTitle ?? projectSlug}`,
      subtitle: projectSlug,
      group: 'Create',
      keywords: ['new', 'create', 'ticket', projectSlug],
      run: () => navigate(`/projects/${projectSlug}/new`),
    });
  }

  out.push({
    id: 'create-playbook',
    title: 'New Playbook',
    group: 'Create',
    keywords: ['new', 'create', 'playbook'],
    run: () => navigate('/playbooks/create'),
  });

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
