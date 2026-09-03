/**
 * The frame every code block on this console is drawn in.
 *
 * One implementation, because there is one kind of object: a listing with a
 * name, a line-number gutter, and whatever can be done to it in the top right.
 * A fenced block in a reply and a config to paste into a file were separate
 * components with separate looks, and nobody could have said why -- they are the
 * same thing arriving from different directions, and half the value of the
 * connections page is that its snippets look like something you already know
 * how to read.
 *
 * Presentation only. What goes in the header, what the gutter counts, and what
 * the body is made of are the caller's: a reply's block offers to run itself
 * and knows about diffs, a config offers to be copied and never does either.
 */

import type { ReactNode } from 'react';
import { CodeOutlined } from '@ant-design/icons';
import './code.css';

interface Props {
  /** What this listing is: a filename, a language, a step. */
  name: ReactNode;
  /** The top right. Buttons, counts, whatever the caller has. */
  actions?: ReactNode;
  /**
   * The numbers column, already rendered as one element per line.
   *
   * Passed rather than counted here because the callers count differently: a
   * plain listing numbers 1..n, a diff numbers by hunk and skips its own
   * headers. Omitted for a single line, where a gutter is a label saying "1".
   */
  gutter?: ReactNode;
  /** The `<pre>` contents. */
  children: ReactNode;
}

export default function CodeSurface({ name, actions, gutter, children }: Props) {
  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span className="md-code-name">
          <CodeOutlined />
          <span>{name}</span>
        </span>
        {actions && <span className="md-code-actions">{actions}</span>}
      </div>
      <div className="md-code-body">
        {gutter && <div className="md-code-gutter" aria-hidden>{gutter}</div>}
        <pre className={gutter ? 'md-code-numbered' : undefined}>{children}</pre>
      </div>
    </div>
  );
}
