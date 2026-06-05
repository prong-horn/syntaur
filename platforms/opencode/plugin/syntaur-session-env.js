/**
 * Syntaur OpenCode plugin — inject OPENCODE_SESSION_ID into every spawned
 * command so `syntaur` (and any other tool) can resolve the caller's OWN
 * session id from the process (layer 2 of resolveOwnSessionId), instead of the
 * co-tenant-clobberable .syntaur/context.json scalar.
 *
 * REFERENCE ARTIFACT. Syntaur's current OpenCode integration is adapter-file
 * only (see ../README.md); this is not yet auto-installed. To use:
 *   1. Drop this file at `~/.config/opencode/plugin/syntaur-session-env.js`
 *      (or your project's `.opencode/plugin/`).
 *   2. Restart OpenCode.
 *
 * Verify (needs a live OpenCode build): from a tool call, `echo $OPENCODE_SESSION_ID`
 * prints the conversation/session id.
 *
 * Caveat: the V2 `core` bash tool is not yet wired to `shell.env`
 * (`// TODO` in packages/core/src/tool/bash.ts); the `opencode` ShellTool path
 * is. Verify against your target OpenCode version. The hook signature below
 * follows the @opencode-ai/plugin `shell.env` trigger — adjust if the API shifts.
 */
export const SyntaurSessionEnv = async () => ({
  // Fired per spawn with the active session id; mutate the child env in place.
  'shell.env': async ({ sessionID }, output) => {
    if (sessionID && output && output.env) {
      output.env.OPENCODE_SESSION_ID = sessionID;
    }
  },
});

export default SyntaurSessionEnv;
