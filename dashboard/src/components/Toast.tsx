import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '../lib/utils';

export type ToastKind = 'error' | 'success';

interface ActiveToast {
  id: number;
  message: string;
  kind: ToastKind;
}

interface UseToastReturn {
  toast: ActiveToast | null;
  showToast: (message: string, kind?: ToastKind) => void;
  dismissToast: () => void;
}

const DISMISS_AFTER_MS = 4000;

export function useToast(): UseToastReturn {
  const [toast, setToast] = useState<ActiveToast | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismissToast = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setToast(null);
  }, []);

  const showToast = useCallback((message: string, kind: ToastKind = 'error') => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }
    setToast({ id: Date.now() + Math.random(), message, kind });
    timerRef.current = setTimeout(() => {
      setToast(null);
      timerRef.current = null;
    }, DISMISS_AFTER_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  return { toast, showToast, dismissToast };
}

interface ToasterProps {
  toast: ActiveToast | null;
  onDismiss: () => void;
}

export function Toaster({ toast, onDismiss }: ToasterProps) {
  if (!toast) return null;
  const isError = toast.kind === 'error';
  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex max-w-sm"
      role="status"
      aria-live="polite"
    >
      <button
        key={toast.id}
        type="button"
        onClick={onDismiss}
        className={cn(
          'syntaur-toast pointer-events-auto rounded-md border px-4 py-3 text-sm font-medium shadow-lg transition',
          isError
            ? 'border-error-foreground/30 bg-error text-error-foreground hover:opacity-90'
            : 'border-success-foreground/30 bg-success text-success-foreground hover:opacity-90',
        )}
      >
        {toast.message}
      </button>
    </div>
  );
}
