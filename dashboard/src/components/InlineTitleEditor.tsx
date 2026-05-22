import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { cn } from '../lib/utils';

interface InlineTitleEditorProps {
  title: string;
  detailHref: string;
  onSave: (next: string) => Promise<void>;
  disabled?: boolean;
}

export function InlineTitleEditor({ title, detailHref, onSave, disabled = false }: InlineTitleEditorProps) {
  const [editing, setEditing] = useState(false);

  if (!editing) {
    return (
      <div className="group flex items-baseline gap-1.5">
        <button
          type="button"
          data-no-drag
          disabled={disabled}
          onClick={() => {
            if (disabled) return;
            setEditing(true);
          }}
          className={cn(
            'text-left text-base font-semibold text-foreground transition hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded-sm',
            disabled && 'cursor-not-allowed opacity-60',
          )}
          title="Click to rename"
        >
          {title}
        </button>
        <Link
          to={detailHref}
          data-no-drag
          aria-label="Open detail page"
          title="Open detail page"
          onClick={(e) => e.stopPropagation()}
          className="text-muted-foreground opacity-0 transition group-hover:opacity-100 focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded-sm"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      </div>
    );
  }

  return (
    <EditingTitleInput
      initialTitle={title}
      disabled={disabled}
      onSave={onSave}
      onExit={() => setEditing(false)}
    />
  );
}

interface EditingTitleInputProps {
  initialTitle: string;
  disabled: boolean;
  onSave: (next: string) => Promise<void>;
  onExit: () => void;
}

function EditingTitleInput({ initialTitle, disabled, onSave, onExit }: EditingTitleInputProps) {
  // `initialTitle` is consulted ONLY on mount of the edit subtree. Once editing
  // begins, prop updates (e.g., from a WS-driven refetch) do not clobber the
  // user's in-flight draft, AND a blur-without-change is compared against the
  // value the user actually saw when they entered edit mode (not the live
  // prop, which may have changed under them mid-edit).
  const snapshotRef = useRef(initialTitle);
  const [draft, setDraft] = useState(initialTitle);
  const [saving, setSaving] = useState(false);
  const [shaking, setShaking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Set by Escape so the subsequent blur does not commit, and by an in-flight
  // commit so blur does not re-commit.
  const suppressBlurRef = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  const triggerShake = useCallback(() => {
    setShaking(true);
    window.setTimeout(() => setShaking(false), 260);
    inputRef.current?.focus();
  }, []);

  const commit = useCallback(async () => {
    if (suppressBlurRef.current) return;
    const next = draft.trim();
    if (next.length === 0) {
      triggerShake();
      return;
    }
    // Compare against the snapshot at edit-start, not the live prop. A WS
    // refetch that updated the prop mid-edit must not cause an unmodified
    // blur to save the stale snapshot back to the server.
    if (next === snapshotRef.current) {
      onExit();
      return;
    }
    suppressBlurRef.current = true;
    setSaving(true);
    try {
      await onSave(next);
    } catch {
      // Caller surfaces a toast; we just close the editor — the parent will
      // restore the prop title via its revert path.
    } finally {
      setSaving(false);
      onExit();
    }
  }, [draft, onExit, onSave, triggerShake]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      suppressBlurRef.current = true;
      onExit();
    }
  }

  return (
    <input
      ref={inputRef}
      type="text"
      data-no-drag
      disabled={disabled || saving}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={() => void commit()}
      className={cn(
        'w-full rounded-sm border border-border bg-background px-1.5 py-0.5 text-base font-semibold text-foreground outline-none transition focus:border-ring focus:ring-1 focus:ring-ring',
        shaking && 'syntaur-input-shake',
        saving && 'opacity-70',
      )}
    />
  );
}
