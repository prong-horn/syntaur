import { Command, InvalidArgumentError } from 'commander';
import { initCommand } from './commands/init.js';
import { projectCommand } from './commands/project.js';
import { newCommand } from './commands/new.js';
import { renameCommand } from './commands/rename.js';
import { dashboardCommand, didUserSpecifyDashboardPort } from './commands/dashboard.js';
import { assignCommand } from './commands/assign.js';
import { unassignCommand } from './commands/unassign.js';
import { startCommand } from './commands/start.js';
import { archiveCommand } from './commands/archive.js';
import { restoreCommand } from './commands/restore.js';
import { shapeCommand } from './commands/shape.js';
import { planReadyCommand } from './commands/plan-ready.js';
import { implementCommand } from './commands/implement.js';
import { migrateStatusesCommand } from './commands/migrate-statuses.js';
import { migrateStatusHistoryCommand } from './commands/migrate-status-history.js';
import { migrateEventsCommand } from './commands/migrate-events.js';
import { migrateDeriveCommand } from './commands/migrate-derive.js';
import { migrateWorkflowsCommand } from './commands/migrate-workflows.js';
import { v2MigrateCommand } from './commands/migrate-v2.js';
import {
  planApproveCommand,
  planUnapproveCommand,
  parkCommand,
  unparkCommand,
  requestReviewCommand,
  recomputeCommand,
  factSetCommand,
  attestCommand,
} from './commands/derive-verbs.js';
import { completeCommand } from './commands/complete.js';
import { blockCommand } from './commands/block.js';
import { unblockCommand } from './commands/unblock.js';
import { reviewCommand } from './commands/review.js';
import { failCommand } from './commands/fail.js';
import { reopenCommand } from './commands/reopen.js';
import { installPluginCommand } from './commands/install-plugin.js';
import { updateCommand } from './commands/update.js';
import { installStatuslineCommand, uninstallStatuslineCommand, type StatuslineMode } from './commands/install-statusline.js';
import { configureStatuslineCommand, PRESETS as STATUSLINE_PRESETS } from './commands/configure-statusline.js';
import { installCodexPluginCommand } from './commands/install-codex-plugin.js';
import { uninstallSkillsCommand } from './commands/uninstall-skills.js';
import { setupCommand } from './commands/setup.js';
import { uninstallCommand } from './commands/uninstall.js';
import { setupAdapterCommand } from './commands/setup-adapter.js';
import { trackSessionCommand } from './commands/track-session.js';
import { createPlaybookCommand } from './commands/create-playbook.js';
import { listPlaybooksCommand } from './commands/list-playbooks.js';
import { enablePlaybookCommand } from './commands/enable-playbook.js';
import { disablePlaybookCommand } from './commands/disable-playbook.js';
import { deletePlaybookCommand } from './commands/delete-playbook.js';
import { regenPlaybookManifestCommand } from './commands/regen-playbook-manifest.js';
import { doctorCommand } from './commands/doctor.js';
import { commentCommand } from './commands/comment.js';
import { usageCommand } from './commands/usage.js';
import { planCommand } from './commands/plan.js';
import { sessionCommand } from './commands/session.js';
import { worktreeCommand } from './commands/worktree.js';
import { openCommand } from './commands/open.js';
import { lsCommand } from './commands/ls.js';
import { searchCommand } from './commands/search.js';
import { timelineCommand } from './commands/timeline.js';
import { inboxCommand } from './commands/inbox.js';
import { statusCommand } from './commands/status.js';
import { workflowCommand } from './commands/workflow.js';
import { templateCommand } from './commands/template.js';
import { workspaceCommand } from './commands/workspace.js';
import { progressCommand } from './commands/progress.js';
import { getDefaultCommandName } from './cli-default-command.js';
import { maybePromptInstall } from './utils/npx-prompt.js';
import { maybeNudgeForNpxInstall } from './utils/install-detection.js';
import { readPackageVersion } from './utils/version.js';
import { runCommand } from './errors.js';

