import { useCallback, useMemo } from 'react';
import { useResource } from '../data/useResource';
import { resources } from '../data/resources';
import type { ChatAgentSummary, ChatHarnessSummary } from '../lib/chat-types';

export interface ChatAgentsData {
  agents: ChatAgentSummary[];
  errors: string[];
  harnesses: ChatHarnessSummary[];
}

/**
 * Agent definitions + harness availability from the shared store. Refreshed by
 * `chat-agents` / `agents-updated` / `chat-participants` invalidations; every
 * consumer (shell, pickers, Library) shares the two cache entries.
 */
export function useChatAgents() {
  const agents = useResource(resources.agents());
  const harnesses = useResource(resources.harnesses());

  const refetchAgents = agents.refetch;
  const refetchHarnesses = harnesses.refetch;
  const refetch = useCallback(
    () => Promise.all([refetchAgents(), refetchHarnesses()]).then(() => undefined),
    [refetchAgents, refetchHarnesses],
  );

  const data = useMemo<ChatAgentsData | null>(() => {
    if (!agents.data || !harnesses.data) return null;
    return {
      agents: agents.data.agents,
      errors: agents.data.errors,
      harnesses: harnesses.data.harnesses,
    };
  }, [agents.data, harnesses.data]);

  const error = agents.error ?? harnesses.error;
  return {
    data,
    loading: agents.loading || harnesses.loading,
    error: error ? error.message : null,
    refetch,
  };
}
