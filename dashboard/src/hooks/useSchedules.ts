import { useCallback, useEffect, useState } from 'react';
import { useWebSocket } from './useWebSocket';
import { fetchSchedules, type Schedule } from '../lib/schedules';

export function useSchedules() {
  const [data, setData] = useState<Schedule[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      setData(await fetchSchedules());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch schedules');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  // The watcher accelerator + REST mutations both broadcast `schedules-updated`.
  useWebSocket((msg) => {
    if (msg.type === 'schedules-updated') refetch();
  });

  return { data, loading, error, refetch };
}
