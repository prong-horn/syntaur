#!/usr/bin/env node
// Seed a demo Syntaur workspace with realistic content for the landing page.
//
// Usage: node scripts/seed-demo.mjs [--dir ~/.syntaur-demo] [--force]
//
// Point the dashboard at it: SYNTAUR_HOME=~/.syntaur-demo syntaur dashboard

import { mkdir, writeFile, rm, readdir, copyFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// --- CLI args ---
const args = process.argv.slice(2);
function getFlag(name) { return args.includes(name); }
function getOpt(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) return fallback;
  return args[i + 1];
}
const TARGET = expandHome(getOpt('--dir', '~/.syntaur-demo'));
const FORCE = getFlag('--force');

function expandHome(p) {
  if (p.startsWith('~/') || p === '~') return resolve(homedir(), p.slice(2));
  return resolve(p);
}

function iso(date) { return date.toISOString().replace(/\.\d{3}Z$/, 'Z'); }
function daysAgo(n) { return new Date(Date.now() - n * 86400000); }
function hoursAgo(n) { return new Date(Date.now() - n * 3600000); }

async function ensureDir(p) { await mkdir(p, { recursive: true }); }
async function writeText(p, s) {
  await ensureDir(dirname(p));
  await writeFile(p, s, 'utf-8');
}

// --- Templates ---

function renderConfigMd(missionsPath) {
  return `---
version: "1.0"
defaultProjectDir: ${missionsPath}
agentDefaults:
  trustLevel: medium
  autoApprove: false
sync:
  enabled: false
  endpoint: null
  interval: 300
integrations:
  claudePluginDir: null
  codexPluginDir: null
  codexMarketplacePath: null
onboarding:
  completed: true
---

# Syntaur Configuration (Demo)

This is a demo workspace seeded for screenshots and landing-page media.
`;
}

function renderProject(m) {
  const tagsYaml = m.tags?.length
    ? `tags:\n  - ${m.tags.join('\n  - ')}`
    : 'tags: []';
  return `---
id: ${m.id}
slug: ${m.slug}
title: "${m.title}"
archived: ${m.archived ?? false}
archivedAt: ${m.archivedAt ?? 'null'}
archivedReason: ${m.archivedReason ?? 'null'}
created: "${m.created}"
updated: "${m.updated}"
externalIds: []
${tagsYaml}
---

# ${m.title}

## Overview

${m.overview}

## Notes

${m.notes ?? '_No additional notes._'}
`;
}

function renderManifest(slug, createdAt) {
  return `---
version: "1.0"
project: ${slug}
generated: "${createdAt}"
---

# Project: ${slug}

## Overview
- [Project Overview](./project.md)

## Indexes
- [Assignments](./_index-assignments.md)
- [Plans](./_index-plans.md)
- [Decision Records](./_index-decisions.md)
- [Status](./_status.md)
- [Resources](./resources/_index.md)
- [Memories](./memories/_index.md)

## Config
- [Agent Instructions](./agent.md)
- [Claude Code Instructions](./claude.md)
`;
}

function renderAgentMd(slug, title) {
  return `---
project: ${slug}
generated: "${iso(new Date())}"
---

# Agent Instructions — ${title}

Follow the Syntaur protocol. Read \`project.md\` before grabbing an assignment.
`;
}

function renderClaudeMd(slug, title) {
  return `---
project: ${slug}
generated: "${iso(new Date())}"
---

# Claude Code Instructions — ${title}

Run \`/grab-assignment\` to claim pending work. Keep \`assignment.md\` records up to date as you work.
`;
}

function renderStatus(project, assignments) {
  const by = Object.create(null);
  for (const a of assignments) by[a.status] = (by[a.status] ?? 0) + 1;
  const completed = by.completed ?? 0;
  const blockedCount = by.blocked ?? 0;
  const failedCount = by.failed ?? 0;
  return `---
project: ${project.slug}
generated: "${iso(new Date())}"
status: ${project.archived ? 'archived' : 'active'}
progress:
  total: ${assignments.length}
  completed: ${completed}
  in_progress: ${by.in_progress ?? 0}
  blocked: ${blockedCount}
  pending: ${by.pending ?? 0}
  review: ${by.review ?? 0}
  failed: ${failedCount}
needsAttention:
  blockedCount: ${blockedCount}
  failedCount: ${failedCount}
  unansweredQuestions: 0
---

# Project Status: ${project.title}

**Status:** ${project.archived ? 'archived' : 'active'}
**Progress:** ${completed}/${assignments.length} assignments complete
`;
}

function renderAssignmentsIndex(project, assignments) {
  const by = Object.create(null);
  for (const a of assignments) by[a.status] = (by[a.status] ?? 0) + 1;
  const rows = assignments.map((a) => {
    const deps = a.dependsOn?.length ? a.dependsOn.join(', ') : '—';
    return `| ${a.slug} | ${a.title} | ${a.status} | ${a.priority} | ${a.assignee ?? '—'} | ${deps} | ${a.updated} |`;
  }).join('\n');
  return `---
project: ${project.slug}
generated: "${iso(new Date())}"
total: ${assignments.length}
by_status:
  pending: ${by.pending ?? 0}
  in_progress: ${by.in_progress ?? 0}
  blocked: ${by.blocked ?? 0}
  review: ${by.review ?? 0}
  completed: ${by.completed ?? 0}
  failed: ${by.failed ?? 0}
---

# Assignments

| Slug | Title | Status | Priority | Assignee | Dependencies | Updated |
|------|-------|--------|----------|----------|--------------|---------|
${rows}
`;
}

function renderIndexStub(kind, project) {
  return `---
project: ${project.slug}
kind: ${kind}
generated: "${iso(new Date())}"
---

# ${kind}

_None yet._
`;
}