// Skip the npx/global-install startup nudges for `update`/`upgrade` — that
// command does its own install-kind detection and must stay read-only for
// --check/--dry-run (a startup prompt could install before it even runs).
// Also skip for `setup --dry-run`, which must write nothing at all, and for
// `migrate-workflows` / `migrate`, whose `--root <copy>` isolation is only set
// inside the action — these hooks resolve (and could write) the REAL ~/.syntaur
// before SYNTAUR_HOME is pointed at the copy (codex plan-review round-3 major).
{
  const sub = process.argv[2];
  const isDryRunSetup =
    sub === 'setup' && process.argv.slice(3).includes('--dry-run');
  if (
    sub !== 'update' &&
    sub !== 'upgrade' &&
    sub !== 'migrate-workflows' &&
    sub !== 'migrate' &&
    !isDryRunSetup
  ) {
    await maybePromptInstall(import.meta.url);
    await maybeNudgeForNpxInstall(import.meta.url);
  }
}

const program = new Command();
const version = (await readPackageVersion(import.meta.url)) ?? '0.0.0';

program
  .name('syntaur')
  .description('CLI scaffolding tool for the Syntaur protocol')
  .version(version);

program
  .command('init')
  .description('Initialize ~/.syntaur/ directory structure and config')
  .option('--force', 'Overwrite existing config file')
  .action(
    runCommand(async (options) => {
      await initCommand(options);
    }),
  );

program
  .command('new')
  .description('Create a new ticket (defaults to the scratch project when --project is omitted)')
  .argument('<title>', 'Ticket title')
  .option('--project <slug>', 'Target project slug (defaults to scratch)')
  .option('--slug <slug>', 'Override auto-generated display slug')
  .option(
    '--priority <level>',
    'Priority level (low|medium|high|critical)',
    'medium',
  )
  .option('--type <type>', 'Ticket type (e.g. feature, bug, refactor)')
  .option('--workflow <id>', 'Lifecycle workflow this ticket follows (defaults to the resolved binding)')
  .option('--depends-on <ids>', 'Comma-separated dependency ticket ids')
  .option('--links <ids>', 'Comma-separated linked ticket ids')
  .option('--dir <path>', 'Override default project directory')
  .option('--ready', 'Create the ticket directly as ready_for_planning (skips the draft phase)')
  .action(
    runCommand(async (title, options) => {
      await newCommand(title, options);
    }),
  );

program
  .command('rename')
  .description('Rename a ticket slug (folder becomes <ID>-<new-slug>)')
  .argument('<ticket>', 'Ticket id (<PREFIX>-<n>)')
  .argument('<new-slug>', 'New display slug')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (ticket, newSlug, options) => {
      await renameCommand(ticket, newSlug, options);
    }),
  );

program
  .command('comment')
  .description('Add a comment to a ticket (CLI-mediated, append-only)')
  .argument('<ticket>', 'Target ticket slug (with --project) or UUID (standalone)')
  .argument('<text>', 'Comment body')
  .option('--project <slug>', 'Project slug if the target is project-nested')
  .option('--reply-to <id>', 'ID of the comment this replies to')
  .option('--type <type>', 'Comment type: question | note | feedback', 'note')
  .option('--author <name>', 'Override author (default: $USER or "unknown")')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (ticket, text, options) => {
      await commentCommand(ticket, text, options);
    }),
  );

program
  .command('dashboard')
  .description('Start the local Syntaur dashboard web UI')
  .option('--port <number>', 'Port to run the dashboard on', '4800')
  .option('--dev', 'Run the dashboard with the Vite dev server', false)
  .option('--server-only', 'Run only the API server without any UI', false)
  .option('--api-only', 'Deprecated alias for --server-only', false)
  .option('--no-open', 'Do not automatically open the browser')
  .action(
    runCommand(async (options) => {
      const autoPort = !didUserSpecifyDashboardPort();
      await dashboardCommand({
        ...options,
        autoPort,
      });
    }),
  );

program
  .command('assign')
  .description('Set the assignee on a ticket')
  .argument('<ticket>', 'Ticket slug')
  .option('--project <slug>', 'Target project slug')
  .option('--agent <name>', 'Agent name to assign')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (ticket, options) => {
      await assignCommand(ticket, options);
    }),
  );

