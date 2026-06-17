// Pure helpers for the MarkdownEditor keyboard-save shortcut and the
// unsaved-changes navigation guard. Kept free of React so they can be
// unit-tested in the dashboard's node-env vitest suite (no DOM).

/**
 * True when a keyboard event is the platform "save" chord (Cmd+S on macOS,
 * Ctrl+S elsewhere). Case-insensitive on the key so Shift+Cmd+S still counts.
 */
export function isSaveShortcut(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
}): boolean {
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's';
}

/**
 * Mirrors the Save button's enabled condition
 * (`disabled={saving || validationErrors.length > 0}`). Saving is allowed only
 * when nothing is in flight and there are no validation errors.
 */
export function canSave(args: {
  saving: boolean;
  validationErrorCount: number;
}): boolean {
  return !args.saving && args.validationErrorCount === 0;
}

/**
 * Whether to attach a `beforeunload` guard. We only want the native
 * "leave site?" prompt when there are genuinely unsaved edits.
 */
export function shouldWarnBeforeUnload(hasChanges: boolean): boolean {
  return hasChanges;
}
