import { useState } from 'react';
import { Image, Segmented, Typography } from 'antd';
import { RightOutlined } from '@ant-design/icons';
import type { Turn } from '../chat';
import { ACCENT, LINE, MONO } from '../theme';
import './thinking.css';

const { Text } = Typography;

/**
 * Everything that happened before the answer, in one place.
 *
 * A turn that used the sandbox used to render as a chain of separate
 * disclosures down the thread -- a thinking block, a code block, another
 * thinking block, another code block -- each with its own chevron and its own
 * open state. Four widgets for one answer, and no way to see the shape of what
 * had happened without opening all of them.
 *
 * So one container, with the steps inside it. Collapsed it is a single line
 * saying what it did and what it cost; expanded it separates the two kinds of
 * thing it did, because they are read for different reasons. Reasoning is read
 * to follow the argument; code is read to check the work.
 *
 * Open while it runs and collapsible after. Showing the tool and its result at
 * the moment of the decision, rather than filing them in a log to be opened
 * later, is the difference between an auditable answer and one taken on faith.
 */

export interface Step {
  kind: 'reasoning' | 'code';
  /** The thinking text, or the Python source. */
  text: string;
  /** Present on a code step once it has run. */
  turn?: Turn;
  ms?: number;
}

type View = 'steps' | 'reasoning' | 'code';

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

/** One code step, whole: what was asked for and everything that came back. */
function CodeStep({ step }: { step: Step }) {
  const result = step.turn?.run?.result;
  return (
    <div style={{ marginBottom: 12 }}>
      <Block label="PYTHON" value={step.text} />
      {result?.error && <Block label="錯誤" value={result.error} tone={ACCENT.error} />}
      {result?.stdout.trim() && <Block label="輸出" value={result.stdout} />}
      {result?.stderr.trim() && <Block label="STDERR" value={result.stderr} tone={ACCENT.warn} />}
      {result && result.value !== null && (
        <Block label="回傳值" value={result.value} tone="#7fb8d8" />
      )}
      {result?.images.map((src, i) => (
        <Image key={i} src={src} width="100%"
               style={{ marginTop: 8, borderRadius: 4, background: '#fff' }} />
      ))}
      {result
        && !result.error
        && !result.stdout.trim()
        && !result.images.length
        && result.value === null && (
        <Text style={{ fontSize: 11, opacity: 0.4, display: 'block', marginTop: 6 }}>
          沒有輸出
        </Text>
      )}
      {!result && (
        <Text className="tt-shimmer" style={{ fontSize: 11, opacity: 0.5, display: 'block', marginTop: 6 }}>
          執行中…
        </Text>
      )}
    </div>
  );
}

export default function Trace({ steps, live }: { steps: Step[]; live: boolean }) {
  // Open while it runs, and whatever the reader chose after that. Closing
  // itself under someone who is reading would be worse than staying open.
  const [manual, setManual] = useState<boolean | null>(null);
  const [view, setView] = useState<View>('steps');
  const open = manual ?? live;

  if (!steps.length) return null;

  const runs = steps.filter((s) => s.kind === 'code');
  const failures = runs.filter((s) => s.turn?.run?.result?.error).length;
  const total = steps.reduce((sum, s) => sum + (s.ms ?? 0), 0);

  // What it did, in one line, for the collapsed state. A count of code runs is
  // the part that distinguishes this turn from an ordinary one.
  const summary = live
    ? (runs.length ? `執行中・已跑 ${runs.length} 段程式碼` : '思考中')
    : [
        runs.length ? `${runs.length} 段程式碼` : '思考過程',
        failures ? `${failures} 次失敗` : null,
      ].filter(Boolean).join('・');

  // The tabs are only worth their row when there is more than one kind of
  // thing to switch between.
  const tabbed = runs.length > 0 && steps.some((s) => s.kind === 'reasoning');

  return (
    <div style={{ marginBottom: 12 }}>
      <button
        type="button"
        className="tt-head"
        aria-expanded={open}
        onClick={() => setManual(!open)}
      >
        <RightOutlined className={`tt-chevron${open ? ' tt-chevron-open' : ''}`} />
        <span className={live ? 'tt-label tt-shimmer' : 'tt-label'}>{summary}</span>
        {!live && total > 0 && (
          <span className="tt-meta">{(total / 1000).toFixed(1)}s</span>
        )}
      </button>

      {open && (
        <div style={{ paddingLeft: 18, paddingTop: 4 }}>
          {tabbed && (
            <Segmented
              size="small"
              value={view}
              onChange={(v) => setView(v as View)}
              style={{ marginBottom: 8 }}
              options={[
                { label: '步驟', value: 'steps' },
                { label: '推理', value: 'reasoning' },
                { label: '程式碼', value: 'code' },
              ]}
            />
          )}

          {/* Steps: the shape of what happened, one line each. Read to find
              the step worth opening, not to read the step. */}
          {(!tabbed || view === 'steps') && (
            <div>
              {steps.map((step, i) => (
                <div key={i} style={{
                  display: 'flex', gap: 10, alignItems: 'baseline',
                  padding: '3px 0', borderBottom: `1px solid ${LINE.faint}`,
                }}>
                  <Text style={{ fontSize: 10, opacity: 0.3, fontFamily: MONO, width: 16 }}>
                    {i + 1}
                  </Text>
                  <Text style={{ fontSize: 11, opacity: 0.75, flex: 1, minWidth: 0 }} ellipsis>
                    {step.kind === 'reasoning'
                      ? step.text.trim().split('\n')[0] || '思考'
                      : step.text.trim().split('\n')[0]}
                  </Text>
                  <Text style={{
                    fontSize: 10, fontFamily: MONO,
                    color: step.turn?.run?.result?.error ? ACCENT.error : undefined,
                    opacity: step.turn?.run?.result?.error ? 1 : 0.35,
                  }}>
                    {step.kind === 'code'
                      ? (step.turn?.run?.result
                          ? `${(step.turn.run.result.elapsed_ms / 1000).toFixed(2)}s`
                          : '…')
                      : step.ms ? `${(step.ms / 1000).toFixed(1)}s` : ''}
                  </Text>
                </div>
              ))}
            </div>
          )}

          {tabbed && view === 'reasoning' && (
            <div style={{ fontSize: 12, lineHeight: 1.7, opacity: 0.75, whiteSpace: 'pre-wrap' }}>
              {steps.filter((s) => s.kind === 'reasoning').map((s) => s.text).join('\n\n')}
            </div>
          )}

          {(tabbed ? view === 'code' : false) && (
            <div>{runs.map((s, i) => <CodeStep key={i} step={s} />)}</div>
          )}

          {/* Untabbed and code-only: nowhere else for it to go. */}
          {!tabbed && runs.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {runs.map((s, i) => <CodeStep key={i} step={s} />)}
            </div>
          )}

          {/* Untabbed and reasoning-only: the ordinary thinking block. */}
          {!tabbed && !runs.length && (
            <div style={{
              fontSize: 12, lineHeight: 1.7, opacity: 0.75, whiteSpace: 'pre-wrap',
              marginTop: 6,
            }}>
              {steps.map((s) => s.text).join('\n\n')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