program
  .command('unassign')
  .description('Clear the assignee on a ticket (inverse of assign)')
  .argument('<ticket>', 'Ticket slug (UUID for standalone)')
  .option('--project <slug>', 'Target project slug')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (ticket, options) => {
      await unassignCommand(ticket, options);
    }),
  );

program
  .command('start')
  .description('Assert implementation has started (alias of implement under derived status)')
  .argument('<ticket>', 'Ticket slug')
  .option('--project <slug>', 'Target project slug')
  .option('--agent <name>', 'Agent name (sets assignee if not already set)')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (ticket, options) => {
      await startCommand(ticket, options);
    }),
  );

program
  .command('archive')
  .description('Archive a ticket or a project (hidden from normal views; restorable)')
  .argument('<target>', 'Ticket id, or a project slug')
  .option('--project <slug>', 'Resolve <target> as a ticket id within this project')
  .option('--reason <text>', 'Optional reason recorded with the archive')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (target, options) => {
      await archiveCommand(target, options);
    }),
  );

program
  .command('restore')
  .description('Restore an archived ticket or project (preserves prior status)')
  .argument('<target>', 'Ticket id, or a project slug')
  .option('--project <slug>', 'Resolve <target> as a ticket id within this project')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (target, options) => {
      await restoreCommand(target, options);
    }),
  );

program
  .command('shape')
  .description('Recompute derived status; ready_for_planning follows once objective + ACs are real')
  .argument('<ticket>', 'Ticket slug')
  .option('--project <slug>', 'Target project slug')
  .option('--agent <name>', 'Agent name (sets assignee if not already set)')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (ticket, options) => {
      await shapeCommand(ticket, options);
    }),
  );

program
  .command('plan-ready')
  .description('Approve the latest plan revision (file+digest bound); ready_to_implement derives from it')
  .argument('<ticket>', 'Ticket slug')
  .option('--project <slug>', 'Target project slug')
  .option('--agent <name>', 'Agent name (sets assignee if not already set)')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (ticket, options) => {
      await planReadyCommand(ticket, options);
    }),
  );

program
  .command('migrate-statuses')
  .description('Suggest pending -> ready_for_planning promotions for fleshed-out tickets (use --apply to write)')
  .option('--dir <path>', 'Override default project directory')
  .option('--apply', 'Apply the migration (default: dry-run)')
  .action(
    runCommand(async (options) => {
      await migrateStatusesCommand(options);
    }),
  );

program
  .command('migrate-status-history')
  .description('Seed a synthetic statusHistory entry on tickets that lack one (use --apply to write)')
  .option('--dir <path>', 'Override default project directory')
  .option('--apply', 'Apply the migration (default: dry-run)')
  .action(
    runCommand(async (options) => {
      await migrateStatusHistoryCommand(options);
    }),
  );

program
  .command('migrate-events')
  .description('Backfill the audit event log from statusHistory + planApproval (idempotent via source_key; use --apply to write)')
  .option('--dir <path>', 'Override default project directory')
  .option('--apply', 'Apply the backfill (default: dry-run)')
  .action(
    runCommand(async (options) => {
      await migrateEventsCommand(options);
    }),
  );

program
  .command('migrate-derive')
  .description('One-time migration to derived status: seed facts from current statuses, re-derive all, print a divergence report')
  .option('--dir <path>', 'Override default project directory')
  .option('--dry-run', 'Report what would change without writing')
  .action(
    runCommand(async (options) => {
      await migrateDeriveCommand(options);
    }),
  );

program
  .command('migrate-workflows')
  .description('One-time WS-3 migration: relocate workflows to per-file yaml (deleting the config block), compile the ladder to stages, seed stored stage positions, set the stages-migrated marker')
  .option('--root <path>', 'Migrate this syntaur home (a copy) instead of ~/.syntaur')
  .option('--dry-run', 'Print the compile + divergence report without writing')
  .action(
    runCommand(async (options) => {
      await migrateWorkflowsCommand(options);
    }),
  );

