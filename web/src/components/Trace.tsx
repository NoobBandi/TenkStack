import { useState } from 'react';
import { Typography } from 'antd';
import type { Turn } from '../chat';
import { ACCENT, LINE, MONO } from '../theme';
import './thinking.css';

const { Text } = Typography;

/**
 * Everything that happened before the answer, in one place.
 *
 * A turn that used the sandbox used to render as a chain of separate
 * disclosures down the thread -- a thinking block, a code block, another
 * thinking block, another code block. Four widgets for one answer, each with
 * its own chevron and its own open state, and no way to see the shape of what
 * had happened without opening all of them.
 *
 * One container now, and one list inside it. An earlier attempt put tabs across
 * the top -- Steps, Reasoning, Coding -- which came from misreading the
 * reference: those are the names of four *variants* of its component, switched
 * by the page demonstrating them, not tabs within one. The component itself is
 * a single list of rows, which is also the better design: a run alternates
 * between thinking and doing, and splitting them into separate views destroys
 * the one thing the order was carrying.
 *
 * Structure and motion follow beautifului.dev's Thinking primitive. The colours
 * do not -- see thinking.css.
 *
 * Open while it runs, and closed once it settles, unless the reader said
 * otherwise. Showing the tool and its result at the moment of the decision
 * rather than filing them in a log is the difference between an auditable
 * answer and one taken on faith; keeping them open afterwards would bury the
 * answer under the working.
 */

export interface Step {
  kind: 'reasoning' | 'code';
  /** The thinking text, or the Python source. */
  text: string;
  /** Present on a code step; carries the result once it has run. */
  turn?: Turn;
  ms?: number;
}

/** The four-point star the reference uses. Not a lightbulb or a brain: this
 *  marks a machine's working, and the metaphors for human thought overclaim. */
