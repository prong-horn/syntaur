import { useState, useEffect, useCallback } from 'react';
import { useWebSocket } from './useWebSocket';
import type { TodoListResponse, TodoAggregateResponse, TodoLogEntry } from '../types';

export function useTodos(workspace: string) {
  const [data, setData] = useState<TodoListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/todos/${encodeURIComponent(workspace)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch todos');
    } finally {
      setLoading(false);
    }
  }, [workspace]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useWebSocket((msg) => {
    if (msg.type === 'todos-updated' && !msg.projectSlug) fetchData();
  });

  return { data, loading, error, refetch: fetchData };
}

export function useAllTodos() {
  const [data, setData] = useState<TodoAggregateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/todos');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch todos');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useWebSocket((msg) => {
    if (msg.type === 'todos-updated' && !msg.projectSlug) fetchData();
  });

  return { data, loading, error, refetch: fetchData };
}

export function useTodoLog(workspace: string, id?: string) {
  const [entries, setEntries] = useState<TodoLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const url = id
        ? `/api/todos/${encodeURIComponent(workspace)}/log/${encodeURIComponent(id)}`
        : `/api/todos/${encodeURIComponent(workspace)}/log`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setEntries(data.entries || []);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [workspace, id]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useWebSocket((msg) => {
    if (msg.type === 'todos-updated' && !msg.projectSlug) fetchData();
  });

  return { entries, loading, refetch: fetchData };
}

// --- Mutation helpers ---

export async function addTodo(workspace: string, description: string, tags?: string[]): Promise<void> {
  await fetch(`/api/todos/${encodeURIComponent(workspace)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description, tags }),
  });
}

export async function completeTodo(workspace: string, id: string, summary?: string): Promise<void> {
  await fetch(`/api/todos/${encodeURIComponent(workspace)}/${id}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary: summary || 'Completed.' }),
  });
}

export async function blockTodo(workspace: string, id: string, reason?: string): Promise<void> {
  await fetch(`/api/todos/${encodeURIComponent(workspace)}/${id}/block`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
}

export async function startTodo(workspace: string, id: string, session?: string): Promise<void> {
  await fetch(`/api/todos/${encodeURIComponent(workspace)}/${id}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session }),
  });
}

export async function reopenTodo(workspace: string, id: string): Promise<void> {
  await fetch(`/api/todos/${encodeURIComponent(workspace)}/${id}/reopen`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

export async function unblockTodo(workspace: string, id: string): Promise<void> {
  await fetch(`/api/todos/${encodeURIComponent(workspace)}/${id}/unblock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

export async function reorderTodos(workspace: string, ids: string[]): Promise<void> {
  await fetch(`/api/todos/${encodeURIComponent(workspace)}/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
}

export async function deleteTodo(workspace: string, id: string): Promise<void> {
  await fetch(`/api/todos/${encodeURIComponent(workspace)}/${id}`, {
    method: 'DELETE',
  });
}

export type PromoteBody =
  | {
      todoIds: string[];
      mode: 'new-assignment';
      target: { project: string };
      title?: string;
      type?: string;
      priority?: string;
      keepSource?: boolean;
    }
  | {
      todoIds: string[];
      mode: 'to-assignment';
      target: { assignment: string };
      keepSource?: boolean;
    };

export type MoveTarget =
  | { workspace: string }
  | { project: string }
  | { global: true };

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

export async function promoteTodos(workspace: string, body: PromoteBody): Promise<void> {
  await postOrThrow(`/api/todos/${encodeURIComponent(workspace)}/promote`, body);
}

export async function moveTodo(workspace: string, id: string, to: MoveTarget): Promise<void> {
  await postOrThrow(`/api/todos/${encodeURIComponent(workspace)}/${id}/move`, { to });
}
