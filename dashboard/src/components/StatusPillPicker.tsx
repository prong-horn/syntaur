import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/utils';
import { STATUS_PILL_BASE, getStatusIcon } from './StatusBadge';
import { useStatusConfig, getStatusLabel } from '../hooks/useStatusConfig';
import { resolveStatusAppearance } from '../lib/statusMeta';
import type { StatusOverrideTarget } from '../lib/statusMeta';
import type { AssignmentTransitionAction } from '../hooks/useProjects';

interface StatusPillPickerProps {
  currentStatus: string;
  availableTransitions: AssignmentTransitionAction[];
  onSelect: (action: AssignmentTransitionAction) => void;
  /** Config-driven direct-set targets, rendered as an "Override → …" section. */
  overrideTargets?: StatusOverrideTarget[];
  onOverride?: (statusId: string) => void;
  disabled?: boolean;
  className?: string;
}

interface AnchorRect {
  top: number;
  left: number;
  width: number;
  bottom: number;
}

export function StatusPillPicker({
  currentStatus,
  availableTransitions,
  onSelect,
  overrideTargets,
  onOverride,
  disabled = false,
  className,
}: StatusPillPickerProps) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const config = useStatusConfig();
  const triggerAppearance = resolveStatusAppearance(config.statuses, currentStatus);
  const CurrentIcon = getStatusIcon(currentStatus);

  // Single combined list so keyboard nav traverses transitions then overrides.
  const overrides = overrideTargets ?? [];
  const itemCount = availableTransitions.length + overrides.length;

  const closeMenu = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) {
      // Defer to next frame so React has finished unmounting the menu.
      requestAnimationFrame(() => {
        triggerRef.current?.focus();
      });
    }
  }, []);

  const updateAnchor = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor({
      top: rect.top,
      left: rect.left,
      width: rect.width,
      bottom: rect.bottom,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updateAnchor();
  }, [open, updateAnchor]);

  useEffect(() => {
    if (!open) return;
    const handler = () => updateAnchor();
    window.addEventListener('scroll', handler, true);
    window.addEventListener('resize', handler);
    return () => {
      window.removeEventListener('scroll', handler, true);
      window.removeEventListener('resize', handler);
    };
  }, [open, updateAnchor]);

  useEffect(() => {
    if (!open) return;
    const onDocPointer = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      closeMenu(false);
    };
    document.addEventListener('mousedown', onDocPointer);
    return () => document.removeEventListener('mousedown', onDocPointer);
  }, [open, closeMenu]);

  useEffect(() => {
    if (!open) return;
    setHighlightIndex(0);
  }, [open, itemCount]);

  function isOverrideActionable(target: StatusOverrideTarget): boolean {
    return !target.disabled && target.id !== currentStatus;
  }

  /** Activate the menu item at `index` (transition first, then override). */
  function activateItem(index: number) {
    if (index < availableTransitions.length) {
      const action = availableTransitions[index];
      if (action) {
        onSelect(action);
        closeMenu(true);
      }
      return;
    }
    const target = overrides[index - availableTransitions.length];
    if (target && isOverrideActionable(target)) {
      onOverride?.(target.id);
      closeMenu(true);
    }
  }

  function handleTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
    }
  }

  function handleMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (itemCount === 0) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu(true);
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlightIndex((i) => (i + 1) % itemCount);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlightIndex((i) => (i - 1 + itemCount) % itemCount);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setHighlightIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setHighlightIndex(itemCount - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      activateItem(highlightIndex);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu(true);
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-no-drag
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          if (disabled) return;
          setOpen((o) => !o);
        }}
        onKeyDown={handleTriggerKeyDown}
        title={`Status: ${triggerAppearance.label}. Click to change.`}
        style={triggerAppearance.style}
        className={cn(
          STATUS_PILL_BASE,
          triggerAppearance.className,
          className,
          'cursor-pointer transition hover:brightness-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          disabled && 'cursor-not-allowed opacity-60',
        )}
      >
        <CurrentIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 truncate">{triggerAppearance.label}</span>
      </button>

      {open && anchor && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              role="menu"
              tabIndex={-1}
              autoFocus
              onKeyDown={handleMenuKeyDown}
              style={{
                position: 'fixed',
                top: anchor.bottom + 6,
                left: anchor.left,
                minWidth: Math.max(anchor.width, 180),
                zIndex: 60,
              }}
              className="rounded-md border border-border/70 bg-popover py-1 text-sm text-popover-foreground shadow-lg"
            >
              {itemCount === 0 ? (
                <div className="px-3 py-2 text-xs text-muted-foreground">
                  No status changes available from this status.
                </div>
              ) : (
                <>
                  {availableTransitions.map((action, index) => {
                    const TargetIcon = getStatusIcon(action.targetStatus);
                    const highlighted = index === highlightIndex;
                    return (
                      <button
                        key={`${action.command}:${action.targetStatus}`}
                        type="button"
                        role="menuitem"
                        data-no-drag
                        onMouseEnter={() => setHighlightIndex(index)}
                        onClick={() => activateItem(index)}
                        title={action.warning || action.description}
                        className={cn(
                          'flex w-full flex-col items-stretch gap-0.5 px-3 py-1.5 text-left text-sm transition',
                          highlighted ? 'bg-foreground/5' : 'hover:bg-foreground/5',
                        )}
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="flex min-w-0 items-center gap-2">
                            <TargetIcon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                            <span className="truncate">{action.label}</span>
                          </span>
                          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                            {getStatusLabel(config, action.targetStatus)}
                          </span>
                        </span>
                        {action.warning ? (
                          <span className="text-[11px] leading-snug text-warning-foreground">
                            {action.warning}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}

                  {overrides.length > 0 && availableTransitions.length > 0 ? (
                    <div className="my-1 border-t border-border/60" role="separator" />
                  ) : null}

                  {overrides.map((target, i) => {
                    const index = availableTransitions.length + i;
                    const highlighted = index === highlightIndex;
                    const inactive = !isOverrideActionable(target);
                    const appearance = resolveStatusAppearance(config.statuses, target.id);
                    return (
                      <button
                        key={`override-${target.id}`}
                        type="button"
                        role="menuitem"
                        data-no-drag
                        disabled={inactive}
                        onMouseEnter={() => setHighlightIndex(index)}
                        onClick={() => activateItem(index)}
                        title={
                          inactive
                            ? target.disabledReason ??
                              (target.id === currentStatus ? 'Already in this status' : undefined)
                            : `Set status to ${target.label}`
                        }
                        className={cn(
                          'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm transition',
                          inactive
                            ? 'cursor-not-allowed text-muted-foreground/60'
                            : highlighted
                              ? 'bg-foreground/5'
                              : 'hover:bg-foreground/5',
                        )}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          {/* Config-driven color swatch so the override list matches
                              the trigger/badge styling (hex → solid dot, else class). */}
                          <span
                            aria-hidden="true"
                            className={cn(
                              'h-2.5 w-2.5 flex-shrink-0 rounded-full border border-border/40',
                              appearance.style ? undefined : appearance.className,
                            )}
                            style={appearance.style ? { backgroundColor: appearance.style.color } : undefined}
                          />
                          <span className="truncate">Override → {target.label}</span>
                        </span>
                      </button>
                    );
                  })}
                </>
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
