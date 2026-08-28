/**
 * Saving a served file to the device.
 *
 * Chrome honours a link's `download` attribute. Android's WebView does not —
 * it ignores the attribute entirely and simply navigates to the picture, which
 * is why a long-press inside the APK looked like nothing happened. The only
 * signal that reaches the shell's DownloadListener is a `Content-Disposition:
 * attachment` header from the server, so our own file routes take a
 * `?download=1` switch and every save path in the app asks for it.
 *
 * Cross-origin images can't be flagged that way (and their `download`
 * attribute is ignored everywhere), so those open in a tab instead of
 * pretending to save.
 */

function sameOriginSaveUrl(src: string): string | null {
  try {
    const url = new URL(src, window.location.href);
    if (url.origin !== window.location.origin) return null;
    url.searchParams.set('download', '1');
    return url.toString();
  } catch {
    return null;
  }
}

/** An href for a link the owner taps directly (export pills, file chips). */
export function saveHref(src: string): string {
  return sameOriginSaveUrl(src) ?? src;
}

/** Trigger a save from code — long-press, menu action, keyboard shortcut. */
export function saveToDevice(src: string, suggestedName?: string): void {
  const href = sameOriginSaveUrl(src);
  if (!href) {
    window.open(src, '_blank', 'noopener,noreferrer');
    return;
  }
  const a = document.createElement('a');
  a.href = href;
  if (suggestedName) a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
