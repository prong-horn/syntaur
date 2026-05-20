import { useEffect, useMemo, useState } from 'react';
import { GitBranchPlus } from 'lucide-react';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import {
  CreateWorktreeError,
  createAssignmentWorktree,
  createAssignmentWorktreeById,
  getAssignmentRepositoryCandidatesById,
  getProjectRepositoryCandidates,
  type RepositoryCandidate,
} from '../lib/assignments';

type Mode =
  | { kind: 'project-nested'; projectSlug: string; assignmentSlug: string }
  | { kind: 'standalone'; assignmentId: string };

interface CreateWorktreeButtonProps {
  /** Project-nested: pass slug + aslug. Standalone: pass assignment id only. */
  projectSlug?: string;
  assignmentSlug?: string;
  assignmentId?: string;
  /**
   * Branch-name default. Caller computes this so the button doesn't have to
   * know the convention. Project-nested: `syntaur/<project>/<slug>`;
   * standalone: `syntaur/<slug>`.
   */
  defaultBranch: string;
  defaultParentBranch?: string;
  /** Called after a successful create; the parent typically calls `refetch()`. */
  onCreated: () => void;
}

const OTHER_OPTION = '__other__';

export function CreateWorktreeButton({
  projectSlug,
  assignmentSlug,
  assignmentId,
  defaultBranch,
  defaultParentBranch = 'main',
  onCreated,
}: CreateWorktreeButtonProps): JSX.Element {
  const mode: Mode = projectSlug && assignmentSlug
    ? { kind: 'project-nested', projectSlug, assignmentSlug }
    : { kind: 'standalone', assignmentId: assignmentId! };

  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] = useState<RepositoryCandidate[] | null>(null);
  const [candidatesError, setCandidatesError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [customRepo, setCustomRepo] = useState('');
  const [branch, setBranch] = useState(defaultBranch);
  const [parentBranch, setParentBranch] = useState(defaultParentBranch);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<{ message: string; stderr?: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // Reset all dialog state so a previous open's candidate / repo doesn't
    // bleed into this one. `selected` MUST be cleared too — otherwise a stale
    // repo could be submitted before the fresh candidates fetch resolves.
    setCandidates(null);
    setCandidatesError(null);
    setSubmitError(null);
    setSelected('');
    setCustomRepo('');
    setBranch(defaultBranch);
    setParentBranch(defaultParentBranch);
    const loader = mode.kind === 'project-nested'
      ? getProjectRepositoryCandidates(mode.projectSlug)
      : getAssignmentRepositoryCandidatesById(mode.assignmentId);
    loader
      .then((list) => {
        if (cancelled) return;
        setCandidates(list);
        const firstProject = list.find((c) => c.source === 'project');
        const firstSibling = list.find((c) => c.source === 'sibling');
        setSelected(firstProject?.path ?? firstSibling?.path ?? OTHER_OPTION);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setCandidatesError(err.message);
        setCandidates([]); // unblock the "no candidates" UX
        setSelected(OTHER_OPTION);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mode is rebuilt
    // each render from stable props (projectSlug/assignmentSlug/assignmentId);
    // listing those primitive props is the actual dependency contract.
  }, [open, defaultBranch, defaultParentBranch, projectSlug, assignmentSlug, assignmentId]);

  const repository = selected === OTHER_OPTION ? customRepo.trim() : selected;
  const worktreePath = useMemo(() => {
    if (!repository || !branch) return '';
    return `${repository.replace(/\/+$/, '')}/.worktrees/${branch}`;
  }, [repository, branch]);

  const hasNoCandidates =
    candidates !== null && candidates.length === 0;

  const submitDisabled =
    submitting ||
    candidates === null || // still loading — block submit on stale repo
    !repository ||
    !branch.trim() ||
    !parentBranch.trim();

  const handleSubmit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const payload = {
        repository,
        branch: branch.trim(),
        parentBranch: parentBranch.trim(),
      };
      if (mode.kind === 'project-nested') {
        await createAssignmentWorktree(mode.projectSlug, mode.assignmentSlug, payload);
      } else {
        await createAssignmentWorktreeById(mode.assignmentId, payload);
      }
      setOpen(false);
      onCreated();
    } catch (err) {
      if (err instanceof CreateWorktreeError) {
        setSubmitError({ message: err.message, stderr: err.stderr });
      } else if (err instanceof Error) {
        setSubmitError({ message: err.message });
      } else {
        setSubmitError({ message: String(err) });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (!submitting ? setOpen(next) : undefined)}>
      <button
        type="button"
        className="shell-action inline-flex items-center gap-1.5"
        onClick={() => setOpen(true)}
      >
        <GitBranchPlus className="h-3.5 w-3.5" aria-hidden="true" />
        <span>Create worktree</span>
      </button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create worktree</DialogTitle>
          <DialogDescription>
            Creates a git worktree at <code>{`<repo>/.worktrees/<branch>`}</code> and records the
            workspace fields on this assignment&apos;s frontmatter.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 text-sm">
          {hasNoCandidates ? (
            <div className="rounded-md border border-warning-foreground/30 bg-warning px-3 py-2 text-xs text-warning-foreground">
              No repositories configured for this project. Enter a repo path below, or add a{' '}
              <code>repositories:</code> list to <code>project.md</code>.
            </div>
          ) : null}

          {candidatesError ? (
            <div className="rounded-md border border-error-foreground/30 bg-error px-3 py-2 text-xs text-error-foreground">
              Could not load repository candidates: {candidatesError}
            </div>
          ) : null}

          <label className="grid gap-1">
            <span className="text-xs font-medium text-muted-foreground">Repository</span>
            <select
              className="w-full rounded-md border border-border/70 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              disabled={submitting || candidates === null}
            >
              {(candidates ?? []).map((c) => (
                <option key={`${c.source}:${c.path}`} value={c.path}>
                  {c.path}
                  {c.source === 'project'
                    ? ' (project)'
                    : c.sourceAssignmentSlug
                      ? ` (sibling — ${c.sourceAssignmentSlug})`
                      : ' (sibling)'}
                </option>
              ))}
              <option value={OTHER_OPTION}>Other…</option>
            </select>
            {selected === OTHER_OPTION ? (
              <input
                className="mt-1 w-full rounded-md border border-border/70 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                type="text"
                placeholder="/absolute/path/to/repo"
                value={customRepo}
                onChange={(e) => setCustomRepo(e.target.value)}
                disabled={submitting}
              />
            ) : null}
          </label>

          <label className="grid gap-1">
            <span className="text-xs font-medium text-muted-foreground">Branch</span>
            <input
              className="w-full rounded-md border border-border/70 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              type="text"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              disabled={submitting}
            />
          </label>

          <label className="grid gap-1">
            <span className="text-xs font-medium text-muted-foreground">Parent branch</span>
            <input
              className="w-full rounded-md border border-border/70 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              type="text"
              value={parentBranch}
              onChange={(e) => setParentBranch(e.target.value)}
              disabled={submitting}
            />
          </label>

          <div className="grid gap-1">
            <span className="text-xs font-medium text-muted-foreground">Worktree path</span>
            <code className="rounded-md border border-border bg-muted px-2 py-1 text-xs">
              {worktreePath || <span className="opacity-60">— pick a repo & branch —</span>}
            </code>
          </div>

          {submitError ? (
            <div className="rounded-md border border-error-foreground/30 bg-error px-3 py-2 text-xs text-error-foreground">
              <div className="font-medium">{submitError.message}</div>
              {submitError.stderr ? (
                <pre className="mt-2 whitespace-pre-wrap text-[11px] opacity-90">
                  {submitError.stderr}
                </pre>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <DialogClose
            disabled={submitting}
            className="shell-action mt-0 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </DialogClose>
          <button
            type="button"
            disabled={submitDisabled}
            onClick={() => void handleSubmit()}
            className="shell-action mt-0 bg-foreground text-background hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Working…' : 'Create worktree'}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
