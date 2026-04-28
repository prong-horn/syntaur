import { useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, Eye, FileCode2, Save } from 'lucide-react';
import { useWorkspaces, type EditableDocumentType } from '../hooks/useProjects';
import {
  normalizeEditorContent,
  parseAssignmentEditorState,
  parseProjectEditorState,
  parsePlanEditorState,
  parsePlaybookEditorState,
  parseScratchpadEditorState,
} from '../lib/documents';
import { isValidSlug, slugify } from '../lib/slug';
import { MarkdownRenderer } from './MarkdownRenderer';

interface MarkdownEditorProps {
  initialContent: string;
  documentType: Exclude<EditableDocumentType, 'handoff' | 'decision-record'>;
  mode?: 'create' | 'edit';
  onSave: (content: string) => Promise<void>;
  saving: boolean;
  error: string | null;
  title: string;
  description?: string;
  onCancel?: () => void;
  helpTitle?: string;
  helpBody?: string;
  allowSlugEdit?: boolean;
}

type MobilePane = 'edit' | 'preview';

export function MarkdownEditor({
  initialContent,
  documentType,
  mode = 'edit',
  onSave,
  saving,
  error,
  title,
  description,
  onCancel,
  helpTitle: _helpTitle,
  helpBody: _helpBody,
  allowSlugEdit = false,
}: MarkdownEditorProps) {
  const [content, setContent] = useState(initialContent);
  const [rawMode, setRawMode] = useState(false);
  const [mobilePane, setMobilePane] = useState<MobilePane>('edit');

  useEffect(() => {
    setContent(initialContent);
  }, [initialContent]);

  const validationErrors = getValidationErrors(documentType, content);
  const hasChanges = content !== initialContent;
  const previewBody = getBodyContent(documentType, content);
  const statusLabel = hasChanges ? 'Unsaved changes' : mode === 'create' ? 'Draft' : 'Saved';

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border/70 bg-card/90 p-3 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <h1 className="text-lg font-semibold text-foreground">{title}</h1>
              <span className="rounded-full border border-border/70 bg-background/80 px-2.5 py-1 text-xs font-medium text-muted-foreground">
                {statusLabel}
              </span>
            </div>
            {description ? <p className="max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p> : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={onCancel} className="shell-action">
              <ArrowLeft className="h-4 w-4" />
              <span>Back</span>
            </button>
            <button
              type="button"
              onClick={() => setRawMode((value) => !value)}
              className="shell-action"
            >
              <FileCode2 className="h-4 w-4" />
              <span>{rawMode ? 'Structured' : 'Raw Markdown'}</span>
            </button>
            <button
              type="button"
              onClick={() => onSave(content)}
              disabled={saving || validationErrors.length > 0}
              className="inline-flex items-center gap-2 rounded-md bg-foreground px-4 py-2 text-sm font-semibold text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              <span>{saving ? 'Saving…' : 'Save'}</span>
            </button>
          </div>
        </div>

        {error ? (
          <p className="mt-4 rounded-md border border-error-foreground/30 bg-error px-4 py-3 text-sm text-error-foreground">
            {error}
          </p>
        ) : null}

        {validationErrors.length > 0 ? (
          <div className="mt-4 rounded-md border border-warning-foreground/30 bg-warning px-4 py-3 text-sm text-warning-foreground">
            <ul className="space-y-1">
              {validationErrors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-2 md:hidden">
        <button
          type="button"
          onClick={() => setMobilePane('edit')}
          className={`shell-action ${mobilePane === 'edit' ? 'bg-foreground text-background' : ''}`}
        >
          Edit
        </button>
        <button
          type="button"
          onClick={() => setMobilePane('preview')}
          className={`shell-action ${mobilePane === 'preview' ? 'bg-foreground text-background' : ''}`}
        >
          <Eye className="h-4 w-4" />
          Preview
        </button>
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
        <div className={mobilePane === 'preview' ? 'hidden md:block' : ''}>
          <div className="surface-panel space-y-3">
            {rawMode ? (
              <textarea
                value={content}
                onChange={(event) => setContent(event.target.value)}
                className="min-h-[720px] w-full rounded-md border border-border/70 bg-background/90 p-4 font-mono text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-ring/30"
                spellCheck={false}
              />
            ) : (
              <StructuredEditor
                documentType={documentType}
                content={content}
                onChange={setContent}
                allowSlugEdit={allowSlugEdit}
              />
            )}
          </div>
        </div>

        <div className={mobilePane === 'edit' ? 'hidden md:block' : ''}>
          <div className="surface-panel sticky top-16 space-y-4">
            <div className="flex items-center gap-2">
              <Eye className="h-4 w-4 text-muted-foreground" />
              <h2 className="text-lg font-semibold text-foreground">Preview</h2>
            </div>
            <MarkdownRenderer content={previewBody} emptyState="Write markdown body content to preview it here." />
          </div>
        </div>
      </div>
    </div>
  );
}

function StructuredEditor({
  documentType,
  content,
  onChange,
  allowSlugEdit,
}: {
  documentType: MarkdownEditorProps['documentType'];
  content: string;
  onChange: (content: string) => void;
  allowSlugEdit: boolean;
}) {
  if (documentType === 'project') {
    const state = parseProjectEditorState(content);
    return (
      <div className="space-y-3">
        <FormGrid>
          <Field label="Project title">
            <input
              value={state.title}
              onChange={(event) => {
                const nextTitle = event.target.value;
                const updates: Record<string, string | boolean> = { title: nextTitle };
                if (allowSlugEdit && (state.slug === slugify(state.title) || !state.slug.trim())) {
                  updates.slug = slugify(nextTitle);
                }
                onChange(normalizeEditorContent(documentType, content, updates));
              }}
              className="editor-input"
            />
          </Field>
          <Field label="Slug">
            <div className="space-y-2">
              <input
                value={state.slug}
                disabled={!allowSlugEdit}
                onChange={(event) => onChange(normalizeEditorContent(documentType, content, { slug: slugify(event.target.value) }))}
                className={`editor-input ${allowSlugEdit ? '' : 'editor-input-disabled'}`}
              />
              <p className="text-xs leading-5 text-muted-foreground">
                {allowSlugEdit
                  ? 'The slug becomes the folder name and URL. It is auto-generated from the title until you change it, and it cannot be renamed after creation.'
                  : 'The slug is the folder name and URL-safe identifier. It is locked after creation so links and file paths stay stable.'}
              </p>
            </div>
          </Field>
          <Field label="Tags">
            <input
              value={state.tags}
              onChange={(event) => onChange(normalizeEditorContent(documentType, content, { tags: event.target.value }))}
              placeholder="Comma-separated tags"
              className="editor-input"
            />
          </Field>
          <WorkspaceField
            value={state.workspace}
            onChange={(value) => onChange(normalizeEditorContent(documentType, content, { workspace: value }))}
          />
        </FormGrid>

        <Field label="Project body">
          <textarea
            value={state.body}
            onChange={(event) => onChange(normalizeEditorContent(documentType, content, { body: event.target.value }))}
            className="editor-textarea"
            spellCheck={false}
          />
        </Field>
      </div>
    );
  }

  if (documentType === 'assignment') {
    const state = parseAssignmentEditorState(content);
    return (
      <div className="space-y-3">
        <FormGrid>
          <Field label="Assignment title">
            <input
              value={state.title}
              onChange={(event) => {
                const nextTitle = event.target.value;
                const updates: Record<string, string | boolean> = { title: nextTitle };
                if (allowSlugEdit && (state.slug === slugify(state.title) || !state.slug.trim())) {
                  updates.slug = slugify(nextTitle);
                }
                onChange(normalizeEditorContent(documentType, content, updates));
              }}
              className="editor-input"
            />
          </Field>
          <Field label="Slug">
            <div className="space-y-2">
              <input
                value={state.slug}
                disabled={!allowSlugEdit}
                onChange={(event) => onChange(normalizeEditorContent(documentType, content, { slug: slugify(event.target.value) }))}
                className={`editor-input ${allowSlugEdit ? '' : 'editor-input-disabled'}`}
              />
              <p className="text-xs leading-5 text-muted-foreground">
                {allowSlugEdit
                  ? 'The slug becomes the assignment folder name and URL. It is auto-generated from the title until you change it, and it cannot be renamed after creation.'
                  : 'The slug is locked after creation because assignment paths and dependency references use it as a stable identifier.'}
              </p>
            </div>
          </Field>
          <Field label="Status">
            <select
              value={state.status}
              onChange={(event) => onChange(normalizeEditorContent(documentType, content, { status: event.target.value }))}
              className="editor-input"
            >
              <option value="pending">Pending</option>
              <option value="in_progress">In Progress</option>
              <option value="blocked">Blocked</option>
              <option value="review">Review</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
            </select>
          </Field>
          <Field label="Priority">
            <select
              value={state.priority}
              onChange={(event) => onChange(normalizeEditorContent(documentType, content, { priority: event.target.value }))}
              className="editor-input"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </Field>
          <Field label="Assignee">
            <input
              value={state.assignee}
              onChange={(event) => onChange(normalizeEditorContent(documentType, content, { assignee: event.target.value }))}
              placeholder="Agent name"
              className="editor-input"
            />
          </Field>
          <Field label="Depends on" className="md:col-span-2">
            <input
              value={state.dependsOn}
              onChange={(event) => onChange(normalizeEditorContent(documentType, content, { dependsOn: event.target.value }))}
              placeholder="Comma-separated assignment slugs"
              className="editor-input"
            />
          </Field>
          <Field label="Links" className="md:col-span-2">
            <input
              value={state.links}
              onChange={(event) => onChange(normalizeEditorContent(documentType, content, { links: event.target.value }))}
              placeholder="Comma-separated: projectSlug/assignmentSlug"
              className="editor-input"
            />
          </Field>
          <Field label="Blocked reason" className="md:col-span-2">
            <input
              value={state.blockedReason}
              onChange={(event) =>
                onChange(normalizeEditorContent(documentType, content, { blockedReason: event.target.value }))
              }
              placeholder="Read-only unless the assignment is actually blocked"
              className="editor-input"
            />
          </Field>
          <Field label="Tags" className="md:col-span-2">
            <input
              value={state.tags}
              onChange={(event) => onChange(normalizeEditorContent(documentType, content, { tags: event.target.value }))}
              placeholder="Comma-separated tags"
              className="editor-input"
            />
          </Field>
        </FormGrid>

        <Field label="Assignment body">
          <textarea
            value={state.body}
            onChange={(event) => onChange(normalizeEditorContent(documentType, content, { body: event.target.value }))}
            className="editor-textarea"
            spellCheck={false}
          />
        </Field>
      </div>
    );
  }

  if (documentType === 'plan') {
    const state = parsePlanEditorState(content);
    return (
      <div className="space-y-3">
        <FormGrid>
          <Field label="Assignment">
            <input value={state.assignment} disabled className="editor-input editor-input-disabled" />
          </Field>
          <Field label="Plan status">
            <select
              value={state.status}
              onChange={(event) => onChange(normalizeEditorContent(documentType, content, { status: event.target.value }))}
              className="editor-input"
            >
              <option value="draft">Draft</option>
              <option value="approved">Approved</option>
              <option value="in_progress">In Progress</option>
              <option value="completed">Completed</option>
            </select>
          </Field>
        </FormGrid>
        <Field label="Plan body">
          <textarea
            value={state.body}
            onChange={(event) => onChange(normalizeEditorContent(documentType, content, { body: event.target.value }))}
            className="editor-textarea"
            spellCheck={false}
          />
        </Field>
      </div>
    );
  }

  if (documentType === 'scratchpad') {
    const state = parseScratchpadEditorState(content);
    return (
      <div className="space-y-3">
        <FormGrid>
          <Field label="Assignment">
            <input value={state.assignment} disabled className="editor-input editor-input-disabled" />
          </Field>
        </FormGrid>
        <Field label="Scratchpad body">
          <textarea
            value={state.body}
            onChange={(event) => onChange(normalizeEditorContent(documentType, content, { body: event.target.value }))}
            className="editor-textarea"
            spellCheck={false}
          />
        </Field>
      </div>
    );
  }

  // playbook
  const state = parsePlaybookEditorState(content);
  return (
    <div className="space-y-3">
      <FormGrid>
        <Field label="Playbook name">
          <input
            value={state.name}
            onChange={(event) => {
              const nextName = event.target.value;
              const updates: Record<string, string | boolean> = { name: nextName };
              if (allowSlugEdit && (state.slug === slugify(state.name) || !state.slug.trim())) {
                updates.slug = slugify(nextName);
              }
              onChange(normalizeEditorContent(documentType, content, updates));
            }}
            className="editor-input"
          />
        </Field>
        <Field label="Slug">
          <div className="space-y-2">
            <input
              value={state.slug}
              disabled={!allowSlugEdit}
              onChange={(event) => onChange(normalizeEditorContent(documentType, content, { slug: slugify(event.target.value) }))}
              className={`editor-input ${allowSlugEdit ? '' : 'editor-input-disabled'}`}
            />
            <p className="text-xs leading-5 text-muted-foreground">
              {allowSlugEdit
                ? 'The slug becomes the filename. It is auto-generated from the name until you change it.'
                : 'The slug is locked after creation because it is the filename.'}
            </p>
          </div>
        </Field>
        <Field label="Description" className="md:col-span-2">
          <input
            value={state.description}
            onChange={(event) => onChange(normalizeEditorContent(documentType, content, { description: event.target.value }))}
            placeholder="One-line description of what this playbook does"
            className="editor-input"
          />
        </Field>
        <Field label="Tags" className="md:col-span-2">
          <input
            value={state.tags}
            onChange={(event) => onChange(normalizeEditorContent(documentType, content, { tags: event.target.value }))}
            placeholder="Comma-separated tags"
            className="editor-input"
          />
        </Field>
        <Field label="When to use" className="md:col-span-2">
          <input
            value={state.whenToUse}
            onChange={(event) => onChange(normalizeEditorContent(documentType, content, { whenToUse: event.target.value }))}
            placeholder="Describe when agents should apply this playbook"
            className="editor-input"
          />
        </Field>
      </FormGrid>

      <Field label="Playbook rules">
        <textarea
          value={state.body}
          onChange={(event) => onChange(normalizeEditorContent(documentType, content, { body: event.target.value }))}
          className="editor-textarea"
          spellCheck={false}
        />
      </Field>
    </div>
  );
}

function FormGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 md:grid-cols-2">{children}</div>;
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`block space-y-2 ${className ?? ''}`}>
      <span className="text-sm font-medium text-foreground">{label}</span>
      {children}
    </label>
  );
}

