import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Circle, Reply } from 'lucide-react';
import { MarkdownRenderer } from './MarkdownRenderer';
import { SectionCard } from './SectionCard';
import { cn } from '../lib/utils';
import type { AssignmentCommentEntry } from '../hooks/useProjects';

type CommentType = 'note' | 'question' | 'feedback';

interface CommentsThreadProps {
  /** `null` for standalone assignments — uses the /api/assignments/:id/comments route. */
  projectSlug: string | null;
  /** Project-nested: the assignment slug. Standalone: the UUID. */
  assignmentSlug: string;
  entries: AssignmentCommentEntry[];
}

interface ThreadNode {
  entry: AssignmentCommentEntry;
  replies: ThreadNode[];
}

function buildThread(entries: AssignmentCommentEntry[]): ThreadNode[] {
  const nodes = new Map<string, ThreadNode>();
  for (const entry of entries) {
    nodes.set(entry.id, { entry, replies: [] });
  }
  const roots: ThreadNode[] = [];
  for (const entry of entries) {
    const node = nodes.get(entry.id)!;
    if (entry.replyTo && nodes.has(entry.replyTo)) {
      nodes.get(entry.replyTo)!.replies.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function buildCommentBase(projectSlug: string | null, assignmentSlug: string): string {
  return projectSlug === null
    ? `/api/assignments/${encodeURIComponent(assignmentSlug)}/comments`
    : `/api/projects/${encodeURIComponent(projectSlug)}/assignments/${encodeURIComponent(assignmentSlug)}/comments`;
}

export function CommentsThread({ projectSlug, assignmentSlug, entries }: CommentsThreadProps) {
  const [localEntries, setLocalEntries] = useState<AssignmentCommentEntry[]>(entries);
  useEffect(() => {
    setLocalEntries(entries);
  }, [entries]);

  const tree = useMemo(() => buildThread(localEntries), [localEntries]);
  const [newBody, setNewBody] = useState('');
  const [newType, setNewType] = useState<CommentType>('note');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!newBody.trim()) return;
    setSubmitting(true);
    setError(null);

    // Optimistic append.
    const tempId = `tmp-${Date.now()}`;
    const optimistic: AssignmentCommentEntry = {
      id: tempId,
      timestamp: new Date().toISOString(),
      author: 'human',
      type: newType,
      body: newBody,
      resolved: newType === 'question' ? false : undefined,
    };
    setLocalEntries((prev) => [...prev, optimistic]);

    try {
      const res = await fetch(buildCommentBase(projectSlug, assignmentSlug), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: newBody, type: newType }),
      });
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(msg || `HTTP ${res.status}`);
      }
      const payload = (await res.json().catch(() => null)) as
        | { comment?: { id?: string } }
        | null;
      const realId = payload?.comment?.id;

      // Replace optimistic entry's id with the server's, if returned.
      setLocalEntries((prev) =>
        prev.map((e) => (e.id === tempId ? { ...e, id: realId ?? e.id } : e)),
      );
      setNewBody('');
      // Hint the outer page to refetch for canonical state (timestamp, entryCount).
      window.dispatchEvent(new CustomEvent('syntaur-refresh'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // Roll back the optimistic entry on error.
      setLocalEntries((prev) => prev.filter((entry) => entry.id !== tempId));
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleResolved(commentId: string, next: boolean) {
    // Optimistic flip.
    setLocalEntries((prev) =>
      prev.map((e) => (e.id === commentId ? { ...e, resolved: next } : e)),
    );

    try {
      const url =
        projectSlug === null
          ? `/api/assignments/${encodeURIComponent(assignmentSlug)}/comments/${encodeURIComponent(commentId)}/resolved`
          : `/api/projects/${encodeURIComponent(projectSlug)}/assignments/${encodeURIComponent(assignmentSlug)}/comments/${encodeURIComponent(commentId)}/resolved`;
      const res = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolved: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      window.dispatchEvent(new CustomEvent('syntaur-refresh'));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // Roll back on error.
      setLocalEntries((prev) =>
        prev.map((entry) => (entry.id === commentId ? { ...entry, resolved: !next } : entry)),
      );
    }
  }

  return (
    <SectionCard
      title="Comments"
      description="Threaded questions, notes, and feedback. Questions can be resolved once answered."
    >
      <div className="space-y-4">
        {tree.map((node) => (
          <CommentNode key={node.entry.id} node={node} onToggleResolved={toggleResolved} depth={0} />
        ))}
        <form onSubmit={handleSubmit} className="mt-6 space-y-2 border-t border-border pt-4">
          <label className="block text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Add comment
          </label>
          <textarea
            value={newBody}
            onChange={(e) => setNewBody(e.target.value)}
            className="w-full rounded border border-border bg-background p-2 text-sm"
            rows={3}
            placeholder="Ask a question, leave a note, or give feedback…"
          />
          <div className="flex items-center gap-2">
            <select
              value={newType}
              onChange={(e) => setNewType(e.target.value as CommentType)}
              className="rounded border border-border bg-background px-2 py-1 text-xs"
            >
              <option value="note">note</option>
              <option value="question">question</option>
              <option value="feedback">feedback</option>
            </select>
            <button
              type="submit"
              disabled={submitting || !newBody.trim()}
              className="shell-action"
            >
              {submitting ? 'Posting…' : 'Post comment'}
            </button>
            {error ? <span className="text-xs text-error-foreground">{error}</span> : null}
          </div>
        </form>
      </div>
    </SectionCard>
  );
}

interface CommentNodeProps {
  node: ThreadNode;
  depth: number;
  onToggleResolved: (commentId: string, next: boolean) => void;
}

function CommentNode({ node, depth, onToggleResolved }: CommentNodeProps) {
  const { entry, replies } = node;
  const isQuestion = entry.type === 'question';
  return (
    <div className={cn('space-y-2', depth > 0 && 'ml-4 border-l border-border pl-4')}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono">{entry.id}</span>
        <span>·</span>
        <span>{entry.timestamp}</span>
        <span>·</span>
        <span className="font-medium text-foreground">{entry.author}</span>
        <span>·</span>
        <span
          className={cn(
            'rounded px-1.5 py-0.5 font-mono text-[10px] uppercase',
            isQuestion && 'bg-warning text-warning-foreground',
            entry.type === 'feedback' && 'bg-info text-info-foreground',
            entry.type === 'note' && 'bg-muted text-muted-foreground',
          )}
        >
          {entry.type}
        </span>
        {isQuestion ? (
          <button
            type="button"
            onClick={() => onToggleResolved(entry.id, !entry.resolved)}
            className={cn(
              'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium',
              entry.resolved
                ? 'bg-success text-success-foreground hover:bg-success/80'
                : 'bg-muted text-muted-foreground hover:bg-muted/80',
            )}
            title={entry.resolved ? 'Mark unresolved' : 'Mark resolved'}
          >
            {entry.resolved ? <CheckCircle2 className="h-3 w-3" /> : <Circle className="h-3 w-3" />}
            {entry.resolved ? 'resolved' : 'open'}
          </button>
        ) : null}
        {entry.replyTo ? (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <Reply className="h-3 w-3" />
            {entry.replyTo}
          </span>
        ) : null}
      </div>
      <MarkdownRenderer content={entry.body} />
      {replies.length > 0 ? (
        <div className="space-y-2">
          {replies.map((reply) => (
            <CommentNode
              key={reply.entry.id}
              node={reply}
              depth={depth + 1}
              onToggleResolved={onToggleResolved}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
