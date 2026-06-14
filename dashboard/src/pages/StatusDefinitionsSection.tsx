import { Plus, Trash2, GripVertical } from 'lucide-react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { SectionCard } from '../components/SectionCard';
import { ColorPicker } from '../components/ColorPicker';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip';
import type { EditableStatus } from './status-section-helpers';

interface SortableStatusRowProps {
  row: EditableStatus;
  isSaved: boolean;
  onUpdate: (field: keyof EditableStatus, value: string | boolean) => void;
  onRemove: () => void;
}

function SortableStatusRow({ row, isSaved, onUpdate, onRemove }: SortableStatusRowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: row.rowKey });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    position: isDragging ? ('relative' as const) : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`surface-panel flex flex-wrap items-center gap-3 px-3 py-2 ${
        isDragging ? 'opacity-60 shadow-lg' : ''
      }`}
    >
      <button
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        type="button"
        aria-label="Drag to reorder"
        className="cursor-grab active:cursor-grabbing text-muted-foreground/40 hover:text-muted-foreground transition touch-none"
      >
        <GripVertical className="h-4 w-4" />
      </button>

      {/* ID */}
      <div className="min-w-[8rem] flex-1">
        {isSaved ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <input
                type="text"
                value={row.id}
                readOnly
                aria-label="Status ID"
                className="editor-input w-full text-sm cursor-not-allowed opacity-60"
              />
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-xs font-normal normal-case tracking-normal">
              To rename a saved status, delete the row and create a new one (this triggers the orphan-resolution flow if assignments still reference it).
            </TooltipContent>
          </Tooltip>
        ) : (
          <input
            type="text"
            value={row.id}
            onChange={(e) => onUpdate('id', e.target.value)}
            aria-label="Status ID"
            className="editor-input w-full text-sm"
          />
        )}
      </div>

      {/* Label */}
      <div className="min-w-[8rem] flex-1">
        <input
          type="text"
          value={row.label}
          onChange={(e) => onUpdate('label', e.target.value)}
          aria-label="Status label"
          className="editor-input w-full text-sm"
        />
      </div>

      {/* Description */}
      <div className="min-w-[10rem] flex-1">
        <input
          type="text"
          value={row.description}
          onChange={(e) => onUpdate('description', e.target.value)}
          aria-label="Status description"
          placeholder="description (optional)"
          className="editor-input w-full text-sm"
        />
      </div>

      {/* Color */}
      <ColorPicker
        value={row.color}
        onChange={(color) => onUpdate('color', color)}
        ariaLabel={`Color for ${row.label || row.id}`}
      />

      {/* Done-state toggle */}
      <div className="flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-help text-xs text-muted-foreground underline decoration-dotted underline-offset-4">
              Done
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs text-xs font-normal normal-case tracking-normal">
            When enabled, assignments in this status count as finished — they fill the "done" portion of progress bars and satisfy dependency requirements.
          </TooltipContent>
        </Tooltip>
        <button
          type="button"
          role="switch"
          aria-checked={row.terminal}
          aria-label={`Done state for ${row.label || row.id}`}
          onClick={() => onUpdate('terminal', !row.terminal)}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
            row.terminal ? 'bg-primary' : 'bg-muted'
          }`}
        >
          <span
            className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-sm ring-0 transition-transform ${
              row.terminal ? 'translate-x-4' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      {/* Delete */}
      <button
        type="button"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={onRemove}
        title="Remove status"
        aria-label={`Remove status ${row.id}`}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

interface StatusDefinitionsSectionProps {
  statuses: EditableStatus[];
  savedStatusIds: Set<string>; // lifted orphan-resolution state; drives each row's read-only-vs-editable ID field
  onUpdate: (index: number, field: keyof EditableStatus, value: string | boolean) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onReorder: (next: EditableStatus[]) => void; // section computes arrayMove(prev, old, new) and hands back the reordered array
}

export function StatusDefinitionsSection({
  statuses,
  savedStatusIds,
  onUpdate,
  onAdd,
  onRemove,
  onReorder,
}: StatusDefinitionsSectionProps) {
  // KeyboardSensor needs the sortable coordinate getter so arrow keys move rows
  // within the list (a bare KeyboardSensor only nudges by pixel delta).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = statuses.findIndex((s) => s.rowKey === active.id);
    const newIndex = statuses.findIndex((s) => s.rowKey === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    onReorder(arrayMove(statuses, oldIndex, newIndex));
  }

  return (
    <SectionCard
      title="Status Definitions"
      description="Define the statuses assignments can have. Drag rows to set the display order used by Kanban columns, progress bars, and dropdowns."
      actions={
        <button className="shell-action text-xs" onClick={onAdd}>
          <Plus className="h-3 w-3" />
          Add Status
        </button>
      }
    >
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={statuses.map((s) => s.rowKey)} strategy={verticalListSortingStrategy}>
          <div className="space-y-2">
            {statuses.map((s, i) => (
              <SortableStatusRow
                key={s.rowKey}
                row={s}
                isSaved={savedStatusIds.has(s.id)}
                onUpdate={(field, value) => onUpdate(i, field, value)}
                onRemove={() => onRemove(i)}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </SectionCard>
  );
}
