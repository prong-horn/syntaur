import { resolve } from 'node:path';
import { fileExists } from '../../fs.js';
import type { Check, CheckResult } from '../types.js';

const CATEGORY = 'dashboard';

const dbReachable: Check = {
  id: 'dashboard.db-reachable',
  category: CATEGORY,
  title: 'syntaur.db is readable and has expected schema',
  async run(ctx) {
    if (!ctx.db) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'error',
        detail: `could not open syntaur.db: ${ctx.dbError ?? 'unknown error'}`,
        affected: [resolve(ctx.syntaurRoot, 'syntaur.db')],
        remediation: {
          kind: 'manual',
          suggestion: 'Start the dashboard once (`syntaur dashboard`) to initialize the DB, or restore it from backup',
          command: 'syntaur dashboard',
        },
        autoFixable: false,
      } satisfies CheckResult;
    }
    try {
      const row = ctx.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
        .get();
      if (!row) {
        return {
          id: this.id,
          category: this.category,
          title: this.title,
          status: 'error',
          detail: 'syntaur.db is missing the expected "sessions" table',
          affected: [resolve(ctx.syntaurRoot, 'syntaur.db')],
          autoFixable: false,
        } satisfies CheckResult;
      }
      return pass(this);
    } catch (err) {
      return {
        id: this.id,
        category: this.category,
        title: this.title,
        status: 'error',
        detail: `syntaur.db query failed: ${err instanceof Error ? err.message : String(err)}`,
        affected: [resolve(ctx.syntaurRoot, 'syntaur.db')],
        autoFixable: false,
      } satisfies CheckResult;
    }
  },
};

const ghostSessions: Check = {
  id: 'dashboard.ghost-sessions',
  category: CATEGORY,
  title: 'Session records reference tickets that still exist on disk',
  async run(ctx) {
    if (!ctx.db) {
      return skipped(this, 'skipped: db not reachable');
    }
    let rows: Array<{ session_id: string; ticket_id: string | null }>;
    try {
      rows = ctx.db
        .prepare(
          `SELECT DISTINCT session_id, ticket_id
             FROM engagement
            WHERE ticket_id IS NOT NULL AND ticket_id != ''`,
        )
        .all() as typeof rows;
    } catch {
      return skipped(this, 'skipped: engagement table unreadable');
    }

    const projectsDir = ctx.config.defaultProjectDir;
    const { resolveTicketById } = await import('../../ticket-resolver.js');
    const results: CheckResult[] = [];
    for (const row of rows) {
      if (!row.ticket_id) continue;
      const resolved = await resolveTicketById(projectsDir, row.ticket_id);
      if (!resolved) {
        results.push({
          id: this.id,
          category: this.category,
          title: this.title,
          status: 'warn',
          detail: `session ${row.session_id} references missing ticket "${row.ticket_id}"`,
          affected: [],
          remediation: {
            kind: 'manual',
            suggestion: 'Remove the session row or restore the ticket folder',
            command: null,
          },
          autoFixable: false,
        });
      }
    }
    if (results.length === 0) return pass(this);
    return results;
  },
};

export const dashboardChecks: Check[] = [dbReachable, ghostSessions];

function pass(check: { id: string; category: string; title: string }): CheckResult {
  return {
    id: check.id,
    category: check.category,
    title: check.title,
    status: 'pass',
    autoFixable: false,
  };
}

function skipped(check: { id: string; category: string; title: string }, reason: string): CheckResult {
  return {
    id: check.id,
    category: check.category,
    title: check.title,
    status: 'skipped',
    detail: reason,
    autoFixable: false,
  };
}

