import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import {
  Copy,
  Check,
  Trash2,
  ArrowRightLeft,
  Paperclip,
  X,
  GitBranch,
  FileText,
} from 'lucide-react';
import { StatusMenu } from './StatusMenu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { cn } from '../lib/utils';
import { copyText } from '../lib/clipboard';
import type { TodoItem, TodoAttachment } from '../types';

// Shared todo row used by both WorkspaceTodosPage and ProjectTodosPanel. Each
// affordance does exactly one thing: clicking the text edits it, the status dot
// changes status, the checkbox only selects. The row no longer cycles status on
// click (that was the source of the "checkbox vs dot" confusion).

export interface TodoRowProps {
  item: TodoItem;
  copiedId: string | null;
  selected: boolean;
  editing: boolean;
  onBeginEdit: (id: string) => void;
  onEndEdit: () => void;
  onPatchDescription: (id: string, next: string) => Promise<void>;
  onAddAttachments: (id: string, files: File[]) => Promise<void>;
  onDeleteAttachment: (id: string, attachmentId: string) => Promise<void>;
  attachmentUrl: (id: string, attachmentId: string) => string;
  onToggleSelected: (id: string, e: React.MouseEvent | React.ChangeEvent) => void;
  onMoveOne: (id: string, e: React.MouseEvent) => void;
  onStatusChange: (id: string, status: string) => void;
  onCopyId: (e: React.MouseEvent, id: string) => void;
  onDelete: (e: React.MouseEvent, id: string, description: string) => void;
  hotkeyRowProps?: Record<string, string | number | boolean>;
  onDragOrigin: (e: React.MouseEvent<HTMLDivElement>) => void;
  onDragStart: (e: DragEvent<HTMLDivElement>, id: string) => void;
  onDragEnd: () => void;
  isDragging: boolean;
}

export function TodoRow({
  item,
  copiedId,
  selected,
  editing,
  onBeginEdit,
  onEndEdit,
  onPatchDescription,
  onAddAttachments,
  onDeleteAttachment,
  attachmentUrl,
  onToggleSelected,
  onMoveOne,
  onStatusChange,
  onCopyId,
  onDelete,
  hotkeyRowProps,
  onDragOrigin,
  onDragStart,
  onDragEnd,
  isDragging,
}: TodoRowProps) {
  return (
    <div
      draggable
      data-todo-id={item.id}
      {...(hotkeyRowProps ?? {})}
      onMouseDown={onDragOrigin}
      onDragStart={(e) => onDragStart(e, item.id)}
      onDragEnd={onDragEnd}
      className={`surface-panel flex items-start gap-3 px-3 py-2 cursor-grab active:cursor-grabbing hover:bg-foreground/[0.03] transition ${
        isDragging ? 'opacity-50 shadow-lg' : ''
      }`}
    >
      {/* Selection checkbox — selects only; never changes status. */}
      <input
        type="checkbox"
        data-no-drag
        aria-label={`Select todo ${item.id}`}
        title="Select"
        checked={selected}
        onChange={(e) => onToggleSelected(item.id, e)}
        onClick={(e) => e.stopPropagation()}
        className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-foreground"
      />
      {/* Thin divider so the selection box reads as separate from the status dot. */}
      <span className="mt-0.5 self-stretch w-px bg-border/60" aria-hidden="true" />
      {/* Status dot — the only control that changes status. */}
      <div className="mt-0.5 shrink-0">
        <StatusMenu status={item.status as any} onChange={(s) => onStatusChange(item.id, s)} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline flex-wrap gap-x-2">
          <InlineTodoText
            description={item.description}
            status={item.status}
            editing={editing}
            onBeginEdit={() => onBeginEdit(item.id)}
            onEndEdit={onEndEdit}
            onSave={(next) => onPatchDescription(item.id, next)}
          />
          {item.tags.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {item.tags.map((t) => `#${t}`).join(' ')}
            </span>
          )}
          {item.session && (
            <span className="text-xs text-info-foreground/70 font-mono">
              session:{item.session.slice(0, 8)}
            </span>
          )}
          <TodoMetaBadges item={item} />
        </div>
        <TodoAttachments
          item={item}
          attachmentUrl={attachmentUrl}
          onAdd={(files) => onAddAttachments(item.id, files)}
          onDelete={(attachmentId) => onDeleteAttachment(item.id, attachmentId)}
        />
      </div>
      {copiedId === item.id ? (
        <span className="text-xs text-status-completed-foreground flex items-center gap-1">
          <Check className="h-3 w-3" /> Copied to clipboard
        </span>
      ) : (
        <>
          <button
            data-no-drag
            className="text-xs text-muted-foreground/60 font-mono hover:text-foreground transition"
            onClick={(e) => onCopyId(e, item.id)}
          >
            t:{item.id}
          </button>
          <button
            data-no-drag
            className="text-muted-foreground/40 hover:text-foreground transition"
            title="Copy ID"
            onClick={(e) => onCopyId(e, item.id)}
          >
            <Copy className="h-3 w-3" />
          </button>
          <button
            data-no-drag
            className="text-muted-foreground/40 hover:text-foreground transition"
            title="Move to..."
            onClick={(e) => onMoveOne(item.id, e)}
          >
            <ArrowRightLeft className="h-3 w-3" />
          </button>
          <button
            data-no-drag
            className="text-muted-foreground/40 hover:text-destructive transition"
            title="Delete todo"
            onClick={(e) => onDelete(e, item.id, item.description)}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </>
      )}
    </div>
  );
}

