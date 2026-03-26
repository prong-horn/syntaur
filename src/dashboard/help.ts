import type {
  HelpChecklistItem,
  HelpCommand,
  HelpResponse,
} from './types.js';

const CLI_COMMANDS: HelpCommand[] = [
  {
    command: 'syntaur init',
    description: 'Initialize the local Syntaur home directory and config scaffolding.',
    example: 'syntaur init',
  },
  {
    command: 'syntaur create-mission',
    description: 'Create a new mission folder with the required source and derived files.',
    example: 'syntaur create-mission "Ship dashboard overhaul"',
  },
  {
    command: 'syntaur create-assignment',
    description: 'Create a new assignment inside a mission.',
    example: 'syntaur create-assignment "Implement overview API" --mission ui-overhaul',
  },
  {
    command: 'syntaur assign',
    description: 'Set the assignee for an assignment before work begins.',
    example: 'syntaur assign implement-overview --mission ui-overhaul --agent codex-1',
  },
  {
    command: 'syntaur start',
    description: 'Transition an assignment from pending to in_progress when dependencies are satisfied.',
    example: 'syntaur start implement-overview --mission ui-overhaul',
  },
  {
    command: 'syntaur review',
    description: 'Move active work into review once implementation is ready for inspection.',
    example: 'syntaur review implement-overview --mission ui-overhaul',
  },
  {
    command: 'syntaur complete',
    description: 'Mark an assignment completed after review or direct completion.',
    example: 'syntaur complete implement-overview --mission ui-overhaul',
  },
  {
    command: 'syntaur block',
    description: 'Mark an assignment blocked and record the explicit reason.',
    example: 'syntaur block implement-overview --mission ui-overhaul --reason "Waiting on API spec"',
  },
  {
    command: 'syntaur unblock',
    description: 'Move a blocked assignment back to in_progress after the blocker is cleared.',
    example: 'syntaur unblock implement-overview --mission ui-overhaul',
  },
  {
    command: 'syntaur fail',
    description: 'Mark an assignment failed when it cannot be completed as planned.',
    example: 'syntaur fail implement-overview --mission ui-overhaul',
  },
  {
    command: 'syntaur dashboard',
    description: 'Start the local dashboard UI over the mission files on disk.',
    example: 'syntaur dashboard --port 4800',
  },
];

const WORKFLOW: HelpChecklistItem[] = [
  {
    title: 'Initialize the workspace',
    detail: 'Run the init command once so Syntaur has its local home directory and config scaffolding.',
    command: CLI_COMMANDS[0],
  },
  {
    title: 'Create a mission',
    detail: 'Use a mission for a higher-level objective. Missions group assignments, shared resources, and memories.',
    command: CLI_COMMANDS[1],
    href: '/create/mission',
  },
  {
    title: 'Create the first assignment',
    detail: 'Assignments are the execution unit. Create one for each concrete chunk of work inside the mission.',
    command: CLI_COMMANDS[2],
  },
  {
    title: 'Assign the work',
    detail: 'Setting an assignee before starting is recommended for clarity, but not required.',
    command: CLI_COMMANDS[3],
  },
  {
    title: 'Start, review, complete, or block through lifecycle actions',
    detail: 'Status changes happen through lifecycle actions, kanban drag-and-drop, or the status override controls.',
    command: CLI_COMMANDS[4],
  },
  {
    title: 'Use the dashboard for triage and context',
    detail: 'Overview shows the current queue, mission pages show health, assignment pages show the execution surface.',
    command: CLI_COMMANDS[10],
    href: '/',
  },
];

