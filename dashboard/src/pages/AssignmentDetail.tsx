import { useParams } from 'react-router-dom';
import * as Tabs from '@radix-ui/react-tabs';
import { useAssignment } from '../hooks/useMissions';
import { StatusBadge } from '../components/StatusBadge';
import { MarkdownRenderer } from '../components/MarkdownRenderer';

export function AssignmentDetail() {
  const { slug, aslug } = useParams<{ slug: string; aslug: string }>();
  const { data: assignment, loading, error } = useAssignment(slug, aslug);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-muted-foreground">Loading assignment...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-red-400">Failed to load assignment: {error}</p>
      </div>
    );
  }

  if (!assignment) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-muted-foreground">Assignment not found.</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-2xl font-bold text-foreground">{assignment.title}</h1>
          <StatusBadge status={assignment.status} />
        </div>

        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <InfoItem label="Priority" value={assignment.priority} />
          <InfoItem label="Assignee" value={assignment.assignee ?? 'Unassigned'} />
          <InfoItem label="Created" value={new Date(assignment.created).toLocaleDateString()} />
          <InfoItem label="Updated" value={new Date(assignment.updated).toLocaleDateString()} />
        </div>

        {assignment.blockedReason && (
          <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3">
            <p className="text-sm text-red-400">
              <span className="font-medium">Blocked:</span> {assignment.blockedReason}
            </p>
          </div>
        )}

        {assignment.dependsOn.length > 0 && (
          <div className="mt-4">
            <span className="text-sm text-muted-foreground">Dependencies: </span>
            <span className="text-sm text-foreground">{assignment.dependsOn.join(', ')}</span>
          </div>
        )}

        {assignment.workspace.branch && (
          <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
            {assignment.workspace.branch && (
              <span className="rounded bg-accent px-2 py-1">
                Branch: {assignment.workspace.branch}
              </span>
            )}
            {assignment.workspace.repository && (
              <span className="rounded bg-accent px-2 py-1">
                Repo: {assignment.workspace.repository}
              </span>
            )}
          </div>
        )}

        {assignment.externalIds.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {assignment.externalIds.map((ext) => (
              <a
                key={`${ext.system}-${ext.id}`}
                href={ext.url}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded bg-accent px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
              >
                {ext.system}: {ext.id}
              </a>
            ))}
          </div>
        )}
      </div>

      {/* Tabbed Content */}
      <Tabs.Root defaultValue="overview" className="w-full">
        <Tabs.List className="flex border-b border-border">
          <TabTrigger value="overview">Overview</TabTrigger>
          {assignment.plan && <TabTrigger value="plan">Plan</TabTrigger>}
          {assignment.scratchpad && <TabTrigger value="scratchpad">Scratchpad</TabTrigger>}
          {assignment.handoff && (
            <TabTrigger value="handoff">
              Handoff ({assignment.handoff.handoffCount})
            </TabTrigger>
          )}
          {assignment.decisionRecord && (
            <TabTrigger value="decisions">
              Decisions ({assignment.decisionRecord.decisionCount})
            </TabTrigger>
          )}
        </Tabs.List>

        <Tabs.Content value="overview" className="pt-6">
          <MarkdownRenderer content={assignment.body} />
        </Tabs.Content>

        {assignment.plan && (
          <Tabs.Content value="plan" className="pt-6">
            <div className="mb-4">
              <StatusBadge status={assignment.plan.status} />
            </div>
            <MarkdownRenderer content={assignment.plan.body} />
          </Tabs.Content>
        )}

        {assignment.scratchpad && (
          <Tabs.Content value="scratchpad" className="pt-6">
            <MarkdownRenderer content={assignment.scratchpad.body} />
          </Tabs.Content>
        )}

        {assignment.handoff && (
          <Tabs.Content value="handoff" className="pt-6">
            <MarkdownRenderer content={assignment.handoff.body} />
          </Tabs.Content>
        )}

        {assignment.decisionRecord && (
          <Tabs.Content value="decisions" className="pt-6">
            <MarkdownRenderer content={assignment.decisionRecord.body} />
          </Tabs.Content>
        )}
      </Tabs.Root>
    </div>
  );
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium text-foreground capitalize">{value}</p>
    </div>
  );
}

function TabTrigger({
  value,
  children,
}: {
  value: string;
  children: React.ReactNode;
}) {
  return (
    <Tabs.Trigger
      value={value}
      className="border-b-2 border-transparent px-4 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground"
    >
      {children}
    </Tabs.Trigger>
  );
}