function WorkspaceField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { data } = useWorkspaces();
  const workspaces = data?.workspaces ?? [];

  return (
    <Field label="Workspace">
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="editor-input"
      >
        <option value="">Ungrouped</option>
        {workspaces.map((w) => (
          <option key={w} value={w}>{w}</option>
        ))}
      </select>
    </Field>
  );
}

function getBodyContent(
  documentType: MarkdownEditorProps['documentType'],
  content: string,
): string {
  switch (documentType) {
    case 'project':
      return parseProjectEditorState(content).body;
    case 'assignment':
      return parseAssignmentEditorState(content).body;
    case 'plan':
      return parsePlanEditorState(content).body;
    case 'scratchpad':
      return parseScratchpadEditorState(content).body;
    case 'playbook':
      return parsePlaybookEditorState(content).body;
  }
}

function getValidationErrors(
  documentType: MarkdownEditorProps['documentType'],
  content: string,
): string[] {
  switch (documentType) {
    case 'project': {
      const state = parseProjectEditorState(content);
      return [
        !state.title.trim() ? 'Project title is required.' : null,
        !state.slug.trim() ? 'Project slug is required.' : null,
        state.slug.trim() && !isValidSlug(state.slug) ? 'Project slug must be lowercase letters, numbers, and hyphens only.' : null,
      ].filter((value): value is string => Boolean(value));
    }
    case 'assignment': {
      const state = parseAssignmentEditorState(content);
      return [
        !state.title.trim() ? 'Assignment title is required.' : null,
        !state.slug.trim() ? 'Assignment slug is required.' : null,
        state.slug.trim() && !isValidSlug(state.slug) ? 'Assignment slug must be lowercase letters, numbers, and hyphens only.' : null,
      ].filter((value): value is string => Boolean(value));
    }
    case 'plan': {
      const state = parsePlanEditorState(content);
      return !state.assignment.trim() ? ['Plan assignment is required.'] : [];
    }
    case 'scratchpad': {
      const state = parseScratchpadEditorState(content);
      return !state.assignment.trim() ? ['Scratchpad assignment is required.'] : [];
    }
    case 'playbook': {
      const state = parsePlaybookEditorState(content);
      return [
        !state.name.trim() ? 'Playbook name is required.' : null,
        !state.slug.trim() ? 'Playbook slug is required.' : null,
        state.slug.trim() && !isValidSlug(state.slug) ? 'Playbook slug must be lowercase letters, numbers, and hyphens only.' : null,
      ].filter((value): value is string => Boolean(value));
    }
  }
}
