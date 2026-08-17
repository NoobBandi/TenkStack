import { useState } from 'react';
import { RightOutlined } from '@ant-design/icons';
import { Image, Typography } from 'antd';
import type { Turn } from '../chat';
import { ACCENT, LINE, MONO } from '../theme';
import './thinking.css';

const { Text } = Typography;

/**
 * What the sandbox was asked to do, and what came back.
 *
 * Open while it is happening, collapsible afterwards. That order is the point:
 * showing the tool and its result at the moment of the decision, rather than
 * filing them in a log to be opened later, is the difference between an
 * auditable answer and one you have to take on faith. Collapsing afterwards is
 * only so a finished thread stays readable -- the trace never goes away, and it
 * is stored on the turn, so it survives navigating away and coming back.
 *
 * The code is shown before the output, in the order it happened, and neither is
 * summarised. A model that quietly ran something different from what it said it
 * ran is exactly the failure this is here to catch.
 */

function Line({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div style={{ marginTop: 6 }}>
      <Text style={{ fontSize: 10, letterSpacing: 0.8, opacity: 0.4 }}>{label}</Text>
      <pre style={{
        margin: '2px 0 0', padding: '6px 9px', borderRadius: 4,
        background: 'rgba(255,255,255,0.03)', border: `1px solid ${LINE.faint}`,
        font: `11px/1.55 ${MONO}`, color: tone, whiteSpace: 'pre-wrap',
        wordBreak: 'break-word', maxHeight: 260, overflow: 'auto',
      }}>
        {value}
      </pre>
    </div>
  );
}

export default function AgentStep({ turn, live }: { turn: Turn; live: boolean }) {
  // Open while it runs, and whatever the reader chose after that. Closing
  // itself under someone who is reading it would be worse than staying open,
  // so the manual choice wins for the rest of the turn.
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? live;
  const shown = turn.run;
  const result = shown?.result;

  const failed = !!result?.error;
  const seconds = result ? (result.elapsed_ms / 1000).toFixed(2) : null;

  return (
    <div style={{ marginBottom: 10 }}>
      <button
        type="button"
        className="tt-head"
        aria-expanded={open}
        onClick={() => setManual(!open)}
      >
        <RightOutlined className={`tt-chevron${open ? ' tt-chevron-open' : ''}`} />
        <span className={live ? 'tt-label tt-shimmer' : 'tt-label'}>
          {live ? '執行中' : failed ? 'Python・失敗' : 'Python'}
        </span>
        {seconds && <span className="tt-meta">{seconds}s</span>}
        {failed && (
          <span className="tt-meta" style={{ color: ACCENT.warn }}>需要重試</span>
        )}
      </button>

      {open && shown && (
        <div style={{ paddingLeft: 18 }}>
          <Line label="程式碼" value={shown.code} />
          {result?.error && (
            <Line label="錯誤" value={result.error} tone={ACCENT.error} />
          )}
          {result?.stdout.trim() && (
            <Line label="輸出" value={result.stdout} />
          )}
          {result?.stderr.trim() && (
            <Line label="STDERR" value={result.stderr} tone={ACCENT.warn} />
          )}
          {result && result.value !== null && (
            <Line label="回傳值" value={result.value} tone="#7fb8d8" />
          )}
          {/* The figures the code drew. Shown here rather than only described,
              because a plot is the answer to the question that asked for it --
              the model is told one exists but cannot be handed it, so this is
              the only place it can be seen. */}
          {result?.images.map((src, i) => (
            <Image
              key={i}
              src={src}
              style={{ marginTop: 8, borderRadius: 4, background: '#fff' }}
              width="100%"
            />
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
        </div>
      )}
    </div>
  );
}
