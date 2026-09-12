import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Overview } from './pages/Overview';
import { InboxPage } from './pages/InboxPage';
import { HelpPage } from './pages/Help';
import { NotFoundPage } from './pages/NotFound';
import { ProjectList } from './pages/ProjectList';
import { Archive } from './pages/Archive';
import { ProjectDetail } from './pages/ProjectDetail';
import { TicketDetail } from './pages/TicketDetail';
import { TicketsPage } from './pages/TicketsPage';
import { CreateProject } from './pages/CreateProject';
import { CreateTicket } from './pages/CreateTicket';
import { CreateStandaloneTicket } from './pages/CreateStandaloneTicket';
import { EditProject } from './pages/EditProject';
import { EditTicket } from './pages/EditTicket';
import { EditTicketPlan } from './pages/EditTicketPlan';
import { EditTicketScratchpad } from './pages/EditTicketScratchpad';
import { AppendTicketHandoff } from './pages/AppendTicketHandoff';
import { AppendTicketDecisionRecord } from './pages/AppendTicketDecisionRecord';
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
            <Route path="/tickets" element={<TicketsPage />} />
            <Route path="/tickets/new" element={<CreateStandaloneTicket />} />
            <Route path="/t/:id" element={<TicketDetail />} />
            <Route path="/t/:id/edit" element={<EditTicket />} />
            <Route path="/t/:id/plan/edit" element={<EditTicketPlan />} />
            <Route path="/t/:id/scratchpad/edit" element={<EditTicketScratchpad />} />
            <Route path="/t/:id/handoff/edit" element={<AppendTicketHandoff />} />
            <Route path="/t/:id/decision-record/edit" element={<AppendTicketDecisionRecord />} />
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
            <Route path="/projects/:slug/new" element={<CreateTicket />} />

            {/* Anything unmatched — a stale link or a retired page — says so instead of rendering nothing. */}
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </HotkeyProvider>
    </BrowserRouter>
  );
}
