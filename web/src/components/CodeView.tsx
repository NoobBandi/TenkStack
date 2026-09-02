/**
 * A CodeMirror 6 view: read-only for the preview pane, editable for the editor.
 *
 * The preview used to render text through the chat's markdown renderer, wrapped
 * in a fence so highlight.js would colour it. That works for a paragraph and
 * falls apart on a file: no line numbers to refer to, no way to search inside,
 * the whole thing laid out at once so a 256 KiB config janks while it paints,
 * and long lines wrapped or clipped with no say in the matter.
 *
 * CodeMirror only builds the lines that are on screen, which is what makes the
 * size cap in `peek` a formatting decision instead of a performance one, and it
 * brings its own find-in-file.
 *
 * Editing is opt-in, via `onChange`. Without it the document is locked at both
 * levels, which matters because the preview reads /api/fs/peek -- a truncated
 * prefix that must never look like something to save. The editor takes a
 * different route, /api/fs/text, which refuses anything it cannot hand over
 * whole.
 */
import { useEffect, useMemo, useRef } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, dropCursor,
} from '@codemirror/view';
import {
  defaultKeymap, history, historyKeymap, indentWithTab, insertNewlineAndIndent,
} from '@codemirror/commands';
import {
  syntaxHighlighting, bracketMatching, foldGutter, foldKeymap, indentOnInput,
} from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches, search } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap, autocompletion } from '@codemirror/autocomplete';
import { LINE, MONO } from '../theme';
import { highlightStyle, languageFor } from './syntax';

const theme = EditorView.theme({
  '&': { fontSize: '12px', backgroundColor: 'transparent', height: '100%' },
  '.cm-scroller': { fontFamily: MONO, lineHeight: '1.55', overflow: 'auto' },
  // No caret rule here. It used to hide the caret for the read-only preview,
  // and the editable branch could not reliably override it: both rules target
  // .cm-content with equal specificity, so which one wins is decided by the
  // order the stylesheets were injected rather than the order the extensions
  // were added. The caret is now settled once, in the branch that knows.
  '.cm-cursor, .cm-dropCursor': { borderLeftWidth: '2px' },
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

export default function CodeView({ text, suffix, wrap = false, onChange }: {
  text: string;
  suffix: string;
  wrap?: boolean;
  /** Supplied only by the editor. Its absence is what makes this read-only, so
   *  a preview cannot become editable by accident. */
  onChange?: (next: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Held rather than closed over: an inline arrow from the parent is a new
  // function every render, and depending on it would tear down and rebuild the
  // editor -- losing cursor, selection, undo history and scroll on every
  // keystroke, since each keystroke re-renders the parent.
  const changed = useRef(onChange);
  changed.current = onChange;
  const editable = Boolean(onChange);

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
      keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap]),
    ];
    if (editable) {
      list.push(EditorView.updateListener.of((u) => {
        if (u.docChanged) changed.current?.(u.state.doc.toString());
      }));
      // drawSelection replaces the browser's caret and selection with ones
      // CodeMirror draws itself. Needed rather than cosmetic: the native caret
      // in a dark editor inherits a colour from somewhere up the antd tree and
      // is routinely invisible, and .cm-selectionBackground -- already in the
      // theme above -- is drawSelection's element and does nothing without it.
      // dropCursor is the drag-and-drop counterpart, and its absence shows as a
      // drop landing somewhere the eye never predicted.
      // A real editor's minimum: Enter keeps the indent of the line it left,
      // Tab indents rather than moving focus out of the editor, and closing
      // brackets and quotes are inserted with their opener. Left out of the
      // read-only branch, where all three would be keys that do nothing.
      list.push(
        closeBrackets(),
        autocompletion({ defaultKeymap: false }),
        keymap.of([...closeBracketsKeymap, indentWithTab, {
          key: 'Enter', run: insertNewlineAndIndent,
        }]),
      );
      list.push(drawSelection(), dropCursor(), EditorView.theme({
        '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#82aaff' },
        // Dimmed rather than hidden when focus is elsewhere, so a click on the
        // save button does not make the editor look like it lost the cursor.
        '&:not(.cm-focused) .cm-cursor': { display: 'block', opacity: 0.35 },
      }));
    } else {
      // Read-only rather than merely non-editable: editable:false alone still
      // leaves the document mutable through the API, and the preview is showing
      // a truncated prefix that must never look like something to save.
      list.push(
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.theme({ '.cm-content': { caretColor: 'transparent' } }),
      );
    }
    if (wrap) list.push(EditorView.lineWrapping);
    const lang = languageFor(suffix);
    if (lang) list.push(lang);
    return list;
  }, [suffix, wrap, editable]);

  // `text` is the initial document, not a controlled value: rebuilding state on
  // every keystroke would reset the cursor to the top of the file. The editor
  // owns its document once created, and the parent hears about changes through
  // onChange.
  const initial = useRef(text);
  useEffect(() => {
    if (!host.current) return undefined;
    const instance = new EditorView({
      state: EditorState.create({ doc: initial.current, extensions }),
      parent: host.current,
    });
    view.current = instance;
    return () => { instance.destroy(); view.current = null; };
  }, [extensions]);

  // A different file in the same mounted editor -- stepping through a directory
  // with the arrows -- does replace the document.
  useEffect(() => {
    const v = view.current;
    if (!v || text === v.state.doc.toString()) return;
    initial.current = text;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
  }, [text]);

  return <div ref={host} style={{ height: '100%', minHeight: 0, overflow: 'hidden' }} />;
}
