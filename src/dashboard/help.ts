import type {
  HelpChecklistItem,
  HelpCommand,
  HelpResponse,
  HelpStatusGuideEntry,
} from './types.js';
import { getStatusConfig } from './api.js';

const CLI_COMMANDS: HelpCommand[] = [
  // --- Core setup & scaffolding (indices 0-4) ---
  {
    command: 'syntaur setup',
    description: 'Initialize Syntaur and optionally install plugins or launch the dashboard.',
    example: 'syntaur setup',
  },
  {
    command: 'syntaur init',
    description: 'Initialize the local Syntaur home directory and config scaffolding without any prompts.',
    example: 'syntaur init',
  },
  {
    command: 'syntaur create-project',
    description: 'Create a new project folder with the required source and derived files.',
    example: 'syntaur create-project "Ship dashboard overhaul"',
  },
  {
    command: 'syntaur create-assignment',
    description: 'Create a new assignment inside a project.',
    example: 'syntaur create-assignment "Implement overview API" --project ui-overhaul',
  },
  {
    command: 'syntaur assign',
    description: 'Set the assignee for an assignment before work begins.',
    example: 'syntaur assign implement-overview --project ui-overhaul --agent codex-1',
  },

  // --- Lifecycle transitions (indices 5-11) ---
  {
    command: 'syntaur start',
    description: 'Transition an assignment to in_progress.',
    example: 'syntaur start implement-overview --project ui-overhaul',
  },
  {
    command: 'syntaur review',
    description: 'Move active work into review once implementation is ready for inspection.',
    example: 'syntaur review implement-overview --project ui-overhaul',
  },
  {
    command: 'syntaur complete',
    description: 'Mark an assignment completed after review or direct completion.',
    example: 'syntaur complete implement-overview --project ui-overhaul',
  },
  {
    command: 'syntaur block',
    description: 'Mark an assignment blocked and record the explicit reason.',
    example: 'syntaur block implement-overview --project ui-overhaul --reason "Waiting on API spec"',
  },
  {
    command: 'syntaur unblock',
    description: 'Move a blocked assignment back to in_progress after the blocker is cleared.',
    example: 'syntaur unblock implement-overview --project ui-overhaul',
  },
  {
    command: 'syntaur fail',
    description: 'Mark an assignment failed when it cannot be completed as planned.',
    example: 'syntaur fail implement-overview --project ui-overhaul',
  },
  {
    command: 'syntaur reopen',
    description: 'Reopen a completed or failed assignment back to in_progress.',
    example: 'syntaur reopen implement-overview --project ui-overhaul',
  },

  // --- Dashboard (index 12) ---
  {
    command: 'syntaur dashboard',
    description: 'Start the local dashboard UI over the project files on disk.',
    example: 'syntaur dashboard --port 4800',
  },

  // --- Plugin & adapter setup (indices 13-16) ---
  {
    command: 'syntaur install-plugin',
    description: 'Install the Syntaur Claude Code plugin, detecting the local Claude marketplace when available and prompting for the target directory when interactive.',
    example: 'syntaur install-plugin --target-dir ~/.claude/plugins/marketplaces/user-plugins/plugins/syntaur',
  },
  {
    command: 'syntaur install-codex-plugin',
    description: 'Install the Syntaur Codex plugin and register its marketplace entry, prompting for both paths when interactive.',
    example: 'syntaur install-codex-plugin --target-dir ~/plugins/syntaur --marketplace-path ~/.agents/plugins/marketplace.json',
  },
  {
    command: 'syntaur uninstall',
    description: 'Remove Syntaur plugins and optionally local ~/.syntaur data.',
    example: 'syntaur uninstall --all',
  },
  {
    command: 'syntaur setup-adapter',
    description: 'Generate adapter instruction files for cursor, codex, or opencode in the current directory.',
    example: 'syntaur setup-adapter cursor --project ui-overhaul --assignment implement-overview',
  },

  // --- Session & server tracking (index 17) ---
  {
    command: 'syntaur track-session',
    description:
      'Register an agent session. Requires --session-id from the agent runtime (real, not generated). Pass --transcript-path for the rollout/transcript file. --project and --assignment are optional.',
    example:
      'syntaur track-session --agent claude --session-id <real-id> --transcript-path <path> --project ui-overhaul --assignment implement-overview',
  },

  // --- Browsing & playbooks (indices 18-20) ---
  {
    command: 'syntaur browse',
    description: 'Interactive TUI browser for projects and assignments.',
    example: 'syntaur browse',
  },
  {
    command: 'syntaur create-playbook',
    description: 'Create a new playbook with behavioral rules for agents.',
    example: 'syntaur create-playbook "Code Review Standards"',
  },
  {
    command: 'syntaur list-playbooks',
    description: 'List all playbooks in the Syntaur home directory.',
    example: 'syntaur list-playbooks',
  },
];

