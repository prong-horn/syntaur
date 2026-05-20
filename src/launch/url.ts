import {
  TERMINAL_CHOICES,
  type TerminalChoice,
} from '../utils/terminal-schema.js';

export type OpenUrlErrorCode =
  | 'bad-scheme'
  | 'bad-host'
  | 'missing-id'
  | 'both-ids'
  | 'malformed'
  | 'duplicate-param'
  | 'bad-terminal'
  | 'bad-mode';

export class OpenUrlError extends Error {
  readonly code: OpenUrlErrorCode;
  constructor(code: OpenUrlErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'OpenUrlError';
  }
}

export type SessionMode = 'resume' | 'fork';

const SESSION_MODES: readonly SessionMode[] = ['resume', 'fork'];

export interface ParsedOpenUrl {
  kind: 'assignment' | 'session';
  id: string;
  /**
   * Optional one-shot terminal override. When present, the launch plan uses
   * this instead of the configured `terminal:`. The dashboard's
   * missing-terminal fallback dialog sets this so a confirm-to-fallback flow
   * doesn't require mutating user config.
   */
  terminal?: TerminalChoice;
  /**
   * Only set when `kind === 'session'`. Defaults to `'resume'` when the URL
   * has no `mode` query param. Distinguishes "continue this session under the
   * same id" (resume) from "branch a new session id at this point in
   * history" (fork) so the dashboard can disable Resume while the original
   * process may still be writing the transcript.
   */
  mode?: SessionMode;
}

/**
 * Parse a `syntaur://open?assignment=<id>` or `syntaur://open?session=<id>` URL.
 *
 * Validation:
 * - scheme must be `syntaur:`
 * - host must be `open`
 * - exactly one of `assignment` or `session` query params must be present
 * - neither param may be duplicated
 * - when `session` is present, optional `mode=resume|fork` (default `resume`)
 * - optional `terminal=<choice>` one-shot override (validated against
 *   `TERMINAL_CHOICES`)
 *
 * Throws OpenUrlError with a structured code on any failure.
 */
export function parseOpenUrl(input: string): ParsedOpenUrl {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new OpenUrlError(
      'malformed',
      `Could not parse URL: ${JSON.stringify(input)}`,
    );
  }

  if (url.protocol !== 'syntaur:') {
    throw new OpenUrlError(
      'bad-scheme',
      `Expected scheme 'syntaur:' but got '${url.protocol}'`,
    );
  }

  if (url.hostname !== 'open') {
    throw new OpenUrlError(
      'bad-host',
      `Expected host 'open' but got '${url.hostname}'`,
    );
  }

  const assignmentVals = url.searchParams.getAll('assignment');
  const sessionVals = url.searchParams.getAll('session');

  if (assignmentVals.length > 1) {
    throw new OpenUrlError(
      'duplicate-param',
      'URL has more than one `assignment` query param',
    );
  }
  if (sessionVals.length > 1) {
    throw new OpenUrlError(
      'duplicate-param',
      'URL has more than one `session` query param',
    );
  }

  // Both-ids is decided by PARAM PRESENCE (`...length === 1`), not by value
  // truthiness. `?assignment=&session=x` has BOTH params present even though
  // assignment's value is empty — that must error as both-ids, not silently
  // fall through to the session branch.
  if (assignmentVals.length === 1 && sessionVals.length === 1) {
    throw new OpenUrlError(
      'both-ids',
      'URL has both `assignment` and `session` query params — only one is allowed',
    );
  }

  const terminalVals = url.searchParams.getAll('terminal');
  if (terminalVals.length > 1) {
    throw new OpenUrlError(
      'duplicate-param',
      'URL has more than one `terminal` query param',
    );
  }
  let terminal: TerminalChoice | undefined;
  if (terminalVals.length === 1 && terminalVals[0].trim() !== '') {
    const candidate = terminalVals[0];
    if (!(TERMINAL_CHOICES as readonly string[]).includes(candidate)) {
      throw new OpenUrlError(
        'bad-terminal',
        `\`terminal\` query param must be one of: ${TERMINAL_CHOICES.join(', ')}`,
      );
    }
    terminal = candidate as TerminalChoice;
  }

  if (assignmentVals.length === 1) {
    const id = assignmentVals[0];
    if (id.trim() === '') {
      throw new OpenUrlError(
        'missing-id',
        '`assignment` query param is empty',
      );
    }
    return { kind: 'assignment', id, ...(terminal ? { terminal } : {}) };
  }

  if (sessionVals.length === 1) {
    const id = sessionVals[0];
    if (id.trim() === '') {
      throw new OpenUrlError('missing-id', '`session` query param is empty');
    }

    const modeVals = url.searchParams.getAll('mode');
    if (modeVals.length > 1) {
      throw new OpenUrlError(
        'duplicate-param',
        'URL has more than one `mode` query param',
      );
    }
    let mode: SessionMode = 'resume';
    if (modeVals.length === 1) {
      const raw = modeVals[0];
      if (!SESSION_MODES.includes(raw as SessionMode)) {
        throw new OpenUrlError(
          'bad-mode',
          `\`mode\` must be one of ${SESSION_MODES.join('|')} (got "${raw}")`,
        );
      }
      mode = raw as SessionMode;
    }
    return { kind: 'session', id, mode, ...(terminal ? { terminal } : {}) };
  }

  throw new OpenUrlError(
    'missing-id',
    'URL must include either `assignment=<id>` or `session=<id>`',
  );
}
