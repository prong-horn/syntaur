import { Link, useLocation } from 'react-router-dom';
import { ChevronDown, type LucideIcon } from 'lucide-react';
import { cn } from '../lib/utils';
import { isSidebarItemActive, type SidebarSection } from '../lib/routes';

export interface SidebarNavItem {
  to: SidebarSection;
  label: string;
  icon: LucideIcon;
  /** Optional numeric pill rendered next to the label (e.g. inbox count). */
  badge?: number;
}

// Shared nav row, used by both the flat `SidebarNav` and the collapsible
// `SidebarNavGroup` so active styling, the badge pill, and the `/w/` guard stay
// in one place.
function SidebarNavLink({ item, onNavigate }: { item: SidebarNavItem; onNavigate?: () => void }) {
  const location = useLocation();
  const Icon = item.icon;
  const isActive = isSidebarItemActive(location.pathname, item.to)
    && !location.pathname.startsWith('/w/');

  return (
    <Link
      to={item.to}
      onClick={onNavigate}
      className={cn(
        'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition',
        isActive
          ? 'bg-foreground text-background shadow-sm'
          : 'text-muted-foreground hover:bg-background/80 hover:text-foreground',
      )}
    >
      <Icon className="h-4 w-4" />
      <span>{item.label}</span>
      {item.badge && item.badge > 0 ? (
        <span
          className={cn(
            'ml-auto inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold',
            isActive
              ? 'bg-background/20 text-background'
              : 'bg-foreground text-background',
          )}
        >
          {item.badge}
        </span>
      ) : null}
    </Link>
  );
}

interface SidebarNavProps {
  items: SidebarNavItem[];
  onNavigate?: () => void;
}

export function SidebarNav({ items, onNavigate }: SidebarNavProps) {
  return (
    <nav className="space-y-1">
      {items.map((item) => (
        <SidebarNavLink key={item.to} item={item} onNavigate={onNavigate} />
      ))}
    </nav>
  );
}

interface SidebarNavGroupProps {
  label: string;
  items: SidebarNavItem[];
  collapsed: boolean;
  onToggle: () => void;
  /** True when an item in this group is the active route. */
  containsActive: boolean;
  onNavigate?: () => void;
}

export function SidebarNavGroup({
  label,
  items,
  collapsed,
  onToggle,
  containsActive,
  onNavigate,
}: SidebarNavGroupProps) {
  // A collapsed group that holds the active route highlights its header
  // (folder-contains-current-file), so the current location stays discoverable
  // without forcing the group open. Matches the workspace-header active style.
  const headerActive = collapsed && containsActive;

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition',
          headerActive
            ? 'text-foreground'
            : 'text-muted-foreground/70 hover:text-muted-foreground',
        )}
      >
        <ChevronDown className={cn('h-3 w-3 transition-transform', collapsed && '-rotate-90')} />
        {label}
      </button>
      {!collapsed ? (
        <nav className="space-y-1">
          {items.map((item) => (
            <SidebarNavLink key={item.to} item={item} onNavigate={onNavigate} />
          ))}
        </nav>
      ) : null}
    </div>
  );
}
