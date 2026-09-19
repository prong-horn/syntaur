import { Link } from 'react-router-dom';
import { NotebookPen } from 'lucide-react';
import { ContentTabs } from '../ContentTabs';
import { SectionCard } from '../SectionCard';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { EmptyState } from '../EmptyState';
import { ActivityTimeline } from '../ActivityTimeline';
import { SessionActivityTimeline } from '../SessionActivityTimeline';
import { ChatTab } from '../chat/ChatTab';
import { DocumentEditorPage } from '../DocumentEditorPage';
import { JournalTab } from './JournalTab';
import { buildTicketTabs, type TicketTabSpec } from '../../lib/ticketTabs';
import {
  resolveTicketFileEditor,
  ticketFileEditQueryHref,
  type TicketEditorSpec,
} from './ticketEditorRoutes';
import type {
  ActivityEvent,
  TicketDetail,
  TicketTemplateFileDetail,
} from '../../hooks/useProjects';
import type { TicketSummarySections } from '../../lib/acceptanceCriteria';

export interface TicketTabsBodyProps {
  ticket: TicketDetail;
  ticketId: string;
  tab: string;
  editingFile: boolean;
  onTabChange: (value: string) => void;
  summarySections: TicketSummarySections;
  criteriaError: string | null;
  savingCriterionIndex: number | null;
  optimisticChecks: Record<number, boolean>;
  onToggleCriterion: (index: number, checked: boolean) => void;
  events: ActivityEvent[];
  eventsLoading: boolean;
  eventsError: string | null;
  onTicketRefetch: () => void;
}

export function TicketTabsBody({
  ticket,
  ticketId,
  tab,
  editingFile,
  onTabChange,
  summarySections,
  criteriaError,
  savingCriterionIndex,
  optimisticChecks,
  onToggleCriterion,
  events,
  eventsLoading,
  eventsError,
  onTicketRefetch,
}: TicketTabsBodyProps) {
  const tabItems = buildTabItems({
    ticket,
    ticketId,
    activeTab: tab,
    summarySections,
    criteriaError,
    savingCriterionIndex,
    optimisticChecks,
    onToggleCriterion,
    events,
    eventsLoading,
    eventsError,
    editingFile,
    onTicketRefetch,
  });

  return (
    <ContentTabs value={tab} onValueChange={onTabChange} items={tabItems} />
  );
}

function buildTabItems(args: {
  ticket: TicketDetail;
  ticketId: string;
  activeTab: string;
  summarySections: TicketSummarySections;
  criteriaError: string | null;
  savingCriterionIndex: number | null;
  optimisticChecks: Record<number, boolean>;
  onToggleCriterion: (index: number, checked: boolean) => void;
  events: ActivityEvent[];
  eventsLoading: boolean;
  eventsError: string | null;
  editingFile: boolean;
  onTicketRefetch: () => void;
}) {
  const {
    ticket,
    ticketId,
    activeTab,
    summarySections,
    criteriaError,
    savingCriterionIndex,
    optimisticChecks,
    onToggleCriterion,
    events,
    eventsLoading,
    eventsError,
    editingFile,
    onTicketRefetch,
  } = args;

  return buildTicketTabs(ticket).map((spec: TicketTabSpec) => {
    if (spec.kind === 'summary') {
      return {
        value: spec.value,
        label: spec.label,
        content: (
          <SummaryTab
            summarySections={summarySections}
            criteriaError={criteriaError}
            savingCriterionIndex={savingCriterionIndex}
            optimisticChecks={optimisticChecks}
            onToggleCriterion={onToggleCriterion}
          />
        ),
      };
    }
    if (spec.kind === 'chat') {
      return { value: spec.value, label: spec.label, content: <ChatTab ticketId={ticket.id} /> };
    }
    if (spec.kind === 'template-file' && spec.file) {
      return {
        value: spec.value,
        label: spec.label,
        count: spec.count,
        badge: spec.badge,
        content: (
          <TemplateFileTab
            ticketId={ticketId}
            file={spec.file}
            editing={editingFile && activeTab === spec.value}
            onAppended={() => void onTicketRefetch()}
          />
        ),
      };
    }
    if (spec.kind === 'activity') {
      return {
        value: spec.value,
        label: spec.label,
        count: events.length,
        content: (
          <ActivityTimeline events={events} loading={eventsLoading} error={eventsError} />
        ),
      };
    }
    return {
      value: spec.value,
      label: spec.label,
      count: spec.count,
      content: <SessionActivityTimeline engagements={ticket.engagements} />,
    };
  });
}

