import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { LegacyRedirect, WorkspacePrefixRedirect } from './components/LegacyRedirect';
import { NotFoundPage } from './components/NotFound';
import { NavigationHotkeys } from './components/navigation/NavigationHotkeys';
import { NeedsMePage } from './pages/NeedsMePage';
import { BoardPage } from './pages/BoardPage';
import { TicketPage } from './pages/TicketPage';
import { SessionsPage } from './pages/SessionsPage';
import { LibraryPage } from './pages/LibraryPage';
import { SettingsPage } from './pages/SettingsPage';

export function App() {
  return (
    <BrowserRouter>
      <NavigationHotkeys />
      <Routes>
        <Route path="/w/:workspace/*" element={<WorkspacePrefixRedirect />} />
        <Route element={<Layout />}>
          <Route path="/" element={<LegacyRedirect />} />
          <Route path="/inbox" element={<NeedsMePage />} />
          <Route path="/board" element={<BoardPage />} />
          <Route path="/t/:id" element={<TicketPage />} />
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/library/*" element={<LibraryPage />} />
          <Route path="/settings" element={<SettingsPage />} />

          {/* Legacy routes — redirect via table-driven resolver */}
          <Route path="/tickets" element={<LegacyRedirect />} />
          <Route path="/projects" element={<LegacyRedirect />} />
          <Route path="/projects/:slug" element={<LegacyRedirect />} />
          <Route path="/projects/:slug/edit" element={<LegacyRedirect />} />
          <Route path="/projects/:slug/new" element={<LegacyRedirect />} />
          <Route path="/create/project" element={<LegacyRedirect />} />
          <Route path="/archive" element={<LegacyRedirect />} />
          <Route path="/t/:id/edit" element={<LegacyRedirect />} />
          <Route path="/t/:id/plan/edit" element={<LegacyRedirect />} />
          <Route path="/t/:id/scratchpad/edit" element={<LegacyRedirect />} />
          <Route path="/agents" element={<LegacyRedirect />} />
          <Route path="/agents/new" element={<LegacyRedirect />} />
          <Route path="/agents/:id/edit" element={<LegacyRedirect />} />
          <Route path="/usage" element={<LegacyRedirect />} />
          <Route path="/agent-sessions" element={<LegacyRedirect />} />
          <Route path="/agent-sessions/:id" element={<LegacyRedirect />} />
          <Route path="/playbooks" element={<LegacyRedirect />} />
          <Route path="/playbooks/create" element={<LegacyRedirect />} />
          <Route path="/playbooks/:slug" element={<LegacyRedirect />} />
          <Route path="/playbooks/:slug/edit" element={<LegacyRedirect />} />
          <Route path="/help" element={<LegacyRedirect />} />

          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