function renderAssignment(a) {
  const dependsOn = a.dependsOn?.length
    ? `dependsOn:\n  - ${a.dependsOn.join('\n  - ')}`
    : 'dependsOn: []';
  const links = a.links?.length
    ? `links:\n  - ${a.links.join('\n  - ')}`
    : 'links: []';
  const tagsYaml = a.tags?.length
    ? `tags:\n  - ${a.tags.join('\n  - ')}`
    : 'tags: []';
  const criteria = a.criteria.map((c) => `- [${c.done ? 'x' : ' '}] ${c.text}`).join('\n');
  const progress = a.progressNotes?.length
    ? a.progressNotes.map((n) => `### ${n.date} — ${n.heading}\n\n${n.body}`).join('\n\n')
    : 'No progress yet.';
  return `---
id: ${a.id}
slug: ${a.slug}
title: "${a.title}"
status: ${a.status}
priority: ${a.priority}
created: "${a.created}"
updated: "${a.updated}"
assignee: ${a.assignee ?? 'null'}
externalIds: []
${dependsOn}
${links}
blockedReason: ${a.blockedReason ? `"${a.blockedReason}"` : 'null'}
workspace:
  repository: ${a.workspace?.repository ?? 'null'}
  worktreePath: ${a.workspace?.worktreePath ?? 'null'}
  branch: ${a.workspace?.branch ?? 'null'}
  parentBranch: ${a.workspace?.parentBranch ?? 'null'}
${tagsYaml}
---

# ${a.title}

## Objective

${a.objective}

## Acceptance Criteria

${criteria}

## Context

${a.context ?? '_See the project overview for shared context._'}

## Questions & Answers

${a.qa ?? 'No questions yet.'}

## Progress

${progress}

## Links

- [Plan](./plan.md)
- [Scratchpad](./scratchpad.md)
- [Handoff](./handoff.md)
- [Decision Record](./decision-record.md)
`;
}

function renderPlan(a, body) {
  return `---
assignment: ${a.slug}
project: ${a.projectSlug}
generated: "${a.created}"
---

# Plan — ${a.title}

${body}
`;
}

function renderScratchpad(a, body) {
  return `---
assignment: ${a.slug}
generated: "${a.created}"
---

# Scratchpad — ${a.title}

${body ?? '_No scratch notes yet._'}
`;
}

function renderHandoff(a, entries) {
  const body = (entries ?? []).map((e) => {
    return `### ${e.date} — ${e.heading}\n\n${e.body}`;
  }).join('\n\n');
  return `---
assignment: ${a.slug}
generated: "${a.created}"
---

# Handoff — ${a.title}

${body || '_No handoffs yet._'}
`;
}

function renderDecisionRecord(a, entries) {
  const body = (entries ?? []).map((e) => {
    return `### ${e.date} — ${e.title}\n\n**Decision:** ${e.decision}\n\n**Context:** ${e.context}\n\n**Consequences:** ${e.consequences}`;
  }).join('\n\n');
  return `---
assignment: ${a.slug}
generated: "${a.created}"
---

# Decision Record — ${a.title}

${body || '_No decisions recorded yet._'}
`;
}

// --- Data: Projects ---

const NOW = new Date();

const projects = [
  {
    id: randomUUID(),
    slug: 'stripe-webhook-migration',
    title: 'Stripe Webhook Migration',
    created: iso(daysAgo(28)),
    updated: iso(hoursAgo(3)),
    tags: ['backend', 'payments', 'compliance'],
    externalIds: ['PAY-421'],
    overview: `Migrate the billing service off Stripe webhook v1 endpoints (\`/v1/events\`) onto v2 (\`/v2/billing.events\`) before the deprecation window closes on **2026-06-30**. All event handlers, signature verification, retry queue, and reconciliation jobs must move over without dropping a single production event.`,
    notes: `Stripe has indicated the v1 endpoint will stop signing new events on 2026-06-01 and will be removed on 2026-06-30. We have six weeks of dual-write overlap budgeted.`,
  },
  {
    id: randomUUID(),
    slug: 'customer-onboarding-revamp',
    title: 'Customer Onboarding Revamp',
    created: iso(daysAgo(21)),
    updated: iso(hoursAgo(7)),
    tags: ['growth', 'frontend', 'activation'],
    externalIds: ['GROW-88'],
    overview: `Rebuild the post-signup onboarding flow to improve D1 activation. Current flow loses ~34% of signups between account-create and first-workspace. Target: lift activation by 10 percentage points.`,
    notes: `Design brief and wireframes in Figma: https://figma.com/file/demo-onboarding. Research synthesis lives in the "Activation Q2" Notion page.`,
  },
  {
    id: randomUUID(),
    slug: 'search-relevance-v2',
    title: 'Search Relevance v2',
    created: iso(daysAgo(14)),
    updated: iso(hoursAgo(18)),
    tags: ['search', 'ml', 'backend'],
    externalIds: [],
    overview: `Ship the second-pass reranker for document search. Blends BM25 with a cross-encoder scorer and ships behind a feature flag. Goal: top-1 precision improvement of 8pp on the labeled eval set without regressing p95 latency beyond 220ms.`,
    notes: `Eval harness lives in \`packages/search-eval\`. Talk to @mira before touching the token budget config.`,
  },
  {
    id: randomUUID(),
    slug: 'mobile-performance-sprint',
    title: 'Mobile Performance Sprint',
    created: iso(daysAgo(10)),
    updated: iso(hoursAgo(32)),
    tags: ['mobile', 'ios', 'android', 'perf'],
    externalIds: ['MOB-17', 'MOB-22'],
    overview: `One-week focused sprint to get the mobile app under a 2.0s cold-start p75 across top 20 device models. Covers image lazy-load, JS bundle split, prefetch tuning, and native-side startup work.`,
    notes: `Baseline measured on the week of 2026-04-05 with Sentry mobile performance. Raw CSVs are in \`perf/2026-04-05-baseline/\`.`,
  },
  {
    id: randomUUID(),
    slug: 'admin-console-redesign',
    title: 'Admin Console Redesign',
    archived: true,
    archivedAt: `"${iso(daysAgo(6))}"`,
    archivedReason: `"Shipped v1 — follow-on polish tracked in issue tracker."`,
    created: iso(daysAgo(45)),
    updated: iso(daysAgo(6)),
    tags: ['internal', 'ux'],
    externalIds: [],
    overview: `Full visual refresh of the internal admin console: typography, density, navigation, and a new command palette. Replaces the legacy jQuery-era surface.`,
    notes: `Shipped to 100% of admin users on 2026-04-13. See the archived \`ux-refresh-retro.md\` playbook for what we learned.`,
  },
];

// --- Data: Assignments ---

function mk(project, overrides) {
  const created = overrides.created ?? iso(daysAgo(7));
  const updated = overrides.updated ?? created;
  return {
    id: randomUUID(),
    projectSlug: project.slug,
    assignee: 'claude',
    priority: 'medium',
    dependsOn: [],
    links: [],
    tags: [],
    externalIds: [],
    workspace: { repository: null, worktreePath: null, branch: null, parentBranch: null },
    blockedReason: null,
    criteria: [],
    created,
    updated,
    qa: null,
    ...overrides,
  };
}