program
  .command('park')
  .description('Park a ticket (intentional withhold); disposition derives to parked')
  .argument('<ticket>', 'Ticket slug or standalone UUID')
  .option('--project <slug>', 'Target project slug')
  .option('--reason <text>', 'Why it is parked (recorded in history)')
  .option('--agent <name>', 'Acting agent id')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (ticket, options) => {
      await parkCommand(ticket, options);
    }),
  );

program
  .command('unpark')
  .description('Unpark a ticket; status re-derives from facts')
  .argument('<ticket>', 'Ticket slug or standalone UUID')
  .option('--project <slug>', 'Target project slug')
  .option('--agent <name>', 'Acting agent id')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (ticket, options) => {
      await unparkCommand(ticket, options);
    }),
  );

program
  .command('request-review')
  .description('Request review (sets reviewRequested); the review phase derives from it')
  .argument('<ticket>', 'Ticket slug or standalone UUID')
  .option('--project <slug>', 'Target project slug')
  .option('--clear', 'Clear the review request instead')
  .option('--agent <name>', 'Acting agent id')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (ticket, options) => {
      await requestReviewCommand(ticket, options);
    }),
  );

const factCommand = program
  .command('fact')
  .description('Manage custom asserted facts declared under statuses.facts');

factCommand
  .command('set')
  .description('Set a declared custom fact (bool/number); status re-derives from it')
  .argument('<ticket>', 'Ticket slug or standalone UUID')
  .argument('<name>', 'Declared fact name (statuses.facts)')
  .argument('<value>', 'Value (bool: true/false; number: any finite number)')
  .option('--project <slug>', 'Target project slug')
  .option('--agent <name>', 'Acting agent id')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (ticket, name, value, options) => {
      await factSetCommand(ticket, name, value, options);
    }),
  );

program
  .command('attest')
  .description('Record an attestation (agent reviewed a revision with a verdict); revision-bound')
  .argument('<ticket>', 'Ticket slug or standalone UUID')
  .argument('<fact>', 'Declared attestation fact name (statuses.facts)')
  .option('--verdict <verdict>', 'approved | changes-requested', 'approved')
  .option('--note <text>', 'Optional note recorded on the attestation')
  .option('--agent <id>', 'Acting agent id (else the bound session, else human)')
  .option('--project <slug>', 'Target project slug')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (ticket, fact, options) => {
      await attestCommand(ticket, fact, options);
    }),
  );

program
  .command('recompute')
  .description('Recompute derived status for one ticket or --all (headless reconcile)')
  .argument('[ticket]', 'Ticket slug or standalone UUID')
  .option('--all', 'Recompute every ticket (projects + standalone)')
  .option('--project <slug>', 'Target project slug')
  .option('--agent <name>', 'Acting agent id')
  .option('--dir <path>', 'Override default project directory')
  .option('--if-migrated', 'No-op unless derive migration has run (for implicit triggers like session-end hooks)')
  .option(
    '--session-id <id>',
    'Resolve the implicit target from this session\'s latest engagement (open-else-latest). The SessionEnd cleanup hook passes the ending session id here; explicit provenance lets it recompute after `session stop` closed the engagement.',
  )
  .action(
    runCommand(async (ticket, options) => {
      await recomputeCommand(ticket, options);
    }),
  );

program
  .command('implement')
  .description('Assert implementation has started; status derives to in_progress when the plan is approved')
  .argument('<ticket>', 'Ticket slug')
  .option('--project <slug>', 'Target project slug')
  .option('--agent <name>', 'Agent name (sets assignee if not already set)')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (ticket, options) => {
      await implementCommand(ticket, options);
    }),
  );

program
  .command('complete')
  .description('Transition a ticket to completed')
  .argument('<ticket>', 'Ticket slug')
  .option('--project <slug>', 'Target project slug')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (ticket, options) => {
      await completeCommand(ticket, options);
    }),
  );

program
  .command('block')
  .description('Assert a blocker (sets blockedReason); disposition derives to blocked')
  .argument('<ticket>', 'Ticket slug')
  .option('--project <slug>', 'Target project slug')
  .option('--reason <text>', 'Reason for blocking')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (ticket, options) => {
      await blockCommand(ticket, options);
    }),
  );