function Sparkle({ lit }: { lit: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden
         fill={lit ? 'rgba(242,242,242,0.7)' : 'rgba(242,242,242,0.32)'}
         style={{ flexShrink: 0, transition: 'fill 300ms' }}>
      <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden
         stroke="currentColor" strokeWidth="2.2"
         strokeLinecap="round" strokeLinejoin="round"
         style={{
           flexShrink: 0, opacity: 0.3,
           transform: open ? 'rotate(180deg)' : 'none',
           transition: 'transform 300ms cubic-bezier(0.23, 1, 0.32, 1)',
         }}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function Check() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden
         className="tt-icon" stroke="currentColor" strokeWidth="2.5"
         strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function Block({ label, value, tone }: { label?: string; value: string; tone?: string }) {
  return (
    <div style={{ marginTop: 6 }}>
      {label && (
        <Text style={{ fontSize: 10, letterSpacing: 0.8, opacity: 0.4 }}>{label}</Text>
      )}
      <pre style={{
        margin: '2px 0 0', padding: '7px 10px', borderRadius: 4,
        background: 'rgba(255,255,255,0.03)', border: `1px solid ${LINE.faint}`,
        font: `11px/1.6 ${MONO}`, color: tone, whiteSpace: 'pre-wrap',
        wordBreak: 'break-word', maxHeight: 300, overflow: 'auto',
      }}>
        {value}
      </pre>
    </div>
  );
}

/** Everything a code step produced, shown when its row is opened. */
function Detail({ step }: { step: Step }) {
  const result = step.turn?.run?.result;
  return (
    <div style={{ padding: '2px 6px 10px 27px' }}>
      <Block value={step.text} />
      {/* The tools that answer in prose -- a result list, a page -- put it
          here. Python has structure and gets the labelled blocks below. */}
      {step.turn?.run?.output && <Block value={step.turn.run.output} />}
      {result?.error && <Block label="錯誤" value={result.error} tone={ACCENT.error} />}
      {result?.stdout.trim() && <Block label="輸出" value={result.stdout} />}
      {result?.stderr.trim() && <Block label="STDERR" value={result.stderr} tone={ACCENT.warn} />}
      {result && result.value !== null && (
        <Block label="回傳值" value={result.value} tone="#7fb8d8" />
      )}
      {/* No figures here. They are shown with the answer, where what was
          asked for belongs, rather than inside the working that produced it. */}
      {result
        && !result.error
        && !result.stdout.trim()
        && result.value === null
        && !result.images.length && (
        <Text style={{ fontSize: 11, opacity: 0.4, display: 'block', marginTop: 6 }}>
          沒有輸出
        </Text>
      )}
    </div>
  );
}

export default function Trace({ steps, live }: { steps: Step[]; live: boolean }) {
  const [manual, setManual] = useState<boolean | null>(null);
  const [openStep, setOpenStep] = useState<number | null>(null);
  const open = manual ?? live;

  if (!steps.length) return null;

  const runs = steps.filter((s) => s.kind === 'code').length;
  const searches = steps.filter((s) => s.turn?.run?.tool === '搜尋').length;
  const failures = steps.filter((s) => s.turn?.run?.result?.error).length;
  const total = steps.reduce(
    (sum, s) => sum + (s.turn?.run?.result?.elapsed_ms ?? s.ms ?? 0), 0,
  );

  // Past tense once it has settled, the way the reference says "Thought for 4
  // seconds" -- a label that still reads "thinking" beside a finished answer is
  // the interface disagreeing with itself.
  const label = live
    ? (runs ? '執行中' : '思考中')
    : [
        runs ? `${runs} 個步驟` : '思考完成',
        searches ? `搜了 ${searches} 次` : null,
        failures ? `${failures} 次失敗` : null,
      ].filter(Boolean).join('・');

  return (
    <div style={{ marginBottom: 12 }}>
      <button
        type="button"
        className="tt-head"
        aria-expanded={open}
        onClick={() => setManual(!open)}
      >
        <Sparkle lit={live} />
        <span className={live ? 'tt-label tt-shimmer' : 'tt-label'}>{label}</span>
        {!live && total > 0 && (
          <span className="tt-meta">{(total / 1000).toFixed(1)}s</span>
        )}
        <Chevron open={open} />
      </button>

      {/* A 0fr -> 1fr grid row animates to the content's real height, where a
          max-height only approximates it -- and a trace can be three lines or
          eighty. */}
      <div className={open ? 'tt-body tt-body-open' : 'tt-body'}>
        <div className="tt-clip">
          <div className="tt-rail">
            {steps.map((step, i) => {
              const result = step.turn?.run?.result;
              const running = step.kind === 'code'
                && !result && !step.turn?.run?.output;
              // Staggered, so the rows arrive as a sequence rather than as a
              // block appearing at once.
              const delay = { animationDelay: `${Math.min(i, 6) * 90}ms` };

              if (step.kind === 'reasoning') {
                const body = step.text.trim();
                const opened = openStep === i;
                // A reasoning block runs to hundreds of words. Printed whole,
                // three of them bury the two code rows between them and the
                // trace stops being a trace. The first line is the topic
                // sentence often enough to serve as the label, and the rest is
                // one click away.
                const head = body.split('\n').find((l) => l.trim()) ?? '思考';
                const more = body.length > head.length;
                return (
                  <div key={i}>
                    <button
                      type="button"
                      className="tt-row"
                      style={delay}
                      aria-pressed={opened}
                      disabled={!more}
                      onClick={() => setOpenStep(opened ? null : i)}
                    >
                      <Check />
                      <span className="tt-primary" style={{ fontWeight: 400, opacity: 0.62 }}>
                        {head}
                      </span>
                      {step.ms ? (
                        <span className="tt-secondary">{(step.ms / 1000).toFixed(1)}s</span>
                      ) : null}
                    </button>
                    {opened && (
                      <div className="tt-prose" style={{ padding: '0 6px 10px 27px' }}>
                        {body}
                      </div>
                    )}
                  </div>
                );
              }

              const tool = step.turn?.run?.tool ?? 'Python';
              const first = step.text.trim().split('\n')[0] || tool.toLowerCase();
              const lines = step.text.trim().split('\n').length;
              // Lines are a measure of code and say nothing about a query or a
              // URL, which are one line by construction.
              const measure = step.turn?.run?.result
                ? `${lines} 行・${(step.turn.run.result.elapsed_ms / 1000).toFixed(2)}s`
                : step.turn?.run?.output
                  ? '完成'
                  : lines > 1 ? `${lines} 行` : '';
              return (
                <div key={i}>
                  <button
                    type="button"
                    className="tt-row"
                    style={delay}
                    aria-pressed={openStep === i}
                    onClick={() => setOpenStep(openStep === i ? null : i)}
                  >
                    {running ? <span className="tt-spin" /> : <Check />}
                    <span className="tt-primary" style={{ flex: 'none' }}>{tool}</span>
                    <span className="tt-primary" style={{
                      fontFamily: MONO, fontWeight: 400, opacity: 0.5,
                    }}>
                      {first}
                    </span>
                    <span className="tt-secondary" style={{
                      color: result?.error ? ACCENT.error : undefined,
                    }}>
                      {measure}
                    </span>
                  </button>
                  {openStep === i && <Detail step={step} />}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