const assignmentsByMission = {
  'stripe-webhook-migration': [
    mk(projects[0], {
      slug: 'audit-v1-event-handlers',
      title: 'Audit v1 Event Handlers',
      status: 'completed',
      priority: 'high',
      assignee: 'claude',
      tags: ['audit', 'webhooks'],
      externalIds: ['PAY-421'],
      created: iso(daysAgo(27)),
      updated: iso(daysAgo(22)),
      workspace: {
        repository: '/Users/brennen/demo-billing',
        worktreePath: '/Users/brennen/demo-billing/.worktrees/audit-v1',
        branch: 'audit-v1-handlers',
        parentBranch: 'main',
      },
      objective: `Catalogue every Stripe webhook handler in \`packages/billing\` along with the event types each one listens for, what downstream side effects it has, and whether v2 provides a direct equivalent.`,
      criteria: [
        { text: 'Full handler inventory committed as `billing/docs/webhook-inventory.md`.', done: true },
        { text: 'Each handler tagged with `v2_equivalent: yes | partial | no`.', done: true },
        { text: 'Partial/no cases have written migration notes with proposed approach.', done: true },
        { text: 'Shared the inventory with @mira and incorporated her review comments.', done: true },
      ],
      context: `Start from \`packages/billing/src/webhooks/*.ts\` and use \`rg "event.type ==="\` to enumerate event discrimination. Handlers are registered in \`webhooks/router.ts\`.`,
      progressNotes: [
        { date: '2026-04-22', heading: 'Inventory complete', body: 'Catalogued 34 handlers across 18 event types. 2 handlers have no v2 equivalent (`invoice.sent`, `customer.discount.created`) — see notes in doc.' },
      ],
    }),
    mk(projects[0], {
      slug: 'dual-write-signature-verifier',
      title: 'Dual-Write Signature Verifier',
      status: 'in_progress',
      priority: 'high',
      tags: ['webhooks', 'security'],
      assignee: 'claude',
      created: iso(daysAgo(14)),
      updated: iso(hoursAgo(3)),
      dependsOn: ['audit-v1-event-handlers'],
      workspace: {
        repository: '/Users/brennen/demo-billing',
        worktreePath: '/Users/brennen/demo-billing/.worktrees/dual-verifier',
        branch: 'dual-verifier',
        parentBranch: 'main',
      },
      objective: `Accept webhooks at both \`/v1/events\` and \`/v2/billing.events\` during the six-week overlap. Signature verification must run for both and reject mismatches without breaking the v1 path.`,
      criteria: [
        { text: 'New `VerifySignature` adapter supports v1 and v2 signing secrets via env.', done: true },
        { text: 'Integration test spins up a local webhook fixture and asserts both paths accept valid and reject invalid signatures.', done: true },
        { text: 'Metrics emitted: `webhook.received{version=v1|v2}` and `webhook.rejected{reason}`.', done: true },
        { text: 'Feature flag `billing.dualWrite` gates the v2 path; off by default in prod.', done: false },
        { text: 'Runbook entry written for on-call: how to flip the flag, how to read the metrics.', done: false },
      ],
      context: `Signing secret rotation happens in Vault. Talk to @rohit before staging reads the new secret.`,
      progressNotes: [
        { date: '2026-04-24', heading: 'Adapter landed behind flag', body: 'v1 path untouched. v2 path passes the shared integration-test fixture. Next up: metrics + runbook.' },
      ],
    }),
    mk(projects[0], {
      slug: 'reconciliation-backfill',
      title: 'Reconciliation Backfill Job',
      status: 'blocked',
      priority: 'critical',
      tags: ['jobs', 'data'],
      assignee: 'claude',
      created: iso(daysAgo(10)),
      updated: iso(hoursAgo(26)),
      dependsOn: ['dual-write-signature-verifier'],
      blockedReason: 'Waiting on v2 event replay API access from Stripe support (ticket #SUP-90214). ETA TBD.',
      workspace: {
        repository: '/Users/brennen/demo-billing',
        worktreePath: null,
        branch: null,
        parentBranch: 'main',
      },
      objective: `Backfill v2 events for the 30-day overlap window so the v2 pipeline has parity with v1 before cutover.`,
      criteria: [
        { text: 'Design doc reviewed with @mira and @rohit.', done: true },
        { text: 'Job pulls from the Stripe v2 replay API with exponential backoff.', done: false },
        { text: 'Idempotency keyed on `event.id`; re-runs are no-ops.', done: false },
        { text: 'Dry-run mode writes counts only, no side effects.', done: false },
      ],
      context: `Stripe support is the blocker. Ticket history is in Linear (PAY-421-sub-3).`,
      qa: `**Q (@mira, 2026-04-18):** What happens to \`customer.discount.created\` which has no v2 equivalent?\n\n**A (@brennen, 2026-04-18):** We keep reading those off v1 until Stripe ships a v2 replacement. Documented in the inventory.`,
      progressNotes: [
        { date: '2026-04-17', heading: 'Blocked on replay API access', body: 'Design done, implementation cannot start until Stripe grants replay scope on the test key.' },
      ],
    }),
    mk(projects[0], {
      slug: 'cutover-runbook',
      title: 'Cutover Runbook',
      status: 'pending',
      priority: 'medium',
      tags: ['runbook', 'ops'],
      assignee: null,
      created: iso(daysAgo(5)),
      updated: iso(daysAgo(5)),
      dependsOn: ['reconciliation-backfill'],
      objective: `Write the step-by-step runbook on-call will follow during the final v1-to-v2 cutover. Must cover rollback, observability, and escalation paths.`,
      criteria: [
        { text: 'Draft reviewed by two engineers outside the billing team.', done: false },
        { text: 'Includes pre-cutover checklist (feature flag state, metric baselines, Vault secrets, paging).', done: false },
        { text: 'Includes rollback procedure with explicit rollback criteria (error budget thresholds).', done: false },
        { text: 'Stored alongside other billing runbooks in `docs/runbooks/billing/`.', done: false },
      ],
      context: `Follow the template in \`docs/runbooks/_template.md\`. Cross-reference the dual-write flag and reconciliation job.`,
    }),
  ],

  'customer-onboarding-revamp': [
    mk(projects[1], {
      slug: 'funnel-instrumentation',
      title: 'Funnel Instrumentation',
      status: 'completed',
      priority: 'high',
      tags: ['analytics', 'frontend'],
      assignee: 'codex',
      created: iso(daysAgo(20)),
      updated: iso(daysAgo(15)),
      workspace: {
        repository: '/Users/brennen/demo-webapp',
        worktreePath: null,
        branch: 'funnel-events',
        parentBranch: 'main',
      },
      objective: `Add Segment events for every step in the post-signup flow: email-verified, workspace-created, first-invite-sent, first-agent-run.`,
      criteria: [
        { text: 'Events fire with consistent schema (`event_name`, `user_id`, `timestamp`, `context`).', done: true },
        { text: 'Looker dashboard "Onboarding Funnel" shows all four steps with no null values.', done: true },
        { text: 'Pull request reviewed and merged.', done: true },
      ],
      progressNotes: [
        { date: '2026-04-04', heading: 'Landed and dashboard live', body: 'All four events firing. @sophie signed off on the dashboard.' },
      ],
    }),
    mk(projects[1], {
      slug: 'empty-workspace-illustration',
      title: 'Empty Workspace Illustration & Copy',
      status: 'review',
      priority: 'medium',
      tags: ['design', 'frontend'],
      assignee: 'claude',
      created: iso(daysAgo(11)),
      updated: iso(hoursAgo(9)),
      workspace: {
        repository: '/Users/brennen/demo-webapp',
        worktreePath: '/Users/brennen/demo-webapp/.worktrees/empty-state',
        branch: 'onboarding/empty-state',
        parentBranch: 'main',
      },
      objective: `Replace the current empty-workspace screen (a sad inline SVG with "No data yet") with the new illustration set and first-run copy from design.`,
      criteria: [
        { text: 'Imports Lottie animation from `assets/onboarding/empty.lottie`.', done: true },
        { text: 'Copy pulled from localization strings, not hardcoded.', done: true },
        { text: 'Animation pauses when `prefers-reduced-motion: reduce` is set.', done: true },
        { text: 'Visual diff approved by @sophie.', done: true },
        { text: 'Ships behind the `onboarding.v2` flag, default on for internal team.', done: false },
      ],
      progressNotes: [
        { date: '2026-04-18', heading: 'Ready for review', body: 'All five criteria addressed. Awaiting @sophie to walk the visual diff in staging.' },
      ],
    }),
    mk(projects[1], {
      slug: 'invite-teammate-step',
      title: 'Invite Teammate Step',
      status: 'in_progress',
      priority: 'high',
      tags: ['frontend', 'activation'],
      assignee: 'claude',
      created: iso(daysAgo(8)),
      updated: iso(hoursAgo(14)),
      dependsOn: ['funnel-instrumentation'],
      workspace: {
        repository: '/Users/brennen/demo-webapp',
        worktreePath: '/Users/brennen/demo-webapp/.worktrees/invite-step',
        branch: 'onboarding/invite-step',
        parentBranch: 'main',
      },
      objective: `Introduce an "Invite a teammate" step between workspace creation and the dashboard. Should be skippable and should not block the user, but should nudge with social proof ("Teams of 3+ are 2x more likely to succeed").`,
      criteria: [
        { text: 'New `/onboarding/invite` route and page.', done: true },
        { text: 'Skipping fires `onboarding.invite.skipped` event.', done: true },
        { text: 'Sending invites fires `onboarding.invite.sent{count}`.', done: false },
        { text: 'A/B test wired up via GrowthBook (`onboarding-invite-step`).', done: false },
        { text: 'Copy reviewed by @sophie and localized into ES and FR.', done: false },
      ],
    }),
    mk(projects[1], {
      slug: 'welcome-email-template',
      title: 'Welcome Email Template',
      status: 'pending',
      priority: 'low',
      tags: ['email', 'lifecycle'],
      assignee: null,
      created: iso(daysAgo(3)),
      updated: iso(daysAgo(3)),
      objective: `Rewrite the welcome email to match the new onboarding voice. Include a single primary CTA back into the product.`,
      criteria: [
        { text: 'MJML template lands in `emails/welcome.mjml`.', done: false },
        { text: 'Preview renders in Litmus across top 10 clients.', done: false },
        { text: 'Link tracking uses the new UTM convention `utm_source=welcome&utm_medium=email&utm_campaign=onboarding_v2`.', done: false },
      ],
    }),
    mk(projects[1], {
      slug: 'sample-project-seed',
      title: 'Seed a Sample Project on Signup',
      status: 'pending',
      priority: 'medium',
      tags: ['backend', 'activation'],
      assignee: null,
      created: iso(daysAgo(3)),
      updated: iso(daysAgo(3)),
      dependsOn: ['invite-teammate-step'],
      objective: `Create a "Sample Project" in every new workspace so the first-run dashboard isn't empty. Lives behind the same \`onboarding.v2\` flag.`,
      criteria: [
        { text: 'Seeding job runs in the post-signup handler, not on the hot signup path.', done: false },
        { text: 'Sample project is tagged and can be deleted like any other.', done: false },
        { text: 'Metric: `onboarding.sample_project.created` emitted on success.', done: false },
      ],
    }),
  ],

  'search-relevance-v2': [
    mk(projects[2], {
      slug: 'eval-set-refresh',
      title: 'Refresh the Labeled Eval Set',
      status: 'completed',
      priority: 'medium',
      tags: ['ml', 'eval'],
      assignee: 'codex',
      created: iso(daysAgo(13)),
      updated: iso(daysAgo(10)),
      objective: `The eval set hasn't been refreshed in 7 months and no longer reflects production query distributions. Pull a new sample of 2,000 queries and relabel.`,
      criteria: [
        { text: 'New sample drawn from logs (last 30d, stratified by result-click-through).', done: true },
        { text: '2,000 queries labeled by contractors (3-way consensus).', done: true },
        { text: 'Eval set committed to `packages/search-eval/fixtures/2026-04.jsonl`.', done: true },
      ],
    }),
    mk(projects[2], {
      slug: 'cross-encoder-reranker',
      title: 'Cross-Encoder Reranker',
      status: 'in_progress',
      priority: 'high',
      tags: ['ml', 'search'],
      assignee: 'claude',
      created: iso(daysAgo(8)),
      updated: iso(hoursAgo(18)),
      dependsOn: ['eval-set-refresh'],
      workspace: {
        repository: '/Users/brennen/demo-search',
        worktreePath: '/Users/brennen/demo-search/.worktrees/reranker',
        branch: 'reranker',
        parentBranch: 'main',
      },
      objective: `Integrate a cross-encoder reranker on top of the BM25 first stage. Target top-1 precision improvement of 8pp without p95 regression above 220ms.`,
      criteria: [
        { text: 'Reranker service exposes a single `rerank(queries, docs)` RPC.', done: true },
        { text: 'Latency at p95 < 220ms on the canary slice.', done: false },
        { text: 'Eval top-1 precision improves by ≥ 8pp on the 2026-04 set.', done: false },
        { text: 'Flag-gated (`search.reranker.v2`) and rolled out at 10% for the first week.', done: false },
      ],
      progressNotes: [
        { date: '2026-04-18', heading: 'First eval pass', body: 'Top-1 precision up 6.4pp, but p95 blew past 260ms. Working on batching and ONNX quantization next.' },
      ],
    }),
    mk(projects[2], {
      slug: 'query-token-budget-tuning',
      title: 'Query Token Budget Tuning',
      status: 'pending',
      priority: 'low',
      tags: ['ml', 'perf'],
      assignee: null,
      created: iso(daysAgo(4)),
      updated: iso(daysAgo(4)),
      dependsOn: ['cross-encoder-reranker'],
      objective: `Once the reranker lands, sweep the query-side token budget to find the latency/quality frontier.`,
      criteria: [
        { text: 'Sweep covers 32, 48, 64, 96, 128 tokens.', done: false },
        { text: 'Report committed to `packages/search-eval/reports/token-budget.md`.', done: false },
        { text: 'Recommendation landed as the new default in config.', done: false },
      ],
    }),
  ],

  'mobile-performance-sprint': [
    mk(projects[3], {
      slug: 'baseline-measurement',
      title: 'Baseline Cold-Start Measurement',
      status: 'completed',
      priority: 'high',
      tags: ['perf', 'measurement'],
      assignee: 'claude',
      created: iso(daysAgo(10)),
      updated: iso(daysAgo(9)),
      objective: `Establish a reproducible baseline for cold-start across the top 20 device models using Sentry mobile performance and a scripted test harness.`,
      criteria: [
        { text: 'Harness runs against the top 20 device models from the last 30 days.', done: true },
        { text: 'Baseline CSV committed to `perf/2026-04-05-baseline/`.', done: true },
        { text: 'Dashboard pinned in Sentry showing the baseline p50/p75/p95.', done: true },
      ],
    }),
    mk(projects[3], {
      slug: 'image-lazy-load',
      title: 'Image Lazy-Load on First Screen',
      status: 'in_progress',
      priority: 'high',
      tags: ['perf', 'mobile'],
      assignee: 'codex',
      created: iso(daysAgo(7)),
      updated: iso(hoursAgo(5)),
      dependsOn: ['baseline-measurement'],
      workspace: {
        repository: '/Users/brennen/demo-mobile',
        worktreePath: '/Users/brennen/demo-mobile/.worktrees/lazy-images',
        branch: 'perf/lazy-images',
        parentBranch: 'main',
      },
      objective: `Defer decoding and network fetch of images that aren't in the first-screen viewport. iOS and Android parity.`,
      criteria: [
        { text: 'iOS: uses `UIImageView` with async decoding flag + below-fold deferred fetch.', done: true },
        { text: 'Android: uses Coil with `placeholderMemoryCacheKey` + below-fold deferred fetch.', done: true },
        { text: 'Smoke test: scrolling below the fold loads images within 200ms of reaching them.', done: false },
      ],
    }),
    mk(projects[3], {
      slug: 'js-bundle-split',
      title: 'JS Bundle Split',
      status: 'failed',
      priority: 'high',
      tags: ['perf', 'bundler'],
      assignee: 'codex',
      created: iso(daysAgo(6)),
      updated: iso(daysAgo(2)),
      dependsOn: ['baseline-measurement'],
      blockedReason: null,
      objective: `Split the JS bundle into a first-screen critical chunk and a background chunk. Load the background chunk after \`hermes.initialized\`.`,
      criteria: [
        { text: 'Metro config splits the bundle on a manual boundary.', done: true },
        { text: 'Cold-start improves by ≥ 150ms on p75.', done: false },
        { text: 'No new crashes in the Sentry release-health dashboard.', done: false },
      ],
      progressNotes: [
        { date: '2026-04-17', heading: 'Regression — failing out', body: 'Split broke dynamic requires in `@react-navigation` which we depend on deeply. Crash rate jumped 3x in the canary. Rolled back. Re-opening is gated on upgrading react-navigation and rethinking the split boundary.' },
      ],
    }),
    mk(projects[3], {
      slug: 'prefetch-tuning',
      title: 'Prefetch Tuning',
      status: 'pending',
      priority: 'medium',
      tags: ['perf', 'mobile'],
      assignee: null,
      created: iso(daysAgo(4)),
      updated: iso(daysAgo(4)),
      dependsOn: ['image-lazy-load'],
      objective: `Review the current prefetch waterfall and tune what gets kicked off on app start vs. on first interaction.`,
      criteria: [
        { text: 'Document the current prefetch set in `perf/prefetch-audit.md`.', done: false },
        { text: 'Move anything below the fold off the startup path.', done: false },
        { text: 'Ship behind the `perf.prefetch-v2` flag.', done: false },
      ],
    }),
  ],

  'admin-console-redesign': [
    mk(projects[4], {
      slug: 'design-system-tokens',
      title: 'Design System Tokens',
      status: 'completed',
      priority: 'high',
      tags: ['design', 'tokens'],
      assignee: 'claude',
      created: iso(daysAgo(44)),
      updated: iso(daysAgo(38)),
      objective: `Land the new design-token set (typography, spacing, colour, radius) as a Tailwind preset consumed by the admin console.`,
      criteria: [
        { text: 'Preset published as `@internal/admin-tokens`.', done: true },
        { text: 'Storybook renders every token.', done: true },
        { text: 'Admin console imports the preset.', done: true },
      ],
    }),
    mk(projects[4], {
      slug: 'command-palette',
      title: 'Command Palette',
      status: 'completed',
      priority: 'medium',
      tags: ['frontend', 'keyboard'],
      assignee: 'codex',
      created: iso(daysAgo(40)),
      updated: iso(daysAgo(14)),
      dependsOn: ['design-system-tokens'],
      objective: `Build a ⌘K command palette covering navigation, quick-actions, and search across users, workspaces, and invoices.`,
      criteria: [
        { text: 'Opens on ⌘K and Ctrl+K; closes on Esc.', done: true },
        { text: 'Indexes users, workspaces, invoices.', done: true },
        { text: 'Actions support keyboard navigation with `aria-selected`.', done: true },
        { text: 'A11y pass with axe: zero violations.', done: true },
      ],
    }),
    mk(projects[4], {
      slug: 'billing-dashboard-refresh',
      title: 'Billing Dashboard Refresh',
      status: 'completed',
      priority: 'medium',
      tags: ['frontend', 'billing'],
      assignee: 'claude',
      created: iso(daysAgo(25)),
      updated: iso(daysAgo(8)),
      objective: `Port the billing dashboard to the new token set and restructure the layout to surface MRR, churn, and upcoming invoices above the fold.`,
      criteria: [
        { text: 'MRR card is the first card on desktop and mobile.', done: true },
        { text: 'Churn and upcoming-invoices cards follow.', done: true },
        { text: 'Deprecated legacy CSS removed from `admin/legacy/billing.css`.', done: true },
      ],
    }),
    mk(projects[4], {
      slug: 'migration-retro',
      title: 'Migration Retro',
      status: 'completed',
      priority: 'low',
      tags: ['process'],
      assignee: 'claude',
      created: iso(daysAgo(8)),
      updated: iso(daysAgo(6)),
      objective: `Write a retro covering what went well, what didn't, and what we'd do differently.`,
      criteria: [
        { text: 'Retro published to `docs/retros/2026-04-admin-redesign.md`.', done: true },
        { text: 'Circulated to engineering and design leads.', done: true },
      ],
    }),
  ],
};

