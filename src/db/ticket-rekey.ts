import type Database from 'better-sqlite3';
import { openWalDatabase } from './open-sqlite.js';

export interface TicketRekeyParams {
  oldId: string;
  newId: string;
  oldProjectSlug: string;
  newProjectSlug: string;
}

export interface TicketRekeyCounts {
  events: number;
  eventsSourceKey: number;
  engagement: number;
  chatSessionsTicket: number;
  chatSessionsKey: number;
  chatItemsDeleted: number;
  usageEvents: number;
  usageDaily: number;
  usageDailyMerged: number;
}

const USAGE_DAILY_SUM_COLS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_tokens',
  'cache_read_tokens',
  'total_tokens',
  'total_cost',
] as const;

function tableColumns(database: Database.Database, table: string): Set<string> {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function rewriteTicketSourceKey(sourceKey: string, oldId: string, newId: string): string | null {
  if (sourceKey === `migrate~${oldId}~archived`) {
    return `migrate~${newId}~archived`;
  }
  for (const prefix of ['backfill~', 'log~', 'migrate~']) {
    const head = `${prefix}${oldId}~`;
    if (sourceKey.startsWith(head)) {
      return `${prefix}${newId}~${sourceKey.slice(head.length)}`;
    }
  }
  if (sourceKey.includes(`~${oldId}~`)) {
    return sourceKey.replaceAll(`~${oldId}~`, `~${newId}~`);
  }
  return null;
}

function rewriteSessionKey(sessionKey: string, oldId: string, newId: string): string {
  if (sessionKey.startsWith(`${oldId}~`)) {
    return `${newId}~${sessionKey.slice(oldId.length + 1)}`;
  }
  return sessionKey;
}

function mergeUsageDailyRows(
  database: Database.Database,
  cols: Set<string>,
  ticketCol: string,
  targetTicket: string,
  sourceTicket: string,
  day: string,
  tool: string,
  model: string,
  projectSlug: string,
): void {
  const source = database
    .prepare(
      `SELECT * FROM usage_daily WHERE day = ? AND tool = ? AND model = ? AND project_slug = ? AND ${ticketCol} = ?`,
    )
    .get(day, tool, model, projectSlug, sourceTicket) as Record<string, number | string> | undefined;
  if (!source) return;

  const sumParts: string[] = [];
  const params: Record<string, number | string> = {
    day,
    tool,
    model,
    project_slug: projectSlug,
    target_ticket: targetTicket,
    source_ticket: sourceTicket,
  };
  for (const col of USAGE_DAILY_SUM_COLS) {
    if (!cols.has(col)) continue;
    sumParts.push(`${col} = ${col} + @src_${col}`);
    params[`src_${col}`] = source[col] as number;
  }
  if (cols.has('frozen')) {
    sumParts.push('frozen = MAX(frozen, @src_frozen)');
    params.src_frozen = source.frozen as number;
  }
  const tsCol = cols.has('computed_at') ? 'computed_at' : null;
  if (tsCol) {
    sumParts.push(
      `${tsCol} = CASE WHEN ${tsCol} > @src_${tsCol} THEN ${tsCol} ELSE @src_${tsCol} END`,
    );
    params[`src_${tsCol}`] = source[tsCol] as string;
  }

  database
    .prepare(
      `UPDATE usage_daily SET ${sumParts.join(', ')}
       WHERE day = @day AND tool = @tool AND model = @model AND project_slug = @project_slug AND ${ticketCol} = @target_ticket`,
    )
    .run(params);

  database
    .prepare(
      `DELETE FROM usage_daily WHERE day = @day AND tool = @tool AND model = @model AND project_slug = @project_slug AND ${ticketCol} = @source_ticket`,
    )
    .run(params);
}

export function rekeyTicket(dbPath: string, params: TicketRekeyParams): TicketRekeyCounts {
  const { oldId, newId, oldProjectSlug, newProjectSlug } = params;
  const database = openWalDatabase(dbPath);
  const counts: TicketRekeyCounts = {
    events: 0,
    eventsSourceKey: 0,
    engagement: 0,
    chatSessionsTicket: 0,
    chatSessionsKey: 0,
    chatItemsDeleted: 0,
    usageEvents: 0,
    usageDaily: 0,
    usageDailyMerged: 0,
  };

  database.exec('BEGIN IMMEDIATE');
  try {
    const eventsCols = tableColumns(database, 'events');
    const ticketCol = eventsCols.has('ticket_id') ? 'ticket_id' : 'assignment_id';
    if (eventsCols.has(ticketCol)) {
      counts.events += database
        .prepare(`UPDATE events SET ${ticketCol} = ? WHERE ${ticketCol} = ?`)
        .run(newId, oldId).changes;
      if (eventsCols.has('source_key')) {
        const rows = database
          .prepare('SELECT source_key FROM events WHERE source_key IS NOT NULL')
          .all() as Array<{ source_key: string }>;
        for (const row of rows) {
          const next = rewriteTicketSourceKey(row.source_key, oldId, newId);
          if (next && next !== row.source_key) {
            counts.eventsSourceKey += database
              .prepare('UPDATE events SET source_key = ? WHERE source_key = ?')
              .run(next, row.source_key).changes;
          }
        }
      }
    }

    const engagementCols = tableColumns(database, 'engagement');
    const engTicketCol = engagementCols.has('ticket_id') ? 'ticket_id' : 'assignment_id';
    if (engagementCols.has(engTicketCol)) {
      counts.engagement += database
        .prepare(
          `UPDATE engagement SET ${engTicketCol} = ? WHERE ${engTicketCol} = ? AND ${engTicketCol} IS NOT NULL AND ${engTicketCol} != ''`,
        )
        .run(newId, oldId).changes;
    }

    const chatSessionCols = tableColumns(database, 'chat_sessions');
    const chatTicketCol = chatSessionCols.has('ticket_id') ? 'ticket_id' : 'assignment_id';
    if (chatSessionCols.has(chatTicketCol)) {
      counts.chatSessionsTicket += database
        .prepare(`UPDATE chat_sessions SET ${chatTicketCol} = ? WHERE ${chatTicketCol} = ?`)
        .run(newId, oldId).changes;
      const sessions = database
        .prepare('SELECT session_key FROM chat_sessions')
        .all() as Array<{ session_key: string }>;
      for (const row of sessions) {
        const next = rewriteSessionKey(row.session_key, oldId, newId);
        if (next !== row.session_key) {
          counts.chatSessionsKey += database
            .prepare('UPDATE chat_sessions SET session_key = ? WHERE session_key = ?')
            .run(next, row.session_key).changes;
        }
      }
    }

    const chatItemCols = tableColumns(database, 'chat_items');
    const chatItemTicketCol = chatItemCols.has('ticket_id') ? 'ticket_id' : 'assignment_id';
    if (chatItemCols.has(chatItemTicketCol)) {
      counts.chatItemsDeleted += database
        .prepare(`DELETE FROM chat_items WHERE ${chatItemTicketCol} = ?`)
        .run(oldId).changes;
    }

    const usageEventCols = tableColumns(database, 'usage_events');
    const usageTicketCol = usageEventCols.has('ticket_id')
      ? 'ticket_id'
      : usageEventCols.has('assignment_slug')
        ? 'assignment_slug'
        : null;
    if (usageTicketCol && usageEventCols.has('project_slug')) {
      counts.usageEvents += database
        .prepare(
          `UPDATE usage_events SET ${usageTicketCol} = ?, project_slug = CASE WHEN project_slug = ? THEN ? ELSE project_slug END WHERE ${usageTicketCol} = ?`,
        )
        .run(newId, oldProjectSlug, newProjectSlug, oldId).changes;
    }

    const usageDailyCols = tableColumns(database, 'usage_daily');
    const dailyTicketCol = usageDailyCols.has('ticket_id')
      ? 'ticket_id'
      : usageDailyCols.has('assignment_slug')
        ? 'assignment_slug'
        : null;
    if (dailyTicketCol && usageDailyCols.has('project_slug')) {
      const sources = database
        .prepare(`SELECT day, tool, model, project_slug FROM usage_daily WHERE ${dailyTicketCol} = ?`)
        .all(oldId) as Array<{
        day: string;
        tool: string;
        model: string;
        project_slug: string;
      }>;
      for (const source of sources) {
        const collision = database
          .prepare(
            `SELECT 1 AS ok FROM usage_daily WHERE day = ? AND tool = ? AND model = ? AND project_slug = ? AND ${dailyTicketCol} = ?`,
          )
          .get(source.day, source.tool, source.model, source.project_slug, newId) as
          | { ok: number }
          | undefined;
        if (collision) {
          mergeUsageDailyRows(
            database,
            usageDailyCols,
            dailyTicketCol,
            newId,
            oldId,
            source.day,
            source.tool,
            source.model,
            source.project_slug,
          );
          if (source.project_slug === oldProjectSlug) {
            database
              .prepare(
                `UPDATE usage_daily SET project_slug = ? WHERE day = ? AND tool = ? AND model = ? AND project_slug = ? AND ${dailyTicketCol} = ?`,
              )
              .run(
                newProjectSlug,
                source.day,
                source.tool,
                source.model,
                oldProjectSlug,
                newId,
              );
          }
          counts.usageDailyMerged += 1;
          counts.usageDaily += 1;
        } else {
          counts.usageDaily += database
            .prepare(
              `UPDATE usage_daily SET ${dailyTicketCol} = ?, project_slug = CASE WHEN project_slug = ? THEN ? ELSE project_slug END WHERE day = ? AND tool = ? AND model = ? AND project_slug = ? AND ${dailyTicketCol} = ?`,
            )
            .run(
              newId,
              oldProjectSlug,
              newProjectSlug,
              source.day,
              source.tool,
              source.model,
              source.project_slug,
              oldId,
            ).changes;
        }
      }
    }

    database.exec('COMMIT');
  } catch (err) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // ignore
    }
    throw err;
  } finally {
    database.close();
  }

  return counts;
}
