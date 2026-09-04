import { useCallback, useEffect, useState } from 'react';
import { useWebSocket } from './useWebSocket';
import {
  fetchChatAgents,
  fetchChatHarnesses,
} from '../lib/chat-api';
import type { ChatAgentSummary } from '../lib/chat-types';
import type { ChatHarnessSummary } from '../lib/chat-types';

export interface ChatAgentsData {
  agents: ChatAgentSummary[];
  errors: string[];
  harnesses: ChatHarnessSummary[];
}

export function useChatAgents() {
  const [data, setData] = useState<ChatAgentsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const [agentsRes, harnessesRes] = await Promise.all([
        fetchChatAgents(),
        fetchChatHarnesses(),
      ]);
      setData({
        agents: agentsRes.agents,
        errors: agentsRes.errors,
        harnesses: harnessesRes.harnesses,
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch agents');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  useWebSocket((msg) => {
    if (msg.type === 'chat-agents' || msg.type === 'chat-participants') {
      void refetch();
    }
  });

  return { data, loading, error, refetch };
}