// --- Playbooks, servers, todos, sessions ---

const playbooks = [
  {
    slug: 'commit-discipline',
    name: 'Commit Discipline',
    description: 'Make small, logical commits with clear messages tied to plan tasks',
    whenToUse: 'When making git commits during assignment work',
    tags: ['quality', 'git'],
    body: `- Make commits at logical boundaries — one commit per plan task or meaningful unit of work.
- Commit messages should reference what was done, not just "implement feature".
- If the assignment has an external ID, include it in the commit message.
- Never commit secrets, credentials, .env files, or API keys.
- Run the linter/formatter before committing.
- Do not amend previous commits unless explicitly asked.`,
  },
  {
    slug: 'read-before-plan',
    name: 'Read Before You Plan',
    description: 'Read all project context files before creating or modifying a plan',
    whenToUse: 'Before creating or modifying plan.md',
    tags: ['planning', 'quality'],
    body: `Before writing or modifying any plan, read:
- \`project.md\` — the overall goal
- Sibling assignment.md files in the same project
- Any referenced design docs in \`resources/\`
- The most recent handoffs and decision records

Planning without context produces brittle, redundant work. Take the five minutes.`,
  },
  {
    slug: 'test-before-done',
    name: 'Test Before Done',
    description: 'Run tests and verify acceptance criteria before marking assignments complete',
    whenToUse: 'Before transitioning an assignment to review or completed',
    tags: ['quality', 'testing'],
    body: `Before calling an assignment done:
1. Run the project's full test suite and make sure it passes locally.
2. Re-read each acceptance criterion and verify it against the actual behavior, not the intended behavior.
3. For UI work, load the running app and exercise the golden path.
4. If any criterion is partially met, leave it unchecked and note it in the Progress section.`,
  },
  {
    slug: 'workspace-before-code',
    name: 'Workspace Before Code',
    description: 'Set workspace fields in assignment.md before writing any implementation code',
    whenToUse: 'Before writing any implementation code for an assignment',
    tags: ['workflow', 'quality'],
    body: `Before writing code:
- Set \`workspace.repository\`, \`workspace.worktreePath\`, \`workspace.branch\`, and \`workspace.parentBranch\` in \`assignment.md\`.
- If you're working in an isolated worktree, create it first.

This tells the dashboard and other agents where your work lives, and the write-boundary hook uses it to prevent cross-assignment edits.`,
  },
  {
    slug: 'keep-records-updated',
    name: 'Keep Records Updated',
    description: 'Keep assignment.md progress, sessions, and criteria current in real-time',
    whenToUse: 'After every meaningful action, when completing criteria, when starting or stopping work',
    tags: ['workflow', 'protocol'],
    body: `Assignment records are the source of truth for human stakeholders and downstream agents.
- Check off acceptance criteria as soon as they're met.
- Add a progress entry after every meaningful action (new approach, blocker, decision).
- Keep the Questions & Answers section current.
- Never backfill records retroactively in a final flurry — do it as you go.`,
  },
];

