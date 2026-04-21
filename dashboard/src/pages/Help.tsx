import { Link } from 'react-router-dom';
import { useHelp } from '../hooks/useProjects';
import { LoadingState } from '../components/LoadingState';
import { ErrorState } from '../components/ErrorState';
import { SectionCard } from '../components/SectionCard';
import { CommandSnippet } from '../components/CommandSnippet';
import { GlossaryTooltip } from '../components/GlossaryTooltip';
import { StatusBadge } from '../components/StatusBadge';
import { useHotkeyContext, formatPatternForDisplay } from '../hotkeys';

export function HelpPage() {
  const { data: help, loading, error } = useHelp();
  const { openCheatsheet } = useHotkeyContext();

  if (loading) {
    return <LoadingState label="Loading help…" />;
  }

  if (error || !help) {
    return <ErrorState error={error || 'Help content is unavailable.'} />;
  }

  return (
    <div className="space-y-5">

      <SectionCard title="Keyboard Shortcuts" description="Navigate the dashboard without reaching for the mouse.">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={openCheatsheet}
            className="inline-flex items-center gap-2 rounded-md border border-border/70 bg-background/80 px-3 py-1.5 text-sm font-medium text-foreground hover:bg-accent"
          >
            Open shortcuts cheatsheet
          </button>
          <span className="text-xs text-muted-foreground">
            or press <kbd className="rounded border border-border/70 bg-muted px-1.5 py-0.5 font-mono text-[11px]">?</kbd>{' '}
            anywhere. {formatPatternForDisplay('Mod+k')} opens the command palette.
          </span>
        </div>
      </SectionCard>

      <SectionCard title="What Syntaur Is" description={help.whatIsSyntaur.summary}>
        <div className="grid gap-3 md:grid-cols-3">
          {help.whatIsSyntaur.bullets.map((bullet) => (
            <div key={bullet} className="rounded-md border border-border/60 bg-background/80 p-3 text-sm leading-6 text-muted-foreground">
              {bullet}
            </div>
          ))}
        </div>
      </SectionCard>

      <SectionCard title="Getting Started">
        <div className="space-y-3">
          {help.workflow.map((item, index) => (
            <div key={item.title} className="rounded-md border border-border/60 bg-background/80 p-3">
              <div className="flex items-start gap-3">
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background">
                  {index + 1}
                </span>
                <div className="space-y-2">
                  <h3 className="font-semibold text-foreground">{item.title}</h3>
                  <p className="text-sm leading-6 text-muted-foreground">{item.detail}</p>
                  {item.command ? (
                    <CommandSnippet
                      command={item.command.command}
                      description={item.command.description}
                      example={item.command.example}
                    />
                  ) : null}
                  {item.href ? (
                    <Link className="inline-flex text-sm font-semibold text-primary hover:underline" to={item.href}>
                      Open the related surface
                    </Link>
                  ) : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      </SectionCard>

      <div className="grid gap-3 xl:grid-cols-2">
        <SectionCard title="Core Concepts">
          <div className="flex flex-wrap gap-2">
            {help.coreConcepts.map((concept) => (
              <GlossaryTooltip
                key={concept.term}
                term={concept.term}
                description={concept.description}
              />
            ))}
          </div>
          <div className="grid gap-3 pt-2">
            {help.coreConcepts.map((concept) => (
              <div key={concept.term} className="rounded-md border border-border/60 bg-background/80 p-3">
                <h3 className="font-semibold text-foreground">{concept.term}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{concept.description}</p>
              </div>
            ))}
          </div>
        </SectionCard>

        <SectionCard title="Status Guide">
          <div className="space-y-3">
            {help.statusGuide.map((status) => (
              <div key={status.status} className="rounded-md border border-border/60 bg-background/80 p-3">
                <div className="flex flex-wrap items-center gap-3">
                  <StatusBadge status={status.status} />
                  <p className="font-semibold text-foreground">{status.meaning}</p>
                </div>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">{status.useWhen}</p>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>

      <div className="grid gap-3 xl:grid-cols-2">
        <SectionCard title="Ownership And File Rules">
          <div className="space-y-3">
            {help.ownershipRules.map((rule) => (
              <div key={rule.label} className="rounded-md border border-border/60 bg-background/80 p-3">
                <h3 className="font-semibold text-foreground">{rule.label}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{rule.description}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {rule.files.map((file) => (
                    <span
                      key={file}
                      className="rounded-full border border-border/60 bg-card/90 px-2.5 py-1 font-mono text-xs text-foreground"
                    >
                      {file}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </SectionCard>

        <SectionCard title="How To Navigate The Dashboard">
          <div className="space-y-3">
            {help.navigation.map((item) => (
              <div key={item.label} className="rounded-md border border-border/60 bg-background/80 p-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="font-semibold text-foreground">{item.label}</h3>
                  <Link className="text-sm font-semibold text-primary hover:underline" to={item.href}>
                    Open
                  </Link>
                </div>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.description}</p>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>

      <SectionCard title="CLI Quick Reference">
        <div className="grid gap-3 xl:grid-cols-2">
          {help.commands.map((command) => (
            <CommandSnippet
              key={command.command}
              command={command.command}
              description={command.description}
              example={command.example}
            />
          ))}
        </div>
      </SectionCard>

      <div className="grid gap-3 xl:grid-cols-2">
        <SectionCard title="FAQ">
          <div className="space-y-3">
            {help.faq.map((item) => (
              <div key={item.question} className="rounded-md border border-border/60 bg-background/80 p-3">
                <h3 className="font-semibold text-foreground">{item.question}</h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.answer}</p>
              </div>
            ))}
          </div>
        </SectionCard>

        <SectionCard title="First Project Checklist">
          <div className="space-y-3">
            {help.firstProjectChecklist.map((item, index) => (
              <div key={item.title} className="rounded-md border border-border/60 bg-background/80 p-3">
                <div className="flex items-start gap-3">
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background">
                    {index + 1}
                  </span>
                  <div className="space-y-2">
                    <h3 className="font-semibold text-foreground">{item.title}</h3>
                    <p className="text-sm leading-6 text-muted-foreground">{item.detail}</p>
                    {item.command ? (
                      <CommandSnippet command={item.command.command} example={item.command.example} />
                    ) : null}
                    {item.href ? (
                      <Link className="inline-flex text-sm font-semibold text-primary hover:underline" to={item.href}>
                        Open the related surface
                      </Link>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>
    </div>
  );
}
