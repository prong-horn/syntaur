import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
} from '../ui/dialog';
import type { AgentMessageItem, ChatRecordKind, FileChatRecordInput, UserMessageItem } from '../../lib/chat-types';
import { defaultRecordTitle } from '../../lib/chat-records';

const TITLES: Record<ChatRecordKind, string> = {
  decision: 'File as decision',
  progress: 'File as progress entry',
  comment: 'File as comment',
};

export interface FileRecordFormProps {
  kind: ChatRecordKind;
  item: UserMessageItem | AgentMessageItem;
  sourceLabel: string;
  submitting: boolean;
  onSubmit(input: FileChatRecordInput): Promise<void>;
  onCancel(): void;
}

export function FileRecordForm({
  kind,
  item,
  sourceLabel,
  submitting,
  onSubmit,
  onCancel,
}: FileRecordFormProps) {
  const [title, setTitle] = useState(() => (kind === 'decision' ? defaultRecordTitle(item.text) : ''));
  const [body, setBody] = useState(() => item.text);
  const [commentType, setCommentType] = useState<'note' | 'feedback' | 'question'>('note');

  useEffect(() => {
    setBody(item.text);
    setTitle(kind === 'decision' ? defaultRecordTitle(item.text) : '');
    setCommentType('note');
  }, [item, kind]);

  return (
    <form
      className="space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        const trimmed = body.trim();
        if (!trimmed) return;
        await onSubmit({
          kind,
          body: trimmed,
          ...(kind === 'decision' ? { title: title.trim() } : {}),
          ...(kind === 'comment' ? { commentType } : {}),
        });
      }}
    >
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{TITLES[kind]}</h2>
        <p className="text-sm text-muted-foreground">From {sourceLabel}</p>
      </div>

      {kind === 'decision' && (
        <label className="block space-y-1 text-sm">
          <span className="text-muted-foreground">Title</span>
          <input
            value={title}
            required
            disabled={submitting}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded-md border border-border/70 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
      )}

      {kind === 'comment' && (
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name="file-comment-type"
              value="note"
              checked={commentType === 'note'}
              onChange={() => setCommentType('note')}
            />
            note
          </label>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name="file-comment-type"
              value="feedback"
              checked={commentType === 'feedback'}
              onChange={() => setCommentType('feedback')}
            />
            feedback
          </label>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              name="file-comment-type"
              value="question"
              checked={commentType === 'question'}
              onChange={() => setCommentType('question')}
            />
            question
          </label>
        </div>
      )}

      <textarea
        value={body}
        required
        rows={10}
        disabled={submitting}
        onChange={(e) => setBody(e.target.value)}
        className="w-full rounded-md border border-border/70 bg-background px-3 py-2 text-sm leading-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />

      <div className="flex justify-end gap-2">
        <button
          type="button"
          disabled={submitting}
          onClick={onCancel}
          className="rounded-md border border-border/70 px-3 py-1.5 text-sm hover:bg-muted"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting || !body.trim() || (kind === 'decision' && !title.trim())}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          File
        </button>
      </div>
    </form>
  );
}

export interface FileRecordDialogProps {
  open: boolean;
  kind: ChatRecordKind;
  item: UserMessageItem | AgentMessageItem | null;
  sourceLabel: string;
  submitting: boolean;
  onSubmit(input: FileChatRecordInput): Promise<void>;
  onOpenChange(open: boolean): void;
}

export function FileRecordDialog({
  open,
  kind,
  item,
  sourceLabel,
  submitting,
  onSubmit,
  onOpenChange,
}: FileRecordDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => (!submitting ? onOpenChange(next) : undefined)}>
      <DialogContent className="max-w-xl">
        {item && (
          <FileRecordForm
            kind={kind}
            item={item}
            sourceLabel={sourceLabel}
            submitting={submitting}
            onSubmit={onSubmit}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
