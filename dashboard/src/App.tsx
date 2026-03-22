import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Overview } from './pages/Overview';
import { AttentionPage } from './pages/Attention';
import { HelpPage } from './pages/Help';
import { MissionList } from './pages/MissionList';
import { MissionDetail } from './pages/MissionDetail';
import { AssignmentDetail } from './pages/AssignmentDetail';
import { AssignmentsPage } from './pages/AssignmentsPage';
import { CreateMission } from './pages/CreateMission';
import { CreateAssignment } from './pages/CreateAssignment';
import { EditMission } from './pages/EditMission';
import { EditAssignment } from './pages/EditAssignment';
import { EditAssignmentPlan } from './pages/EditAssignmentPlan';
import { EditAssignmentScratchpad } from './pages/EditAssignmentScratchpad';
import { AppendAssignmentHandoff } from './pages/AppendAssignmentHandoff';
import { AppendAssignmentDecisionRecord } from './pages/AppendAssignmentDecisionRecord';
import { ServersPage } from './pages/ServersPage';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Overview />} />
          <Route path="/missions" element={<MissionList />} />
          <Route path="/assignments" element={<AssignmentsPage />} />
          <Route path="/attention" element={<AttentionPage />} />
          <Route path="/servers" element={<ServersPage />} />
          <Route path="/help" element={<HelpPage />} />
          <Route path="/create/mission" element={<CreateMission />} />
          <Route path="/missions/:slug" element={<MissionDetail />} />
          <Route path="/missions/:slug/edit" element={<EditMission />} />
          <Route path="/missions/:slug/create/assignment" element={<CreateAssignment />} />
          <Route path="/missions/:slug/assignments/:aslug" element={<AssignmentDetail />} />
          <Route path="/missions/:slug/assignments/:aslug/edit" element={<EditAssignment />} />
          <Route path="/missions/:slug/assignments/:aslug/plan/edit" element={<EditAssignmentPlan />} />
          <Route path="/missions/:slug/assignments/:aslug/scratchpad/edit" element={<EditAssignmentScratchpad />} />
          <Route path="/missions/:slug/assignments/:aslug/handoff/edit" element={<AppendAssignmentHandoff />} />
          <Route path="/missions/:slug/assignments/:aslug/decision-record/edit" element={<AppendAssignmentDecisionRecord />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
