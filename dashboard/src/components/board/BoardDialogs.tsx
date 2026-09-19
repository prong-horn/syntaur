import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { mutate } from '../../data/mutate';
import { apiUrl, projectWriteTargets, ticketWriteTargets } from '../../data/resources';
import { boardResources } from '../../data/boardResources';
import { useResource } from '../../data/useResource';
import { useProjects } from '../../hooks/useProjects';
import { useTemplates, getTemplateLabel } from '../../hooks/useTemplates';
import { MarkdownEditor } from '../MarkdownEditor';
import { LoadingState } from '../LoadingState';
import { ErrorState } from '../ErrorState';
import type { BoardFilterActions, BoardFilterState } from '../../hooks/useBoardFilters';
import { DocumentEditorPage } from '../DocumentEditorPage';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../ui/dialog';

function injectTemplateFrontmatter(content: string, templateId: string): string {
  if (/^template:\s/m.test(content)) {
    return content.replace(/^template:\s*.*$/m, `template: ${templateId}`);
  }
  return content.replace(/^(---\n)/, `---\ntemplate: ${templateId}\n`);
}

export type NewTicketDialogDraft = {
  content: string;
  projectSlug: string;
  templateId: string;
};

export interface BoardDialogsProps {
  state: BoardFilterState;
  actions: BoardFilterActions;
  showToast: (message: string, kind: 'success' | 'error') => void;
  /** Optional override for dialog close focus restoration (integration tests). */
  restoreFocusRef?: React.MutableRefObject<HTMLElement | null>;
}

export function BoardDialogs({ state, actions, showToast, restoreFocusRef: restoreFocusOverride }: BoardDialogsProps) {
  const { data: projects } = useProjects();
  const activeProjects = useMemo(() => (projects ?? []).filter((p) => p.status !== 'archived'), [projects]);
  const [pendingTicketDraft, setPendingTicketDraft] = useState<NewTicketDialogDraft | null>(null);
  const [newProjectReturnToTicket, setNewProjectReturnToTicket] = useState(false);
  const internalRestoreFocusRef = useRef<HTMLElement | null>(null);
  const prevDialogRef = useRef<BoardFilterState['dialog']>(null);

  useEffect(() => {
    if (state.dialog === null || state.dialog === 'edit-project') {
      setPendingTicketDraft(null);
      setNewProjectReturnToTicket(false);
    }
  }, [state.dialog]);

  const clearTicketDraftFlow = () => {
    setPendingTicketDraft(null);
    setNewProjectReturnToTicket(false);
  };

  const closeNewTicketDialog = () => {
    clearTicketDraftFlow();
    actions.setDialog(null);
  };

  const openNewProjectFromTicket = (snapshot: NewTicketDialogDraft) => {
    setPendingTicketDraft(snapshot);
    setNewProjectReturnToTicket(true);
    actions.setDialog('new-project');
  };
  if (!restoreFocusOverride) {
    if (state.dialog && !prevDialogRef.current) {
      const active = document.activeElement;
      if (active instanceof HTMLElement) {
        internalRestoreFocusRef.current = active;
      }
    }
  }
  useEffect(() => {
    if (restoreFocusOverride) return;
    const hadDialog = prevDialogRef.current;
    prevDialogRef.current = state.dialog;
    if (hadDialog && !state.dialog) {
      const restore = internalRestoreFocusRef.current;
      internalRestoreFocusRef.current = null;
      if (restore?.isConnected) {
        restore.focus({ preventScroll: true });
      }
    }
  }, [state.dialog, restoreFocusOverride]);
  const restoreFocusRef = restoreFocusOverride ?? internalRestoreFocusRef;

  const editSlug = state.project.length === 1 ? state.project[0] : null;

  if (state.dialog === 'edit-project' && editSlug) {
    return (
      <DialogShell
        onClose={() => actions.setDialog(null)}
        restoreFocusRef={restoreFocusRef}
        title="Edit Project"
        description="Edit the human-authored project document."
      >
          <DocumentEditorPage
            loadUrl={boardResources.projectEditDocument(editSlug).url}
            saveUrl={apiUrl(['projects', editSlug])}
            redirectTo=""
            onSaved={() => {
              actions.setDialog(null);
              showToast('Project saved', 'success');
            }}
            onCancel={() => actions.setDialog(null)}
            title="Edit Project"
            description="Project edits change the human-authored source document."
            documentType="project"
            helpTitle="Editable vs derived project fields"
            helpBody="Project status remains derived from ticket state."
          />
      </DialogShell>
    );
  }

  if (state.dialog === 'new-project') {
    return (
      <NewProjectDialog
        returnToTicketAfterClose={newProjectReturnToTicket}
        onClose={() => {
          if (newProjectReturnToTicket) {
            actions.setDialog('new-ticket');
            return;
          }
          actions.setDialog(null);
        }}
        onCreatedReturnToTicket={(slug) => {
          setPendingTicketDraft((draft) => ({
            content: draft?.content ?? '',
            projectSlug: slug,
            templateId: draft?.templateId ?? 'feature',
          }));
          setNewProjectReturnToTicket(false);
          actions.setDialog('new-ticket');
        }}
        restoreFocusRef={restoreFocusRef}
        showToast={showToast}
      />
    );
  }

  if (state.dialog === 'new-ticket') {
    return (
      <NewTicketDialog
        initialProjectSlug={state.project.length === 1 ? state.project[0] : null}
        activeProjects={activeProjects}
        restoredDraft={pendingTicketDraft}
        onClose={closeNewTicketDialog}
        onNeedProject={openNewProjectFromTicket}
        restoreFocusRef={restoreFocusRef}
        showToast={showToast}
      />
    );
  }

  return null;
}

