import { Command, InvalidArgumentError } from 'commander';
import { initCommand } from './commands/init.js';
import { createProjectCommand } from './commands/create-project.js';
import { createAssignmentCommand } from './commands/create-assignment.js';
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
import { urlCommand, formatUrlCommandError } from './commands/url.js';
import {
  installUrlHandlerCommand,
  formatInstallUrlHandlerError,
} from './commands/install-url-handler.js';
import { browseCommand } from './commands/browse.js';
import { createPlaybookCommand } from './commands/create-playbook.js';
import { listPlaybooksCommand } from './commands/list-playbooks.js';
import { enablePlaybookCommand } from './commands/enable-playbook.js';
import { disablePlaybookCommand } from './commands/disable-playbook.js';
import { deletePlaybookCommand } from './commands/delete-playbook.js';
import { regenPlaybookManifestCommand } from './commands/regen-playbook-manifest.js';
import { todoCommand } from './commands/todo.js';
import { backupCommand } from './commands/backup.js';
import { doctorCommand } from './commands/doctor.js';
import { agentsCommand } from './commands/agents.js';
import { commentCommand } from './commands/comment.js';
import { captureCommand } from './commands/capture.js';
import { proofCommand } from './commands/proof.js';
import { leaseCommand } from './commands/lease.js';
import { scheduleCommand } from './commands/schedule.js';
import { usageCommand } from './commands/usage.js';
import { requestCommand } from './commands/request.js';
import { planCommand } from './commands/plan.js';
import { sessionCommand } from './commands/session.js';
import { worktreeCommand } from './commands/worktree.js';
import { openCommand } from './commands/open.js';
import { resourceCommand } from './commands/resource.js';
import { memoryCommand } from './commands/memory.js';
import { lsCommand } from './commands/ls.js';
import { searchCommand } from './commands/search.js';
import { timelineCommand } from './commands/timeline.js';
import { inboxCommand } from './commands/inbox.js';
import { viewsCommand } from './commands/views.js';
import { statusCommand } from './commands/status.js';
import { workspaceCommand } from './commands/workspace.js';
import { progressCommand } from './commands/progress.js';
import { getDefaultCommandName } from './cli-default-command.js';
import { maybePromptInstall } from './utils/npx-prompt.js';
import { maybeNudgeForNpxInstall } from './launch/index.js';
import { spliceDashDashFromArgv } from './utils/argv-split.js';
import { readPackageVersion } from './utils/version.js';
import { runCommand } from './errors.js';

// Skip the npx/global-install startup nudges for `update`/`upgrade` — that
// command does its own install-kind detection and must stay read-only for
// --check/--dry-run (a startup prompt could install before it even runs).
// Also skip for `setup --dry-run`, which must write nothing at all.
{
  const sub = process.argv[2];
  const isDryRunSetup =
    sub === 'setup' && process.argv.slice(3).includes('--dry-run');
  if (sub !== 'update' && sub !== 'upgrade' && !isDryRunSetup) {
    await maybePromptInstall(import.meta.url);
    await maybeNudgeForNpxInstall(import.meta.url);
  }
}

let captureDashDashArgv: string[] = [];

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
  .command('create-project')
  .description('Create a new project with all required files')
  .argument('<title>', 'Project title')
  .option('--slug <slug>', 'Override auto-generated slug')
  .option('--dir <path>', 'Override default project directory')
  .option('--workspace <workspace>', 'Workspace for organizational grouping')
  .action(
    runCommand(async (title, options) => {
      await createProjectCommand(title, options);
    }),
  );

program
  .command('create-assignment')
  .description('Create a new assignment within a project')
  .argument('<title>', 'Assignment title')
  .option('--project <slug>', 'Target project slug (required unless --one-off)')
  .option('--one-off', 'Create a standalone assignment at ~/.syntaur/assignments/<uuid>/')
  .option('--slug <slug>', 'Override auto-generated slug (display only for standalone; folder name for project-nested)')
  .option(
    '--priority <level>',
    'Priority level (low|medium|high|critical)',
    'medium',
  )
  .option('--type <type>', 'Assignment type (e.g. feature, bug, refactor)')
  .option('--depends-on <slugs>', 'Comma-separated dependency slugs (not allowed with --one-off)')
  .option('--links <slugs>', 'Comma-separated linked assignment slugs (projectSlug/assignmentSlug format)')
  .option('--dir <path>', 'Override default project directory (ignored for --one-off)')
  .option('--with-todos', 'Scaffold a ## Todos section in assignment.md (omitted by default; typically populated by /plan-assignment)')
  .option('--workspace <slug>', 'Workspace group slug (only valid with --one-off; mutually exclusive with --project)')
  .option('--ready', 'Create the assignment directly as ready_for_planning (skips the draft phase)')
  .action(
    runCommand(async (title, options) => {
      await createAssignmentCommand(title, options);
    }),
  );

