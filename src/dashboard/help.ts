import type {
  HelpChecklistItem,
  HelpCommand,
  HelpResponse,
  HelpStatusGuideEntry,
} from './types.js';
import { STAGE_TABLE } from './stage-config.js';

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
    command: 'syntaur project new',
    description: 'Create a new project folder with the required source and derived files.',
    example: 'syntaur project new "Ship dashboard overhaul"',
  },
  {
    command: 'syntaur new',
    description: 'Create a new ticket inside a project.',
    example: 'syntaur new "Implement overview API" --project ui-overhaul',
  },
  {
    command: 'syntaur assign',
    description: 'Set the assignee for a ticket before work begins.',
    example: 'syntaur assign UI-1 --project ui-overhaul --agent codex-1',
  },

  // --- Lifecycle verbs ---
  {
    command: 'syntaur plan',
    description: 'Move a ticket into planning (or scaffold its plan file).',
    example: 'syntaur plan UI-1 --project ui-overhaul',
  },
  {
    command: 'syntaur approve',
    description: 'Approve the plan and move to ready when gates pass.',
    example: 'syntaur approve UI-1 --project ui-overhaul',
  },
  {
    command: 'syntaur start',
    description: 'Move a ticket to in_progress.',
    example: 'syntaur start UI-1 --project ui-overhaul',
  },
  {
    command: 'syntaur review',
    description: 'Move active work into review.',
    example: 'syntaur review UI-1 --project ui-overhaul',
  },
  {
    command: 'syntaur done',
    description: 'Mark a ticket done after review or direct completion.',
    example: 'syntaur done UI-1 --project ui-overhaul',
  },
  {
    command: 'syntaur drop',
    description: 'Drop a ticket with a required reason.',
    example: 'syntaur drop UI-1 "Out of scope" --project ui-overhaul',
  },
  {
    command: 'syntaur reopen',
    description: 'Reopen a done or dropped ticket.',
    example: 'syntaur reopen UI-1 --project ui-overhaul',
  },
  {
    command: 'syntaur block',
    description: 'Mark a ticket blocked and record the explicit reason.',
    example: 'syntaur block UI-1 --project ui-overhaul --reason "Waiting on API spec"',
  },
  {
    command: 'syntaur unblock',
    description: 'Move a blocked ticket back to in_progress after the blocker is cleared.',
    example: 'syntaur unblock UI-1 --project ui-overhaul',
  },
  {
    command: 'syntaur park',
    description: 'Park a ticket with a required reason (pauses work without dropping).',
    example: 'syntaur park UI-1 --project ui-overhaul --reason "Waiting on design"',
  },
  {
    command: 'syntaur unpark',
    description: 'Resume a parked ticket.',
    example: 'syntaur unpark UI-1 --project ui-overhaul',
  },

  // --- Dashboard (index 16) ---
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
    example: 'syntaur setup-adapter cursor --project ui-overhaul --ticket UI-1',
  },

  // --- Session & server tracking (index 17) ---
  {
    command: 'syntaur track-session',
    description:
      'Register an agent session. Requires --session-id from the agent runtime (real, not generated). Pass --transcript-path for the rollout/transcript file. --project and --ticket are optional.',
    example:
      'syntaur track-session --agent claude --session-id <real-id> --transcript-path <path> --project ui-overhaul --ticket UI-1',
  },

  // --- Playbooks (indices 18-20) ---
  {
    command: 'syntaur create-playbook',
    description: 'Create a new playbook with behavioral rules for agents.',
    example: 'syntaur create-playbook "Code Review Standards"',
  },
  {
    command: 'syntaur list-playbooks',
    description:
      'List playbooks in the Syntaur home directory. Disabled playbooks are excluded by default; pass --all to include them with a (disabled) tag.',
    example: 'syntaur list-playbooks --all',
  },
  {
    command: 'syntaur enable-playbook',
    description:
      'Re-enable a previously-disabled playbook so agents load it again. Updates config.md and rebuilds manifest.md.',
    example: 'syntaur enable-playbook commit-discipline',
  },
  {
    command: 'syntaur disable-playbook',
    description:
      'Disable a playbook so agents no longer list or load it. Playbook file is untouched; state is tracked in config.md.',
    example: 'syntaur disable-playbook commit-discipline',
  },
  {
    command: 'syntaur delete-playbook',
    description:
      'Delete a playbook from disk and regenerate the manifest. Refuses to delete the manifest itself.',
    example: 'syntaur delete-playbook scratch-foo',
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
    detail: 'Use a project for a higher-level objective. Projects group related tickets.',
    command: CLI_COMMANDS[2],
    href: '/create/project',
  },
  {
    title: 'Create the first ticket',
    detail: 'Tickets are the execution unit. Create one for each concrete chunk of work inside the project.',
    command: CLI_COMMANDS[3],
  },
  {
    title: 'Assign the work',
    detail: 'Setting an assignee before starting is recommended for clarity, but not required.',
    command: CLI_COMMANDS[4],
  },
  {
    title: 'Move tickets through lifecycle verbs',
    detail: 'Use plan, approve, start, review, and done to advance stages. Block, park, or drop when work stalls. Kanban drag-and-drop and the status pill call the same verb API.',
    command: CLI_COMMANDS[7],
  },
  {
    title: 'Use the dashboard for triage and context',
    detail: 'Overview shows the current queue, project pages show health, ticket pages show the execution surface.',
    command: CLI_COMMANDS[16],
    href: '/',
  },
];

