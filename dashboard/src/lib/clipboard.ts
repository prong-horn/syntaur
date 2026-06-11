/**
 * Copy plain text to the clipboard with a legacy fallback.
 *
 * Prefers the async Clipboard API (`navigator.clipboard.writeText`), which is
 * only available in secure contexts (https or localhost). When that's missing
 * (e.g. the dashboard is reached over http via a LAN IP) or the write is
 * rejected, falls back to the deprecated `document.execCommand('copy')`, which
 * still works in insecure contexts and synchronous gestures.
 *
 * Returns `true` if the text was copied, `false` if every path failed — callers
 * should gate their "copied" UI on the result rather than assuming success.
 *
 * NOTE: this is for *synchronous* copies (the value is already in hand). Copies
 * that must `await` a fetch before writing lose the click's user activation and
 * need the `ClipboardItem`-with-a-promise pattern instead — see
 * `CopyLaunchCommandButton`.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through: the API exists but the write was blocked (lost
      // activation, denied permission, etc.). Try the legacy path.
    }
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    // Keep it out of view and out of the layout/scroll flow.
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '0';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}
