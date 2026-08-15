import { useState } from 'react';
import { RightOutlined } from '@ant-design/icons';
import './thinking.css';

/**
 * The reasoning block, as a disclosure rather than an accordion panel.
 *
 * It opens itself while the thinking is what is arriving and closes once the
 * answer starts, which is when the trace stops being the interesting thing. A
 * click overrides that for the rest of the turn — having the panel shut itself
 * under someone who is reading it would be worse than leaving it open.
 */

interface Props {
  reasoning: string;
  /** Tokens are still arriving into this block. */
  live: boolean;
  /** Wall time the block took, once it has finished. */
  ms?: number;
}

export default function ThinkingTrace({ reasoning, live, ms }: Props) {
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? live;

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
          {live ? '思考中' : '思考過程'}
        </span>
        {ms !== undefined && (
          <span className="tt-meta">{(ms / 1000).toFixed(1)}s</span>
        )}
      </button>

      <div className={`tt-body${open ? ' tt-body-open' : ''}`}>
        <div className="tt-clip">
          <div className="tt-rail">
            <div className="tt-text">{reasoning}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