program
  .command('unblock')
  .description('Clear the blocker; status re-derives from facts')
  .argument('<ticket>', 'Ticket slug')
  .option('--project <slug>', 'Target project slug')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (ticket, options) => {
      await unblockCommand(ticket, options);
    }),
  );

program
  .command('review')
  .description('Request review; the review phase derives from it (or from all ACs checked)')
  .argument('<ticket>', 'Ticket slug')
  .option('--project <slug>', 'Target project slug')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (ticket, options) => {
      await reviewCommand(ticket, options);
    }),
  );

program
  .command('fail')
  .description('Transition a ticket to failed')
  .argument('<ticket>', 'Ticket slug')
  .option('--project <slug>', 'Target project slug')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (ticket, options) => {
      await failCommand(ticket, options);
    }),
  );

program
  .command('reopen')
  .description('Reopen a completed or failed ticket')
  .argument('<ticket>', 'Ticket slug')
  .option('--project <slug>', 'Target project slug')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (ticket, options) => {
      await reopenCommand(ticket, options);
    }),
  );

program
  .command('setup')
  .description('Initialize Syntaur and optionally install plugins or launch the dashboard')
  .option('--yes', 'Skip interactive prompts and perform only the requested flags')
  .option('--claude', 'Install the Claude Code plugin')
  .option('--codex', 'Install the Codex plugin')
  .option('--claude-dir <path>', 'Install the Claude Code plugin at a specific path')
  .option('--codex-dir <path>', 'Install the Codex plugin at a specific path')
  .option('--codex-marketplace-path <path>', 'Write the Codex marketplace entry to a specific file')
  .option('--dashboard', 'Launch the dashboard after setup')
  .option('--target <id>', 'Install Syntaur into a cross-agent target. Built-in ids: pi, hermes, openclaw, cursor, opencode (plus any user descriptors in ~/.syntaur/targets/). Comma-separated for several')
  .option('--agent <id>', 'Alias for --target; cross-agent target id(s) to install into')
  .option('--force', 'Overwrite existing cross-agent protocol files / skills')
  .option('--dry-run', 'Print the cross-agent install actions without writing anything')
  .action(
    runCommand(async (options) => {
      await setupCommand(options);
    }),
  );

program
  .command('install-plugin')
  .description('Install the Syntaur Claude Code plugin')
  .option('--force', 'Overwrite an existing Syntaur-managed install')
  .option('--target-dir <path>', 'Install the plugin at a specific directory')
  .option('--link', 'Use a symlink instead of copying files (repo-local dev only)')
  .option('--force-skills', 'Overwrite user-edited skills in ~/.claude/skills')
  .option('--skip-skills', 'Do not install protocol skills into ~/.claude/skills')
  .option('--enable', 'Enable the plugin in ~/.claude/settings.json after install')
  .action(
    runCommand(async (options) => {
      await installPluginCommand({ ...options, promptForTarget: true });
    }),
  );

program
  .command('update')
  .alias('upgrade')
  .description('Self-update the global syntaur package and refresh the plugin/skills')
  .option('--version <v>', 'Update to a specific version instead of latest')
  .option('--check', 'Report whether an update is available; apply nothing')
  .option('--dry-run', 'Print what would happen without changing anything')
  .option('--skip-refresh', 'Update the package only; do not refresh the plugin/skills')
  .option('--force-skills', 'Overwrite user-edited skills during the refresh')
  .option('--enable', 'Enable the plugin in settings.json during the refresh')
  .option('--pm <name>', 'Override package-manager detection (npm|pnpm|yarn|bun)')
  .option('--yes', 'Assume yes for any confirmation (non-interactive)')
  .action(
    runCommand(async (options) => {
      await updateCommand({ ...options, scriptUrl: import.meta.url });
    }),
  );

