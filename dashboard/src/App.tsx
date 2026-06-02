import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Overview } from './pages/Overview';
import { HelpPage } from './pages/Help';
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
import { ServersPage } from './pages/ServersPage';
import { InventoriesPage } from './pages/InventoriesPage';
import { UsagePage } from './pages/UsagePage';
import { AgentSessionsPage } from './pages/AgentSessionsPage';
import { PlaybooksPage } from './pages/PlaybooksPage';
import { PlaybookDetail } from './pages/PlaybookDetail';
import { CreatePlaybook } from './pages/CreatePlaybook';
import { EditPlaybook } from './pages/EditPlaybook';
import { MemoriesPage } from './pages/MemoriesPage';
import { MemoryDetail } from './pages/MemoryDetail';
import { CreateMemory } from './pages/CreateMemory';
import { EditMemory } from './pages/EditMemory';
import { ResourcesPage } from './pages/ResourcesPage';
import { ResourceDetail } from './pages/ResourceDetail';
import { CreateResource } from './pages/CreateResource';
import { EditResource } from './pages/EditResource';
import { SettingsPage } from './pages/SettingsPage';
import { TodosPage } from './pages/TodosPage';
import { WorkspaceTodosPage } from './pages/WorkspaceTodosPage';
import { SavedViewsPage } from './pages/SavedViewsPage';
import { SavedViewPage } from './pages/SavedViewPage';
import { HotkeyProvider } from './hotkeys';

export function App() {
  return (
    <BrowserRouter>
      <HotkeyProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Overview />} />
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
            <Route path="/servers" element={<ServersPage />} />
            <Route path="/inventories" element={<InventoriesPage />} />
            <Route path="/usage" element={<UsagePage />} />
            <Route path="/agent-sessions" element={<AgentSessionsPage />} />
            <Route path="/playbooks" element={<PlaybooksPage />} />
            <Route path="/playbooks/create" element={<CreatePlaybook />} />
            <Route path="/playbooks/:slug" element={<PlaybookDetail />} />
            <Route path="/playbooks/:slug/edit" element={<EditPlaybook />} />
            <Route path="/memories" element={<MemoriesPage />} />
            <Route path="/memories/new" element={<CreateMemory />} />
            <Route path="/projects/:slug/memories/:itemSlug" element={<MemoryDetail />} />
            <Route path="/projects/:slug/memories/:itemSlug/edit" element={<EditMemory />} />
            <Route path="/resources" element={<ResourcesPage />} />
            <Route path="/resources/new" element={<CreateResource />} />
            <Route path="/projects/:slug/resources/:itemSlug" element={<ResourceDetail />} />
            <Route path="/projects/:slug/resources/:itemSlug/edit" element={<EditResource />} />
            <Route path="/todos" element={<TodosPage />} />
            <Route path="/views" element={<SavedViewsPage />} />
            <Route path="/views/:id" element={<SavedViewPage />} />
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

            {/* Workspace-scoped routes */}
            <Route path="/w/:workspace/projects" element={<ProjectList />} />
            <Route path="/w/:workspace/assignments" element={<AssignmentsPage />} />
            <Route path="/w/:workspace/assignments/new" element={<CreateStandaloneAssignment />} />
            <Route path="/w/:workspace/servers" element={<ServersPage />} />
            <Route path="/w/:workspace/inventories" element={<InventoriesPage />} />
            <Route path="/w/:workspace/usage" element={<UsagePage />} />
            <Route path="/w/:workspace/agent-sessions" element={<AgentSessionsPage />} />
            <Route path="/w/:workspace/todos" element={<WorkspaceTodosPage />} />
            <Route path="/w/:workspace/views" element={<SavedViewsPage />} />
            <Route path="/w/:workspace/views/:id" element={<SavedViewPage />} />
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
          </Route>
        </Routes>
      </HotkeyProvider>
    </BrowserRouter>
  );
}
