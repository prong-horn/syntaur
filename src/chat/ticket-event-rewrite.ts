function rewriteTicketString(value: string, oldId: string, newId: string): string {
  let out = value;
  if (out.startsWith(`session~${oldId}~`)) {
    out = `session~${newId}~${out.slice(`session~${oldId}~`.length)}`;
  }
  if (out.startsWith(`${oldId}~`)) {
    out = `${newId}~${out.slice(oldId.length + 1)}`;
  }
  out = out.replaceAll(`~${oldId}~`, `~${newId}~`);
  return out;
}

function rewriteJsonValue(value: unknown, oldId: string, newId: string): unknown {
  if (typeof value === 'string') {
    return rewriteTicketString(value, oldId, newId);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteJsonValue(entry, oldId, newId));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = rewriteJsonValue(v, oldId, newId);
    }
    return out;
  }
  return value;
}

/** Rewrite ticket-scoped ids inside one `chat/events.jsonl` record. */
export function rewriteChatEventLineForTicket(
  line: string,
  oldId: string,
  newId: string,
): string {
  if (!line.trim()) return line;
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (typeof event.ticketId === 'string') {
      event.ticketId = event.ticketId === oldId ? newId : rewriteTicketString(event.ticketId, oldId, newId);
    }
    if (typeof event.sessionKey === 'string') {
      event.sessionKey = rewriteTicketString(event.sessionKey, oldId, newId);
    }
    for (const key of Object.keys(event)) {
      event[key] = rewriteJsonValue(event[key], oldId, newId);
    }
    return `${JSON.stringify(event)}\n`;
  } catch {
    return line.endsWith('\n') ? line : `${line}\n`;
  }
}