program
  .command('install-statusline')
  .description(
    'Install the syntaur statusLine for Claude Code. Augments ~/.claude/settings.json; wraps any existing script by default.',
  )
  .option('--mode <mode>', 'replace | wrap | skip | ask (default: ask, wrap in non-TTY)', 'ask')
  .option('--link', 'Symlink the installed script to the package source (dev mode)')
  .action(
    runCommand(async (options: { mode?: string; link?: boolean }) => {
      const rawMode = (options.mode ?? 'ask').toLowerCase();
      const valid: StatuslineMode[] = ['replace', 'wrap', 'skip', 'ask'];
      if (!valid.includes(rawMode as StatuslineMode)) {
        throw new Error(
          `Invalid --mode "${rawMode}". Must be one of: ${valid.join(', ')}.`,
        );
      }
      await installStatuslineCommand({
        mode: rawMode as StatuslineMode,
        link: options.link,
      });
    }),
  );

program
  .command('uninstall-statusline')
  .description(
    'Remove the syntaur statusLine. Restores the previously configured command from backup if present.',
  )
  .option('--keep-script', 'Leave ~/.syntaur/statusline.sh on disk (only edit settings.json)')
  .action(
    runCommand(async (options: { keepScript?: boolean }) => {
      await uninstallStatuslineCommand({ keepScript: options.keepScript });
    }),
  );

program
  .command('configure-statusline')
  .description(
    'Configure which segments (git, ticket, session, model, ctx, cwd, wrap) appear in the syntaur statusLine and in what order.',
  )
  .option(
    '--preset <name>',
    `Preset shortcut. Choices: ${Object.keys(STATUSLINE_PRESETS).join(', ')}.`,
  )
  .option(
    '--segments <list>',
    'Comma-separated segment list, e.g. "git,ticket,session,model,ctx".',
  )
  .option('--separator <string>', 'Segment separator (default " · ")')
  .option('--wrap <path>', 'Path to an external statusline script to compose as a "wrap" segment')
  .option('--preview', 'Print the resolved config and a preview line without writing')
  .action(
    runCommand(async (options: { preset?: string; segments?: string; separator?: string; wrap?: string; preview?: boolean }) => {
      await configureStatuslineCommand(options);
    }),
  );

program
  .command('uninstall-skills')
  .description('Remove Syntaur protocol skills from ~/.claude/skills and/or ~/.codex/skills')
  .option('--claude', 'Remove from ~/.claude/skills')
  .option('--codex', 'Remove from ~/.codex/skills')
  .option('--all', 'Remove from both')
  .action(
    runCommand(async (options: { claude?: boolean; codex?: boolean; all?: boolean }) => {
      await uninstallSkillsCommand(options);
    }),
  );

program
  .command('install-codex-plugin')
  .description('Install the Syntaur Codex plugin and marketplace entry')
  .option('--force', 'Overwrite an existing Syntaur-managed install')
  .option('--target-dir <path>', 'Install the plugin at a specific directory')
  .option('--marketplace-path <path>', 'Write the marketplace entry to a specific file')
  .option('--link', 'Use a symlink instead of copying files (repo-local dev only)')
  .option('--force-skills', 'Overwrite user-edited skills in ~/.codex/skills')
  .option('--skip-skills', 'Do not install protocol skills into ~/.codex/skills')
  .action(
    runCommand(async (options) => {
      await installCodexPluginCommand({ ...options, promptForTarget: true });
    }),
  );

program
  .command('uninstall')
  .description('Remove Syntaur integrations and optionally local data')
  .option('--claude', 'Remove only the Claude Code plugin')
  .option('--codex', 'Remove only the Codex plugin and marketplace entry')
  .option('--data', 'Remove ~/.syntaur data')
  .option('--all', 'Remove plugins and ~/.syntaur data')
  .option('--yes', 'Skip confirmation prompts')
  .action(
    runCommand(async (options) => {
      await uninstallCommand(options);
    }),
  );

program
  .command('setup-adapter')
  .description('Generate adapter instruction files for a framework in the current directory')
  .argument('<framework>', 'Target framework: built-in ids cursor, codex, opencode, pi, openclaw, hermes (plus any user descriptor with an instructions adapter in ~/.syntaur/targets/)')
  .option('--project <slug>', 'Target project slug (required)')
  .option('--ticket <id>', 'Target ticket id (required)')
  .option('--force', 'Overwrite existing adapter files')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (framework, options) => {
      await setupAdapterCommand(framework, options);
    }),
  );

