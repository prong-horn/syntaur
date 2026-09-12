import { useRef, useState } from 'react';
import {
  Square,
  Pin,
  PinOff,
  Archive,
  ArchiveRestore,
  Pencil,
  Trash2,
  MoreHorizontal,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { ContextMenuPopover } from './ContextMenuPopover';
import type { OverflowMenuItem } from './OverflowMenu';
import { cn } from '../lib/utils';
import type { AgentSessionWithLiveness } from '../types';

interface SessionActionButtonsProps {
  session: AgentSessionWithLiveness;
  /**
   * Invoked when the user clicks Mark-stopped. The callback should PATCH
   * `/api/agent-sessions/<sessionId>` with `{ status: 'stopped' }` and
   * rely on the websocket `agent-sessions-updated` event to refresh the
   * row — no local optimistic state.
   */
  onMarkStopped: (sessionId: string) => void;
  /**
   * Invoked when the user toggles the pin. The callback should PATCH
   * `/api/agent-sessions/<sessionId>/curation` with `{ pinned }` and rely on
   * the websocket refresh — no local optimistic state. Omit to hide the control.
   */
  onTogglePin?: (sessionId: string, pinned: boolean) => void;
  /**
   * Invoked when the user toggles archive. Same contract as {@link onTogglePin},
   * with `{ archived }`. Omit to hide the control.
   */
  onToggleArchive?: (sessionId: string, archived: boolean) => void;
  /**
   * Invoked when the user renames the session. Same contract, with `{ name }`.
   * A name is `description` written with `description_source = 'human'`, which
   * the auto-summarizer will not overwrite. Omit to hide the control.
   */
  onRename?: (sessionId: string) => void;
  /**
   * Invoked when the user picks Delete. Destructive and irreversible, so the
   * caller is expected to raise a confirm dialog rather than delete on the
   * click. Omit to hide the control.
   */
  onDelete?: (sessionId: string) => void;
  /**
   * `inline` (default) renders every action as its own labelled button — the
   * ticket-detail list has a wrapping flex row and plenty of width.
   *
   * `compact` keeps only Pin visible and folds the rest into a `⋯` menu, for
   * the Agent Sessions table where the actions live in the last column of a
   * horizontally scrolling twelve-column table. See the layout note below.
   */
  layout?: 'inline' | 'compact';
}

/**
 * One action in the row. Both layouts render from this single list, so a new
 * action cannot appear in the table but go missing from the ticket page.
 */
interface RowAction {
  key: string;
  /** Button text in the inline layout; falls back as the menu label. */
  label: string;
  /** Menu text when the terse inline label reads badly on its own row. */
  menuLabel?: string;
  /** Accessible name — required in the compact layout, where buttons are icon-only. */
  ariaLabel?: string;
  icon: LucideIcon;
  /** Hover help for the inline layout. */
  tooltip: string;
  /** Inert with no explanation — a transient state such as a pending preflight. */
  disabled?: boolean;
  /** Inert *and* explains why; shown in place of `tooltip` in both layouts. */
  disabledReason?: string;
  destructive?: boolean;
  /** Stays a visible button in the compact layout instead of folding into the menu. */
  standalone?: boolean;
  ariaPressed?: boolean;
  onSelect?: () => void;
}

/**
 * Per-row action group rendered on the standalone `/agent-sessions` page and on
 * embedded `AgentSessionsSection` lists under ticket detail pages.
 *
 * Affordances, in render order:
 *
 *   | Icon            | Hidden when           | Action |
 *   |-----------------|-----------------------|--------|
 *   | Square (Stop)   | status !== 'active'   | PATCH /api/agent-sessions/<id> |
 *   | Pencil (Rename) | usageOnly, or no onRename        | PATCH /api/agent-sessions/<id>/curation |
 *   | Pin / PinOff    | usageOnly, or no onTogglePin     | PATCH /api/agent-sessions/<id>/curation |
 *   | Archive/Restore | usageOnly, or no onToggleArchive | PATCH /api/agent-sessions/<id>/curation |
 *   | Trash2 (Delete) | usageOnly, or no onDelete        | caller confirms, then DELETE |
 *
 * Resume and Fork are GONE (phase 4): they re-fired a deep link into a
 * terminal, and their capability flags came from the agent's terminal profile.
 * What is left is session curation, which the chat does not replace.
 *
 * The `usageOnly` gate lives INSIDE this component rather than only at the call
 * site (D12): a usage-only row is synthesized from usage_events and has no DB
 * row, so a curation PATCH would 404. `AgentSessionsPage` wraps this component
 * in a `!session.usageOnly` guard but `AgentSessionsSection` does not, so the
 * internal gate is what makes the component correct at both call sites.
 *
 * Layout. Labelled buttons overflow the Agent Sessions table's last
 * column, which pushed Pin and Archive off the right edge of the viewport — the
 * whole point of the feature was that they be the *quickest* thing on the row.
 * `layout="compact"` therefore keeps Pin visible (it is the one action you take
 * repeatedly, and its pressed state is worth seeing without opening anything)
 * and folds the rest behind `⋯`. The menu is `ContextMenuPopover` rather than
 * `OverflowMenu` because the table scrolls under `overflow-x-auto`, which
 * clips an absolutely-positioned dropdown; the popover is fixed-positioned and
 * escapes the scroll container.
 */
export function SessionActionButtons({
  session,
  onMarkStopped,
  onTogglePin,
  onToggleArchive,
  onRename,
  onDelete,
  layout = 'inline',
}: SessionActionButtonsProps) {
  const [menuAnchor, setMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  // D12/H7: synthetic usage-only rows have no DB row to curate.
  const curatable = !session.usageOnly;
  const isPinned = Boolean(session.pinnedAt);
  const isArchived = Boolean(session.archivedAt);

  const iconClass = 'size-3.5';
  const btnClass = cn(
    'shell-action',
    'inline-flex items-center justify-center px-2 py-1 text-xs',
    'disabled:cursor-not-allowed disabled:opacity-50',
  );
  // Disabled <button> elements don't emit hover/focus events reliably across
  // browsers, so a tooltip attached directly to one won't show and isn't
  // keyboard reachable. Wrap disabled buttons in a focusable span and use that
  // as the TooltipTrigger (same pattern as OverflowMenu / ContextMenuPopover).
  const disabledTriggerClass = 'inline-flex outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm';

  const actions: RowAction[] = [];

  if (session.status === 'active') {
    actions.push({
      key: 'mark-stopped',
      label: 'Mark stopped',
      icon: Square,
      tooltip: 'Tell the dashboard this session has ended',
      onSelect: () => onMarkStopped(session.sessionId),
    });
  }

  if (curatable && onRename) {
    actions.push({
      key: 'rename',
      label: session.description ? 'Rename' : 'Name',
      menuLabel: session.description ? 'Rename session' : 'Name session',
      ariaLabel: session.description ? 'Rename session' : 'Name session',
      icon: Pencil,
      tooltip: session.descriptionSource === 'auto'
        ? 'Replace the auto-generated summary with your own name — the summarizer will stop overwriting it'
        : 'Give this session a name you will recognise later',
      onSelect: () => onRename(session.sessionId),
    });
  }

  if (curatable && onTogglePin) {
    actions.push({
      key: 'pin',
      label: isPinned ? 'Unpin' : 'Pin',
      ariaLabel: isPinned ? 'Unpin session' : 'Pin session',
      icon: isPinned ? PinOff : Pin,
      tooltip: isPinned
        ? 'Stop keeping this session at the top of the list'
        : 'Keep this session at the top of the list and on the Overview page',
      ariaPressed: isPinned,
      // Never folds into the `⋯` menu — see the Layout note above.
      standalone: true,
      onSelect: () => onTogglePin(session.sessionId, !isPinned),
    });
  }

  if (curatable && onToggleArchive) {
    actions.push({
      key: 'archive',
      label: isArchived ? 'Unarchive' : 'Archive',
      menuLabel: isArchived ? 'Unarchive session' : 'Archive session',
      ariaLabel: isArchived ? 'Unarchive session' : 'Archive session',
      icon: isArchived ? ArchiveRestore : Archive,
      tooltip: isArchived
        ? 'Bring this session back into the default list'
        : 'Hide this session from the default list — nothing is deleted',
      ariaPressed: isArchived,
      onSelect: () => onToggleArchive(session.sessionId, !isArchived),
    });
  }

  if (curatable && onDelete) {
    actions.push({
      key: 'delete',
      label: 'Delete',
      menuLabel: 'Delete session',
      ariaLabel: 'Delete session',
      icon: Trash2,
      tooltip: 'Remove this session record for good — Archive hides it without deleting anything',
      destructive: true,
      onSelect: () => onDelete(session.sessionId),
    });
  }

  // Not a component: returning JSX from a plain function keeps these buttons as
  // inline elements of the parent, so a re-render doesn't remount them and drop
  // an open tooltip.
  function renderActionButton(action: RowAction, iconOnly: boolean) {
    const Icon = action.icon;
    const inert = action.disabled || Boolean(action.disabledReason);
    const help = action.disabledReason ?? action.tooltip;
    const button = (
      <button
        type="button"
        className={cn(btnClass, action.destructive && 'text-destructive')}
        disabled={inert}
        aria-disabled={inert || undefined}
        aria-pressed={action.ariaPressed}
        aria-label={action.ariaLabel ?? (iconOnly ? action.label : undefined)}
        onClick={inert ? undefined : action.onSelect}
      >
        <Icon className={iconClass} />
        {!iconOnly && <span>{action.label}</span>}
      </button>
    );

    return (
      <Tooltip key={action.key}>
        <TooltipTrigger asChild>
          {inert ? (
            <span tabIndex={0} className={disabledTriggerClass}>
              {button}
            </span>
          ) : (
            button
          )}
        </TooltipTrigger>
        <TooltipContent side="top">{help}</TooltipContent>
      </Tooltip>
    );
  }

  if (layout === 'inline') {
    return (
      <TooltipProvider delayDuration={200}>
        <div className="inline-flex items-center gap-1">
          {actions.map((action) => renderActionButton(action, false))}
        </div>
      </TooltipProvider>
    );
  }

  const menuItems: OverflowMenuItem[] = actions
    .filter((action) => !action.standalone)
    .map((action) => ({
      key: action.key,
      label: action.menuLabel ?? action.label,
      icon: action.icon,
      onSelect: action.onSelect,
      disabled: action.disabled || Boolean(action.disabledReason),
      disabledReason: action.disabledReason,
      destructive: action.destructive,
    }));

  function toggleMenu() {
    if (menuAnchor) {
      setMenuAnchor(null);
      return;
    }
    const rect = menuButtonRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    // ContextMenuPopover clamps the menu into the viewport, so anchoring at the
    // button's bottom-left is enough to keep a right-edge menu fully on screen.
    setMenuAnchor({ x: rect.left, y: rect.bottom + 4 });
  }

  return (
    <>
      <TooltipProvider delayDuration={200}>
        <div className="inline-flex items-center gap-1">
          {actions
            .filter((action) => action.standalone)
            .map((action) => renderActionButton(action, true))}
          {menuItems.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  ref={menuButtonRef}
                  type="button"
                  className={btnClass}
                  aria-haspopup="menu"
                  aria-expanded={menuAnchor !== null}
                  aria-label="More actions"
                  onClick={toggleMenu}
                >
                  <MoreHorizontal className={iconClass} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">More actions</TooltipContent>
            </Tooltip>
          )}
        </div>
      </TooltipProvider>
      <ContextMenuPopover
        anchor={menuAnchor}
        items={menuItems}
        anchorRef={menuButtonRef}
        onClose={() => setMenuAnchor(null)}
      />
    </>
  );
}