program
  .command('comment')
  .description('Add a comment to an assignment (CLI-mediated, append-only)')
  .argument('<assignment>', 'Target assignment slug (with --project) or UUID (standalone)')
  .argument('<text>', 'Comment body')
  .option('--project <slug>', 'Project slug if the target is project-nested')
  .option('--reply-to <id>', 'ID of the comment this replies to')
  .option('--type <type>', 'Comment type: question | note | feedback', 'note')
  .option('--author <name>', 'Override author (default: $USER or "unknown")')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (assignment, text, options) => {
      await commentCommand(assignment, text, options);
    }),
  );

program
  .command('capture')
  .description('Capture a typed proof artifact for an assignment')
  .argument('[target]', 'Assignment slug (with --project) or UUID; falls back to .syntaur/context.json')
  .option('--kind <type>', 'Artifact kind: screenshot | video | asciinema | http | text')
  .option('--file <path>', 'Source file to ingest (forbidden for --kind=text)')
  .option('--criterion <index>', 'Optional 0-based criterion index to tag')
  .option('--note <text>', 'Optional note (required for --kind=text)')
  .option('--project <slug>', 'Project slug if the target is project-nested')
  .option('--dir <path>', 'Override default project directory')
  .option('--interactive', 'Interactive mode: drag a region (--kind=screenshot) or record a TTY (--kind=asciinema)')
  .option('--window', 'Screenshot mode: window picker (macOS only)')
  .option('--fullscreen', 'Screenshot mode: silent full-screen capture (macOS only)')
  .option('--start', 'Start ffmpeg screen recording in the background (macOS only). Stop with --stop.')
  .option('--stop', 'Stop the running ffmpeg recording and attach the mp4.')
  .option('--device <index>', 'AVFoundation video device index for --start (default: 1). List devices: ffmpeg -f avfoundation -list_devices true -i ""')
  .option('--fps <n>', 'Frame rate for --start (default: 30)')
  .option('--transcribe', 'Auto-transcribe captured video to a <id>.transcript.md sidecar (kind=video only; requires ELEVENLABS_API_KEY + ffmpeg)')
  .action(
    runCommand(async (target, options) => {
      await captureCommand(target, {
        ...options,
        commandArgv: captureDashDashArgv,
      });
    }),
  );

program
  .command('request')
  .description('Append a todo to another assignment (cross-assignment work request)')
  .argument('<target>', 'Target assignment slug (with --project) or UUID (standalone)')
  .argument('<text>', 'Todo text')
  .option('--project <slug>', 'Project slug if the target is project-nested')
  .option('--from <source>', 'Source assignment (default: $SYNTAUR_ASSIGNMENT)')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (target, text, options) => {
      await requestCommand(target, text, options);
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
  .description('Set the assignee on an assignment')
  .argument('<assignment>', 'Assignment slug')
  .option('--project <slug>', 'Target project slug')
  .option('--agent <name>', 'Agent name to assign')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (assignment, options) => {
      await assignCommand(assignment, options);
    }),
  );

program
  .command('unassign')
  .description('Clear the assignee on an assignment (inverse of assign)')
  .argument('<assignment>', 'Assignment slug (UUID for standalone)')
  .option('--project <slug>', 'Target project slug')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (assignment, options) => {
      await unassignCommand(assignment, options);
    }),
  );

program
  .command('start')
  .description('Assert implementation has started (alias of implement under derived status)')
  .argument('<assignment>', 'Assignment slug')
  .option('--project <slug>', 'Target project slug')
  .option('--agent <name>', 'Agent name (sets assignee if not already set)')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (assignment, options) => {
      await startCommand(assignment, options);
    }),
  );

program
  .command('archive')
  .description('Archive an assignment or a project (hidden from normal views; restorable)')
  .argument('<target>', 'Assignment slug/UUID, or a project slug')
  .option('--project <slug>', 'Resolve <target> as an assignment within this project')
  .option('--reason <text>', 'Optional reason recorded with the archive')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (target, options) => {
      await archiveCommand(target, options);
    }),
  );

program
  .command('restore')
  .description('Restore an archived assignment or project (preserves prior status)')
  .argument('<target>', 'Assignment slug/UUID, or a project slug')
  .option('--project <slug>', 'Resolve <target> as an assignment within this project')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (target, options) => {
      await restoreCommand(target, options);
    }),
  );

program
  .command('shape')
  .description('Recompute derived status; ready_for_planning follows once objective + ACs are real')
  .argument('<assignment>', 'Assignment slug')
  .option('--project <slug>', 'Target project slug')
  .option('--agent <name>', 'Agent name (sets assignee if not already set)')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (assignment, options) => {
      await shapeCommand(assignment, options);
    }),
  );

