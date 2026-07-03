export type MouseButton = 'left' | 'middle' | 'right' | 'none';
export type MouseAction = 'down' | 'up' | 'move' | 'scroll-up' | 'scroll-down';
export interface MouseEvent {
  x: number;
  y: number;
  button: MouseButton;
  action: MouseAction;
}

// SGR 1006: ESC [ < Cb ; Cx ; Cy (M|m). M=press/motion, m=release. 1-indexed coords.
const SGR_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const WHEEL_BIT = 64; // bit 6 -> wheel/scroll
const MOTION_BIT = 32; // bit 5 -> drag/motion
const BUTTON_MASK = 0b11;
const MOUSE_PREFIX = '\x1b[<';

// A trailing fragment that is a prefix of a valid SGR mouse sequence (no
// terminator yet). Anchored so `\x1b[A` (arrow) and other escapes do NOT match.
const PARTIAL_MOUSE_RE = /^\x1b(\[(<\d*(;\d*(;\d*)?)?)?)?$/;

export function isMouseSequence(input: string): boolean {
  return input.includes(MOUSE_PREFIX);
}

function buttonOf(cb: number): MouseButton {
  switch (cb & BUTTON_MASK) {
    case 0: return 'left';
    case 1: return 'middle';
    case 2: return 'right';
    default: return 'none';
  }
}

function toEvent(cb: number, x1: number, y1: number, terminator: string): MouseEvent {
  const x = x1 - 1;
  const y = y1 - 1;
  if ((cb & WHEEL_BIT) !== 0) {
    return { x, y, button: 'none', action: (cb & 1) === 0 ? 'scroll-up' : 'scroll-down' };
  }
  if ((cb & MOTION_BIT) !== 0) {
    return { x, y, button: buttonOf(cb), action: 'move' };
  }
  return { x, y, button: buttonOf(cb), action: terminator === 'm' ? 'up' : 'down' };
}

export class MouseParser {
  private carry = '';

  push(chunk: string): MouseEvent[] {
    const data = this.carry + chunk;
    this.carry = '';
    const out: MouseEvent[] = [];
    SGR_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let end = 0;
    while ((m = SGR_RE.exec(data)) !== null) {
      out.push(toEvent(Number(m[1]), Number(m[2]), Number(m[3]), m[4]));
      end = SGR_RE.lastIndex;
    }
    // Hold a trailing PARTIAL mouse sequence for the next chunk. Match only a
    // valid mouse-sequence prefix (ESC, ESC[, ESC[<, ESC[<Cb;Cx;Cy...) so we
    // never swallow a completed non-mouse escape like an arrow key (ESC[A).
    const tail = data.slice(end);
    const esc = tail.lastIndexOf('\x1b');
    if (esc !== -1) {
      const frag = tail.slice(esc);
      if (PARTIAL_MOUSE_RE.test(frag)) this.carry = frag;
    }
    return out;
  }
}