const WORKFLOW: HelpChecklistItem[] = [
  {
    title: 'Initialize the workspace',
    detail: 'Run setup once so Syntaur can initialize its local home directory and offer plugin installation.',
    command: CLI_COMMANDS[0],
  },
  {
    title: 'Create a project',
    detail: 'Use a project for a higher-level objective. Projects group assignments, shared resources, and memories.',
    command: CLI_COMMANDS[2],
    href: '/create/project',
  },
  {
    title: 'Create the first assignment',
    detail: 'Assignments are the execution unit. Create one for each concrete chunk of work inside the project.',
    command: CLI_COMMANDS[3],
  },
  {
    title: 'Assign the work',
    detail: 'Setting an assignee before starting is recommended for clarity, but not required.',
    command: CLI_COMMANDS[4],
  },
  {
    title: 'Start, review, complete, or block through lifecycle actions',
    detail: 'Status changes happen through lifecycle actions, kanban drag-and-drop, or the status override controls.',
    command: CLI_COMMANDS[5],
  },
  {
    title: 'Use the dashboard for triage and context',
    detail: 'Overview shows the current queue, project pages show health, assignment pages show the execution surface.',
    command: CLI_COMMANDS[12],
    href: '/',
  },
];

const DEFAULT_STATUS_GUIDE: Record<string, { meaning: string; useWhen: string }> = {
  pending: {
    meaning: 'The assignment has not started yet.',
    useWhen: 'Use pending while waiting to start. If dependencies are unmet, pending is the normal waiting state.',
  },
  in_progress: {
    meaning: 'An assigned agent is actively working the assignment.',
    useWhen: 'Use in_progress once the work has started and dependencies are satisfied.',
  },
  blocked: {
    meaning: 'The assignment hit a manual or runtime obstacle.',
    useWhen: 'Use blocked when work hits an obstacle. Adding a blockedReason is recommended for traceability.',
  },
  review: {
    meaning: 'Implementation is ready for inspection or validation.',
    useWhen: 'Use review after active work is ready to be checked before completion.',
  },
  completed: {
    meaning: 'The assignment is done.',
    useWhen: 'Use completed when the acceptance criteria are satisfied.',
  },
  failed: {
    meaning: 'The assignment could not be completed as planned.',
    useWhen: 'Use failed when the work cannot be recovered within the current assignment.',
  },
};

async function buildStatusGuide(): Promise<HelpStatusGuideEntry[]> {
  const config = await getStatusConfig();

  return config.statuses.map((s) => {
    const defaults = DEFAULT_STATUS_GUIDE[s.id];
    return {
      status: s.id,
      meaning: s.description ?? defaults?.meaning ?? `The assignment is in the "${s.label}" state.`,
      useWhen: defaults?.useWhen ?? `Use ${s.id} when appropriate for the "${s.label}" workflow state.`,
    };
  });
}

