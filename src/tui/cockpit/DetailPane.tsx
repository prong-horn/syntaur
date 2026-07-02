import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { getAssignmentDetail, getAssignmentDetailById } from '../../dashboard/api.js';
import { tailFile } from '../sessions/transcript.js';
import { statusColors } from '../colors.js';
import { parseAcceptanceCriteria } from './acParse.js';
import type { AssignmentDetail, AgentSessionWithLiveness } from '../../dashboard/types.js';

export type DetailSelection =
  | { kind: 'assignment'; projectSlug: string | null; assignmentSlug: string }
  | { kind: 'session'; session: AgentSessionWithLiveness }
  | { kind: 'none' };

const MAX_VISIBLE = 200;

function AssignmentView({
  projectsDir, assignmentsDir, projectSlug, assignmentSlug,
}: { projectsDir: string; assignmentsDir: string; projectSlug: string | null; assignmentSlug: string }) {
  const [detail, setDetail] = useState<AssignmentDetail | null>(null);
  useEffect(() => {
    let alive = true;
    setDetail(null);
    const p = projectSlug
      ? getAssignmentDetail(projectsDir, projectSlug, assignmentSlug)
      : getAssignmentDetailById(projectsDir, assignmentsDir, assignmentSlug);
    p.then((d) => { if (alive) setDetail(d); }).catch(() => { if (alive) setDetail(null); });
    return () => { alive = false; };
  }, [projectsDir, assignmentsDir, projectSlug, assignmentSlug]);

  if (!detail) return <Text dimColor>Loading…</Text>;
  const acs = parseAcceptanceCriteria(detail.body);
  return (
    <Box flexDirection="column">
      <Text bold>{detail.title}</Text>
      <Text>Status: <Text color={statusColors[detail.status] ?? 'white'}>{detail.status}</Text></Text>
      {acs.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold underline>Acceptance Criteria</Text>
          {acs.map((c, i) => (<Text key={i}>{c.checked ? '☑' : '☐'} {c.text}</Text>))}
        </Box>
      )}
      {detail.plan && (
        <Box marginTop={1}><Text dimColor>plan: {detail.plan.status} (updated {detail.plan.updated})</Text></Box>
      )}
    </Box>
  );
}

function TranscriptView({ session }: { session: AgentSessionWithLiveness }) {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    setLines([]);
    if (!session.transcriptPath) { setLines(['(no transcript available)']); return; }
    const h = tailFile({
      path: session.transcriptPath,
      onLines: (ls) => setLines((prev) => [...prev, ...ls].slice(-MAX_VISIBLE)),
      onError: (e) => setLines([`(transcript error: ${e.message})`]),
    });
    return () => h.stop();
  }, [session.sessionId, session.transcriptPath]);
  return (<Box flexDirection="column">{lines.map((l, i) => <Text key={i}>{l}</Text>)}</Box>);
}

export const DetailPane: React.FC<{ projectsDir: string; assignmentsDir: string; selection: DetailSelection }> = ({
  projectsDir, assignmentsDir, selection,
}) => {
  if (selection.kind === 'none') return <Text dimColor>Select an assignment or session (↑/↓, click)</Text>;
  if (selection.kind === 'assignment')
    return (
      <AssignmentView
        projectsDir={projectsDir}
        assignmentsDir={assignmentsDir}
        projectSlug={selection.projectSlug}
        assignmentSlug={selection.assignmentSlug}
      />
    );
  return <TranscriptView session={selection.session} />;
};