function renderPlaybook(p) {
  return `---
name: "${p.name}"
slug: ${p.slug}
description: "${p.description}"
when_to_use: "${p.whenToUse}"
created: "${iso(daysAgo(60))}"
updated: "${iso(daysAgo(20))}"
tags:
${p.tags.map((t) => `  - ${t}`).join('\n')}
---

# ${p.name}

${p.body}
`;
}

function renderPlaybooksManifest(items) {
  const lines = items.map((p) =>
    `- **[${p.name}](${p.slug}.md)** — ${p.description}\n  _When to use: ${p.whenToUse}_`
  ).join('\n');
  return `---
generated: "${iso(new Date())}"
total: ${items.length}
---

# Playbooks

Behavioral rules for AI agents. Read and follow all playbooks before starting work.

${lines}
`;
}

// auto: false so autodiscovery's liveness-cleanup won't wipe them when the
// underlying process or tmux session doesn't actually exist on this machine.
const servers = [
  { session: 'demo-webapp', kind: 'tmux', auto: false },
  { session: 'demo-billing-api', kind: 'process', auto: false, ports: [4174], cwd: '/Users/brennen/demo-billing' },
  { session: 'demo-search-index', kind: 'process', auto: false, ports: [8001], cwd: '/Users/brennen/demo-search' },
  { session: 'demo-admin-console', kind: 'process', auto: false, ports: [6403], cwd: '/Users/brennen/demo-admin' },
  { session: 'demo-worker-queue', kind: 'tmux', auto: false },
];

