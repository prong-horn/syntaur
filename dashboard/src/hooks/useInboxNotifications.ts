import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ChatAgentSummary } from '../lib/chat-types';
import type { InboxItem } from '../lib/inbox';
import {
  diffChatRows,
  notifyFreshRows,
  type NotificationApi,
} from '../lib/inbox-notify';

export function useInboxNotifications({
  items,
  loading,
  error,
  agents,
}: {
  items: InboxItem[];
  loading: boolean;
  error: string | null;
  agents: readonly ChatAgentSummary[];
}): void {
  const seenRef = useRef<Set<string> | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    try {
      if ((loading || error) && seenRef.current === null) return;

      const { seen, fresh } = diffChatRows(seenRef.current, items);
      seenRef.current = seen;

      notifyFreshRows({
        fresh,
        agents,
        api:
          typeof Notification === 'undefined'
            ? undefined
            : (Notification as unknown as NotificationApi),
        onOpen: (href) => {
          try {
            window.focus();
          } catch {
            // Ignore focus failures (e.g. SSR).
          }
          navigate(href);
        },
      });
    } catch {
      // Never let notification side effects break the shell.
    }
  }, [items, loading, error, agents, navigate]);
}