program
  .command('plan-ready')
  .description('Approve the latest plan revision (file+digest bound); ready_to_implement derives from it')
  .argument('<assignment>', 'Assignment slug')
  .option('--project <slug>', 'Target project slug')
  .option('--agent <name>', 'Agent name (sets assignee if not already set)')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (assignment, options) => {
      await planReadyCommand(assignment, options);
    }),
  );

program
  .command('migrate-statuses')
  .description('Suggest pending -> ready_for_planning promotions for fleshed-out assignments (use --apply to write)')
  .option('--dir <path>', 'Override default project directory')
  .option('--apply', 'Apply the migration (default: dry-run)')
  .action(
    runCommand(async (options) => {
      await migrateStatusesCommand(options);
    }),
  );

program
  .command('migrate-status-history')
  .description('Seed a synthetic statusHistory entry on assignments that lack one (use --apply to write)')
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
  .command('park')
  .description('Park an assignment (intentional withhold); disposition derives to parked')
  .argument('<assignment>', 'Assignment slug or standalone UUID')
  .option('--project <slug>', 'Target project slug')
  .option('--reason <text>', 'Why it is parked (recorded in history)')
  .option('--agent <name>', 'Acting agent id')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (assignment, options) => {
      await parkCommand(assignment, options);
    }),
  );

program
  .command('unpark')
  .description('Unpark an assignment; status re-derives from facts')
  .argument('<assignment>', 'Assignment slug or standalone UUID')
  .option('--project <slug>', 'Target project slug')
  .option('--agent <name>', 'Acting agent id')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (assignment, options) => {
      await unparkCommand(assignment, options);
    }),
  );

program
  .command('request-review')
  .description('Request review (sets reviewRequested); the review phase derives from it')
  .argument('<assignment>', 'Assignment slug or standalone UUID')
  .option('--project <slug>', 'Target project slug')
  .option('--clear', 'Clear the review request instead')
  .option('--agent <name>', 'Acting agent id')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (assignment, options) => {
      await requestReviewCommand(assignment, options);
    }),
  );

const factCommand = program
  .command('fact')
  .description('Manage custom asserted facts declared under statuses.facts');

factCommand
  .command('set')
  .description('Set a declared custom fact (bool/number); status re-derives from it')
  .argument('<assignment>', 'Assignment slug or standalone UUID')
  .argument('<name>', 'Declared fact name (statuses.facts)')
  .argument('<value>', 'Value (bool: true/false; number: any finite number)')
  .option('--project <slug>', 'Target project slug')
  .option('--agent <name>', 'Acting agent id')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (assignment, name, value, options) => {
      await factSetCommand(assignment, name, value, options);
    }),
  );

program
  .command('attest')
  .description('Record an attestation (agent reviewed a revision with a verdict); revision-bound')
  .argument('<assignment>', 'Assignment slug or standalone UUID')
  .argument('<fact>', 'Declared attestation fact name (statuses.facts)')
  .option('--verdict <verdict>', 'approved | changes-requested', 'approved')
  .option('--note <text>', 'Optional note recorded on the attestation')
  .option('--agent <id>', 'Acting agent id (else the bound session, else human)')
  .option('--project <slug>', 'Target project slug')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (assignment, fact, options) => {
      await attestCommand(assignment, fact, options);
    }),
  );

program
  .command('recompute')
  .description('Recompute derived status for one assignment or --all (headless reconcile)')
  .argument('[assignment]', 'Assignment slug or standalone UUID')
  .option('--all', 'Recompute every assignment (projects + standalone)')
  .option('--project <slug>', 'Target project slug')
  .option('--agent <name>', 'Acting agent id')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (assignment, options) => {
      await recomputeCommand(assignment, options);
    }),
  );

program
  .command('implement')
  .description('Assert implementation has started; status derives to in_progress when the plan is approved')
  .argument('<assignment>', 'Assignment slug')
  .option('--project <slug>', 'Target project slug')
  .option('--agent <name>', 'Agent name (sets assignee if not already set)')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (assignment, options) => {
      await implementCommand(assignment, options);
    }),
  );

program
  .command('complete')
  .description('Transition an assignment to completed')
  .argument('<assignment>', 'Assignment slug')
  .option('--project <slug>', 'Target project slug')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (assignment, options) => {
      await completeCommand(assignment, options);
    }),
  );

program
  .command('block')
  .description('Assert a blocker (sets blockedReason); disposition derives to blocked')
  .argument('<assignment>', 'Assignment slug')
  .option('--project <slug>', 'Target project slug')
  .option('--reason <text>', 'Reason for blocking')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (assignment, options) => {
      await blockCommand(assignment, options);
    }),
  );