function renderServer(s) {
  const lines = [
    `session: ${s.session}`,
    `registered: ${iso(daysAgo(2))}`,
    `last_refreshed: ${iso(hoursAgo(1))}`,
    `auto: ${s.auto ? 'true' : 'false'}`,
    `kind: ${s.kind}`,
  ];
  if (s.pid) lines.push(`pid: ${s.pid}`);
  if (s.ports) lines.push(`ports: [${s.ports.join(', ')}]`);
  if (s.cwd) lines.push(`cwd: ${s.cwd}`);
  return `---\n${lines.join('\n')}\n---\n`;
}

const todoWorkspaces = [
  {
    workspace: 'demo-billing',
    items: [
      { id: 'a1b2', status: 'completed', text: 'Audit v1 webhook handlers' },
      { id: 'c3d4', status: 'in_progress', text: 'Wire the v2 signature verifier behind the feature flag', session: 'claude-1234' },
      { id: 'e5f6', status: 'blocked', text: 'Backfill v2 events for the 30-day overlap' },
      { id: '7890', status: 'open', text: 'Write the cutover runbook' },
      { id: '1122', status: 'open', text: 'Set up Grafana alert for `webhook.rejected` rate' },
    ],
  },
  {
    workspace: 'demo-webapp',
    items: [
      { id: 'aaaa', status: 'completed', text: 'Instrument the four onboarding funnel events' },
      { id: 'bbbb', status: 'in_progress', text: 'Ship the Lottie empty-workspace illustration', session: 'claude-5678' },
      { id: 'cccc', status: 'in_progress', text: 'Build the Invite Teammate step', session: 'claude-5679' },
      { id: 'dddd', status: 'open', text: 'Rewrite welcome email' },
      { id: 'eeee', status: 'open', text: 'Seed a sample project on signup' },
    ],
  },
];

