import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
} from '../ui/dialog';
import type { AgentMessageItem, ChatRecordKind, FileChatRecordInput, UserMessageItem } from '../../lib/chat-types';

const TITLES: Record<ChatRecordKind, string> = {
  decision: 'File as decision',
  progress: 'File as progress entry',
  note: 'File as note',
  question: 'File as question',
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
  const [body, setBody] = useState(() => item.text);

  useEffect(() => {
    setBody(item.text);
  }, [item, kind]);

  return (
    <form
      className="space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        const trimmed = body.trim();
        if (!trimmed) return;
        await onSubmit({ kind, body: trimmed });
      }}
    >
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{TITLES[kind]}</h2>
        <p className="text-sm text-muted-foreground">From {sourceLabel}</p>
      </div>

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
          className="rounded-md border border-border px-3 py-1.5 text-sm"
          disabled={submitting}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
          disabled={submitting || !body.trim()}
        >
          File
        </button>
      </div>
    </form>
  );
}

interface FileRecordDialogProps {
  open: boolean;
  kind: ChatRecordKind | null;
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
  if (!kind || !item) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <FileRecordForm
          kind={kind}
          item={item}
          sourceLabel={sourceLabel}
          submitting={submitting}
          onSubmit={onSubmit}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