function SummaryTab({
  summarySections,
  criteriaError,
  savingCriterionIndex,
  optimisticChecks,
  onToggleCriterion,
}: {
  summarySections: TicketSummarySections;
  criteriaError: string | null;
  savingCriterionIndex: number | null;
  optimisticChecks: Record<number, boolean>;
  onToggleCriterion: (index: number, checked: boolean) => void;
}) {
  const disabled = savingCriterionIndex !== null;
  return (
    <div className="space-y-5">
      {summarySections.acceptanceCriteria.length > 0 ? (
        <SectionCard
          title="Acceptance Criteria"
          description="These checkboxes update the source ticket markdown."
        >
          <div className="space-y-3">
            {criteriaError ? (
              <p className="rounded-md border border-error-foreground/30 bg-error px-4 py-3 text-sm text-error-foreground">
                {criteriaError}
              </p>
            ) : null}
            {summarySections.acceptanceCriteria.map((criterion, index) => {
              const effectiveChecked =
                index in optimisticChecks ? optimisticChecks[index] : criterion.checked;
              return (
                <label
                  key={`${index}-${criterion.text}`}
                  className="flex items-start gap-3 rounded-md border border-border/60 bg-background/80 px-3 py-3"
                >
                  <input
                    type="checkbox"
                    checked={effectiveChecked}
                    disabled={disabled}
                    onChange={(event) => onToggleCriterion(index, event.target.checked)}
                    className="mt-1 h-4 w-4 rounded border-border text-primary"
                  />
                  <span
                    className="criterion-label text-sm leading-6"
                    data-checked={effectiveChecked}
                  >
                    {criterion.text}
                  </span>
                </label>
              );
            })}
          </div>
        </SectionCard>
      ) : null}
      <SectionCard title="Ticket Summary">
        <MarkdownRenderer
          content={summarySections.summaryBody}
          emptyState={
            summarySections.acceptanceCriteria.length > 0
              ? 'No additional summary markdown beyond the acceptance criteria.'
              : 'This ticket does not have summary markdown yet.'
          }
        />
      </SectionCard>
    </div>
  );
}

function TemplateFileTab({
  ticketId,
  file,
  editing,
  onAppended,
}: {
  ticketId: string;
  file: TicketTemplateFileDetail;
  editing: boolean;
  onAppended: () => void;
}) {
  const editor = resolveTicketFileEditor(ticketId, file);
  if (editing && editor) {
    return <InlineTicketEditor spec={editor} />;
  }

  if (!file.exists) {
    return (
      <EmptyState title={`Not created yet (createOn: ${file.createOn})`} description="" />
    );
  }

  const editAction =
    editor && file.writer !== 'cli' ? (
      <Link className="shell-action" to={ticketFileEditQueryHref(ticketId, file.path)}>
        <NotebookPen className="h-4 w-4" />
        <span>Edit</span>
      </Link>
    ) : undefined;

  if (file.role === 'log') {
    return <JournalTab ticketId={ticketId} file={file} onAppended={onAppended} />;
  }

  if (file.role === 'plan') {
    return (
      <SectionCard title="Plan" description={file.description} actions={editAction}>
        <div className="mb-4">
          <span className="rounded-full border border-border px-2 py-0.5 text-xs font-medium capitalize">
            {file.state}
          </span>
        </div>
        <MarkdownRenderer content={file.body ?? ''} emptyState="No plan content yet." />
      </SectionCard>
    );
  }

  return (
    <SectionCard title={file.path} description={file.description} actions={editAction}>
      <MarkdownRenderer content={file.body ?? ''} emptyState="No content yet." />
    </SectionCard>
  );
}

function InlineTicketEditor({ spec }: { spec: TicketEditorSpec }) {
  return (
    <DocumentEditorPage
      loadUrl={spec.loadUrl}
      saveUrl={spec.saveUrl}
      redirectTo={spec.redirectTo}
      title={spec.title}
      description={spec.description}
      documentType={spec.documentType}
      helpTitle={spec.helpTitle}
      helpBody={spec.helpBody}
    />
  );
}
