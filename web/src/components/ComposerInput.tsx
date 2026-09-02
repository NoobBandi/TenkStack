/**
 * The composer's text field: a CodeMirror 6 document that draws a fenced block
 * as a block.
 *
 * This replaces a textarea with a transparent backdrop painted behind it. The
 * overlay worked -- it is the standard trick -- but it can only ever shade the
 * ``` markers along with the code, because a textarea cannot hide three
 * characters of its own value or set a different font for one range of it. Slack
 * and Claude both consume the fence outright: their composers are block editors,
 * the fence becomes a node, and the markers stop being text. That is what this
 * does now.
 *
 * The markers are hidden with block-replace decorations rather than removed, so
 * `value` stays the exact Markdown that gets sent. Nothing here rewrites the
 * message; it only declines to draw six characters of it.
 *
 * IME was the reason for the textarea, and it is still the risk: composition
 * (注音, 拼音, kana) is reliable in a textarea and historically flaky in
 * contenteditable. CodeMirror handles composition explicitly rather than
 * inheriting the browser's default behaviour, and every key handler here defers
 * while `view.composing` is set -- an IME uses Enter to accept a candidate, and
 * sending on that keystroke fires off half-typed Chinese.
 */

import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { EditorState, Prec, RangeSet, type Extension } from '@codemirror/state';
import {
  Decoration, EditorView, WidgetType, keymap, placeholder as placeholderExt,
  drawSelection, type DecorationSet,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { StateField } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting } from '@codemirror/language';
import { highlightStyle, parserFor } from './syntax';
import './composer.css';

export interface ComposerHandle {
  focus: () => void;
  /** Wrap the selection, or insert at the caret when nothing is selected. */
  insert: (before: string, after?: string) => void;
}

/** One fenced region: the marker lines, and the body between them. */
interface Fence {
  open: number;
  close: number | null;
  body: number;
}

function fences(state: EditorState): Fence[] {
  const found: Fence[] = [];
  let open: number | null = null;
  for (let i = 1; i <= state.doc.lines; i += 1) {
    if (!state.doc.line(i).text.trimStart().startsWith('```')) continue;
    if (open === null) {
      open = i;
    } else {
      found.push({ open, close: i, body: i - open - 1 });
      open = null;
    }
  }
  // An unclosed fence is a block still being written, not a mistake.
  if (open !== null) found.push({ open, close: null, body: state.doc.lines - open });
  return found;
}

function insideFence(text: string, caret: number): boolean {
  const before = text.slice(0, caret);
  const count = before.split('\n').filter((l) => l.trimStart().startsWith('```')).length;
  return count % 2 === 1;
}

/**
 * The empty opening fence needs to say what it is for.
 *
 * Hiding the marker hid the one place a language could be typed, so a block
 * came out uncoloured with nothing on screen explaining why. The hint is the
 * label that was missing.
 */
class LanguageHint extends WidgetType {
  toDOM() {
    const hint = document.createElement('span');
    hint.className = 'cm-fence-hint';
    hint.textContent = '語言';
    return hint;
  }

  eq() { return true; }
}

/**
 * Shade the block; turn its closing marker into an edge and its opening one
 * into a header.
 *
 * Only the backticks go. What follows them on that line is the language, and it
 * has to stay visible and typeable -- it is what decides how the body is
 * coloured, and a block whose language cannot be seen or set is a block that is
 * never coloured. The closing marker carries nothing, so it is blanked outright
 * and left as seven pixels of shading, which is what the bottom of a code block
 * looks like anyway.
 *
 * The lines themselves are kept. Hiding them outright with block decorations
 * that swallow a line break collapses on the case the shortcut produces most --
 * a new empty block, where the closing fence's range starts at the same offset
 * as the empty body line and takes it along, leaving nowhere to put the caret.
 * Keeping them also keeps arrow keys, selection and delete behaving as before.
 */
