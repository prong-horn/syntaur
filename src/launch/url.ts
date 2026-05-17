export type OpenUrlErrorCode =
  | 'bad-scheme'
  | 'bad-host'
  | 'missing-id'
  | 'both-ids'
  | 'malformed'
  | 'duplicate-param';

export class OpenUrlError extends Error {
  readonly code: OpenUrlErrorCode;
  constructor(code: OpenUrlErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'OpenUrlError';
  }
}

export interface ParsedOpenUrl {
  kind: 'assignment' | 'session';
  id: string;
}

/**
 * Parse a `syntaur://open?assignment=<id>` or `syntaur://open?session=<id>` URL.
 *
 * Validation:
 * - scheme must be `syntaur:`
 * - host must be `open`
 * - exactly one of `assignment` or `session` query params must be present
 * - neither param may be duplicated
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

  if (assignmentVals.length === 1) {
    const id = assignmentVals[0];
    if (id.trim() === '') {
      throw new OpenUrlError(
        'missing-id',
        '`assignment` query param is empty',
      );
    }
    return { kind: 'assignment', id };
  }

  if (sessionVals.length === 1) {
    const id = sessionVals[0];
    if (id.trim() === '') {
      throw new OpenUrlError('missing-id', '`session` query param is empty');
    }
    return { kind: 'session', id };
  }

  throw new OpenUrlError(
    'missing-id',
    'URL must include either `assignment=<id>` or `session=<id>`',
  );
}
