import React, { createContext, useContext, useEffect, useMemo } from 'react';
import { useStdin, useStdout } from 'ink';
import { HitRegistry } from './registry.js';
import { MouseParser } from './parse.js';
import { enableMouseTracking, disableMouseTracking } from './tracking.js';

const MouseCtx = createContext<HitRegistry | null>(null);

export function useHitRegistry(): HitRegistry {
  const r = useContext(MouseCtx);
  if (!r) throw new Error('useHitRegistry must be used inside <MouseProvider>');
  return r;
}

export const MouseProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const registry = useMemo(() => new HitRegistry(), []);
  const { stdin, setRawMode, isRawModeSupported } = useStdin();
  const { write } = useStdout();

  useEffect(() => {
    if (!isRawModeSupported || !stdin) return; // no TTY -> keyboard-only
    setRawMode(true);
    enableMouseTracking(write);
    const parser = new MouseParser();
    const onData = (data: Buffer | string) => {
      const chunk = typeof data === 'string' ? data : data.toString('utf8');
      for (const evt of parser.push(chunk)) registry.dispatch(evt);
    };
    stdin.on('data', onData);
    return () => {
      stdin.off('data', onData);
      disableMouseTracking(write);
      setRawMode(false);
    };
  }, [stdin, setRawMode, isRawModeSupported, write, registry]);

  return <MouseCtx.Provider value={registry}>{children}</MouseCtx.Provider>;
};
