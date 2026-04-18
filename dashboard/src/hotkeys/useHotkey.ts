import { useEffect, useRef } from 'react';
import { useHotkeyContext, type HotkeyScope } from './HotkeyProvider';

export interface UseHotkeyOptions {
  keys: string;
  handler: (event: KeyboardEvent) => void;
  scope?: HotkeyScope;
  description: string;
  when?: () => boolean;
  enabled?: boolean;
}

export function useHotkey({
  keys,
  handler,
  scope = 'global',
  description,
  when,
  enabled = true,
}: UseHotkeyOptions): void {
  const { register, unregister } = useHotkeyContext();
  const handlerRef = useRef(handler);
  const whenRef = useRef(when);

  useEffect(() => {
    handlerRef.current = handler;
    whenRef.current = when;
  }, [handler, when]);

  useEffect(() => {
    if (!enabled) return;
    const id = register({
      keys,
      handler: (e) => handlerRef.current(e),
      scope,
      description,
      when: whenRef.current ? () => whenRef.current!() : undefined,
    });
    return () => unregister(id);
  }, [register, unregister, keys, scope, description, enabled]);
}

export function useHotkeyScope(scope: HotkeyScope): void {
  const { pushScope, popScope } = useHotkeyContext();
  useEffect(() => {
    pushScope(scope);
    return () => popScope(scope);
  }, [pushScope, popScope, scope]);
}
