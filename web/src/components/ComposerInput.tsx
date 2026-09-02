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
  Decoration, EditorView, keymap, placeholder as placeholderExt,
  drawSelection, type DecorationSet,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { StateField } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
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
 * Shade the block, and turn its markers into its edges.
 *
 * The marker lines keep their place in the layout; only their text is replaced.
 * Six pixels of shaded nothing is what a code block's padding looks like
 * anyway, so the fence stops being three characters to read and becomes the top
 * and bottom of the box.
 *
 * The alternative -- hiding the lines outright with block decorations that
 * swallow a line break -- collapses on the case the shortcut produces most: an
 * empty new block, where the closing fence's range starts at the same offset as
 * the empty body line and takes it with it, leaving a block with nowhere to put
 * the caret. Keeping the lines also keeps arrow keys, selection and delete
 * working the way they already did, which is the part a writer would notice.
 */
function decorate(state: EditorState): DecorationSet {
  const marks: { from: number; to: number; value: Decoration }[] = [];
  const blank = Decoration.replace({});

  for (const fence of fences(state)) {
    const last = fence.close ?? state.doc.lines;

    for (let i = fence.open; i <= last; i += 1) {
      const line = state.doc.line(i);
      const marker = i === fence.open || i === fence.close;
      const edge = [
        i === fence.open ? 'cm-fence-open' : '',
        i === fence.close ? 'cm-fence-close' : '',
      ].filter(Boolean).join(' ');
      marks.push({
        from: line.from,
        to: line.from,
        value: Decoration.line({ class: `cm-fence ${edge}`.trim() }),
      });
      // A fence line is never empty -- it is at least three backticks -- so the
      // range is never the zero-length one a replacement rejects.
      if (marker) marks.push({ from: line.from, to: line.to, value: blank });
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
          const fence = fences(v.state).find(
            (f) => line.number === f.open || line.number === f.open + 1);
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
        selection: { anchor: from - 2 + 4 },
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
      markdown(),
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
