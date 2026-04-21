import { useMemo, useState } from 'react';
import { CheckCircle2, Circle, Reply } from 'lucide-react';
import { MarkdownRenderer } from './MarkdownRenderer';
import { SectionCard } from './SectionCard';
import { cn } from '../lib/utils';
import type { AssignmentCommentEntry } from '../hooks/useProjects';

type CommentType = 'note' | 'question' | 'feedback';

interface CommentsThreadProps {
  projectSlug: string;
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

export function CommentsThread({ projectSlug, assignmentSlug, entries }: CommentsThreadProps) {
  const tree = useMemo(() => buildThread(entries), [entries]);
  const [newBody, setNewBody] = useState('');
  const [newType, setNewType] = useState<CommentType>('note');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!newBody.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectSlug)}/assignments/${encodeURIComponent(assignmentSlug)}/comments`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body: newBody, type: newType }),
        },
      );
      if (!res.ok) {
        const msg = await res.text();
        throw new Error(msg || `HTTP ${res.status}`);
      }
      setNewBody('');
      // Force a refetch of the assignment detail
      window.dispatchEvent(new CustomEvent('syntaur-refresh'));
      // Fallback: reload the page so the new comment appears
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleResolved(commentId: string, next: boolean) {
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(projectSlug)}/assignments/${encodeURIComponent(assignmentSlug)}/comments/${encodeURIComponent(commentId)}/resolved`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resolved: next }),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
        <form onSubmit={handleSubmit} className="mt-6 space-y-2 border-t border-neutral-800 pt-4">
          <label className="block text-xs font-medium uppercase tracking-wide text-neutral-400">
            Add comment
          </label>
          <textarea
            value={newBody}
            onChange={(e) => setNewBody(e.target.value)}
            className="w-full rounded border border-neutral-700 bg-neutral-900 p-2 text-sm"
            rows={3}
            placeholder="Ask a question, leave a note, or give feedback…"
          />
          <div className="flex items-center gap-2">
            <select
              value={newType}
              onChange={(e) => setNewType(e.target.value as CommentType)}
              className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs"
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
            {error ? <span className="text-xs text-red-400">{error}</span> : null}
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
    <div className={cn('space-y-2', depth > 0 && 'ml-4 border-l border-neutral-800 pl-4')}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-400">
        <span className="font-mono">{entry.id}</span>
        <span>·</span>
        <span>{entry.timestamp}</span>
        <span>·</span>
        <span className="font-medium text-neutral-200">{entry.author}</span>
        <span>·</span>
        <span
          className={cn(
            'rounded px-1.5 py-0.5 font-mono text-[10px] uppercase',
            isQuestion && 'bg-amber-900/40 text-amber-200',
            entry.type === 'feedback' && 'bg-sky-900/40 text-sky-200',
            entry.type === 'note' && 'bg-neutral-800 text-neutral-300',
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
                ? 'bg-emerald-900/40 text-emerald-200 hover:bg-emerald-900/60'
                : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700',
            )}
            title={entry.resolved ? 'Mark unresolved' : 'Mark resolved'}
          >
            {entry.resolved ? <CheckCircle2 className="h-3 w-3" /> : <Circle className="h-3 w-3" />}
            {entry.resolved ? 'resolved' : 'open'}
          </button>
        ) : null}
        {entry.replyTo ? (
          <span className="inline-flex items-center gap-1 text-neutral-500">
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
