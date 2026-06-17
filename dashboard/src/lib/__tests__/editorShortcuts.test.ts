import { describe, it, expect } from 'vitest';
import {
  canSave,
  isSaveShortcut,
  shouldWarnBeforeUnload,
} from '../editorShortcuts';

describe('isSaveShortcut', () => {
  it('matches Cmd+S (macOS)', () => {
    expect(isSaveShortcut({ key: 's', metaKey: true, ctrlKey: false })).toBe(true);
  });

  it('matches Ctrl+S (Windows/Linux)', () => {
    expect(isSaveShortcut({ key: 's', metaKey: false, ctrlKey: true })).toBe(true);
  });

  it('is case-insensitive on the key (Shift held → uppercase S)', () => {
    expect(isSaveShortcut({ key: 'S', metaKey: true, ctrlKey: false })).toBe(true);
  });

  it('does not match S without a modifier', () => {
    expect(isSaveShortcut({ key: 's', metaKey: false, ctrlKey: false })).toBe(false);
  });

  it('does not match a different key with the modifier', () => {
    expect(isSaveShortcut({ key: 'a', metaKey: true, ctrlKey: false })).toBe(false);
  });
});

describe('canSave', () => {
  it('allows saving when not saving and no validation errors', () => {
    expect(canSave({ saving: false, validationErrorCount: 0 })).toBe(true);
  });

  it('blocks saving while a save is in flight', () => {
    expect(canSave({ saving: true, validationErrorCount: 0 })).toBe(false);
  });

  it('blocks saving when there are validation errors', () => {
    expect(canSave({ saving: false, validationErrorCount: 2 })).toBe(false);
  });
});

describe('shouldWarnBeforeUnload', () => {
  it('warns only when there are unsaved changes', () => {
    expect(shouldWarnBeforeUnload(true)).toBe(true);
    expect(shouldWarnBeforeUnload(false)).toBe(false);
  });
});