program
  .command('track-session')
  .description('Register an agent session (optionally linked to a project/ticket)')
  .option('--project <slug>', 'Target project slug')
  .option('--ticket <id>', 'Ticket id')
  .option('--agent <name>', 'Agent name, e.g. claude, codex, cursor (required)')
  .option(
    '--session-id <id>',
    'Session id from the agent runtime (real, not generated). Defaults to self-resolution via env / process-tree markers / transcript scan — pass explicitly only when registering a session other than the calling one.',
  )
  .option(
    '--transcript-path <path>',
    'Absolute path to the agent rollout/transcript file (e.g. the Codex rollout jsonl or Claude transcript jsonl).',
  )
  .option('--path <path>', 'Full path to session on disk (defaults to cwd)')
  .option('--dir <path>', 'Override default project directory')
  .option('--description <text>', 'Description of what this session is for')
  .action(
    runCommand(async (options) => {
      await trackSessionCommand(options);
    }),
  );

program
  .command('create-playbook')
  .description('Create a new playbook')
  .argument('<name>', 'Playbook name')
  .option('--slug <slug>', 'Override auto-generated slug')
  .option('--description <desc>', 'Playbook description')
  .action(
    runCommand(async (name, options) => {
      await createPlaybookCommand(name, options);
    }),
  );

program
  .command('list-playbooks')
  .description('List playbooks (disabled playbooks are excluded unless --all is passed)')
  .option('--all', 'Include disabled playbooks')
  .action(
    runCommand(async (options) => {
      await listPlaybooksCommand({ all: Boolean(options?.all) });
    }),
  );

program
  .command('enable-playbook')
  .description('Enable a previously-disabled playbook')
  .argument('<slug>', 'Playbook slug')
  .action(
    runCommand(async (slug) => {
      await enablePlaybookCommand(slug);
    }),
  );

program
  .command('disable-playbook')
  .description('Disable a playbook so agents no longer load it')
  .argument('<slug>', 'Playbook slug')
  .action(
    runCommand(async (slug) => {
      await disablePlaybookCommand(slug);
    }),
  );

program
  .command('delete-playbook')
  .description('Delete a playbook from disk and regenerate the manifest')
  .argument('<slug>', 'Playbook slug')
  .action(
    runCommand(async (slug) => {
      await deletePlaybookCommand(slug);
    }),
  );

program
  .command('regen-playbook-manifest')
  .description('Rebuild ~/.syntaur/playbooks/manifest.md from current playbook files')
  .action(
    runCommand(async () => {
      await regenPlaybookManifestCommand();
    }),
  );

const migrateCommand = new Command('migrate').description('One-time data migrations');
migrateCommand.addCommand(v2MigrateCommand);
program.addCommand(migrateCommand);

program.addCommand(doctorCommand);
program.addCommand(projectCommand);
program.addCommand(planCommand);
program.addCommand(sessionCommand);
program.addCommand(worktreeCommand);
program.addCommand(openCommand);
program.addCommand(lsCommand);
program.addCommand(searchCommand);
program.addCommand(timelineCommand);
program.addCommand(inboxCommand);
program.addCommand(statusCommand);
program.addCommand(workflowCommand);
program.addCommand(templateCommand);
program.addCommand(workspaceCommand);
program.addCommand(progressCommand);
program.addCommand(usageCommand);

program.addHelpText(
  'after',
  `
Common workflow:
  $ syntaur setup                                  Initialize Syntaur (plugins, dashboard)
  $ syntaur project new "My App"                   Start a new project
  $ syntaur new --project my-app "Add login"   Add a ticket to a project
  $ syntaur dashboard                              Open the local web dashboard
  $ syntaur doctor                                 Diagnose Syntaur state & suggested fixes

Run 'syntaur <command> --help' for command-specific options.
Migration/internal commands (migrate-*, regen-playbook-manifest) are advanced; most
workflows never need them.`,
);

// Default to dashboard when no command is given
if (process.argv.length <= 2) {
  process.argv.push(await getDefaultCommandName());
}

await program.parseAsync();
