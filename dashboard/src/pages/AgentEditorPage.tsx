import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AgentDefinitionForm } from '../components/agents/AgentDefinitionForm';
import { ErrorState } from '../components/ErrorState';
import { LoadingState } from '../components/LoadingState';
import { useToast, Toaster } from '../components/Toast';
import { useChatAgents } from '../hooks/useChatAgents';
import {
  applyHarnessToDraft,
  draftFromDefinition,
  emptyDraft,
  inputFromDraft,
  validateDraft,
  type AgentDraft,
} from '../lib/agent-editor';
import {
  createChatAgent,
  fetchChatAgent,
  refreshChatHarness,
  testChatAgent,
  updateChatAgent,
} from '../lib/chat-api';
import type { AgentTestResult } from '../lib/chat-types';

export function AgentEditorPage() {
  const { id: routeId } = useParams<{ id: string }>();
  const isCreate = routeId === undefined;
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
    if (!routeId) return;
    let cancelled = false;
    setLoadingAgent(true);
    setLoadError(null);
    void fetchChatAgent(routeId)
      .then(({ definition }) => {
        if (cancelled) return;
        const next = draftFromDefinition(definition);
        setDraft(next);
        setInitialDraft(next);
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : 'Failed to load agent');
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingAgent(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isCreate, routeId]);

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
      showToast(
        'Saved. Open chats keep their current model and mode until their session is re-attached.',
        'success',
      );
      navigate('/agents');
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
      if (result.ok) {
        showToast(
          [
            result.reply ? `Reply: ${result.reply}` : 'OK',
            result.model ? `model ${result.model}` : null,
            result.mode ? `mode ${result.mode}` : null,
            `${(result.durationMs / 1000).toFixed(1)} s`,
          ]
            .filter(Boolean)
            .join(' · '),
          'success',
        );
      } else {
        const detail = result.error ?? result.profileErrors.join('; ') ?? 'Test failed';
        showToast(detail, 'error');
        setServerError(detail);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Test failed';
      setTestResult({
        ok: false,
        reply: null,
        stopReason: null,
        model: null,
        mode: null,
        effort: null,
        profileErrors: [],
        durationMs: 0,
        error: message,
      });
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
        <h1 className="text-2xl font-semibold">{isCreate ? 'New agent' : 'Edit agent'}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Writes the same markdown format the loader reads. Overrides use a file with a built-in id.
        </p>
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
