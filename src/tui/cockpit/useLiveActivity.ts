import { useEffect, useRef, useState } from 'react';
import { tailFile } from '../sessions/transcript.js';
import { createTranscriptRenderer } from '../transcript-render/index.js';
import type { AgentSessionWithLiveness } from '../../dashboard/types.js';

interface Watcher {
  stop(): void;
}

/**
 * Tails every LIVE session's transcript (not just the selected one) purely
 * to extract `TranscriptRenderer.lastActivity()` — the rich "editing
 * DetailPane.tsx" / "running npm test" phrase design spec §5.2 shows per
 * rail row. Without this, `lastActivity()` (built in task 1) has no caller
 * outside its own tests and the rail can only ever show the coarse
 * working/idle/⚠ state. Width is fixed since activity phrases never wrap.
 */
const ACTIVITY_RENDER_WIDTH = 80;

export function useLiveActivity(sessions: AgentSessionWithLiveness[]): Map<string, string> {
  const [activity, setActivity] = useState<Map<string, string>>(new Map());
  const watchersRef = useRef<Map<string, Watcher>>(new Map());

  useEffect(() => {
    const watchers = watchersRef.current;
    const liveIds = new Set<string>();

    for (const s of sessions) {
      if (!s.isLive || !s.transcriptPath) continue;
      liveIds.add(s.sessionId);
      if (watchers.has(s.sessionId)) continue;

      const renderer = createTranscriptRenderer({ width: ACTIVITY_RENDER_WIDTH });
      const handle = tailFile({
        path: s.transcriptPath,
        onLines: (lines) => {
          renderer.push(lines);
          const text = renderer.lastActivity();
          if (!text) return;
          setActivity((prev) => {
            if (prev.get(s.sessionId) === text) return prev;
            const next = new Map(prev);
            next.set(s.sessionId, text);
            return next;
          });
        },
      });
      watchers.set(s.sessionId, { stop: () => handle.stop() });
    }

    for (const [id, watcher] of watchers) {
      if (liveIds.has(id)) continue;
      watcher.stop();
      watchers.delete(id);
      setActivity((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    }
  }, [sessions]);

  // Unmount cleanup — stop every remaining watcher exactly once.
  useEffect(() => () => {
    for (const watcher of watchersRef.current.values()) watcher.stop();
    watchersRef.current.clear();
  }, []);

  return activity;
}
