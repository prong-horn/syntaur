import { Link, useLocation } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../lib/utils';
import { isSidebarItemActive, type SidebarSection } from '../lib/routes';

export interface SidebarNavItem {
  to: SidebarSection;
  label: string;
  icon: LucideIcon;
  /** Optional numeric pill rendered next to the label (e.g. inbox count). */
  badge?: number;
}

interface SidebarNavProps {
  items: SidebarNavItem[];
  onNavigate?: () => void;
}

export function SidebarNav({ items, onNavigate }: SidebarNavProps) {
  const location = useLocation();

  return (
    <nav className="space-y-1">
      {items.map((item) => {
        const Icon = item.icon;
        const isActive = isSidebarItemActive(location.pathname, item.to)
          && !location.pathname.startsWith('/w/');

        return (
          <Link
            key={item.to}
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
      })}
    </nav>
  );
}