function NewProjectDialog({
  onClose,
  returnToTicketAfterClose,
  onCreatedReturnToTicket,
  restoreFocusRef,
  showToast,
}: {
  onClose: () => void;
  returnToTicketAfterClose: boolean;
  onCreatedReturnToTicket: (slug: string) => void;
  restoreFocusRef: React.MutableRefObject<HTMLElement | null>;
  showToast: (message: string, kind: 'success' | 'error') => void;
}) {
  const { data, loading, error, refetch } = useResource(boardResources.projectTemplate());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function handleSave(content: string) {
    setSaving(true);
    setSaveError(null);
    try {
      const payload = await mutate<{ slug: string }>('POST', apiUrl(['projects']), { content }, {
        invalidates: projectWriteTargets(),
      });
      if (returnToTicketAfterClose) {
        showToast('Project created', 'success');
        onCreatedReturnToTicket(payload.slug);
        return;
      }
      showToast('Project created', 'success');
      onClose();
      navigate(`/board?project=${encodeURIComponent(payload.slug)}&panel=project`);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Create failed');
      setSaving(false);
    }
  }

  let body: React.ReactNode;
  if (loading) {
    body = <LoadingState label="Loading template…" />;
  } else if (error || !data) {
    body = (
      <ErrorState
        error={typeof error === 'string' ? error : error?.message || 'Template unavailable'}
        onRetry={refetch}
      />
    );
  } else {
    body = (
      <MarkdownEditor
        initialContent={data.content}
        documentType="project"
        mode="create"
        onSave={handleSave}
        saving={saving}
        error={saveError}
        title="Create Project"
        onCancel={onClose}
        helpTitle="Project editing rules"
        helpBody="Use this form for project intent, slug, tags, and overview content."
        allowSlugEdit
      />
    );
  }

  return (
    <DialogShell onClose={onClose} restoreFocusRef={restoreFocusRef} title="Create Project">
      {body}
    </DialogShell>
  );
}