function decorate(state: EditorState): DecorationSet {
  const marks: { from: number; to: number; value: Decoration }[] = [];
  const blank = Decoration.replace({});
  const hint = Decoration.widget({ widget: new LanguageHint(), side: 1 });

  for (const fence of fences(state)) {
    const last = fence.close ?? state.doc.lines;

    for (let i = fence.open; i <= last; i += 1) {
      const line = state.doc.line(i);
      const edge = [
        i === fence.open ? 'cm-fence-open' : '',
        i === fence.close ? 'cm-fence-close' : '',
      ].filter(Boolean).join(' ');
      marks.push({
        from: line.from,
        to: line.from,
        value: Decoration.line({ class: `cm-fence ${edge}`.trim() }),
      });

      if (i === fence.open) {
        // The indent and the backticks; never zero-length, a fence is at least
        // three characters.
        const lead = line.text.length - line.text.trimStart().length;
        const ticks = /^`+/.exec(line.text.slice(lead))?.[0].length ?? 3;
        const info = line.from + lead + ticks;
        marks.push({ from: line.from, to: info, value: blank });
        if (info < line.to) {
          marks.push({
            from: info, to: line.to,
            value: Decoration.mark({ class: 'cm-fence-lang' }),
          });
        } else {
          marks.push({ from: line.to, to: line.to, value: hint });
        }
      } else if (i === fence.close) {
        marks.push({ from: line.from, to: line.to, value: blank });
      }
    }
  }
  return marks.length ? Decoration.set(marks.map(
    (m) => m.value.range(m.from, m.to)), true) : RangeSet.empty;
}

const blocks = StateField.define<DecorationSet>({
  create: decorate,
  update: (deco, tr) => (tr.docChanged ? decorate(tr.state) : deco),
  provide: (field) => EditorView.decorations.from(field),
});

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** Enter outside a fenced block. */
  onSend: () => void;
  onPasteFiles: (files: File[]) => void;
  /** Whether the caret sits inside a fenced block. With the markers hidden,
   *  this is the only thing left that says which key sends. */
  onInFenceChange?: (inside: boolean) => void;
  disabled?: boolean;
  placeholder?: string;
  ref?: Ref<ComposerHandle>;
}

export default function ComposerInput({
  value, onChange, onSend, onPasteFiles, onInFenceChange, disabled, placeholder, ref,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Held in refs so a changed callback does not tear down the editor: rebuilding
  // it would drop the undo history and the caret on every keystroke.
  const handlers = useRef({ onChange, onSend, onPasteFiles, onInFenceChange });
  handlers.current = { onChange, onSend, onPasteFiles, onInFenceChange };

  useImperativeHandle(ref, () => ({
    focus: () => view.current?.focus(),
    insert: (before: string, after = '') => {
      const v = view.current;
      if (!v) return;
      const { from, to } = v.state.selection.main;
      const selected = v.state.sliceDoc(from, to);
      v.dispatch({
        changes: { from, to, insert: before + selected + after },
        selection: { anchor: from + before.length + selected.length },
      });
      v.focus();
    },
  }), []);

  useEffect(() => {
    if (!host.current) return undefined;

    const sending = keymap.of([
      {
        key: 'Enter',
        run: (v) => {
          // An IME uses Enter to accept a candidate.
          if (v.composing) return false;
          const { head } = v.state.selection.main;
          const line = v.state.doc.lineAt(head);
          const all = fences(v.state);
          // Enter on the header goes into the block, so ```js followed by
          // Enter does what it looks like it does -- which is how everyone
          // writes a fence, and how they wrote it here before the shortcut
          // started jumping the caret past the language.
          const opening = all.find((f) => f.open === line.number);
          if (opening) {
            const next = line.number < v.state.doc.lines
              ? v.state.doc.line(line.number + 1) : null;
            if (next && line.number + 1 !== opening.close) {
              v.dispatch({ selection: { anchor: next.from }, scrollIntoView: true });
            } else {
              v.dispatch({
                changes: { from: line.to, insert: '\n' },
                selection: { anchor: line.to + 1 }, scrollIntoView: true,
              });
            }
            return true;
          }
          // The closing edge counts as out. Its ``` is not drawn any more, so
          // "click past the fence and press Enter" is no longer a thing anyone
          // can do -- and without this, a block sitting at the end of the
          // message has no way out at all.
          const onClose = all.some((f) => f.close === line.number);
          if (onClose || !insideFence(v.state.doc.toString(), head)) {
            handlers.current.onSend();
            return true;
          }
          // Enter on the last, empty line of a block leaves the block rather
          // than growing it -- the fences are not visible to click past, so
          // this is the way out. Every block editor works this way.
          const fence = all.find((f) => f.close !== null && line.number === f.close - 1);
          if (fence && line.text.trim() === '' && fence.body > 1) {
            const close = v.state.doc.line(fence.close!);
            const after = close.to === v.state.doc.length ? '\n' : '';
            v.dispatch({
              changes: [
                { from: line.from - 1, to: line.to },
                { from: close.to, to: close.to, insert: after },
              ],
              selection: { anchor: close.to - (line.to - line.from + 1) + after.length },
            });
            return true;
          }
          return false;   // a newline, which is what code wants
        },
      },
      {
        key: 'Shift-Enter',
        run: (v) => {
          v.dispatch(v.state.replaceSelection('\n'));
          return true;
        },
      },
      {
        key: 'Tab',
        run: (v) => {
          if (!insideFence(v.state.doc.toString(), v.state.selection.main.head)) return false;
          v.dispatch(v.state.replaceSelection('  '));
          return true;
        },
      },
    ]);

    /**
     * Step out of a block with the arrow keys.
     *
     * The fence lines are seven pixels of shading now, so an arrow key landing
     * on one puts the caret somewhere the writer cannot see it. They are skipped
     * in both directions, and when there is nothing on the far side -- a block
     * that opens the message, or ends it -- the line to move to is made. That is
     * the only way out of a block that starts at the top of an empty draft.
     */
    const stepping = keymap.of([
      {
        key: 'ArrowUp',
        run: (v) => {
          if (v.composing || !v.state.selection.main.empty) return false;
          const line = v.state.doc.lineAt(v.state.selection.main.head);
          const fence = fences(v.state).find((f) => line.number === f.open);
          if (!fence) return false;
          if (fence.open === 1) {
            v.dispatch({
              changes: { from: 0, insert: '\n' },
              selection: { anchor: 0 }, scrollIntoView: true,
            });
            return true;
          }
          v.dispatch({
            selection: { anchor: v.state.doc.line(fence.open - 1).to },
            scrollIntoView: true,
          });
          return true;
        },
      },
      {
        key: 'ArrowDown',
        run: (v) => {
          if (v.composing || !v.state.selection.main.empty) return false;
          const line = v.state.doc.lineAt(v.state.selection.main.head);
          const fence = fences(v.state).find(
            (f) => f.close !== null && (line.number === f.close || line.number === f.close - 1));
          if (!fence) return false;
          if (fence.close === v.state.doc.lines) {
            const end = v.state.doc.length;
            v.dispatch({
              changes: { from: end, insert: '\n' },
              selection: { anchor: end + 1 }, scrollIntoView: true,
            });
            return true;
          }
          v.dispatch({
            selection: { anchor: v.state.doc.line(fence.close! + 1).from },
            scrollIntoView: true,
          });
          return true;
        },
      },
    ]);

    // The third backtick opens a block and closes it in one go, with the caret
    // on the empty line between the fences.
    const fenceShortcut = EditorView.inputHandler.of((v, from, to, text) => {
      if (text !== '`' || from !== to) return false;
      if (from < 2 || v.state.sliceDoc(from - 2, from) !== '``') return false;
      if (insideFence(v.state.doc.toString(), from)) return false;
      v.dispatch({
        changes: { from: from - 2, to, insert: '```\n\n```' },
        // On the header, after the backticks: the language is the first thing
        // to say about a block, and Enter drops into the body.
        selection: { anchor: from - 2 + 3 },
      });
      return true;
    });

    const files = EditorView.domEventHandlers({
      paste: (event) => {
        const dropped = Array.from(event.clipboardData?.files ?? []);
        if (!dropped.length) return false;
        event.preventDefault();
        handlers.current.onPasteFiles(dropped);
        return true;
      },
    });

    const extensions: Extension[] = [
      history(),
      drawSelection(),
      EditorView.lineWrapping,
      // The fence's own language, parsed for real. `codeLanguages` takes a
      // function, so the info string is resolved against the console's table
      // rather than pulling in @codemirror/language-data and its lazy loader
      // for a set of languages that is already installed.
      markdown({ codeLanguages: parserFor }),
      syntaxHighlighting(highlightStyle),
      blocks,
      Prec.highest(sending),
      Prec.highest(stepping),
      fenceShortcut,
      files,
      keymap.of([...defaultKeymap.filter((b) => b.key !== 'Enter'), ...historyKeymap]),
      placeholderExt(placeholder ?? ''),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) handlers.current.onChange(update.state.doc.toString());
        if (update.docChanged || update.selectionSet) {
          handlers.current.onInFenceChange?.(insideFence(
            update.state.doc.toString(), update.state.selection.main.head));
        }
      }),
      EditorView.editable.of(!disabled),
      EditorState.readOnly.of(!!disabled),
    ];

    const editor = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: host.current,
    });
    view.current = editor;
    return () => { editor.destroy(); view.current = null; };
    // Built once. `value` is pushed in below, and the handlers live in a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, placeholder]);

  // Controlled from outside: a send clears the draft, history reopens one.
  useEffect(() => {
    const v = view.current;
    if (!v || v.state.doc.toString() === value) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  return <div className="composer-input" ref={host} />;
}
