import { useLocation } from 'react-router-dom';
import { parseLibraryPath } from '../lib/libraryPath';
import { LibraryNav } from '../components/library/LibraryNav';
import { PlaybooksListSection } from '../components/library/PlaybooksListSection';
import { PlaybookDetailSection } from '../components/library/PlaybookDetailSection';
import { PlaybookCreateSection } from '../components/library/PlaybookCreateSection';
import { PlaybookEditSection } from '../components/library/PlaybookEditSection';
import { AgentsListSection } from '../components/library/AgentsListSection';
import { AgentEditorSection } from '../components/library/AgentEditorSection';
import { TemplatesListSection } from '../components/library/TemplatesListSection';
import { TemplateDetailSection } from '../components/library/TemplateDetailSection';

export interface LibraryPageProps {
  /** Override pathname (legacy wrappers pass `/playbooks/...`). */
  pathname?: string;
  linkPrefix?: string;
}

export function LibraryPage({ pathname, linkPrefix }: LibraryPageProps) {
  const location = useLocation();
  const path = pathname ?? location.pathname;
  const view = parseLibraryPath(path);
  const section = view.section;
  const prefix = linkPrefix ?? `/library/${section}`;

  let body: JSX.Element;
  switch (view.section) {
    case 'playbooks':
      if (view.view === 'create') body = <PlaybookCreateSection linkPrefix={prefix} />;
      else if (view.view === 'edit') body = <PlaybookEditSection slug={view.slug} linkPrefix={prefix} />;
      else if (view.view === 'detail') body = <PlaybookDetailSection slug={view.slug} linkPrefix={prefix} />;
      else body = <PlaybooksListSection linkPrefix={prefix} />;
      break;
    case 'agents':
      if (view.view === 'create') body = <AgentEditorSection linkPrefix={prefix} />;
      else if (view.view === 'edit') body = <AgentEditorSection agentId={view.agentId} linkPrefix={prefix} />;
      else body = <AgentsListSection linkPrefix={prefix} />;
      break;
    case 'templates':
      if (view.view === 'detail') body = <TemplateDetailSection templateId={view.templateId} linkPrefix={prefix} />;
      else body = <TemplatesListSection linkPrefix={prefix} />;
      break;
    default:
      body = <PlaybooksListSection linkPrefix="/library/playbooks" />;
  }

  return (
    <div className="p-4 md:p-6">
      <header className="mb-2">
        <h1 className="text-2xl font-semibold text-foreground">Library</h1>
        <p className="mt-1 text-sm text-muted-foreground">Playbooks, agents, and read-only ticket templates.</p>
      </header>
      <LibraryNav activeSection={section} basePrefix="/library" />
      {body}
    </div>
  );
}
