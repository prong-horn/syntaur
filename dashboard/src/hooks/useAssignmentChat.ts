import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWebSocket, type WsMessage } from './useWebSocket';
import {
  answerChatPermission,
  answerChatQuestion,
  applyFrame,
  authorOf,
  cancelChatTurn,
  chipAgents,
  emptyChatState,
  fetchChatItems,
  fetchChatParticipants,
  fetchChatSession,
  mergePage,
  putChatParticipants,
  sendChatMessage,
  sortItems,
  withdrawChatMessage,
  workingByAgent,
  type ChatState,
  type ItemAuthor,
  type WorkingState,
} from '../lib/chat-api';
import type {
  ChatAgentSummary,
  ChatItem,
  ChatSessionSummary,
  Participants,
} from '../lib/chat-types';

const PAGE_SIZE = 200;
/** The working indicator ticks on Syntaur's clock — claude sends no thinking signal. */
const TICK_MS = 1000;

const CHAT_FRAMES = new Set(['chat-item', 'chat-session', 'chat-participants', 'chat-agents']);

export interface UseAssignmentChatResult {
  items: ChatItem[];
  /** One entry per agent that has a session, keyed by agent id. */
  sessions: Map<string, ChatSessionSummary>;
  participants: Participants | null;
  agents: ChatAgentSummary[];
  /** The attached definitions, in participant order. */
  attached: ChatAgentSummary[];
  /**
   * Who gets a header chip: the attached set plus anyone still mid-turn, so a
   * detached agent keeps its interrupt until its cancel resolves.
   */
  chips: ChatAgentSummary[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  /** Who is working right now, and for how long, per agent. */
  working: Map<string, WorkingState>;
  authorOf: (item: { agentId: string }) => ItemAuthor;
  send: (text: string, agentId?: string | null) => Promise<void>;
  withdraw: (messageId: string) => Promise<void>;
  /** With an id, cancel that agent; without one, every in-flight agent. */
  cancel: (agentId?: string | null) => Promise<void>;
  setParticipants: (next: Participants) => Promise<void>;
  answerPermission: (requestId: string, optionId: string) => Promise<void>;
  answerQuestion: (requestId: string, answer: { optionId?: string; text?: string }) => Promise<void>;
  loadOlder: () => Promise<void>;
  refresh: () => void;
}

/**
 * Load an assignment's chat and keep it live.
 *
 * History comes from REST; everything after that arrives as `chat-item`,
 * `chat-session` and `chat-participants` frames on the shared `/ws` connection.
 * The broadcast is a flat fan-out with no topics (Decision 3), so frames for
 * other assignments are filtered out here.
 *
 * A chat holds SEVERAL agents now, so the session is a map keyed by agent id
 * and every item resolves its own author rather than inheriting one from the
 * tab.
 */
export function useAssignmentChat(assignmentId: string | null): UseAssignmentChatResult {
  const [state, setState] = useState<ChatState>(emptyChatState);
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
        const [page, roster] = await Promise.all([
          fetchChatItems(assignmentId, { limit: PAGE_SIZE }),
          fetchChatParticipants(assignmentId),
        ]);
        if (cancelled) return;
        // One read per attached agent. The server materialises attached agents
        // itself now, so this is a read rather than a create.
        const summaries = await Promise.all(
          roster.participants.agents.map((agentId) =>
            fetchChatSession(assignmentId, agentId).catch(() => ({ session: null })),
          ),
        );
        if (cancelled) return;
        const sessions = new Map<string, ChatSessionSummary>();
        for (const { session } of summaries) if (session) sessions.set(session.agentId, session);
        setState((prev) => ({
          ...mergePage({ ...emptyChatState(), items: prev.items }, page, PAGE_SIZE),
          sessions,
          participants: roster.participants,
          agents: roster.agents,
        }));
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
        if (!CHAT_FRAMES.has(message.type)) return;
        setState((prev) =>
          applyFrame(
            prev,
            assignmentId,
            message.type as 'chat-item' | 'chat-session' | 'chat-participants' | 'chat-agents',
            message.payload,
          ),
        );
      },
      [assignmentId],
    ),
  );

  const items = useMemo(() => sortItems(state.items.values()), [state.items]);
  const working = useMemo(() => workingByAgent(items, nowMs), [items, nowMs]);
  const anyWorking = working.size > 0;

  const attached = useMemo(() => {
    const ids = state.participants?.agents ?? [];
    return ids
      .map((id) => state.agents.find((a) => a.id === id))
      .filter((a): a is ChatAgentSummary => a !== undefined);
  }, [state.participants, state.agents]);

  const chips = useMemo(() => {
    const attachedIds = attached.map((agent) => agent.id);
    return chipAgents(attachedIds, working).map(
      (id) =>
        state.agents.find((agent) => agent.id === id) ?? {
          id,
          name: id,
          color: 'slate' as const,
          harness: 'claude' as const,
          model: null,
          mode: null,
          effort: null,
          respondsTo: 'mentions' as const,
          description: null,
          avatar: ([...id][0] ?? '?').toUpperCase(),
          default: false,
          source: null,
          builtin: false,
          overridesBuiltin: false,
          missing: null,
        },
    );
  }, [attached, working, state.agents]);

  const resolveAuthor = useCallback(
    (item: { agentId: string }) => authorOf(item, state.agents),
    [state.agents],
  );

  // Only tick while some agent is working; an idle chat costs no renders.
  useEffect(() => {
    if (!anyWorking) return;
    const timer = setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [anyWorking]);

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

  const cancel = useCallback(
    async (agentId?: string | null) => {
      if (!assignmentId) return;
      try {
        await cancelChatTurn(assignmentId, agentId ?? null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [assignmentId],
  );

  const setParticipants = useCallback(
    async (next: Participants) => {
      if (!assignmentId) return;
      setError(null);
      try {
        const saved = await putChatParticipants(assignmentId, next);
        setState((prev) => ({ ...prev, participants: saved.participants, agents: saved.agents }));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        throw err;
      }
    },
    [assignmentId],
  );

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

  const answerQuestion = useCallback(
    async (requestId: string, answer: { optionId?: string; text?: string }) => {
      if (!assignmentId) return;
      try {
        await answerChatQuestion(assignmentId, requestId, answer);
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
    sessions: state.sessions,
    participants: state.participants,
    agents: state.agents,
    attached,
    chips,
    loading,
    error,
    hasMore: state.hasMore,
    working,
    authorOf: resolveAuthor,
    send,
    withdraw,
    cancel,
    setParticipants,
    answerPermission,
    answerQuestion,
    loadOlder,
    refresh,
  };
}
