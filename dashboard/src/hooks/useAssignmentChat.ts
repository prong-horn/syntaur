import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWebSocket, type WsMessage } from './useWebSocket';
import {
  answerChatPermission,
  applyFrame,
  cancelChatTurn,
  emptyChatState,
  fetchChatAgents,
  fetchChatItems,
  fetchChatSession,
  mergePage,
  sendChatMessage,
  sortItems,
  withdrawChatMessage,
  workingFor,
  type ChatState,
} from '../lib/chat-api';
import type { ChatAgentSummary, ChatItem, ChatSessionSummary } from '../lib/chat-types';

const PAGE_SIZE = 200;
/** The working indicator ticks on Syntaur's clock — claude sends no thinking signal. */
const TICK_MS = 1000;

export interface UseAssignmentChatResult {
  items: ChatItem[];
  session: ChatSessionSummary | null;
  agents: ChatAgentSummary[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  working: { since: string; elapsedMs: number } | null;
  send: (text: string, agentId?: string | null) => Promise<void>;
  withdraw: (messageId: string) => Promise<void>;
  cancel: () => Promise<void>;
  answerPermission: (requestId: string, optionId: string) => Promise<void>;
  loadOlder: () => Promise<void>;
  refresh: () => void;
}

/**
 * Load an assignment's chat and keep it live.
 *
 * History comes from REST; everything after that arrives as `chat-item` /
 * `chat-session` frames on the shared `/ws` connection. The broadcast is a flat
 * fan-out with no topics (Decision 3), so frames for other assignments are
 * filtered out here.
 */
export function useAssignmentChat(assignmentId: string | null): UseAssignmentChatResult {
  const [state, setState] = useState<ChatState>(emptyChatState);
  const [agents, setAgents] = useState<ChatAgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadCount, setReloadCount] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const loadingOlder = useRef(false);

  const refresh = useCallback(() => setReloadCount((n) => n + 1), []);

  useEffect(() => {
    if (!assignmentId) {
      setState(emptyChatState());
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const [page, session, agentList] = await Promise.all([
          fetchChatItems(assignmentId, { limit: PAGE_SIZE }),
          fetchChatSession(assignmentId),
          fetchChatAgents(),
        ]);
        if (cancelled) return;
        setState((prev) => ({
          ...mergePage({ ...emptyChatState(), items: prev.items }, page, PAGE_SIZE),
          session: session.session,
        }));
        setAgents(agentList.agents);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [assignmentId, reloadCount]);

  useWebSocket(
    useCallback(
      (message: WsMessage) => {
        if (!assignmentId) return;
        if (message.type !== 'chat-item' && message.type !== 'chat-session') return;
        setState((prev) => applyFrame(prev, assignmentId, message.type as 'chat-item' | 'chat-session', message.payload));
      },
      [assignmentId],
    ),
  );

  const items = useMemo(() => sortItems(state.items.values()), [state.items]);
  const working = useMemo(() => workingFor(items, nowMs), [items, nowMs]);

  // Only tick while a turn is open; an idle chat costs no renders.
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [working !== null]);

  const send = useCallback(
    async (text: string, agentId?: string | null) => {
      if (!assignmentId) return;
      setError(null);
      try {
        await sendChatMessage(assignmentId, text, agentId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [assignmentId],
  );

  const withdraw = useCallback(
    async (messageId: string) => {
      if (!assignmentId) return;
      try {
        await withdrawChatMessage(assignmentId, messageId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [assignmentId],
  );

  const cancel = useCallback(async () => {
    if (!assignmentId) return;
    try {
      await cancelChatTurn(assignmentId, state.session?.agentId ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [assignmentId, state.session?.agentId]);

  const answerPermission = useCallback(
    async (requestId: string, optionId: string) => {
      if (!assignmentId) return;
      try {
        await answerChatPermission(assignmentId, requestId, optionId);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [assignmentId],
  );

  const loadOlder = useCallback(async () => {
    if (!assignmentId || loadingOlder.current || !state.hasMore || state.oldestSeq === null) return;
    loadingOlder.current = true;
    try {
      const page = await fetchChatItems(assignmentId, { before: state.oldestSeq, limit: PAGE_SIZE });
      setState((prev) => mergePage(prev, page, PAGE_SIZE));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      loadingOlder.current = false;
    }
  }, [assignmentId, state.hasMore, state.oldestSeq]);

  return {
    items,
    session: state.session,
    agents,
    loading,
    error,
    hasMore: state.hasMore,
    working,
    send,
    withdraw,
    cancel,
    answerPermission,
    loadOlder,
    refresh,
  };
}