const DEFAULT_STATUS_GUIDE: Record<string, { meaning: string; useWhen: string }> = {
  backlog: {
    meaning: 'The ticket is queued and not yet in planning.',
    useWhen: 'Use backlog for new tickets. Run `syntaur plan` when shaping or planning should begin.',
  },
  planning: {
    meaning: 'The ticket is being shaped or has a plan in progress.',
    useWhen: 'Use planning while writing or revising plan.md. Run `syntaur approve` when the plan is ready.',
  },
  ready: {
    meaning: 'The plan is approved and the ticket can start implementation.',
    useWhen: 'Use ready when dependencies are satisfied and coding can begin. Run `syntaur start` to move to in_progress.',
  },
  in_progress: {
    meaning: 'An assignee is actively working the ticket.',
    useWhen: 'Use in_progress once work has started. Run `syntaur block` if an obstacle appears.',
  },
  review: {
    meaning: 'Implementation is ready for inspection or validation.',
    useWhen: 'Use review after active work is ready to be checked. Run `syntaur done` when acceptance criteria are met.',
  },
  done: {
    meaning: 'The ticket is complete.',
    useWhen: 'Use done when the acceptance criteria are satisfied.',
  },
  dropped: {
    meaning: 'The ticket was abandoned or cannot be completed as planned.',
    useWhen: 'Use dropped with `syntaur drop` and a reason when work will not continue.',
  },
};

