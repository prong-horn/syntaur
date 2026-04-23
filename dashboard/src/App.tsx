import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Overview } from './pages/Overview';
import { AttentionPage } from './pages/Attention';
import { HelpPage } from './pages/Help';
import { ProjectList } from './pages/ProjectList';
import { ProjectDetail } from './pages/ProjectDetail';
import { AssignmentDetail } from './pages/AssignmentDetail';
import { StandaloneAssignmentDetail } from './pages/StandaloneAssignmentDetail';
import { AssignmentsPage } from './pages/AssignmentsPage';
import { CreateProject } from './pages/CreateProject';
import { CreateAssignment } from './pages/CreateAssignment';
import { EditProject } from './pages/EditProject';
import { EditAssignment } from './pages/EditAssignment';
import { EditAssignmentPlan } from './pages/EditAssignmentPlan';
import { EditAssignmentScratchpad } from './pages/EditAssignmentScratchpad';
import { AppendAssignmentHandoff } from './pages/AppendAssignmentHandoff';
import { AppendAssignmentDecisionRecord } from './pages/AppendAssignmentDecisionRecord';
import { ServersPage } from './pages/ServersPage';
import { AgentSessionsPage } from './pages/AgentSessionsPage';
import { PlaybooksPage } from './pages/PlaybooksPage';
import { PlaybookDetail } from './pages/PlaybookDetail';
import { CreatePlaybook } from './pages/CreatePlaybook';
import { EditPlaybook } from './pages/EditPlaybook';
import { SettingsPage } from './pages/SettingsPage';
import { TodosPage } from './pages/TodosPage';
import { WorkspaceTodosPage } from './pages/WorkspaceTodosPage';
import { ProjectTodosPage } from './pages/ProjectTodosPage';
import { HotkeyProvider } from './hotkeys';

export function App() {
  return (
    <BrowserRouter>
      <HotkeyProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Overview />} />
            <Route path="/projects" element={<ProjectList />} />
            <Route path="/assignments" element={<AssignmentsPage />} />
            <Route path="/assignments/:id" element={<StandaloneAssignmentDetail />} />
            <Route path="/assignments/:id/edit" element={<EditAssignment />} />
            <Route path="/assignments/:id/plan/edit" element={<EditAssignmentPlan />} />
            <Route path="/assignments/:id/scratchpad/edit" element={<EditAssignmentScratchpad />} />
            <Route path="/assignments/:id/handoff/edit" element={<AppendAssignmentHandoff />} />
            <Route path="/assignments/:id/decision-record/edit" element={<AppendAssignmentDecisionRecord />} />
            <Route path="/attention" element={<AttentionPage />} />
            <Route path="/servers" element={<ServersPage />} />
            <Route path="/agent-sessions" element={<AgentSessionsPage />} />
            <Route path="/playbooks" element={<PlaybooksPage />} />
            <Route path="/playbooks/create" element={<CreatePlaybook />} />
            <Route path="/playbooks/:slug" element={<PlaybookDetail />} />
            <Route path="/playbooks/:slug/edit" element={<EditPlaybook />} />
            <Route path="/todos" element={<TodosPage />} />
            <Route path="/help" element={<HelpPage />} />
            <Route path="/settings" element={<SettingsPage />} />
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
            <Route path="/projects/:slug/todos" element={<ProjectTodosPage />} />

            {/* Workspace-scoped routes */}
            <Route path="/w/:workspace/projects" element={<ProjectList />} />
            <Route path="/w/:workspace/assignments" element={<AssignmentsPage />} />
            <Route path="/w/:workspace/servers" element={<ServersPage />} />
            <Route path="/w/:workspace/agent-sessions" element={<AgentSessionsPage />} />
            <Route path="/w/:workspace/todos" element={<WorkspaceTodosPage />} />
            <Route path="/w/:workspace/create/project" element={<CreateProject />} />
            <Route path="/w/:workspace/projects/:slug" element={<ProjectDetail />} />
            <Route path="/w/:workspace/projects/:slug/edit" element={<EditProject />} />
            <Route path="/w/:workspace/projects/:slug/create/assignment" element={<CreateAssignment />} />
            <Route path="/w/:workspace/projects/:slug/assignments/:aslug" element={<AssignmentDetail />} />
            <Route path="/w/:workspace/projects/:slug/assignments/:aslug/edit" element={<EditAssignment />} />
            <Route path="/w/:workspace/projects/:slug/assignments/:aslug/plan/edit" element={<EditAssignmentPlan />} />
            <Route path="/w/:workspace/projects/:slug/assignments/:aslug/scratchpad/edit" element={<EditAssignmentScratchpad />} />
            <Route path="/w/:workspace/projects/:slug/assignments/:aslug/handoff/edit" element={<AppendAssignmentHandoff />} />
            <Route path="/w/:workspace/projects/:slug/assignments/:aslug/decision-record/edit" element={<AppendAssignmentDecisionRecord />} />
            <Route path="/w/:workspace/projects/:slug/todos" element={<ProjectTodosPage />} />
          </Route>
        </Routes>
      </HotkeyProvider>
    </BrowserRouter>
  );
}