export async function getDashboardHelp(): Promise<HelpResponse> {
  return {
    generatedAt: new Date().toISOString(),
    whatIsSyntaur: {
      summary:
        'Syntaur is a local-first, markdown-backed agent work system. The dashboard is a live view over project folders and files on disk.',
      bullets: [
        'Markdown files are the source of truth.',
        'The UI reads project folders, assignment files, and derived indexes from the local filesystem.',
        'Derived underscore-prefixed files are projections, not the canonical edit target.',
      ],
    },
    coreConcepts: [
      {
        term: 'Project',
        description:
          'A project is the higher-level objective. It owns assignments, shared resources, and project memories.',
      },
      {
        term: 'Assignment',
        description:
          'An assignment is a concrete unit of execution. Assignment frontmatter is the source of truth for status, priority, assignee, and dependencies.',
      },
      {
        term: 'Resource',
        description:
          'A project-level shared reference file that provides source material or constraints for the work.',
      },
      {
        term: 'Memory',
        description:
          'A project-level learning or pattern captured during execution so future assignments can reuse it.',
      },
      {
        term: 'Manifest',
        description:
          'A derived navigation file that points agents at the project overview, indexes, and agent instructions.',
      },
      {
        term: 'Derived file',
        description:
          'An underscore-prefixed file regenerated from canonical markdown sources. Read it, but do not edit it directly.',
      },
      {
        term: 'Handoff',
        description:
          'An append-only log that records baton-passes between agents or sessions without rewriting prior history.',
      },
      {
        term: 'Decision record',
        description:
          'An append-only record of important decisions, rationale, and follow-up consequences.',
      },
      {
        term: 'Playbook',
        description:
          'A behavioral rule set stored in ~/.syntaur/playbooks/. Playbooks define constraints and conventions that agents must follow during execution. Manage them via the CLI or the Playbooks page.',
      },
      {
        term: 'Workspace',
        description:
          'The repository context for an assignment, including the repository path, worktree path, branch, and parent branch. Workspace fields connect an assignment to the code being worked on and define write boundaries.',
      },
      {
        term: 'Agent Session',
        description:
          'A tracked AI session tied to assignment work. Sessions are registered via the track-session CLI command or the Claude Code plugin and visible on the Agent Sessions page.',
      },
      {
        term: 'Server',
        description:
          'A tracked tmux session with automatic port discovery, branch detection, and assignment linking. The Servers page shows all tracked sessions with their windows, panes, and discovered services.',
      },
    ],
    workflow: WORKFLOW,
    statusGuide: await buildStatusGuide(),
    ownershipRules: [
      {
        label: 'Human-authored files',
        files: ['project.md', 'agent.md', 'claude.md'],
        description:
          'These files define project intent and instructions. The dashboard treats project status as derived except for the archive fields.',
      },
      {
        label: 'Assignment working files',
        files: ['assignment.md', 'plan*.md (optional, versioned)', 'scratchpad.md'],
        description:
          'These are agent-writable files. The dashboard lets you edit the source markdown while preserving unsupported frontmatter keys.',
      },
      {
        label: 'Append-only logs',
        files: ['handoff.md', 'decision-record.md'],
        description:
          'These logs preserve history. The dashboard appends new entries instead of rewriting previous ones.',
      },
      {
        label: 'Derived files',
        files: ['_status.md', '_index-assignments.md', '_index-plans.md', '_index-decisions.md'],
        description:
          'These files are read-only projections. They can lag behind source files, so the dashboard computes source-first state.',
      },
    ],
    commands: CLI_COMMANDS,
    navigation: [
      {
        label: 'Overview',
        description: 'Triage hub showing current attention items, recent activity, progress stats, and first-run setup guidance.',
        href: '/',
      },
      {
        label: 'Projects',
        description: 'Browse, search, filter, and sort the project directory. Create new projects and drill into project workspaces.',
        href: '/projects',
      },
      {
        label: 'Assignments',
        description: 'Cross-project kanban board of all assignments. Drag cards between columns to change status, or filter by project, assignee, or status.',
        href: '/assignments',
      },
      {
        label: 'Servers',
        description: 'Tracked tmux sessions with auto-discovered ports, URLs, git branches, and links to related assignments. Register sessions manually or let autodiscovery find them.',
        href: '/servers',
      },
      {
        label: 'Agent Sessions',
        description: 'Monitor which AI agents are currently working, what assignments they are linked to, and session duration. Sessions are registered via the Claude Code plugin or track-session CLI command.',
        href: '/agent-sessions',
      },
      {
        label: 'Playbooks',
        description: 'Create, browse, and edit behavioral rules that agents must follow. The playbook manifest at ~/.syntaur/playbooks/manifest.md is auto-generated for inclusion in agent instructions.',
        href: '/playbooks',
      },
      {
        label: 'Attention',
        description: 'Focused queue of assignments that need action: blocked, failed, in review, stale, or with unmet dependencies.',
        href: '/attention',
      },
      {
        label: 'Help',
        description: 'This page. Status guide, CLI quick reference, core concepts, and FAQ.',
        href: '/help',
      },
      {
        label: 'Settings',
        description: 'Customize status definitions, labels, colors, display order, and done states. Changes apply globally across the dashboard and CLI.',
        href: '/settings',
      },
      {
        label: 'Project page',
        description: 'The project workspace shows health stats, assignment list, dependency graph, shared resources, and memories.',
        href: '/projects',
      },
      {
        label: 'Assignment page',
        description: 'The assignment workspace shows lifecycle actions, plan editor, scratchpad, handoff log, decision records, and agent sessions.',
        href: '/projects',
      },
    ],
    faq: [
      {
        question: 'Why are some files read-only in the dashboard?',
        answer:
          'Underscore-prefixed files are derived projections that can be rebuilt from canonical markdown sources. Editing them would create drift, so the UI treats them as read-only.',
      },
      {
        question: 'Why can an assignment be pending even when nothing looks broken?',
        answer:
          'Pending often just means the work has not started yet or it is waiting on declared dependencies. Blocked is reserved for exceptional runtime obstacles that need intervention.',
      },
      {
        question: 'How do I change an assignment\'s status?',
        answer:
          'Use lifecycle CLI commands (syntaur start, syntaur complete, etc.), drag cards on the kanban board, or use the Override Status dropdown on the assignment page. Any status can be set from any other status.',
      },
      {
        question: 'How do I customize statuses?',
        answer:
          'Open the Settings page from the sidebar. You can add, remove, rename, recolor, and reorder statuses. You can also mark statuses as done states. Changes are saved to ~/.syntaur/config.md and take effect immediately across the dashboard.',
      },
      {
        question: 'What is a done state?',
        answer:
          'A done state (also called terminal status) means the assignment is finished. Done states fill the completed portion of progress bars and satisfy dependency requirements. By default, "completed" and "failed" are done states. You can configure which statuses are done states in Settings.',
      },
      {
        question: 'What are playbooks and how do I use them?',
        answer:
          'Playbooks are markdown files in ~/.syntaur/playbooks/ that define behavioral rules agents must follow. Create them via the CLI (syntaur create-playbook) or the Playbooks page. The auto-generated manifest at ~/.syntaur/playbooks/manifest.md can be included in your CLAUDE.md so agents pick up the rules.',
      },
      {
        question: 'How does agent session tracking work?',
        answer:
          'When an AI agent starts working on an assignment, it can register a session via the track-session CLI command or the Claude Code plugin\'s /track-session command. The Agent Sessions page shows active and completed sessions with their linked assignments and duration.',
      },
      {
        question: 'How does server tracking work?',
        answer:
          'Syntaur tracks tmux sessions to discover running dev servers, their ports, git branches, and linked assignments. Register sessions on the Servers page or let autodiscovery find them. Pane info refreshes automatically.',
      },
    ],
    firstProjectChecklist: [
      {
        title: 'Create the project',
        detail: 'Describe the overall objective in project.md, then add tags and archive metadata only when needed.',
        command: CLI_COMMANDS[1],
        href: '/create/project',
      },
      {
        title: 'Create at least one assignment',
        detail: 'Break the project into executable work units with explicit priority and dependencies.',
        command: CLI_COMMANDS[2],
      },
      {
        title: 'Assign and start the first assignment',
        detail: 'Set an assignee, then start the assignment once prerequisites are complete.',
        command: CLI_COMMANDS[3],
      },
      {
        title: 'Use the assignment workspace for execution',
        detail: 'Keep the objective and todos in assignment.md, implementation plans in optional versioned plan files (plan.md, plan-v2.md, ...), and transient notes in scratchpad.md.',
        href: '/projects',
      },
      {
        title: 'Record handoffs and decisions without rewriting history',
        detail: 'Append new handoff and decision entries instead of editing prior entries.',
      },
      {
        title: 'Return to Overview for triage',
        detail: 'Overview and Attention show the queue that needs action next.',
        href: '/',
      },
    ],
    links: [
      { label: 'Overview', href: '/' },
      { label: 'Project Directory', href: '/projects' },
      { label: 'Assignments Board', href: '/assignments' },
      { label: 'Attention Queue', href: '/attention' },
      { label: 'Servers', href: '/servers' },
      { label: 'Agent Sessions', href: '/agent-sessions' },
      { label: 'Playbooks', href: '/playbooks' },
      { label: 'Settings', href: '/settings' },
      { label: 'Create Project', href: '/create/project' },
    ],
  };
}

export function getHelpCommandNames(): string[] {
  return CLI_COMMANDS.map((command) => command.command.replace(/^syntaur\s+/, ''));
}
