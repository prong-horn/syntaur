import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/utils';
import { getStatusMeta, getStatusPillClassName } from './StatusBadge';
import type { AssignmentTransitionAction } from '../hooks/useProjects';

interface StatusPillPickerProps {
  currentStatus: string;
  availableTransitions: AssignmentTransitionAction[];
  onSelect: (action: AssignmentTransitionAction) => void;
  disabled?: boolean;
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
  disabled = false,
}: StatusPillPickerProps) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const currentMeta = getStatusMeta(currentStatus);
  const CurrentIcon = currentMeta.icon;

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
  }, [open, availableTransitions.length]);

  function handleTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
    }
  }

  function handleMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (availableTransitions.length === 0) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu(true);
      }
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlightIndex((i) => (i + 1) % availableTransitions.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlightIndex((i) => (i - 1 + availableTransitions.length) % availableTransitions.length);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setHighlightIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setHighlightIndex(availableTransitions.length - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const action = availableTransitions[highlightIndex];
      if (action) {
        onSelect(action);
        closeMenu(true);
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu(true);
    }
  }

  function handleOptionClick(action: AssignmentTransitionAction) {
    onSelect(action);
    closeMenu(false);
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
        title={`Status: ${currentMeta.label}. Click to change.`}
        className={cn(
          getStatusPillClassName(currentStatus),
          'cursor-pointer transition hover:brightness-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          disabled && 'cursor-not-allowed opacity-60',
        )}
      >
        <CurrentIcon className="h-3.5 w-3.5" />
        <span>{currentMeta.label}</span>
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
              {availableTransitions.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted-foreground">
                  No transitions available from this status.
                </div>
              ) : (
                availableTransitions.map((action, index) => {
                  const targetMeta = getStatusMeta(action.targetStatus);
                  const TargetIcon = targetMeta.icon;
                  const highlighted = index === highlightIndex;
                  return (
                    <button
                      key={`${action.command}:${action.targetStatus}`}
                      type="button"
                      role="menuitem"
                      data-no-drag
                      onMouseEnter={() => setHighlightIndex(index)}
                      onClick={() => handleOptionClick(action)}
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
                          {targetMeta.label}
                        </span>
                      </span>
                      {action.warning ? (
                        <span className="text-[11px] leading-snug text-warning-foreground">
                          {action.warning}
                        </span>
                      ) : null}
                    </button>
                  );
                })
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
