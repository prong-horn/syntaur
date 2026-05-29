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
  getProjectSourceAssignments,
  getRepositoryBranches,
  getRepositoryBranchesById,
  getSourceAssignmentsById,
  validateBranchName,
  type RepositoryCandidate,
  type SourceAssignment,
} from '../lib/assignments';

type Mode =
  | { kind: 'project-nested'; projectSlug: string; assignmentSlug: string }
  | { kind: 'standalone'; assignmentId: string };

/** Which flavour of worktree the user is creating. */
type FlowMode = 'new-branch' | 'branch-off';

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
  /** Fallback parent branch if a repo's default can't be detected. */
  defaultParentBranch?: string;
  /** Called after a successful create; the parent typically calls `refetch()`. */
  onCreated: () => void;
}

const SELECT_CLASS =
  'w-full rounded-md border border-border/70 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50';

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
  const [flowMode, setFlowMode] = useState<FlowMode>('new-branch');

  // New-branch mode: repository selection.
  const [candidates, setCandidates] = useState<RepositoryCandidate[] | null>(null);
  const [candidatesError, setCandidatesError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [customRepo, setCustomRepo] = useState('');

  // New-branch mode: parent-branch dropdown fed by the repo's real branches.
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesError, setBranchesError] = useState<string | null>(null);
  const [parentBranch, setParentBranch] = useState('');

  // Branch-off mode: pick a source assignment; repo + parent come from it.
  const [sourceAssignments, setSourceAssignments] = useState<SourceAssignment[] | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [selectedSourceId, setSelectedSourceId] = useState('');

  const [branch, setBranch] = useState(defaultBranch);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<{ message: string; stderr?: string } | null>(null);

  // On open: reset everything, then load repo candidates (new-branch mode) and
  // source assignments (branch-off mode) in parallel.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setFlowMode('new-branch');
    setCandidates(null);
    setCandidatesError(null);
    setSelected('');
    setShowAdvanced(false);
    setCustomRepo('');
    setBranches([]);
    setBranchesLoading(false);
    setBranchesError(null);
    setParentBranch('');
    setSourceAssignments(null);
    setSourceError(null);
    setSelectedSourceId('');
    setBranch(defaultBranch);
    setSubmitError(null);

    const candLoader = mode.kind === 'project-nested'
      ? getProjectRepositoryCandidates(mode.projectSlug)
      : getAssignmentRepositoryCandidatesById(mode.assignmentId);
    candLoader
      .then((list) => {
        if (cancelled) return;
        setCandidates(list);
        if (list.length === 0) {
          // No candidates — the custom-path field is the only way forward.
          setShowAdvanced(true);
        } else {
          const firstProject = list.find((c) => c.source === 'project');
          const firstSibling = list.find((c) => c.source === 'sibling');
          setSelected(firstProject?.path ?? firstSibling?.path ?? list[0]!.path);
        }
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setCandidatesError(err.message);
        setCandidates([]);
        setShowAdvanced(true);
      });

    const sourceLoader = mode.kind === 'project-nested'
      ? getProjectSourceAssignments(mode.projectSlug, mode.assignmentSlug)
      : getSourceAssignmentsById(mode.assignmentId);
    sourceLoader
      .then((list) => {
        if (!cancelled) setSourceAssignments(list);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setSourceError(err.message);
        setSourceAssignments([]);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mode is rebuilt
    // each render from stable primitive props; listing those is the real dep set.
  }, [open, defaultBranch, defaultParentBranch, projectSlug, assignmentSlug, assignmentId]);

  const selectedSource = flowMode === 'branch-off'
    ? (sourceAssignments ?? []).find((s) => s.id === selectedSourceId) ?? null
    : null;

  // In branch-off mode the repo is the source assignment's repo; otherwise it's
  // the selected candidate (or the advanced custom path).
  const repository = flowMode === 'branch-off'
    ? (selectedSource?.repository ?? '')
    : showAdvanced
      ? customRepo.trim()
      : selected;

  // Load the repo's branches for the parent-branch dropdown. CRITICAL: this is
  // guarded to new-branch mode. In branch-off mode `parentBranch` is owned by
  // the selected source (`source.branch`); letting this effect run would clobber
  // it with the repo's default branch.
  useEffect(() => {
    if (!open) return;
    if (flowMode !== 'new-branch') return;
    if (!repository) {
      setBranches([]);
      setBranchesError(null);
      setBranchesLoading(false);
      setParentBranch('');
      return;
    }
    let cancelled = false;
    setBranchesLoading(true);
    setBranchesError(null);
    // Clear the stale parent selection while the new repo's branches load.
    setParentBranch('');
    const loader = mode.kind === 'project-nested'
      ? getRepositoryBranches(mode.projectSlug, mode.assignmentSlug, repository)
      : getRepositoryBranchesById(mode.assignmentId, repository);
    loader
      .then((res) => {
        if (cancelled) return;
        setBranches(res.branches);
        // Only adopt a default that is actually a loaded local branch, so the
        // dropdown selection always matches a real <option> (and the server's
        // parent-branch pre-flight can't reject what we prefilled).
        const fallback =
          (res.defaultBranch && res.branches.includes(res.defaultBranch)
            ? res.defaultBranch
            : res.branches.includes(defaultParentBranch)
              ? defaultParentBranch
              : res.branches[0]) ?? '';
        setParentBranch(fallback);
        setBranchesLoading(false);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setBranches([]);
        setBranchesError(err.message);
        setBranchesLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mode rebuilt from
    // stable primitive props; repository/flowMode are the real triggers.
  }, [open, flowMode, repository, defaultParentBranch, projectSlug, assignmentSlug, assignmentId]);

  const branchValidationError = validateBranchName(branch.trim());

  const worktreePath = useMemo(() => {
    if (!repository || !branch.trim()) return '';
    return `${repository.replace(/\/+$/, '')}/.worktrees/${branch.trim()}`;
  }, [repository, branch]);

  const hasNoCandidates = candidates !== null && candidates.length === 0;
  const hasNoSources = sourceAssignments !== null && sourceAssignments.length === 0;

  const handleFlowMode = (next: FlowMode) => {
    if (next === flowMode) return;
    setFlowMode(next);
    setSelectedSourceId('');
    setSubmitError(null);
    if (next === 'branch-off') {
      // parentBranch is set when a source is chosen; branches effect is suppressed.
      setParentBranch('');
      setBranches([]);
      setBranchesError(null);
      setBranchesLoading(false);
    }
    // Switching to new-branch re-runs the branches effect (flowMode changed),
    // which repopulates branches + parentBranch for the selected repo.
  };

  const handleSourceSelect = (id: string) => {
    setSelectedSourceId(id);
    const src = (sourceAssignments ?? []).find((s) => s.id === id);
    setParentBranch(src?.branch ?? '');
  };

  const submitDisabled =
    submitting ||
    branchValidationError !== null ||
    !repository ||
    !parentBranch.trim() ||
    (flowMode === 'new-branch'
      ? candidates === null || branchesLoading
      : sourceAssignments === null || !selectedSourceId);

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
          {/* Mode toggle */}
          <div className="grid grid-cols-2 gap-1 rounded-md border border-border/70 p-1">
            <button
              type="button"
              disabled={submitting}
              onClick={() => handleFlowMode('new-branch')}
              className={`rounded px-2 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed ${
                flowMode === 'new-branch'
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              New branch from repo
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={() => handleFlowMode('branch-off')}
              className={`rounded px-2 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed ${
                flowMode === 'branch-off'
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              Branch off another assignment
            </button>
          </div>

          {flowMode === 'new-branch' ? (
            <>
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
                  className={SELECT_CLASS}
                  value={selected}
                  onChange={(e) => setSelected(e.target.value)}
                  disabled={submitting || candidates === null || showAdvanced}
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
                </select>
                {!hasNoCandidates ? (
                  <button
                    type="button"
                    className="justify-self-start text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={submitting}
                    onClick={() => setShowAdvanced((v) => !v)}
                  >
                    {showAdvanced ? 'Use a listed repository' : 'Enter a custom repository path (advanced)'}
                  </button>
                ) : null}
                {showAdvanced ? (
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
                <span className="text-xs font-medium text-muted-foreground">Parent branch</span>
                <select
                  className={SELECT_CLASS}
                  value={parentBranch}
                  onChange={(e) => setParentBranch(e.target.value)}
                  disabled={submitting || branchesLoading || branches.length === 0}
                >
                  {branchesLoading ? (
                    <option value="">Loading branches…</option>
                  ) : branches.length === 0 ? (
                    <option value="">
                      {branchesError ? 'Could not load branches' : repository ? 'No branches found' : '— pick a repository —'}
                    </option>
                  ) : (
                    branches.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))
                  )}
                </select>
                {branchesError ? (
                  <span className="text-[11px] text-error-foreground">
                    Could not load branches: {branchesError}
                  </span>
                ) : null}
              </label>
            </>
          ) : (
            <>
              {sourceError ? (
                <div className="rounded-md border border-error-foreground/30 bg-error px-3 py-2 text-xs text-error-foreground">
                  Could not load assignments: {sourceError}
                </div>
              ) : null}

              {hasNoSources ? (
                <div className="rounded-md border border-warning-foreground/30 bg-warning px-3 py-2 text-xs text-warning-foreground">
                  No other assignments with a configured workspace to branch off. Create a worktree
                  for one first, or use “New branch from repo”.
                </div>
              ) : (
                <label className="grid gap-1">
                  <span className="text-xs font-medium text-muted-foreground">Source assignment</span>
                  <select
                    className={SELECT_CLASS}
                    value={selectedSourceId}
                    onChange={(e) => handleSourceSelect(e.target.value)}
                    disabled={submitting || sourceAssignments === null}
                  >
                    <option value="">— select an assignment —</option>
                    {(sourceAssignments ?? []).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title} ({s.branch})
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {selectedSource ? (
                <div className="grid gap-2 rounded-md border border-border/70 bg-muted/40 px-3 py-2 text-xs">
                  <div className="grid gap-0.5">
                    <span className="font-medium text-muted-foreground">Repository (from source)</span>
                    <code className="break-all">{selectedSource.repository}</code>
                  </div>
                  <div className="grid gap-0.5">
                    <span className="font-medium text-muted-foreground">Parent branch (from source)</span>
                    <code>{selectedSource.branch}</code>
                  </div>
                </div>
              ) : null}
            </>
          )}

          <label className="grid gap-1">
            <span className="text-xs font-medium text-muted-foreground">New branch name</span>
            <input
              className="w-full rounded-md border border-border/70 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              type="text"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              disabled={submitting}
            />
            {branchValidationError ? (
              <span className="text-[11px] text-error-foreground">{branchValidationError}</span>
            ) : null}
          </label>

          <div className="grid gap-1">
            <span className="text-xs font-medium text-muted-foreground">Worktree path</span>
            <code className="rounded-md border border-border bg-muted px-2 py-1 text-xs break-all">
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
