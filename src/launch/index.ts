export {
  parseOpenUrl,
  OpenUrlError,
  type ParsedOpenUrl,
  type OpenUrlErrorCode,
  type SessionMode,
} from './url.js';

export {
  resolveLaunchPlan,
  pickAgent,
  LaunchError,
  type LaunchPlan,
  type LaunchErrorCode,
  type ResolveLaunchPlanInput,
} from './plan.js';

export {
  executeLaunchPlan,
  buildTerminalInvocation,
  buildShellCommandLine,
  TerminalNotFoundError,
  type SpawnFn,
} from './execute.js';

export {
  buildFreshArgv,
  buildSessionArgv,
} from './argv.js';

// NOTE: in-`src/launch`/`src/tui` call sites import the resolver directly from
// './launch-prompt.js' (not this barrel) to avoid the argv→tui/launch cycle.
// This re-export is for external consumers.
export {
  resolveLaunchPrompt,
  bareGrabSeed,
  runPlaybookClause,
  type ResolveLaunchPromptInput,
  type ResolveLaunchPromptResult,
} from './launch-prompt.js';

export type { ResolvedArgv, BuiltArgv } from './types.js';

export {
  detectInstallKind,
  extractNpxHash,
  shouldNudgeForNpx,
  recordNudge,
  hasNudgedHash,
  nudgeMessage,
  isHandlerNudgeDisabled,
  maybeNudgeForNpxInstall,
  nudgeStampDir,
  nudgeStampPath,
  type InstallKind,
} from './install-detection.js';