function renderTodoChecklist(ws) {
  const lines = ws.items.map((it) => {
    const marker =
      it.status === 'completed' ? 'x' :
      it.status === 'blocked' ? '!' :
      it.status === 'in_progress' ? (it.session ? `>:${it.session}` : '>') :
      ' ';
    return `- [${marker}] ${it.text} [t:${it.id}]`;
  }).join('\n');
  return `---
workspace: ${ws.workspace}
archive_interval: weekly
---

# Todos — ${ws.workspace}

${lines}
`;
}

// --- Agent sessions seeded into SQLite ---

function seedAgentSessions(dbPath, projectMap) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      mission_slug TEXT,
      assignment_slug TEXT,
      agent TEXT NOT NULL,
      started TEXT NOT NULL,
      ended TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      path TEXT,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_mission ON sessions(mission_slug);
    CREATE INDEX IF NOT EXISTS idx_sessions_assignment ON sessions(mission_slug, assignment_slug);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '2');
  `);

  const insert = db.prepare(`
    INSERT OR REPLACE INTO sessions
      (session_id, mission_slug, assignment_slug, agent, started, ended, status, path, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const sessions = [
    {
      sessionId: 'claude-sess-01e9b0',
      projectSlug: 'stripe-webhook-migration',
      assignmentSlug: 'dual-write-signature-verifier',
      agent: 'claude',
      started: iso(hoursAgo(4)),
      ended: null,
      status: 'active',
      path: '/Users/brennen/demo-billing/.worktrees/dual-verifier',
      description: 'Implementing the v2 signature verifier behind the `billing.dualWrite` flag.',
    },
    {
      sessionId: 'claude-sess-02a7c3',
      projectSlug: 'customer-onboarding-revamp',
      assignmentSlug: 'invite-teammate-step',
      agent: 'claude',
      started: iso(hoursAgo(14)),
      ended: null,
      status: 'active',
      path: '/Users/brennen/demo-webapp/.worktrees/invite-step',
      description: 'Building the invite teammate onboarding step and wiring the GrowthBook flag.',
    },
    {
      sessionId: 'codex-sess-033f11',
      projectSlug: 'search-relevance-v2',
      assignmentSlug: 'cross-encoder-reranker',
      agent: 'codex',
      started: iso(hoursAgo(18)),
      ended: null,
      status: 'active',
      path: '/Users/brennen/demo-search/.worktrees/reranker',
      description: 'Batching and ONNX-quantizing the cross-encoder to cut p95.',
    },
    {
      sessionId: 'claude-sess-04d8e2',
      projectSlug: 'customer-onboarding-revamp',
      assignmentSlug: 'empty-workspace-illustration',
      agent: 'claude',
      started: iso(hoursAgo(30)),
      ended: iso(hoursAgo(9)),
      status: 'completed',
      path: '/Users/brennen/demo-webapp/.worktrees/empty-state',
      description: 'Shipped Lottie illustration with reduced-motion support.',
    },
    {
      sessionId: 'codex-sess-05b721',
      projectSlug: 'mobile-performance-sprint',
      assignmentSlug: 'js-bundle-split',
      agent: 'codex',
      started: iso(daysAgo(3)),
      ended: iso(daysAgo(2)),
      status: 'stopped',
      path: '/Users/brennen/demo-mobile/.worktrees/bundle-split',
      description: 'Rolled back — split broke react-navigation dynamic requires.',
    },
    {
      sessionId: 'claude-sess-06a440',
      projectSlug: 'stripe-webhook-migration',
      assignmentSlug: 'audit-v1-event-handlers',
      agent: 'claude',
      started: iso(daysAgo(23)),
      ended: iso(daysAgo(22)),
      status: 'completed',
      path: '/Users/brennen/demo-billing/.worktrees/audit-v1',
      description: 'Completed the v1 webhook inventory.',
    },
    {
      sessionId: 'codex-sess-07f299',
      projectSlug: 'mobile-performance-sprint',
      assignmentSlug: 'image-lazy-load',
      agent: 'codex',
      started: iso(hoursAgo(5)),
      ended: null,
      status: 'active',
      path: '/Users/brennen/demo-mobile/.worktrees/lazy-images',
      description: 'Implementing below-fold lazy image load on iOS and Android.',
    },
    {
      sessionId: 'claude-sess-08c511',
      projectSlug: null,
      assignmentSlug: null,
      agent: 'claude',
      started: iso(hoursAgo(2)),
      ended: null,
      status: 'active',
      path: '/Users/brennen/syntaur',
      description: 'Ad-hoc session: seeding the demo workspace.',
    },
  ];

  for (const s of sessions) {
    insert.run(
      s.sessionId,
      s.projectSlug,
      s.assignmentSlug,
      s.agent,
      s.started,
      s.ended,
      s.status,
      s.path,
      s.description,
    );
  }

  db.close();
}

// --- Write everything ---

