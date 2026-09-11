import { useHotkeyScope } from '../hotkeys';

export function Overview() {
  useHotkeyScope('list:overview');

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <p className="eyebrow">Overview</p>
        <h1 className="text-4xl font-semibold tracking-display text-foreground md:text-5xl">
          What needs you today
        </h1>
      </header>
    </div>
  );
}