program
  .command('unblock')
  .description('Clear the blocker; status re-derives from facts')
  .argument('<assignment>', 'Assignment slug')
  .option('--project <slug>', 'Target project slug')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (assignment, options) => {
      await unblockCommand(assignment, options);
    }),
  );

program
  .command('review')
  .description('Request review; the review phase derives from it (or from all ACs checked)')
  .argument('<assignment>', 'Assignment slug')
  .option('--project <slug>', 'Target project slug')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (assignment, options) => {
      await reviewCommand(assignment, options);
    }),
  );

program
  .command('fail')
  .description('Transition an assignment to failed')
  .argument('<assignment>', 'Assignment slug')
  .option('--project <slug>', 'Target project slug')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (assignment, options) => {
      await failCommand(assignment, options);
    }),
  );

program
  .command('reopen')
  .description('Reopen a completed or failed assignment')
  .argument('<assignment>', 'Assignment slug')
  .option('--project <slug>', 'Target project slug')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (assignment, options) => {
      await reopenCommand(assignment, options);
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
    'Configure which segments (git, assignment, session, model, ctx, cwd, wrap) appear in the syntaur statusLine and in what order.',
  )
  .option(
    '--preset <name>',
    `Preset shortcut. Choices: ${Object.keys(STATUSLINE_PRESETS).join(', ')}.`,
  )
  .option(
    '--segments <list>',
    'Comma-separated segment list, e.g. "git,assignment,session,model,ctx".',
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
  .option('--assignment <slug>', 'Target assignment slug (required)')
  .option('--force', 'Overwrite existing adapter files')
  .option('--dir <path>', 'Override default project directory')
  .action(
    runCommand(async (framework, options) => {
      await setupAdapterCommand(framework, options);
    }),
  );

program
  .command('track-session')
  .description('Register an agent session (optionally linked to a project/assignment)')
  .option('--project <slug>', 'Target project slug')
  .option('--assignment <slug>', 'Assignment slug')
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
  .option(
    '--pid <n>',
    'Process ID owning this session — enables liveness detection so Resume is disabled while the process is still running.',
    (v) => {
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new InvalidArgumentError('--pid must be a positive integer');
      }
      return n;
    },
  )
  .action(
    runCommand(async (options) => {
      await trackSessionCommand(options);
    }),
  );

program
  .command('url <url>')
  .description(
    'Open an assignment or session in the configured terminal + agent (handles syntaur:// deep links)',
  )
  .option(
    '--print-plan',
    'Print the launch plan to stdout (two lines: terminal id, shell command) instead of executing. Used internally by the macOS URL handler applet so Apple Events come from the applet rather than from a subprocess.',
  )
  .action(async (url: string, options: { printPlan?: boolean }) => {
    try {
      await urlCommand(url, { printPlan: options.printPlan });
    } catch (error) {
      console.error(formatUrlCommandError(error));
      process.exit(1);
    }
  });

program
  .command('install-url-handler')
  .description(
    'Register the syntaur:// deep-link handler with the OS. macOS-only today. Refuses to register from an npx cache or unrecognized install.',
  )
  .action(async () => {
    try {
      await installUrlHandlerCommand({ scriptUrl: import.meta.url });
    } catch (error) {
      console.error(formatInstallUrlHandlerError(error));
      process.exit(1);
    }
  });

program
  .command('browse')
  .description('Interactive TUI browser for projects and assignments')
  .option('--agent <id>', 'Bypass the agent picker and launch the given configured agent id')
  .option('--no-worktree-prompt', 'Skip the prompt to create a worktree when one is missing')
  .action(
    runCommand(async (options) => {
      await browseCommand(options);
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

program.addCommand(todoCommand);
program.addCommand(backupCommand);
program.addCommand(doctorCommand);
program.addCommand(agentsCommand);
program.addCommand(proofCommand);
program.addCommand(planCommand);
program.addCommand(sessionCommand);
program.addCommand(worktreeCommand);
program.addCommand(openCommand);
program.addCommand(resourceCommand);
program.addCommand(memoryCommand);
program.addCommand(lsCommand);
program.addCommand(searchCommand);
program.addCommand(timelineCommand);
program.addCommand(inboxCommand);
program.addCommand(viewsCommand);
program.addCommand(statusCommand);
program.addCommand(workspaceCommand);
program.addCommand(progressCommand);
program.addCommand(leaseCommand);
program.addCommand(scheduleCommand);
program.addCommand(usageCommand);

program.addHelpText(
  'after',
  `
Common workflow:
  $ syntaur setup                                  Initialize Syntaur (plugins, dashboard)
  $ syntaur create-project "My App"                Start a new project
  $ syntaur create-assignment --project my-app "Add login"   Add a task to a project
  $ syntaur browse                                 Interactive TUI: pick & launch work
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

captureDashDashArgv = spliceDashDashFromArgv(process.argv);
await program.parseAsync();
