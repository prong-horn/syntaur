import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { MarkdownEditor } from '../components/MarkdownEditor';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { useTemplates, getTemplateLabel } from '../hooks/useTemplates';

function injectTemplateFrontmatter(content: string, templateId: string): string {
  if (/^template:\s/m.test(content)) {
    return content.replace(/^template:\s*.*$/m, `template: ${templateId}`);
  }
  return content.replace(/^(---\n)/, `---\ntemplate: ${templateId}\n`);
}

export function CreateTicket() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const templatesConfig = useTemplates();
  const [content, setContent] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState<string>('feature');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const [ticketRes, projectRes] = await Promise.all([
          fetch('/api/templates/ticket'),
          slug ? fetch(`/api/projects/${slug}`) : Promise.resolve(null),
        ]);
        const ticketPayload = await ticketRes.json();
        setContent(ticketPayload.content);
        if (projectRes?.ok) {
          const projectPayload = await projectRes.json();
          const defaultTemplate = projectPayload.defaultTemplate ?? 'feature';
          setTemplateId(defaultTemplate);
        }
        setLoading(false);
      } catch (loadError) {
        setError((loadError as Error).message);
        setLoading(false);
      }
    };
    void load();
  }, [slug]);

  async function handleSave(markdownContent: string) {
    if (!slug) {
      setError('Project slug is required.');
      return;
    }

    setSaving(true);
    setError(null);

    const contentWithTemplate = injectTemplateFrontmatter(markdownContent, templateId);

    try {
      const response = await fetch(`/api/projects/${slug}/tickets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: contentWithTemplate }),
      });
      const payload = await response.json();

      if (!response.ok) {
        setError(payload.error || `HTTP ${response.status}`);
        setSaving(false);
        return;
      }

      const projectRes = await fetch(`/api/projects/${slug}`);
      const projectPayload = await projectRes.json();
      const created = (projectPayload.tickets as Array<{ id: string; slug: string }> | undefined)
        ?.find((ticket) => ticket.slug === payload.slug);
      navigate(created ? `/t/${created.id}` : `/projects/${slug}`);
    } catch (saveError) {
      setError((saveError as Error).message);
      setSaving(false);
      return;
    }

    setSaving(false);
  }

  if (loading) {
    return <LoadingState label="Loading ticket template…" />;
  }

  if (error && !content) {
    return <ErrorState error={error} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 px-1">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Template</span>
          <select
            className="rounded-md border border-border bg-background px-3 py-2"
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
          >
            {templatesConfig.definitions.map((def) => (
              <option key={def.id} value={def.id}>
                {getTemplateLabel(templatesConfig, def.id)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <MarkdownEditor
        initialContent={content || ''}
        documentType="ticket"
        mode="create"
        onSave={handleSave}
        saving={saving}
        error={error}
        title="Create Ticket"
        description="Tickets are the execution unit. Declare dependencies here; new tickets start in backlog, and use blocked later only for runtime obstacles."
        onCancel={() => navigate(slug ? `/projects/${slug}` : `/projects`)}
        helpTitle="Ticket editing rules"
        helpBody="Use structured fields for priority, assignee, dependencies, and tags. Status can be changed through lifecycle actions, kanban drag, or the status override."
        allowSlugEdit
      />
    </div>
  );
}
