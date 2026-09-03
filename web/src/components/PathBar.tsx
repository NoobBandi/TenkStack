import { useEffect, useRef, useState } from 'react';
import { Dropdown, Input, Tooltip, Typography } from 'antd';
import type { InputRef } from 'antd';
import { EditOutlined } from '@ant-design/icons';
import { MONO } from '../theme';

const { Text } = Typography;

/**
 * Where you are, as the path it actually is.
 *
 * This was a breadcrumb of labels -- 模型 / checkpoints -- which reads well and
 * answers the wrong question. The directory has a real path, that path is what
 * appears in a ComfyUI node, a shell command or an error message, and hiding it
 * behind a friendly name means copying it out of the interface is impossible
 * and pasting one in is unthinkable.
 *
 * So it shows the path and it is also the way to change it, which is the same
 * arrangement every browser address bar and every file manager since Explorer
 * has settled on: segments to click, one click away from a text field.
 *
 * The root's own path is dimmed rather than omitted. It is context -- you are
 * inside it and cannot leave upwards -- but it is still part of what you would
 * copy.
 */

interface Props {
  /** Absolute path of the root, dimmed and not divisible. */
  rootPath: string;
  /** Relative to the root, possibly empty. */
  path: string;
  /** '' means the root itself. */
  onSegment: (relative: string) => void;
  /** Whatever was typed, absolute, for the backend to resolve. */
  onSubmit: (absolute: string) => void;
  /** Raised from the page so Ctrl-L can open this from anywhere. */
  editing: boolean;
  onEditing: (editing: boolean) => void;
}

export default function PathBar({
  rootPath, path, onSegment, onSubmit, editing, onEditing,
}: Props) {
  const segments = path ? path.split('/') : [];
  const absolute = path ? `${rootPath}/${path}` : rootPath;
  // Four is where a path stops being readable at a glance in the width this bar
  // gets. Counted rather than measured: measuring would need a layout pass per
  // render to answer a question whose answer barely changes.
  const MAX_SEGMENTS = 4;
  const overflow = Math.max(0, segments.length - MAX_SEGMENTS);
  const hidden = segments.slice(0, overflow);
  const shown = segments.slice(overflow);
  const [draft, setDraft] = useState(absolute);
  const field = useRef<InputRef>(null);

  useEffect(() => {
    if (!editing) return;
    setDraft(absolute);
    // Selected, not just focused: the point of opening this is nearly always to
    // replace the path rather than to append to it.
    const timer = setTimeout(() => field.current?.select(), 0);
    return () => clearTimeout(timer);
  }, [editing, absolute]);

  if (editing) {
    return (
      <Input
        ref={field}
        size="small"
        value={draft}
        style={{ fontFamily: MONO, fontSize: 12 }}
        onChange={(e) => setDraft(e.target.value)}
        onPressEnter={() => onSubmit(draft)}
        onKeyDown={(e) => { if (e.key === 'Escape') onEditing(false); }}
        // Not on blur-to-submit: clicking away from a half-typed path would
        // navigate somewhere nobody asked for.
        onBlur={() => onEditing(false)}
      />
    );
  }

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 2,
        fontFamily: MONO, fontSize: 12, minWidth: 0,
      }}
    >
      <Tooltip title={absolute}>
        <a
          onClick={() => onSegment('')}
          style={{ opacity: 0.45, whiteSpace: 'nowrap' }}
        >
          {rootPath}
        </a>
      </Tooltip>
      {/* Deep paths collapse from the left, which is where the least useful
          segments are: you know which root you are in, and the tail is what
          says where you are now. An ellipsis holds the hidden span and opens a
          menu of it rather than dropping it -- the segments are still the way
          to go up, and losing them would make a deep directory a dead end. */}
      {hidden.length > 0 && (
        <span style={{ display: 'flex', alignItems: 'center' }}>
          <Text style={{ opacity: 0.3 }}>/</Text>
          <Dropdown
            trigger={['click']}
            menu={{
              items: hidden.map((segment, i) => ({
                key: segment + i,
                label: segment,
                onClick: () => onSegment(segments.slice(0, i + 1).join('/')),
              })),
            }}
          >
            <a style={{ opacity: 0.55, padding: '0 2px' }}>…</a>
          </Dropdown>
        </span>
      )}
      {shown.map((segment, si) => {
        const i = si + hidden.length;
        const last = i === segments.length - 1;
        const relative = segments.slice(0, i + 1).join('/');
        return (
          // baseline, not the container's default stretch: the last segment is
          // a Text with `ellipsis`, which lays out as a block, so stretched
          // beside a plain `/` the two sat at different heights and their glyphs
          // stopped sharing a line. The dropdown's span already said center;
          // this one never did.
          <span key={relative} style={{
            display: 'flex', alignItems: 'baseline', minWidth: 0,
          }}>
            <Text style={{ opacity: 0.3 }}>/</Text>
            {last ? (
              <Text style={{ fontFamily: MONO, fontSize: 12 }} ellipsis>{segment}</Text>
            ) : (
              <a onClick={() => onSegment(relative)} style={{ whiteSpace: 'nowrap' }}>
                {segment}
              </a>
            )}
          </span>
        );
      })}
      <Tooltip title="編輯路徑（Ctrl+L）">
        <EditOutlined
          onClick={() => onEditing(true)}
          style={{ fontSize: 11, opacity: 0.35, marginLeft: 8, cursor: 'pointer' }}
        />
      </Tooltip>
    </div>
  );
}
