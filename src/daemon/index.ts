// Public surface of the agent-multiplexer daemon subsystem (Phase A).

export * from './types.js';
export {
  currentPointerPath,
  daemonLogPath,
  jobDir,
  jobStatePath,
  jobsDir,
  runtimeBaseDir,
} from './paths.js';
export { appendLog, tailLog } from './log.js';
export { readJobState, readAllJobStates } from './jobs.js';
export { createDaemon, type Daemon, type DaemonDeps, type DaemonSpawnFn } from './supervisor.js';
export { ensureDaemon, daemonRequest, queryDaemon, sendRequest, type ClientDeps, type ExecFn } from './client.js';
export { runAttachClient, type AttachOptions, type AttachResult, type AttachDeps } from './attach-client.js';
export { runPtyHost, smokePtyHost, type PtyHostConfig } from './pty-host.js';
export { runPtyHostMain, parsePtyHostArgs } from './pty-host-run.js';
export { resolveAdapter } from './adapters/registry.js';
export type { AgentAdapter } from './adapters/types.js';