// --- Inline description editor ----------------------------------------------

interface InlineTodoTextProps {
  description: string;
  status: TodoItem['status'];
  editing: boolean;
  onBeginEdit: () => void;
  onEndEdit: () => void;
  onSave: (next: string) => Promise<void>;
}

export function InlineTodoText({ description, status, editing, onBeginEdit, onEndEdit, onSave }: InlineTodoTextProps) {
  if (!editing) {
    return (
      <button
        type="button"
        data-no-drag
        onClick={(e) => {
          e.stopPropagation();
          onBeginEdit();
        }}
        title="Click to edit"
        className={cn(
          'text-left text-sm rounded-sm transition hover:text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          status === 'completed' ? 'line-through text-muted-foreground' : 'text-foreground',
        )}
      >
        {description}
      </button>
    );
  }
  return <EditingTodoInput initialValue={description} onSave={onSave} onExit={onEndEdit} />;
}

interface EditingTodoInputProps {
  initialValue: string;
  onSave: (next: string) => Promise<void>;
  onExit: () => void;
}

function EditingTodoInput({ initialValue, onSave, onExit }: EditingTodoInputProps) {
  // initialValue is consulted only on mount: a WS-driven refetch must not clobber
  // the in-flight draft, and a blur-without-change is compared against what the user
  // saw when they began editing.
  const snapshotRef = useRef(initialValue);
  const [draft, setDraft] = useState(initialValue);
  const [saving, setSaving] = useState(false);
  const [shaking, setShaking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
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
    if (next === snapshotRef.current) {
      onExit();
      return;
    }
    suppressBlurRef.current = true;
    setSaving(true);
    try {
      await onSave(next);
    } catch {
      // caller surfaces errors; just close and let the prop value reassert.
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
      disabled={saving}
      value={draft}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={() => void commit()}
      className={cn(
        'w-full rounded-sm border border-border bg-background px-1.5 py-0.5 text-sm text-foreground outline-none transition focus:border-ring focus:ring-1 focus:ring-ring',
        shaking && 'syntaur-input-shake',
        saving && 'opacity-70',
      )}
    />
  );
}

// --- Attachments -------------------------------------------------------------

function isThumbnailMime(mime: string): boolean {
  return mime.startsWith('image/') && mime !== 'image/svg+xml';
}

function filesFromClipboard(e: React.ClipboardEvent): File[] {
  const dt = e.clipboardData;
  const out: File[] = [];
  if (dt.files && dt.files.length) out.push(...Array.from(dt.files));
  if (!out.length && dt.items) {
    for (const it of Array.from(dt.items)) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  return out;
}

interface TodoAttachmentsProps {
  item: TodoItem;
  attachmentUrl: (todoId: string, attachmentId: string) => string;
  onAdd: (files: File[]) => Promise<void>;
  onDelete: (attachmentId: string) => Promise<void>;
}

export function TodoAttachments({ item, attachmentUrl, onAdd, onDelete }: TodoAttachmentsProps) {
  const attachments = item.attachments ?? [];
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  // Focus the dropzone when it opens so Cmd/Ctrl+V pastes into it immediately.
  useEffect(() => {
    if (open) dropRef.current?.focus();
  }, [open]);

  const add = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      setBusy(true);
      try {
        await onAdd(files);
        setOpen(false);
      } finally {
        setBusy(false);
      }
    },
    [onAdd],
  );

  return (
    <div className="mt-1" data-no-drag onClick={(e) => e.stopPropagation()}>
      <div className="flex flex-wrap items-center gap-1.5">
        {attachments.map((att) => (
          <AttachmentChip
            key={att.id}
            att={att}
            url={attachmentUrl(item.id, att.id)}
            onDelete={() => void onDelete(att.id)}
          />
        ))}
        <button
          type="button"
          data-no-drag
          title="Attach files"
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-1 rounded-md border border-border/60 px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:border-border transition"
        >
          <Paperclip className="h-3 w-3" />
          {attachments.length === 0 ? 'Attach' : ''}
        </button>
      </div>
      {open && (
        <div
          ref={dropRef}
          data-no-drag
          tabIndex={0}
          role="button"
          aria-label="Add attachments: drop, paste, or click"
          onPaste={(e) => {
            const files = filesFromClipboard(e);
            if (files.length) {
              e.preventDefault();
              void add(files);
            }
          }}
          onDragOver={(e) => {
            if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
          }}
          onDrop={(e) => {
            const files = Array.from(e.dataTransfer.files);
            if (files.length) {
              e.preventDefault();
              void add(files);
            }
          }}
          onClick={() => fileInputRef.current?.click()}
          className="mt-1 cursor-pointer rounded-md border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground hover:border-border focus:outline-none focus:ring-2 focus:ring-ring/40"
        >
          {busy ? 'Uploading…' : 'Drop, paste (⌘V / Ctrl+V), or click to add files'}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              void add(files);
            }}
          />
        </div>
      )}
    </div>
  );
}

