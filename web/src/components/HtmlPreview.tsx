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
 * This used to be `default-src 'none'`, which blocked every remote image, web
 * font and CDN script -- so a page that asked for Chart.js, or Google Fonts, or
 * a placeholder photo, rendered as a broken skeleton with nothing on screen
 * saying why. That is most generated front-end code.
 *
 * What it was buying was not what it looked like it was buying. The boundary
 * here has never been the CSP: it is the missing `allow-same-origin` on the
 * sandbox, which puts this document on an opaque origin with no cookies, no
 * storage, and no reach into the console that framed it. And `unsafe-inline`
 * plus `unsafe-eval` were already granted, so arbitrary script was always going
 * to run -- letting it arrive from a CDN adds a network request, not a
 * capability.
 *
 * So what a strict policy actually cost was the feature, and what it bought was
 * narrower than it appeared: a page could still not read anything of yours, only
 * announce to a remote host that it had been opened. That is a real if small
 * privacy leak, and it is the price of previews that work.
 *
 * The three restrictions kept are the ones no legitimate page needs:
 *
 *   object-src 'none'   no Flash/PDF plugin surfaces
 *   base-uri 'none'     a <base> tag cannot silently repoint every relative URL
 *   form-action 'none'  a form cannot POST what you typed to a remote host,
 *                       which is the one exfiltration route that carries
 *                       something you did not already have
 *
 * upgrade-insecure-requests is there because the console is served over TLS, so
 * an http:// subresource would be blocked as mixed content no matter what this
 * policy said. Upgrading is the difference between an image loading and an
 * error nobody can act on.
 */
const CSP = [
  "default-src https: data: blob:",
  "script-src 'unsafe-inline' 'unsafe-eval' https: data: blob:",
  "style-src 'unsafe-inline' https: data:",
  "img-src https: data: blob:",
  "font-src https: data:",
  "media-src https: data: blob:",
  "connect-src https: data: blob:",
  "frame-src https: data: blob:",
  "worker-src blob: data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  'upgrade-insecure-requests',
].join('; ');

const META = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;

/**
 * In-memory stand-ins for the storage APIs.
 *
 * An opaque origin has no storage, and reading `window.localStorage` there does
 * not return null -- it throws SecurityError. Generated code reaches for it at
 * the top of a script often enough that this is not an edge case: one
 * `localStorage.getItem('highScore')` in a variable declaration throws before a
 * single event listener is registered, and the whole page renders perfectly
 * while responding to nothing. That failure looks like "the JS is broken"
 * rather than like a permission error, which is what makes it worth shimming.
 *
 * Values live for as long as the frame does, so a re-run starts clean. That is
 * the honest behaviour for a preview: it is a scratch document, not a saved one.
 */
const STORAGE_SHIM = `<script>(function(){
  function memory(){
    var data = Object.create(null);
    return {
      getItem: function(k){ k = String(k);
        return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
      setItem: function(k, v){ data[String(k)] = String(v); },
      removeItem: function(k){ delete data[String(k)]; },
      clear: function(){ data = Object.create(null); },
      key: function(i){ var keys = Object.keys(data); return i < keys.length ? keys[i] : null; },
      get length(){ return Object.keys(data).length; }
    };
  }
  ['localStorage', 'sessionStorage'].forEach(function(name){
    var usable = false;
    try { var s = window[name]; s.getItem('__probe'); usable = true; } catch (e) { usable = false; }
    if (!usable) {
      try { Object.defineProperty(window, name, { value: memory(), configurable: true }); } catch (e) {}
    }
  });
  // document.cookie throws in an opaque origin too, and a script that sets one
  // on load would die the same way.
  try { void document.cookie; } catch (e) {
    var jar = '';
    try {
      Object.defineProperty(document, 'cookie', {
        configurable: true,
        get: function(){ return jar; },
        set: function(v){ jar = jar ? jar + '; ' + v : String(v); }
      });
    } catch (e2) {}
  }
})();<\/script>`;

/** A light ground, so a preview that sets no background is not a dark void. */
const BASE = `<style>
  html, body { margin: 0; padding: 0; }
  body { background: #ffffff; color: #111; font: 14px/1.5 system-ui, sans-serif; padding: 12px; }
</style>`;

/**
 * Everything injected ahead of the model's own markup, in order.
 *
 * The charset comes first and is ours rather than the document's. A page's own
 * `<meta charset>` only counts inside the first 1024 bytes, and the shim is
 * long enough to push an existing one past that line -- which on a page of
 * Chinese text is the difference between a preview and a screen of mojibake.
 * A second charset later in the document is harmless; the first one wins.
 */
const PREAMBLE = `<meta charset="utf-8">${META}${STORAGE_SHIM}`;

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
    return `<!doctype html><html><head>${PREAMBLE}${BASE}</head><body>${source}</body></html>`;
  }

  const whole = /<html[\s>]/i.test(source) || /<!doctype\s+html/i.test(source);
  if (!whole) {
    return `<!doctype html><html><head>${PREAMBLE}${BASE}</head><body>${source}</body></html>`;
  }

  // Spliced in as early as the document allows, for two reasons: a CSP delivered
  // after a resource has been requested does not apply to it, and the shim has
  // to be in place before the document's own scripts run.
  if (/<head[^>]*>/i.test(source)) {
    return source.replace(/<head[^>]*>/i, (m) => `${m}${PREAMBLE}`);
  }
  if (/<html[^>]*>/i.test(source)) {
    return source.replace(/<html[^>]*>/i, (m) => `${m}<head>${PREAMBLE}</head>`);
  }
  return `${PREAMBLE}${source}`;
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
    <iframe
      key={runId}
      className="md-preview-frame"
      srcDoc={doc}
      // allow-scripts runs the code and allow-modals lets alert/confirm work,
      // which a lot of generated demos rely on.
      //
      // allow-forms is here because without it the browser refuses the
      // submission outright, which breaks the ordinary demo that has a form and
      // handles it in JavaScript. Nothing is given away by it: form-action
      // 'none' in the policy above already stops a form reaching any host.
      //
      // allow-popups so that target="_blank" links open, and allow-downloads so
      // a page that generates a file can hand it over.
      //
      // Two are deliberately absent. allow-same-origin would remove the whole
      // boundary -- see the note at the top of this file. And
      // allow-popups-to-escape-sandbox would let a window opened from here be
      // an ordinary page again, which is the same hole through a side door.
      sandbox="allow-scripts allow-modals allow-forms allow-popups allow-downloads"
      referrerPolicy="no-referrer"
      title="預覽"
    />
  );
}
