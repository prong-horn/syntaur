import { useState } from 'react';
import { Columns3 } from 'lucide-react';
import {
  TABLE_COLUMN_IDS,
  type TableColumnId,
  type TableColumnVisibility,
} from '@shared/saved-views-schema';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './ui/dialog';

const COLUMN_LABELS: Record<TableColumnId, string> = {
  title: 'Assignment',
  status: 'Status',
  priority: 'Priority',
  assignee: 'Assignee',
  dependencies: 'Dependencies',
  created: 'Created',
  updated: 'Updated',
};

// Title is non-hideable in v1 — the row link needs somewhere to live.
const NON_HIDEABLE: ReadonlySet<TableColumnId> = new Set(['title']);

export interface TableColumnPickerProps {
  visibility: TableColumnVisibility;
  onChange: (next: TableColumnVisibility) => void;
}

export function TableColumnPicker({ visibility, onChange }: TableColumnPickerProps) {
  const [open, setOpen] = useState(false);

  function toggle(id: TableColumnId) {
    if (NON_HIDEABLE.has(id)) return;
    const isHidden = visibility.hidden.includes(id);
    const next = isHidden
      ? visibility.hidden.filter((x) => x !== id)
      : [...visibility.hidden, id];
    onChange({ hidden: next });
  }

  const hiddenCount = visibility.hidden.length;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background/60 px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-background"
          title="Show or hide table columns"
        >
          <Columns3 className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Columns{hiddenCount > 0 ? ` (${TABLE_COLUMN_IDS.length - hiddenCount}/${TABLE_COLUMN_IDS.length})` : ''}</span>
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Columns</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          {TABLE_COLUMN_IDS.map((id) => {
            const hidden = visibility.hidden.includes(id);
            const disabled = NON_HIDEABLE.has(id);
            return (
              <label
                key={id}
                className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${disabled ? 'opacity-60' : 'cursor-pointer hover:bg-background/80'}`}
              >
                <input
                  type="checkbox"
                  checked={!hidden}
                  onChange={() => toggle(id)}
                  disabled={disabled}
                  className="h-4 w-4 rounded border-border accent-foreground"
                />
                <span>{COLUMN_LABELS[id]}</span>
                {disabled ? <span className="ml-auto text-xs text-muted-foreground">always shown</span> : null}
              </label>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
