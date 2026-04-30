import { useState, useEffect, useCallback } from 'react';
import { useWebSocket } from './useWebSocket';
import type { TodoListResponse, TodoLogEntry } from '../types';

function base(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/todos`;
}

export function useProjectTodos(projectId: string) {
  const [data, setData] = useState<TodoListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await fetch(base(projectId));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch todos');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useWebSocket((msg) => {
    if (msg.type === 'todos-updated' && msg.projectSlug === projectId) fetchData();
  });

  return { data, loading, error, refetch: fetchData };
}

export function useProjectTodoLog(projectId: string, id?: string) {
  const [entries, setEntries] = useState<TodoLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    if (!projectId) return;
    try {
      const url = id
        ? `${base(projectId)}/log/${encodeURIComponent(id)}`
        : `${base(projectId)}/log`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setEntries(data.entries || []);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [projectId, id]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useWebSocket((msg) => {
    if (msg.type === 'todos-updated' && msg.projectSlug === projectId) fetchData();
  });

  return { entries, loading, refetch: fetchData };
}

// --- Mutation helpers (mirror useTodos; no patch/archive helpers exist there) ---

export async function addProjectTodo(projectId: string, description: string, tags?: string[]): Promise<void> {
  await fetch(base(projectId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description, tags }),
  });
}

export async function completeProjectTodo(projectId: string, id: string, summary?: string): Promise<void> {
  await fetch(`${base(projectId)}/${id}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary: summary || 'Completed.' }),
  });
}

export async function blockProjectTodo(projectId: string, id: string, reason?: string): Promise<void> {
  await fetch(`${base(projectId)}/${id}/block`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
}

export async function startProjectTodo(projectId: string, id: string, session?: string): Promise<void> {
  await fetch(`${base(projectId)}/${id}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session }),
  });
}

export async function reopenProjectTodo(projectId: string, id: string): Promise<void> {
  await fetch(`${base(projectId)}/${id}/reopen`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

export async function unblockProjectTodo(projectId: string, id: string): Promise<void> {
  await fetch(`${base(projectId)}/${id}/unblock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

export async function reorderProjectTodos(projectId: string, ids: string[]): Promise<void> {
  await fetch(`${base(projectId)}/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
}

export async function deleteProjectTodo(projectId: string, id: string): Promise<void> {
  await fetch(`${base(projectId)}/${id}`, {
    method: 'DELETE',
  });
}

import type { PromoteBody, MoveTarget } from './useTodos';

async function postOrThrow(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let parsed: { error?: string } | null = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* fall through */ }
    const msg = parsed?.error || text || `HTTP ${res.status}`;
    const err = new Error(msg) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json().catch(() => ({}));
}

export async function promoteProjectTodos(projectId: string, body: PromoteBody): Promise<void> {
  await postOrThrow(`${base(projectId)}/promote`, body);
}

export async function moveProjectTodo(projectId: string, id: string, to: MoveTarget): Promise<void> {
  await postOrThrow(`${base(projectId)}/${id}/move`, { to });
}
