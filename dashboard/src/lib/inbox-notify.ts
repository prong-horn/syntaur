/**
 * Pure notification decision logic for the Needs me queue. No React; minimal DOM
 * types so this unit-tests under the node-env dashboard vitest config.
 */

import type { ChatAgentSummary } from './chat-types';
import { inboxRowHref, isChatRow, rowKey, waitingLabel, type InboxItem } from './inbox';

export interface NotificationLike {
  close(): void;
  onclick: ((ev: unknown) => void) | null;
}

export interface NotificationApi {
  permission: 'default' | 'granted' | 'denied';
  new (title: string, options?: { body?: string; tag?: string }): NotificationLike;
  requestPermission(): Promise<'default' | 'granted' | 'denied'>;
}

export type NotificationState = 'unsupported' | 'default' | 'granted' | 'denied';

export function notificationPermission(api: NotificationApi | undefined): NotificationState {
  if (!api) return 'unsupported';
  return api.permission;
}

function authorOf(
  ref: { agentId: string },
  agents: readonly ChatAgentSummary[],
): { name: string } | undefined {
  const agent = agents.find((a) => a.id === ref.agentId);
  return agent ? { name: agent.name } : undefined;
}

export function diffChatRows(
  seen: ReadonlySet<string> | null,
  items: InboxItem[],
): { seen: Set<string>; fresh: InboxItem[] } {
  const chatItems = items.filter(isChatRow);
  const keys = chatItems.map(rowKey);
  if (seen === null) {
    return { seen: new Set(keys), fresh: [] };
  }
  const fresh = chatItems.filter((item) => !seen.has(rowKey(item)));
  const nextSeen = new Set(seen);
  for (const key of keys) nextSeen.add(key);
  return { seen: nextSeen, fresh };
}

export function notificationFor(
  item: InboxItem,
  agents: readonly ChatAgentSummary[],
): { title: string; body: string; tag: string; href: string } {
  const author = item.chat ? authorOf(item.chat, agents) : undefined;
  return {
    title: waitingLabel(item, author),
    body: `${item.title} — ${item.summary}`,
    tag: rowKey(item),
    href: inboxRowHref(item),
  };
}

export function notifyFreshRows(opts: {
  fresh: InboxItem[];
  agents: readonly ChatAgentSummary[];
  api: NotificationApi | undefined;
  onOpen: (href: string) => void;
}): number {
  if (!opts.api || opts.api.permission !== 'granted') return 0;
  let count = 0;
  for (const item of opts.fresh) {
    try {
      const { title, body, tag, href } = notificationFor(item, opts.agents);
      const notification = new opts.api(title, { body, tag });
      notification.onclick = () => {
        opts.onOpen(href);
        notification.close();
      };
      count++;
    } catch {
      // Swallow constructor errors (quota, unsupported options, etc.).
    }
  }
  return count;
}