async function main() {
  if (existsSync(TARGET)) {
    if (!FORCE) {
      console.error(`Refusing to seed into existing directory: ${TARGET}`);
      console.error(`Re-run with --force to wipe and re-seed.`);
      process.exit(1);
    }
    console.log(`Wiping ${TARGET} (--force)...`);
    await rm(TARGET, { recursive: true, force: true });
  }

  const projectsDir = resolve(TARGET, 'projects');
  const playbooksDir = resolve(TARGET, 'playbooks');
  const serversDir = resolve(TARGET, 'servers');
  const todosDir = resolve(TARGET, 'todos');

  await ensureDir(TARGET);
  await ensureDir(projectsDir);
  await ensureDir(playbooksDir);
  await ensureDir(serversDir);
  await ensureDir(todosDir);
  await ensureDir(resolve(TARGET, 'assignments'));

  await writeText(resolve(TARGET, 'config.md'), renderConfigMd(projectsDir));

  // Projects
  for (const m of projects) {
    const projectDir = resolve(projectsDir, m.slug);
    await ensureDir(projectDir);
    await ensureDir(resolve(projectDir, 'assignments'));
    await ensureDir(resolve(projectDir, 'resources'));
    await ensureDir(resolve(projectDir, 'memories'));

    await writeText(resolve(projectDir, 'project.md'), renderProject(m));
    await writeText(resolve(projectDir, 'manifest.md'), renderManifest(m.slug, m.created));
    await writeText(resolve(projectDir, 'agent.md'), renderAgentMd(m.slug, m.title));
    await writeText(resolve(projectDir, 'claude.md'), renderClaudeMd(m.slug, m.title));

    const projectAssignments = assignmentsByMission[m.slug] ?? [];
    await writeText(resolve(projectDir, '_index-assignments.md'), renderAssignmentsIndex(m, projectAssignments));
    await writeText(resolve(projectDir, '_index-plans.md'), renderIndexStub('Plans', m));
    await writeText(resolve(projectDir, '_index-decisions.md'), renderIndexStub('Decision Records', m));
    await writeText(resolve(projectDir, '_status.md'), renderStatus(m, projectAssignments));
    await writeText(resolve(projectDir, 'resources', '_index.md'), renderIndexStub('Resources', m));
    await writeText(resolve(projectDir, 'memories', '_index.md'), renderIndexStub('Memories', m));

    for (const a of projectAssignments) {
      const aDir = resolve(projectDir, 'assignments', a.slug);
      await ensureDir(aDir);
      await writeText(resolve(aDir, 'assignment.md'), renderAssignment(a));

      // Plans — fuller for in-progress / completed
      const planBody = a.status === 'pending'
        ? '_Plan not drafted yet._'
        : `## Approach\n\nBreak the work down per acceptance criterion. Ship behind a feature flag where the change is non-trivial.\n\n## Tasks\n\n${a.criteria.map((c, i) => `${i + 1}. ${c.done ? '~~' + c.text + '~~' : c.text}`).join('\n')}\n\n## Risks\n\n- **Regression risk.** Guard with the ${a.slug}.v1 flag and a canary.\n- **Observability gap.** Emit one counter and one histogram before cutover.`;
      await writeText(resolve(aDir, 'plan.md'), renderPlan(a, planBody));

      // Scratchpad
      const scratchBody = a.status === 'pending' ? null
        : `- Ran \`rg\` to find every touch point. Notes in the commit range.\n- Flag name decision parked in \`decision-record.md\`.\n- Runbook cross-linked from the project overview.`;
      await writeText(resolve(aDir, 'scratchpad.md'), renderScratchpad(a, scratchBody));

      // Handoff — only for review/completed/failed
      const handoffEntries = (a.status === 'review' || a.status === 'completed' || a.status === 'failed')
        ? [{
            date: a.updated.slice(0, 10),
            heading: a.status === 'completed' ? 'Shipped' : a.status === 'failed' ? 'Rolling back' : 'Ready for review',
            body: a.status === 'completed'
              ? `All acceptance criteria met. Verified against the golden path and the two adversarial paths called out in the plan.`
              : a.status === 'failed'
                ? `Rolling this back. The split broke a dynamic-require edge case in react-navigation. Re-opening once we're on the next major.`
                : `Five of six criteria met. The last one (rollout at internal-only) needs a design sign-off. Everything else is in the PR description.`,
          }]
        : [];
      await writeText(resolve(aDir, 'handoff.md'), renderHandoff(a, handoffEntries));

      // Decision record
      const decisionEntries = (a.status !== 'pending')
        ? [{
            date: a.created.slice(0, 10),
            title: 'Ship behind a feature flag',
            decision: `Gated behind \`${a.slug}.v1\` with a 10% canary week.`,
            context: `Rolling straight to 100% on a billing/auth/perf-sensitive change is how we earn incidents.`,
            consequences: `One extra week of carry. Easy rollback. Negligible engineering cost.`,
          }]
        : [];
      await writeText(resolve(aDir, 'decision-record.md'), renderDecisionRecord(a, decisionEntries));
    }
  }

  // Playbooks
  for (const p of playbooks) {
    await writeText(resolve(playbooksDir, `${p.slug}.md`), renderPlaybook(p));
  }
  await writeText(resolve(playbooksDir, 'manifest.md'), renderPlaybooksManifest(playbooks));

  // Servers
  for (const s of servers) {
    await writeText(resolve(serversDir, `${s.session}.md`), renderServer(s));
  }

  // Todos
  for (const ws of todoWorkspaces) {
    await writeText(resolve(todosDir, `${ws.workspace}.md`), renderTodoChecklist(ws));
  }

  // Agent sessions (SQLite)
  const dbPath = resolve(TARGET, 'syntaur.db');
  seedAgentSessions(dbPath, projects);

  // Summary
  const totalAssignments = Object.values(assignmentsByMission).reduce((n, arr) => n + arr.length, 0);
  console.log(`\n✓ Demo workspace seeded at: ${TARGET}`);
  console.log(`  ${projects.length} projects, ${totalAssignments} assignments`);
  console.log(`  ${playbooks.length} playbooks, ${servers.length} servers, ${todoWorkspaces.length} todo workspaces`);
  console.log(`  agent sessions seeded into syntaur.db`);
  console.log(`\nLaunch the dashboard against it with:`);
  console.log(`  SYNTAUR_HOME=${TARGET.replace(homedir(), '~')} syntaur dashboard`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
