import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Layout } from './components/Layout';
import { MissionList } from './pages/MissionList';
import { MissionDetail } from './pages/MissionDetail';
import { AssignmentDetail } from './pages/AssignmentDetail';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<MissionList />} />
          <Route path="/missions/:slug" element={<MissionDetail />} />
          <Route
            path="/missions/:slug/assignments/:aslug"
            element={<AssignmentDetail />}
          />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