async function buildStatusGuide(): Promise<HelpStatusGuideEntry[]> {
  return STAGE_TABLE.map((s) => {
    const defaults = DEFAULT_STATUS_GUIDE[s.id];
    return {
      status: s.id,
      meaning: defaults?.meaning ?? `The ticket is in the "${s.label}" state.`,
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
        'The UI reads project folders, ticket files, and derived indexes from the local filesystem.',
        'Derived underscore-prefixed files are projections, not the canonical edit target.',
      ],
    },
    coreConcepts: [
      {
        term: 'Project',
        description:
          'A project is the higher-level objective. It owns tickets and project-level configuration.',
      },
      {
        term: 'Ticket',
        description:
          'A ticket is a concrete unit of execution. Ticket frontmatter is the source of truth for status, priority, assignee, and dependencies.',
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
          'The repository context for a ticket, including the repository path, worktree path, branch, and parent branch. Workspace fields connect a ticket to the code being worked on and define write boundaries.',
      },
      {
        term: 'Agent Session',
        description:
          'A tracked AI session tied to ticket work. Sessions are registered via the track-session CLI command or the Claude Code plugin and visible on the Agent Sessions page.',
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
        label: 'Ticket working files',
        files: ['the files syntaur show lists'],
        description:
          'Run syntaur show on a ticket to see which files exist for its template. The dashboard edits source markdown for files the API exposes.',
      },
      {
        label: 'Append-only logs',
        files: ['the files syntaur show lists with log or append roles'],
        description:
          'Log and append-only files preserve history. The dashboard appends new entries instead of rewriting previous ones.',
      },
      {
        label: 'Derived files',
        files: ['_status.md', '_index-tickets.md', '_index-plans.md', '_index-decisions.md'],
        description:
          'These files are read-only projections. They can lag behind source files, so the dashboard computes source-first state.',
      },
    ],
    commands: CLI_COMMANDS,
    navigation: [
      {
        label: 'Overview',
        description: 'Triage hub showing tickets that need action, recent activity, progress stats, and first-run setup guidance.',
        href: '/',
      },
      {
        label: 'Projects',
        description: 'Browse, search, filter, and sort the project directory. Create new projects and drill into individual project pages.',
        href: '/projects',
      },
      {
        label: 'Tickets',
        description: 'Cross-project kanban board of all tickets. Drag cards between columns to change status, or filter by project, assignee, or status.',
        href: '/tickets',
      },
      {
        label: 'Agent Sessions',
        description: 'Monitor which AI agents are currently working, what tickets they are linked to, and session duration. Sessions are registered via the Claude Code plugin or track-session CLI command.',
        href: '/agent-sessions',
      },
      {
        label: 'Playbooks',
        description: 'Create, browse, and edit behavioral rules that agents must follow. The playbook manifest at ~/.syntaur/playbooks/manifest.md is auto-generated for inclusion in agent instructions.',
        href: '/playbooks',
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
        description: 'The project page shows health stats, ticket list, and dependency graph.',
        href: '/projects',
      },
      {
        label: 'Ticket page',
        description: 'The ticket workspace shows lifecycle actions, plan editor, scratchpad, handoff log, decision records, and agent sessions.',
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
        question: 'Why can a ticket be pending even when nothing looks broken?',
        answer:
          'Pending often just means the work has not started yet or it is waiting on declared dependencies. Blocked is reserved for exceptional runtime obstacles that need intervention.',
      },
      {
        question: 'How do I change a ticket\'s status?',
        answer:
          'Use lifecycle CLI commands (syntaur start, syntaur complete, etc.), drag cards on the kanban board, or use the Override Status dropdown on the ticket page. Any status can be set from any other status.',
      },
      {
        question: 'How do I customize statuses?',
        answer:
          'Open the Settings page from the sidebar. You can add, remove, rename, recolor, and reorder statuses. You can also mark statuses as done states. Changes are saved to ~/.syntaur/config.md and take effect immediately across the dashboard.',
      },
      {
        question: 'What is a done state?',
        answer:
          'A done state (also called terminal status) means the ticket is finished. Done states fill the completed portion of progress bars and satisfy dependency requirements. By default, "completed" and "failed" are done states. You can configure which statuses are done states in Settings.',
      },
      {
        question: 'What are playbooks and how do I use them?',
        answer:
          'Playbooks are markdown files in ~/.syntaur/playbooks/ that define behavioral rules agents must follow. Create them via the CLI (syntaur create-playbook) or the Playbooks page. The auto-generated manifest at ~/.syntaur/playbooks/manifest.md can be included in your CLAUDE.md so agents pick up the rules.',
      },
      {
        question: 'How does agent session tracking work?',
        answer:
          'When an AI agent starts working on a ticket, it can register a session via the track-session CLI command or the Claude Code plugin\'s /track-session command. The Agent Sessions page shows active and completed sessions with their linked tickets and duration.',
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
        title: 'Create at least one ticket',
        detail: 'Break the project into executable work units with explicit priority and dependencies.',
        command: CLI_COMMANDS[2],
      },
      {
        title: 'Assign and start the first ticket',
        detail: 'Set an assignee, then start the ticket once prerequisites are complete.',
        command: CLI_COMMANDS[3],
      },
      {
        title: 'Use the ticket workspace for execution',
        detail: 'Run syntaur show on the ticket and edit only the files it lists with writer agent; use the Commands line for CLI-mediated files.',
        href: '/projects',
      },
      {
        title: 'Record handoffs and decisions without rewriting history',
        detail: 'Append new handoff and decision entries instead of editing prior entries.',
      },
      {
        title: 'Return to Overview for triage',
        detail: 'Overview surfaces the queue of tickets that need action next.',
        href: '/',
      },
    ],
    links: [
      { label: 'Overview', href: '/' },
      { label: 'Project Directory', href: '/projects' },
      { label: 'Tickets Board', href: '/tickets' },
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
