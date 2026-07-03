import React, { createContext, useContext, useEffect, useMemo } from 'react';
import type { EventEmitter } from 'node:events';
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

// Ink runs stdin through its OWN input parser and re-emits each parsed chunk as
// a string on an internal EventEmitter (App.js `emitInput` ->
// `internal_eventEmitter.emit('input', input)`) — the exact channel `useInput`
// subscribes to. Riding that single read path is mandatory: attaching a second
// `stdin.on('data')` listener flips stdin into flowing mode and competes with
// Ink's `readable`+`read()` consumer on the same TTY, so one starves the other.
// The emitter lives on the StdinContext value at runtime but is intentionally
// kept off the public `useStdin()` type (`PublicProps`), so we read it through
// a narrow cast. Ink's parser delivers a complete SGR mouse sequence (final
// byte `M`/`m`) as one whole string — verified: it never splits or drops it.
type InkStdinInternal = { internal_eventEmitter?: EventEmitter };

export const MouseProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const registry = useMemo(() => new HitRegistry(), []);
  const stdinCtx = useStdin();
  const { stdin, setRawMode, isRawModeSupported } = stdinCtx;
  const emitter = (stdinCtx as unknown as InkStdinInternal).internal_eventEmitter;
  const { write } = useStdout();

  useEffect(() => {
    if (!isRawModeSupported || !stdin || !emitter) return; // no TTY -> keyboard-only
    setRawMode(true);
    enableMouseTracking(write);
    const parser = new MouseParser();
    const onInput = (chunk: string) => {
      // Ink's emitter delivers strings only (no Buffer branch needed).
      for (const evt of parser.push(chunk)) registry.dispatch(evt);
    };
    emitter.on('input', onInput);
    return () => {
      emitter.off('input', onInput);
      disableMouseTracking(write);
      setRawMode(false);
    };
  }, [stdin, emitter, setRawMode, isRawModeSupported, write, registry]);

  return <MouseCtx.Provider value={registry}>{children}</MouseCtx.Provider>;
};