function AttachmentChip({ att, url, onDelete }: { att: TodoAttachment; url: string; onDelete: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background px-1.5 py-0.5 text-xs">
      {isThumbnailMime(att.mime) ? (
        <a href={url} target="_blank" rel="noopener noreferrer" title={att.filename}>
          <img src={url} alt={att.filename} className="h-6 w-6 rounded object-cover" />
        </a>
      ) : (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-foreground hover:text-primary"
        >
          <Paperclip className="h-3 w-3" />
          <span className="block max-w-[160px] truncate">{att.filename}</span>
        </a>
      )}
      <button
        type="button"
        title="Remove attachment"
        onClick={onDelete}
        className="text-muted-foreground/60 hover:text-destructive transition"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

// --- Meta badges (moved here from WorkspaceTodosPage so both pages share it) --

export function TodoMetaBadges({ item }: { item: TodoItem }) {
  const hasMeta = !!(item.branch || item.planDir || item.worktreePath || item.createdAt || item.updatedAt);
  if (!hasMeta) return null;
  return (
    <span className="inline-flex items-center gap-1 align-middle">
      {item.branch ? (
        <TooltipProvider delayDuration={120}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center gap-1 rounded-full border border-info-foreground/30 bg-info/30 px-1.5 py-0.5 text-[10px] font-mono text-info-foreground">
                <GitBranch className="h-2.5 w-2.5" />
                <span className="block min-w-0 max-w-[120px] truncate">{item.branch}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent>{item.branch}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : null}
      {item.planDir ? (
        <TooltipProvider delayDuration={120}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                data-no-drag
                onClick={(e) => {
                  e.stopPropagation();
                  void copyText(item.planDir!);
                }}
                className="inline-flex items-center rounded-full border border-status-completed-foreground/40 bg-status-completed/30 p-1 text-status-completed-foreground hover:bg-status-completed/50"
                aria-label="Copy plan directory path"
              >
                <FileText className="h-2.5 w-2.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Plan: {item.planDir}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : null}
      {item.worktreePath || item.createdAt || item.updatedAt ? (
        <TooltipProvider delayDuration={120}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-[10px] text-muted-foreground/60 cursor-default">·</span>
            </TooltipTrigger>
            <TooltipContent>
              <div className="space-y-0.5 text-xs font-mono">
                {item.worktreePath ? <div>worktree: {item.worktreePath}</div> : null}
                {item.createdAt ? <div>created: {item.createdAt}</div> : null}
                {item.updatedAt ? <div>updated: {item.updatedAt}</div> : null}
              </div>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : null}
    </span>
  );
}