function NewTicketDialog({
  initialProjectSlug,
  activeProjects,
  restoredDraft,
  onClose,
  onNeedProject,
  restoreFocusRef,
  showToast,
}: {
  initialProjectSlug: string | null;
  activeProjects: Array<{ slug: string; title: string; defaultTemplate?: string }>;
  restoredDraft: NewTicketDialogDraft | null;
  onClose: () => void;
  onNeedProject: (snapshot: NewTicketDialogDraft) => void;
  restoreFocusRef: React.MutableRefObject<HTMLElement | null>;
  showToast: (message: string, kind: 'success' | 'error') => void;
}) {
  const templatesConfig = useTemplates();
  const { data: templateData, loading, error, refetch } = useResource(boardResources.ticketTemplate());
  const [projectSlug, setProjectSlug] = useState(
    () => restoredDraft?.projectSlug ?? initialProjectSlug ?? '',
  );
  const [templateId, setTemplateId] = useState(() => restoredDraft?.templateId ?? 'feature');
  const [draftContent, setDraftContent] = useState<string | null>(() => restoredDraft?.content ?? null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!restoredDraft) return;
    setDraftContent(restoredDraft.content);
    setProjectSlug(restoredDraft.projectSlug);
    setTemplateId(restoredDraft.templateId);
  }, [restoredDraft?.content, restoredDraft?.projectSlug, restoredDraft?.templateId]);

  useEffect(() => {
    if (restoredDraft || !templateData?.content || draftContent !== null) return;
    setDraftContent(templateData.content);
  }, [draftContent, restoredDraft, templateData?.content]);

  useEffect(() => {
    if (!projectSlug || !activeProjects.length) return;
    const project = activeProjects.find((p) => p.slug === projectSlug);
    if (project?.defaultTemplate) setTemplateId(project.defaultTemplate);
  }, [activeProjects, projectSlug]);

  async function handleSave(markdownContent: string) {
    if (!projectSlug) {
      setSaveError('Select a project before creating a ticket.');
      return;
    }
    if (activeProjects.length === 0) {
      onNeedProject({ content: markdownContent, projectSlug, templateId });
      return;
    }
    setSaving(true);
    setSaveError(null);
    const content = injectTemplateFrontmatter(markdownContent, templateId);
    try {
      const payload = await mutate<{ slug: string; id?: string }>(
        'POST',
        apiUrl(['projects', projectSlug, 'tickets']),
        { content },
        { invalidates: ticketWriteTargets(undefined, projectSlug),
        },
      );
      showToast('Ticket created', 'success');
      onClose();
      navigate(payload.id ? `/t/${payload.id}` : `/board?project=${encodeURIComponent(projectSlug)}`);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Create failed');
      setSaving(false);
    }
  }

  let body: React.ReactNode;
  if (error) {
    body = <ErrorState error={typeof error === 'string' ? error : error.message} onRetry={refetch} />;
  } else if (loading || draftContent === null) {
    body = <LoadingState label="Loading ticket template…" />;
  } else {
    body = (
      <>
        <div className="mb-4 flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">Project</span>
            <select
              className="rounded-md border border-border bg-background px-3 py-2"
              value={projectSlug}
              onChange={(e) => setProjectSlug(e.target.value)}
            >
              <option value="">Select project…</option>
              {projectSlug && !activeProjects.some((p) => p.slug === projectSlug) ? (
                <option value={projectSlug}>{projectSlug}</option>
              ) : null}
              {activeProjects.map((p) => (
                <option key={p.slug} value={p.slug}>{p.title}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">Template</span>
            <select
              className="rounded-md border border-border bg-background px-3 py-2"
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
            >
              {templatesConfig.definitions.map((def) => (
                <option key={def.id} value={def.id}>{getTemplateLabel(templatesConfig, def.id)}</option>
              ))}
            </select>
          </label>
          {activeProjects.length === 0 ? (
            <button
              type="button"
              className="shell-action self-end"
              onClick={() => {
                if (draftContent === null) return;
                onNeedProject({ content: draftContent, projectSlug, templateId });
              }}
            >
              Create a project first
            </button>
          ) : null}
        </div>
        <MarkdownEditor
          initialContent={draftContent}
          documentType="ticket"
          mode="create"
          onSave={handleSave}
          saving={saving}
          error={saveError}
          title="Create Ticket"
          onCancel={onClose}
          onContentChange={setDraftContent}
          helpTitle="Ticket editing rules"
          helpBody="New tickets start in backlog. Select the owning project before submit."
          allowSlugEdit
        />
      </>
    );
  }

  return (
    <DialogShell onClose={onClose} restoreFocusRef={restoreFocusRef} title="Create Ticket">
      {body}
    </DialogShell>
  );
}

function DialogShell({
  children,
  onClose,
  restoreFocusRef,
  title = 'Board dialog',
  description = 'Complete the board action, or close this dialog to return to the board.',
}: {
  children: React.ReactNode;
  onClose: () => void;
  restoreFocusRef?: React.MutableRefObject<HTMLElement | null>;
  title?: string;
  description?: string;
}) {
  const [open, setOpen] = useState(true);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          const restore = restoreFocusRef?.current ?? null;
          restore?.focus({ preventScroll: true });
          onCloseRef.current();
        }
      }}
    >
      <DialogContent className="max-h-[calc(100vh-2rem)] max-w-4xl overflow-y-auto" aria-describedby="board-dialog-description">
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription id="board-dialog-description" className="sr-only">{description}</DialogDescription>
        <DialogClose asChild>
          <button type="button" aria-label="Close dialog" className="absolute right-3 top-3 text-sm text-muted-foreground hover:text-foreground">
            Close
          </button>
        </DialogClose>
        {children}
      </DialogContent>
    </Dialog>
  );
}
