import { useState, useRef, useEffect } from 'react';

type TodoStatus = 'open' | 'in_progress' | 'completed' | 'blocked';

const STATUS_OPTIONS: Array<{ value: TodoStatus; icon: string; label: string; color: string }> = [
  { value: 'open', icon: '○', label: 'Open', color: 'text-muted-foreground' },
  { value: 'in_progress', icon: '◉', label: 'In Progress', color: 'text-blue-400' },
  { value: 'completed', icon: '✓', label: 'Completed', color: 'text-emerald-400' },
  { value: 'blocked', icon: '✕', label: 'Blocked', color: 'text-amber-400' },
];

interface StatusMenuProps {
  status: TodoStatus;
  onChange: (newStatus: TodoStatus) => void;
}

export function StatusMenu({ status, onChange }: StatusMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const current = STATUS_OPTIONS.find((o) => o.value === status)!;

  return (
    <div className="relative" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => setOpen(!open)}
        className={`text-lg leading-none ${current.color} hover:opacity-70 transition`}
        title={current.label}
      >
        {current.icon}
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-20 min-w-[140px] rounded-md border border-border/70 bg-background shadow-lg py-1">
          {STATUS_OPTIONS.filter((o) => o.value !== status).map((opt) => (
            <button
              key={opt.value}
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-foreground/5 transition ${opt.color}`}
            >
              <span className="text-base leading-none">{opt.icon}</span>
              <span>{opt.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
