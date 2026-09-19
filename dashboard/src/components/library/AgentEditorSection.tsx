import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AgentDefinitionForm } from '../agents/AgentDefinitionForm';
import { ErrorState } from '../ErrorState';
import { LoadingState } from '../LoadingState';
import { useToast, Toaster } from '../Toast';
import { useChatAgents } from '../../hooks/useChatAgents';
import {
  applyHarnessToDraft,
  draftFromDefinition,
  emptyDraft,
  inputFromDraft,
  validateDraft,
  type AgentDraft,
} from '../../lib/agent-editor';
import {
  createChatAgent,
  fetchChatAgent,
  refreshChatHarness,
  testChatAgent,
  updateChatAgent,
} from '../../lib/chat-api';
import type { AgentTestResult } from '../../lib/chat-types';

export interface AgentEditorSectionProps {
  agentId?: string;
  linkPrefix?: string;
}

export function AgentEditorSection({ agentId, linkPrefix = '/library/agents' }: AgentEditorSectionProps) {
  const base = linkPrefix.replace(/\/$/, '');
  const isCreate = agentId === undefined;
  const navigate = useNavigate();
  const { data, loading, error, refetch } = useChatAgents();
  const { toast, showToast, dismissToast } = useToast();

  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [initialDraft, setInitialDraft] = useState<AgentDraft | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [defaultUnsetError, setDefaultUnsetError] = useState<string | null>(null);
  const [loadingAgent, setLoadingAgent] = useState(!isCreate);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [testResult, setTestResult] = useState<AgentTestResult | 'loading' | null>(null);
  const autoRefreshed = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (isCreate) {
      const next = emptyDraft();
      setDraft(next);
      setInitialDraft(next);
      setLoadingAgent(false);
      return;
    }
    if (!agentId) return;
    let cancelled = false;
    setLoadingAgent(true);
    setLoadError(null);
    void fetchChatAgent(agentId)
      .then(({ definition }) => {
        if (cancelled) return;
        const next = draftFromDefinition(definition);
        setDraft(next);
        setInitialDraft(next);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load agent');
      })
      .finally(() => {
        if (!cancelled) setLoadingAgent(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isCreate, agentId]);

  const harnesses = data?.harnesses ?? [];

  useEffect(() => {
    if (!draft || harnesses.length === 0) return;
    const harness = harnesses.find((h) => h.id === draft.harness) ?? null;
    setDraft((prev) => {
      if (!prev) return prev;
      const next = applyHarnessToDraft(prev, harness);
      return JSON.stringify(next) === JSON.stringify(prev) ? prev : next;
    });
  }, [harnesses, draft?.harness]);

  const selectedHarness = useMemo(
    () => harnesses.find((h) => h.id === draft?.harness) ?? null,
    [harnesses, draft?.harness],
  );

  useEffect(() => {
    if (!selectedHarness || !draft) return;
    if (!selectedHarness.installed || selectedHarness.options !== null) return;
    if (autoRefreshed.current.has(selectedHarness.id)) return;
    autoRefreshed.current.add(selectedHarness.id);
    setRefreshing(true);
    void refreshChatHarness(draft.harness)
      .then(() => refetch())
      .catch((err) => {
        setServerError(err instanceof Error ? err.message : 'Refresh failed');
        return refetch();
      })
      .finally(() => setRefreshing(false));
  }, [selectedHarness, draft, refetch]);

  const dirty = useMemo(() => {
    if (!draft || !initialDraft) return false;
    return JSON.stringify(draft) !== JSON.stringify(initialDraft);
  }, [draft, initialDraft]);

  const handleRefresh = useCallback(async () => {
    if (!draft) return;
    setRefreshing(true);
    setServerError(null);
    try {
      await refreshChatHarness(draft.harness);
      await refetch();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Refresh failed');
      await refetch();
    } finally {
      setRefreshing(false);
    }
  }, [draft, refetch]);

  async function handleSave(): Promise<void> {
    if (!draft) return;
    setServerError(null);
    setDefaultUnsetError(null);
    const errors = validateDraft(draft);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSaving(true);
    try {
      const input = inputFromDraft(draft);
      if (isCreate) {
        await createChatAgent(input.id, input);
      } else {
        await updateChatAgent(draft.id, input);
      }
      showToast('Saved. Open chats keep their model until re-attached.', 'success');
      navigate(base);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Save failed';
      if (message.includes('is the default agent')) {
        setDefaultUnsetError(message);
      } else {
        setServerError(message);
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleTest(): Promise<void> {
    if (!draft || dirty) return;
    setServerError(null);
    setTestResult('loading');
    try {
      const result = await testChatAgent(draft.id);
      setTestResult(result);
      if (!result.ok) {
        const detail = result.error ?? result.profileErrors.join('; ') ?? 'Test failed';
        setServerError(detail);
        showToast(detail, 'error');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Test failed';
      setServerError(message);
      showToast(message, 'error');
    }
  }

  if (loading || loadingAgent) return <LoadingState label="Loading agent editor…" />;
  if (error) return <ErrorState title="Could not load harnesses" error={error} />;
  if (loadError) return <ErrorState title="Could not load agent" error={loadError} />;
  if (!draft) return <ErrorState title="Agent not found" error="Missing draft" />;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h2 className="text-xl font-semibold">{isCreate ? 'New agent' : 'Edit agent'}</h2>
        <p className="mt-1 text-sm text-muted-foreground">Writes the same markdown format the loader reads.</p>
      </div>
      <AgentDefinitionForm
        draft={draft}
        errors={fieldErrors}
        harnesses={harnesses}
        mode={isCreate ? 'create' : 'edit'}
        refreshing={refreshing}
        onChange={setDraft}
        onRefresh={() => void handleRefresh()}
        onSave={() => void handleSave()}
        onTest={isCreate ? undefined : () => void handleTest()}
        dirty={dirty}
        saving={saving}
        testResult={testResult}
        serverError={serverError}
        defaultUnsetError={defaultUnsetError}
      />
      <Toaster toast={toast} onDismiss={dismissToast} />
    </div>
  );
}
