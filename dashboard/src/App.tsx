import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Overview } from './pages/Overview';
import { InboxPage } from './pages/InboxPage';
import { HelpPage } from './pages/Help';
import { NotFoundPage } from './pages/NotFound';
import { ProjectList } from './pages/ProjectList';
import { Archive } from './pages/Archive';
import { ProjectDetail } from './pages/ProjectDetail';
import { AssignmentDetail } from './pages/AssignmentDetail';
import { StandaloneAssignmentDetail } from './pages/StandaloneAssignmentDetail';
import { AssignmentsPage } from './pages/AssignmentsPage';
import { CreateProject } from './pages/CreateProject';
import { CreateAssignment } from './pages/CreateAssignment';
import { CreateStandaloneAssignment } from './pages/CreateStandaloneAssignment';
import { EditProject } from './pages/EditProject';
import { EditAssignment } from './pages/EditAssignment';
import { EditAssignmentPlan } from './pages/EditAssignmentPlan';
import { EditAssignmentScratchpad } from './pages/EditAssignmentScratchpad';
import { AppendAssignmentHandoff } from './pages/AppendAssignmentHandoff';
import { AppendAssignmentDecisionRecord } from './pages/AppendAssignmentDecisionRecord';
import { AgentsPage } from './pages/AgentsPage';
import { AgentEditorPage } from './pages/AgentEditorPage';
import { UsagePage } from './pages/UsagePage';
import { AgentSessionsPage } from './pages/AgentSessionsPage';
import { AgentSessionDetail } from './pages/AgentSessionDetail';
import { PlaybooksPage } from './pages/PlaybooksPage';
import { PlaybookDetail } from './pages/PlaybookDetail';
import { CreatePlaybook } from './pages/CreatePlaybook';
import { EditPlaybook } from './pages/EditPlaybook';
import { SettingsPage } from './pages/SettingsPage';
import { WorkflowPage } from './pages/WorkflowPage';
import { HotkeyProvider } from './hotkeys';

function WorkspacePrefixRedirect() {
  const location = useLocation();
  const stripped = location.pathname.replace(/^\/w\/[^/]+/, '') || '/';
  const target = `${stripped}${location.search}${location.hash}`;
  return <Navigate to={target} replace />;
}

export function App() {
  return (
    <BrowserRouter>
      <HotkeyProvider>
        <Routes>
          <Route path="/w/:workspace/*" element={<WorkspacePrefixRedirect />} />
          <Route element={<Layout />}>
            <Route path="/" element={<Overview />} />
            <Route path="/inbox" element={<InboxPage />} />
            <Route path="/projects" element={<ProjectList />} />
            <Route path="/archive" element={<Archive />} />
            <Route path="/assignments" element={<AssignmentsPage />} />
            <Route path="/assignments/new" element={<CreateStandaloneAssignment />} />
            <Route path="/assignments/:id" element={<StandaloneAssignmentDetail />} />
            <Route path="/assignments/:id/edit" element={<EditAssignment />} />
            <Route path="/assignments/:id/plan/edit" element={<EditAssignmentPlan />} />
            <Route path="/assignments/:id/scratchpad/edit" element={<EditAssignmentScratchpad />} />
            <Route path="/assignments/:id/handoff/edit" element={<AppendAssignmentHandoff />} />
            <Route path="/assignments/:id/decision-record/edit" element={<AppendAssignmentDecisionRecord />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/agents/new" element={<AgentEditorPage />} />
            <Route path="/agents/:id/edit" element={<AgentEditorPage />} />
            <Route path="/usage" element={<UsagePage />} />
            <Route path="/agent-sessions" element={<AgentSessionsPage />} />
            <Route path="/agent-sessions/:id" element={<AgentSessionDetail />} />
            <Route path="/playbooks" element={<PlaybooksPage />} />
            <Route path="/playbooks/create" element={<CreatePlaybook />} />
            <Route path="/playbooks/:slug" element={<PlaybookDetail />} />
            <Route path="/playbooks/:slug/edit" element={<EditPlaybook />} />
            <Route path="/help" element={<HelpPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/workflow" element={<WorkflowPage />} />
            <Route path="/create/project" element={<CreateProject />} />
            <Route path="/projects/:slug" element={<ProjectDetail />} />
            <Route path="/projects/:slug/edit" element={<EditProject />} />
            <Route path="/projects/:slug/create/assignment" element={<CreateAssignment />} />
            <Route path="/projects/:slug/assignments/:aslug" element={<AssignmentDetail />} />
            <Route path="/projects/:slug/assignments/:aslug/edit" element={<EditAssignment />} />
            <Route path="/projects/:slug/assignments/:aslug/plan/edit" element={<EditAssignmentPlan />} />
            <Route path="/projects/:slug/assignments/:aslug/scratchpad/edit" element={<EditAssignmentScratchpad />} />
            <Route path="/projects/:slug/assignments/:aslug/handoff/edit" element={<AppendAssignmentHandoff />} />
            <Route path="/projects/:slug/assignments/:aslug/decision-record/edit" element={<AppendAssignmentDecisionRecord />} />

            {/* Anything unmatched — a stale link or a retired page — says so instead of rendering nothing. */}
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </HotkeyProvider>
    </BrowserRouter>
  );
}
