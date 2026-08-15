import { useMemo } from 'react';

/**
 * Runs a model-written HTML document in an isolated frame.
 *
 * The sandbox attribute deliberately omits `allow-same-origin`. Without it the
 * frame gets an opaque origin, and that single omission is what makes this safe:
 * the console authenticates with an HttpOnly session cookie, and HttpOnly stops
 * scripts *reading* the cookie, not the browser *attaching* it to a request. A
 * same-origin frame could therefore call `fetch('/api/keys', {method:'POST'})`
 * and mint itself a key with the signed-in user's rights. From an opaque origin
 * that request is cross-origin, the CORS allow-list does not contain `null`, and
 * cookies are not sent anyway.
 *
 * Never add `allow-same-origin` here. It is not a convenience flag; it removes
 * the whole boundary.
 */

/**
 * Content-Security-Policy injected into every preview.
 *
 * `default-src 'none'` is what stops generated code phoning home -- an
 * `<img src="http://host/?d=...">` or a `fetch()` to the open internet is an
 * exfiltration channel, and this machine sits on a private network. The cost is
 * that previews cannot load remote images, fonts or CDN scripts; anything the
 * model wants has to be inline or a data: URI.
 *
 * `unsafe-eval` is allowed because a fair amount of generated code builds
 * functions at runtime, and with no network and an opaque origin it grants
 * nothing that inline script does not already have.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
].join('; ');

const META = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;

/** A dark ground, so a preview that sets no background is not a white flash. */
const BASE = `<style>
  html, body { margin: 0; padding: 0; }
  body { background: #ffffff; color: #111; font: 14px/1.5 system-ui, sans-serif; padding: 12px; }
</style>`;

/**
 * Wrap the model's source in a complete document.
 *
 * Output comes in two shapes: a whole document starting at <!DOCTYPE or <html,
 * or a bare fragment. A fragment can simply be dropped into a shell, but a whole
 * document already has its own <head>, and nesting it inside another one
 * produces markup the parser silently discards -- so the policy is spliced into
 * the document it already has instead.
 */
function buildDocument(source: string, language: string): string {
  if (language === 'svg') {
    return `<!doctype html><html><head>${META}${BASE}</head><body>${source}</body></html>`;
  }

  const whole = /<html[\s>]/i.test(source) || /<!doctype\s+html/i.test(source);
  if (!whole) {
    return `<!doctype html><html><head>${META}${BASE}</head><body>${source}</body></html>`;
  }

  // Splice the meta in as early as the document allows: a CSP delivered after a
  // resource has already been requested does not apply to it.
  if (/<head[^>]*>/i.test(source)) {
    return source.replace(/<head[^>]*>/i, (m) => `${m}${META}`);
  }
  if (/<html[^>]*>/i.test(source)) {
    return source.replace(/<html[^>]*>/i, (m) => `${m}<head>${META}</head>`);
  }
  return `${META}${source}`;
}

interface Props {
  source: string;
  language: string;
  /** Bumped by the run button; used as the frame key to force a fresh document. */
  runId: number;
}

export default function HtmlPreview({ source, language, runId }: Props) {
  const doc = useMemo(() => buildDocument(source, language), [source, language]);

  return (
    <div className="md-preview">
      <iframe
        key={runId}
        className="md-preview-frame"
        srcDoc={doc}
        // allow-scripts runs the code; allow-modals lets alert/confirm work,
        // which a lot of generated demos rely on. allow-same-origin is absent by
        // design -- see the note at the top of this file.
        sandbox="allow-scripts allow-modals"
        referrerPolicy="no-referrer"
        title="預覽"
      />
    </div>
  );
}