export function getDashboardHelp(): HelpResponse {
  return {
    generatedAt: new Date().toISOString(),
    whatIsSyntaur: {
      summary:
        'Syntaur is a local-first, markdown-backed agent work system. The dashboard is a live view over mission folders and files on disk.',
      bullets: [
        'Markdown files are the source of truth.',
        'The UI reads mission folders, assignment files, and derived indexes from the local filesystem.',
        'Derived underscore-prefixed files are projections, not the canonical edit target.',
      ],
    },
    coreConcepts: [
      {
        term: 'Mission',
        description:
          'A mission is the higher-level objective. It owns assignments, shared resources, and mission memories.',
      },
      {
        term: 'Assignment',
        description:
          'An assignment is a concrete unit of execution. Assignment frontmatter is the source of truth for status, priority, assignee, and dependencies.',
      },
      {
        term: 'Resource',
        description:
          'A mission-level shared reference file that provides source material or constraints for the work.',
      },
      {
        term: 'Memory',
        description:
          'A mission-level learning or pattern captured during execution so future assignments can reuse it.',
      },
      {
        term: 'Manifest',
        description:
          'A derived navigation file that points agents at the mission overview, indexes, and agent instructions.',
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
    ],
    workflow: WORKFLOW,
    statusGuide: [
      {
        status: 'pending',
        meaning: 'The assignment has not started yet.',
        useWhen:
          'Use pending while waiting to start. If dependencies are unmet, pending is the normal waiting state.',
      },
      {
        status: 'in_progress',
        meaning: 'An assigned agent is actively working the assignment.',
        useWhen: 'Use in_progress once the work has started and dependencies are satisfied.',
      },
      {
        status: 'blocked',
        meaning: 'The assignment hit a manual or runtime obstacle.',
        useWhen:
          'Use blocked when work hits an obstacle. Adding a blockedReason is recommended for traceability.',
      },
      {
        status: 'review',
        meaning: 'Implementation is ready for inspection or validation.',
        useWhen: 'Use review after active work is ready to be checked before completion.',
      },
      {
        status: 'completed',
        meaning: 'The assignment is done.',
        useWhen: 'Use completed when the acceptance criteria are satisfied.',
      },
      {
        status: 'failed',
        meaning: 'The assignment could not be completed as planned.',
        useWhen: 'Use failed when the work cannot be recovered within the current assignment.',
      },
    ],
    ownershipRules: [
      {
        label: 'Human-authored files',
        files: ['mission.md', 'agent.md', 'claude.md'],
        description:
          'These files define mission intent and instructions. The dashboard treats mission status as derived except for the archive fields.',
      },
      {
        label: 'Assignment working files',
        files: ['assignment.md', 'plan.md', 'scratchpad.md'],
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
        description: 'Use Overview for triage, current attention items, recent activity, and first-run setup guidance.',
        href: '/',
      },
      {
        label: 'Missions',
        description: 'Use the mission directory to browse, search, filter, and sort the work.',
        href: '/missions',
      },
      {
        label: 'Attention',
        description: 'Use the attention queue to focus on blocked, failed, review, or stale assignments.',
        href: '/attention',
      },
      {
        label: 'Mission page',
        description: 'Use the mission workspace for health, assignments, dependencies, and shared knowledge.',
        href: '/missions',
      },
      {
        label: 'Assignment page',
        description: 'Use the assignment workspace for lifecycle actions, plan, scratchpad, handoff, and decisions.',
        href: '/missions',
      },
      {
        label: 'Help',
        description: 'Use Help for a model refresh, status guide, and CLI quick reference.',
        href: '/help',
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
        question: 'Why can I not edit assignment status directly in the editor?',
        answer:
          'Assignment status can be changed through lifecycle actions, kanban drag, or the Override Status dropdown. Lifecycle actions apply dependency and assignee checks as warnings.',
      },
    ],
    firstMissionChecklist: [
      {
        title: 'Create the mission',
        detail: 'Describe the overall objective in mission.md, then add tags and archive metadata only when needed.',
        command: CLI_COMMANDS[1],
        href: '/create/mission',
      },
      {
        title: 'Create at least one assignment',
        detail: 'Break the mission into executable work units with explicit priority and dependencies.',
        command: CLI_COMMANDS[2],
      },
      {
        title: 'Assign and start the first assignment',
        detail: 'Set an assignee, then start the assignment once prerequisites are complete.',
        command: CLI_COMMANDS[3],
      },
      {
        title: 'Use the assignment workspace for execution',
        detail: 'Keep the objective in assignment.md, the implementation plan in plan.md, and transient notes in scratchpad.md.',
        href: '/missions',
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
      { label: 'Mission Directory', href: '/missions' },
      { label: 'Attention Queue', href: '/attention' },
      { label: 'Create Mission', href: '/create/mission' },
    ],
  };
}

export function getHelpCommandNames(): string[] {
  return CLI_COMMANDS.map((command) => command.command.replace(/^syntaur\s+/, ''));
}
