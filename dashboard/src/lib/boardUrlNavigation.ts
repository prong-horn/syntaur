/**
 * Board URL history semantics: bootstrap/preference sync must not stack entries;
 * dialog/panel opens participate in browser history (plan §57).
 */
export type BoardUrlNavigationIntent =
  | 'bootstrap'
  | 'preference-sync'
  | 'open-ephemeral'
  | 'close-ephemeral';

export function boardUrlUsesReplace(intent: BoardUrlNavigationIntent): boolean {
  switch (intent) {
    case 'open-ephemeral':
      return false;
    case 'bootstrap':
    case 'preference-sync':
    case 'close-ephemeral':
      return true;
  }
}

export function boardUrlNavigateOptions(intent: BoardUrlNavigationIntent): { replace: boolean } {
  return { replace: boardUrlUsesReplace(intent) };
}
