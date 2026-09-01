/**
 * A read-only CodeMirror 6 view, for looking at a file rather than editing it.
 *
 * The preview used to render text through the chat's markdown renderer, wrapped
 * in a fence so highlight.js would colour it. That works for a paragraph and
 * falls apart on a file: no line numbers to refer to, no way to search inside,
 * the whole thing laid out at once so a 256 KiB config janks while it paints,
 * and long lines wrapped or clipped with no say in the matter.
 *
 * CodeMirror only builds the lines that are on screen, which is what makes the
 * size cap in `peek` a formatting decision instead of a performance one, and it
 * brings its own find-in-file. Editing is deliberately absent: this panel reads
 * from /api/fs/peek, which serves a truncated prefix, and an editor over a
 * prefix would invite saving one back.
 */
import { useEffect, useMemo, useRef } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  HighlightStyle, syntaxHighlighting, bracketMatching,
  foldGutter, foldKeymap, indentOnInput, StreamLanguage,
} from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches, search } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { sql } from '@codemirror/lang-sql';
import { cpp } from '@codemirror/lang-cpp';
import { rust } from '@codemirror/lang-rust';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { nginx } from '@codemirror/legacy-modes/mode/nginx';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { LINE, MONO } from '../theme';

/** Extension for a file suffix, or nothing when we have no parser for it.
 *
 *  Keyed on the suffix because that is what /api/fs/peek reports -- it does not
 *  sniff content, and a name is the only thing available before the bytes are. */
function languageFor(suffix: string): Extension | null {
  switch (suffix.toLowerCase()) {
    case 'js': case 'mjs': case 'cjs': case 'jsx':
      return javascript({ jsx: true });
    case 'ts': case 'mts': case 'cts':
      return javascript({ typescript: true });
    case 'tsx':
      return javascript({ typescript: true, jsx: true });
    case 'py': case 'pyi':
      return python();
    case 'json': case 'jsonl': case 'ipynb':
      return json();
    case 'md': case 'markdown':
      return markdown();
    case 'yaml': case 'yml':
      return yaml();
    case 'html': case 'htm': case 'xml': case 'svg':
      return html();
    case 'css': case 'scss': case 'less':
      return css();
    case 'sql':
      return sql();
    case 'c': case 'h': case 'cpp': case 'cc': case 'hpp': case 'cu':
      return cpp();
    case 'rs':
      return rust();
    case 'sh': case 'bash': case 'zsh': case 'env':
      return StreamLanguage.define(shell);
    case 'toml':
      return StreamLanguage.define(toml);
    case 'dockerfile':
      return StreamLanguage.define(dockerFile);
    case 'conf': case 'caddy': case 'nginx':
      return StreamLanguage.define(nginx);
    case 'ini': case 'cfg': case 'properties':
      return StreamLanguage.define(properties);
    default:
      return null;
  }
}

/* The console's own palette rather than one of CodeMirror's themes, so a file
 * and a fenced block in chat colour the same tokens the same way. Hues follow
 * the highlight.js rules already in index.css; the two are meant to match. */
const highlightStyle = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#6b7280', fontStyle: 'italic' },
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: '#c792ea' },
  { tag: [t.string, t.special(t.string)], color: '#c3e88d' },
  { tag: [t.number, t.bool, t.null], color: '#f78c6c' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#82aaff' },
  { tag: [t.typeName, t.className, t.namespace], color: '#ffcb6b' },
  { tag: [t.propertyName, t.attributeName], color: '#80cbc4' },
  { tag: [t.operator, t.punctuation, t.separator], color: '#89ddff' },
  { tag: [t.tagName], color: '#f07178' },
  { tag: [t.heading], color: '#82aaff', fontWeight: '600' },
  { tag: [t.link, t.url], color: '#80cbc4', textDecoration: 'underline' },
  { tag: [t.invalid], color: '#ff5370' },
]);

const theme = EditorView.theme({
  '&': { fontSize: '12px', backgroundColor: 'transparent', height: '100%' },
  '.cm-scroller': { fontFamily: MONO, lineHeight: '1.55', overflow: 'auto' },
  '.cm-content': { caretColor: 'transparent' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    borderRight: `1px solid ${LINE.faint}`,
    color: 'rgba(255,255,255,0.25)',
  },
  '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.03)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'rgba(255,255,255,0.5)' },
  '.cm-selectionBackground, ::selection': { backgroundColor: 'rgba(130,170,255,0.25)' },
  '.cm-selectionMatch': { backgroundColor: 'rgba(255,203,107,0.18)' },
  // The find panel is CodeMirror's own markup, so it needs dressing to sit in
  // an antd surface rather than looking like a second application.
  '.cm-panels': { backgroundColor: '#141414', borderTop: `1px solid ${LINE.faint}` },
  '.cm-panel input, .cm-panel button': {
    fontFamily: MONO, fontSize: '11px', backgroundColor: '#1f1f1f',
    color: 'rgba(255,255,255,0.85)', border: `1px solid ${LINE.soft}`, borderRadius: 3,
  },
  '.cm-searchMatch': { backgroundColor: 'rgba(255,203,107,0.25)' },
  '.cm-searchMatch-selected': { backgroundColor: 'rgba(255,203,107,0.5)' },
}, { dark: true });

export default function CodeView(
  { text, suffix, wrap = false }: { text: string; suffix: string; wrap?: boolean },
) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);

  const extensions = useMemo(() => {
    const list: Extension[] = [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      foldGutter(),
      bracketMatching(),
      indentOnInput(),
      history(),
      search({ top: true }),
      highlightSelectionMatches(),
      syntaxHighlighting(highlightStyle),
      theme,
      // Read-only rather than merely non-editable: editable:false alone still
      // leaves the document mutable through the API, and this panel is showing
      // a truncated prefix that must never look like something to save.
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap]),
    ];
    if (wrap) list.push(EditorView.lineWrapping);
    const lang = languageFor(suffix);
    if (lang) list.push(lang);
    return list;
  }, [suffix, wrap]);

  useEffect(() => {
    if (!host.current) return undefined;
    const instance = new EditorView({
      state: EditorState.create({ doc: text, extensions }),
      parent: host.current,
    });
    view.current = instance;
    return () => { instance.destroy(); view.current = null; };
  }, [text, extensions]);

  return <div ref={host} style={{ height: '100%', minHeight: 0, overflow: 'hidden' }} />;
}
