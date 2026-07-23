// xterm.js pane for browser attach (Phase D). Two modes:
//  - live: open a per-session pty WebSocket (short + freshly-minted token),
//    restore the snapshot, stream output, and — behind the view-only toggle —
//    forward keystrokes and resize.
//  - settled: write a session's final serialized screen once, no socket.
//
// The component itself has no DOM test harness (the dashboard vitest config is
// node-env, no DOM); its transport logic lives in ../lib/terminalSocket.ts,
// which IS unit-tested. This file is covered by the manual verification checklist.

import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { createTerminalSocket, type CloseReason, type HostFrame, type TerminalSocket } from '../lib/terminalSocket';

interface SessionTerminalProps {
  /** Live attach: daemon short id + a freshly minted single-use token. */
  short?: string;
  token?: string;
  /** When true, keystrokes are not forwarded (the bridge also enforces this). */
  viewOnly?: boolean;
  /** Settled mode: render this final screen and open no socket. */
  settledScreen?: string | null;
  /** Dimensions the settled screen was serialized at (serialize omits size, so
   * restoring at a different size would wrap/truncate). */
  settledCols?: number;
  settledRows?: number;
  /** Fired on exit / unavailable / transport loss so the page can refetch. */
  onClose?: (reason: CloseReason) => void;
}

/** Resolve concrete xterm theme colors from the page (xterm rejects oklch(var()) strings). */
function resolveTheme(): { background: string; foreground: string } {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return { background: '#1e1e1e', foreground: '#d4d4d4' };
  }
  const cs = getComputedStyle(document.body);
  return {
    background: cs.backgroundColor || '#1e1e1e',
    foreground: cs.color || '#d4d4d4',
  };
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

export function SessionTerminal({
  short,
  token,
  viewOnly,
  settledScreen,
  settledCols,
  settledRows,
  onClose,
}: SessionTerminalProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const sockRef = useRef<TerminalSocket | null>(null);
  const isLive = Boolean(short && token) && settledScreen == null;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Settled mode: construct at the RECORDED dimensions (serialize omits size,
    // so fitting to the container would wrap/truncate the final screen), write
    // it, and open no socket.
    if (!isLive) {
      const settledTerm = new Terminal({
        cols: settledCols && settledCols > 0 ? settledCols : 80,
        rows: settledRows && settledRows > 0 ? settledRows : 24,
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        fontSize: 13,
        cursorBlink: false,
        scrollback: 5000,
        theme: resolveTheme(),
        disableStdin: true,
      });
      settledTerm.open(container);
      if (settledScreen) settledTerm.write(settledScreen);
      return () => settledTerm.dispose();
    }

    const term = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: resolveTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    try {
      fit.fit();
    } catch {
      /* container not yet measured */
    }

    const sock = createTerminalSocket({
      short: short as string,
      token: token as string,
      cols: term.cols,
      rows: term.rows,
      onFrame: (f: HostFrame) => {
        if (f.t === 'snapshot') term.write(f.data);
        else if (f.t === 'out') term.write(base64ToBytes(f.b));
        else if (f.t === 'exit') term.write(`\r\n[session exited${f.code != null ? ` (${f.code})` : ''}]\r\n`);
      },
      onClose: (reason) => onClose?.(reason),
    });
    sockRef.current = sock;
    if (!viewOnly) sock.takeControl();

    const dataDisp = term.onData((data) => sock.sendStdin(utf8ToBase64(data)));
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        sock.sendResize(term.cols, term.rows);
      } catch {
        /* ignore transient measure errors */
      }
    });
    ro.observe(container);

    return () => {
      dataDisp.dispose();
      ro.disconnect();
      sock.close();
      sockRef.current = null;
      term.dispose();
    };
    // Recreate on a new attach (new token) or a mode switch.
  }, [short, token, isLive, settledScreen, settledCols, settledRows]);

  // Toggle control in place, without tearing the socket down.
  useEffect(() => {
    const sock = sockRef.current;
    if (!sock) return;
    if (viewOnly) sock.releaseControl();
    else sock.takeControl();
  }, [viewOnly]);

  return <div ref={containerRef} className="h-full w-full overflow-hidden" />;
}
