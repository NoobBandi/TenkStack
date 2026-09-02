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
import {
  syntaxHighlighting, LanguageDescription, type Language,
} from '@codemirror/language';
import { highlightTree } from '@lezer/highlight';
import { ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { detectLanguage } from './detect';
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
 * Shade the block and blank its markers.
 *
 * Neither fence line is drawn. The opening one used to stay visible so a
 * language could be typed into it, and that was the wrong trade: it put a field
 * on screen that looked like it had to be filled in, on every block, for the
 * sake of a case the detector already covers. What language a block is in is
 * worked out from the code -- see ./detect -- and nothing is asked for.
 *
 * Both lines are kept in the layout, blanked, as seven pixels of shading, which
 * is what the top and bottom of a code block look like anyway. Hiding them
 * outright with block decorations that swallow a line break collapses on the
 * case the shortcut produces most -- a new empty block, where the closing
 * fence's range starts at the same offset as the empty body line and takes it
 * along, leaving nowhere to put the caret. Keeping them also keeps arrow keys,
 * selection and delete behaving as they did.
 */
function decorate(state: EditorState): DecorationSet {
  const marks: { from: number; to: number; value: Decoration }[] = [];
  const blank = Decoration.replace({});

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

      if (i === fence.open || i === fence.close) {
        // Never zero-length: a fence is at least three characters.
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

/**
 * Colour the code inside a block.
 *
 * CodeMirror's Markdown parser can nest a language into a fence, but it is only
 * ever told the name the fence declares -- and a fence that declares nothing is
 * exactly the case worth handling. So the parsing happens here instead: the
 * language is whatever the fence says, or whatever `detectLanguage` makes of the
 * body, and the tree it produces is run through the same HighlightStyle the rest
 * of the console uses. The classes come out identical to a declared block's,
 * because they are the same classes.
 *
 * A plugin rather than a field: a language that is not in the eager set has to
 * be fetched, and this is the layer that can ask for a redraw once it arrives.
 */
const parsed = new Map<string, { from: number; to: number; cls: string }[]>();

/** Bumped when a parser finishes loading. The document has not changed at that
 *  point, so nothing else would tell the plugin its answer is now different. */
let generation = 0;

/** Runs of one block, relative to its start, so an edit elsewhere reuses them. */
function runs(language: Language, body: string) {
  const key = `${language.name}\u0000${body}`;
  const cached = parsed.get(key);
  if (cached) return cached;
  const out: { from: number; to: number; cls: string }[] = [];
  highlightTree(language.parser.parse(body), highlightStyle, (from, to, cls) => {
    out.push({ from, to, cls });
  });
  if (parsed.size > 60) parsed.clear();
  parsed.set(key, out);
  return out;
}

/** A block longer than this is a pasted file; parsing it on every keystroke is
 *  not what anyone is waiting for. */
const COLOUR_LIMIT = 20000;

const colours = ViewPlugin.fromClass(class {
  decorations: DecorationSet = RangeSet.empty;
  built = -1;

  constructor(view: EditorView) { this.decorations = this.build(view); }

  update(update: ViewUpdate) {
    if (update.docChanged || this.built !== generation) {
      this.decorations = this.build(update.view);
    }
  }

  build(view: EditorView): DecorationSet {
    this.built = generation;
    const marks: { from: number; to: number; cls: string }[] = [];
    const { state } = view;

    for (const fence of fences(state)) {
      const open = state.doc.line(fence.open);
      const last = fence.close ? fence.close - 1 : state.doc.lines;
      if (last <= fence.open) continue;
      const from = state.doc.line(fence.open + 1).from;
      const to = state.doc.line(last).to;
      if (to - from > COLOUR_LIMIT) continue;
      const body = state.sliceDoc(from, to);

      const declared = open.text.trim().replace(/^`+/, '').trim().split(/[\s,]+/)[0];
      const name = declared || detectLanguage(body);
      if (!name) continue;

      const language = resolve(name, view);
      if (!language) continue;
      for (const run of runs(language, body)) {
        marks.push({ from: from + run.from, to: from + run.to, cls: run.cls });
      }
    }
    return marks.length
      ? Decoration.set(marks.map((m) =>
        Decoration.mark({ class: m.cls }).range(m.from, m.to)), true)
      : RangeSet.empty;
  }
}, { decorations: (plugin) => plugin.decorations });

/**
 * The eager table first; anything else is fetched once and then redrawn.
 *
 * `parserFor` already answers both -- a Language for what is bundled, an
 * unloaded description for the rest -- so the only thing added here is the
 * redraw. The document has not changed when a parser arrives, but what can be
 * drawn on it has, and nothing else would ask.
 */
function resolve(name: string, view: EditorView): Language | null {
  const found = parserFor(name);
  if (!found) return null;
  if (!(found instanceof LanguageDescription)) return found;
  if (found.support) return found.support.language;
  void found.load().then(() => {
    generation += 1;
    view.dispatch({});
  });
  return null;
}

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
        /**
         * Backspace at the edges of a block.
         *
         * Emptying a block used to leave the block: the code went, the fence
         * lines stayed, and clearing them meant finding the header and pressing
         * Backspace again on a strip seven pixels tall. A block with nothing in
         * it is one the writer is finished with, so it goes in one press.
         *
         * At the start of code that is still there, Backspace unwraps instead --
         * the fences go and the code stays as text. Without this, the press
         * joins the first line onto the opening fence and quietly turns the
         * whole first line into the block's language.
         */
        key: 'Backspace',
        run: (v) => {
          if (v.composing || !v.state.selection.main.empty) return false;
          const { head } = v.state.selection.main;
          const line = v.state.doc.lineAt(head);
          const fence = fences(v.state).find(
            (f) => f.close !== null && line.number >= f.open && line.number <= f.close);
          if (!fence || fence.close === null) return false;

          const open = v.state.doc.line(fence.open);
          const close = v.state.doc.line(fence.close);
          const info = open.text.trim().replace(/^`+/, '').trim();
          const body = fence.body > 0
            ? v.state.sliceDoc(v.state.doc.line(fence.open + 1).from,
              v.state.doc.line(fence.close - 1).to)
            : '';

          if (!body.trim() && !info) {
            // The whole thing, plus one of the line breaks around it, so the
            // text either side does not end up welded together or pushed apart.
            const after = fence.close < v.state.doc.lines;
            const from = after || open.from === 0 ? open.from : open.from - 1;
            const to = after ? close.to + 1 : close.to;
            v.dispatch({
              changes: { from, to },
              selection: { anchor: from }, scrollIntoView: true,
            });
            return true;
          }

          const first = fence.body > 0 ? v.state.doc.line(fence.open + 1) : null;
          if (first && head === first.from) {
            const lastBody = v.state.doc.line(fence.close - 1);
            v.dispatch({
              changes: [
                { from: open.from, to: first.from },
                { from: lastBody.to, to: close.to },
              ],
              selection: { anchor: open.from }, scrollIntoView: true,
            });
            return true;
          }
          return false;
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

    const pasting = EditorView.domEventHandlers({
      /**
       * Pasted code lands in a block of its own.
       *
       * Pasting into a block already worked -- the detector reads the body and
       * colours it. Pasting code into a message did nothing, because there was
       * no block for it to be the body of, and asking the writer to fence it
       * first is asking them to do the markup by hand again.
       *
       * The gates are the same confidence the rest of this rests on. More than
       * one line, so a copied variable name or URL is left alone. Not already
       * fenced, and not pasted into a fence, so nothing nests. And the detector
       * has to actually name a language -- prose, a log and a stack trace all
       * come back with nothing and stay plain text.
       *
       * The fence goes in bare. What language it is stays inferred, the way it
       * is everywhere else here; writing a guess into a line that is not drawn
       * would put an invisible claim in the message that could be wrong.
       *
       * One transaction, so one undo puts back exactly what was on the
       * clipboard.
       */
      paste: (event, view) => {
        const dropped = Array.from(event.clipboardData?.files ?? []);
        if (dropped.length) {
          event.preventDefault();
          handlers.current.onPasteFiles(dropped);
          return true;
        }

        const text = event.clipboardData?.getData('text/plain') ?? '';
        if (!text.includes('\n') || text.includes('```')) return false;
        const { from, to } = view.state.selection.main;
        if (insideFence(view.state.doc.toString(), from)) return false;
        if (!detectLanguage(text)) return false;

        const line = view.state.doc.lineAt(from);
        // A fence has to start its own line, and leave one behind it.
        const lead = from === line.from ? '' : '\n';
        const insert = `${lead}\`\`\`\n${text.replace(/\s+$/, '')}\n\`\`\`\n`;
        event.preventDefault();
        view.dispatch({
          changes: { from, to, insert },
          selection: { anchor: from + insert.length },
          scrollIntoView: true,
        });
        return true;
      },
    });

    const extensions: Extension[] = [
      history(),
      drawSelection(),
      EditorView.lineWrapping,
      markdown(),
      syntaxHighlighting(highlightStyle),
      blocks,
      colours,
      Prec.highest(sending),
      Prec.highest(stepping),
      fenceShortcut,
      pasting,
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
