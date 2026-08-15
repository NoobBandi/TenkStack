import { Button, Space, Tooltip, Typography } from 'antd';
import { CloseOutlined, ReloadOutlined } from '@ant-design/icons';
import HtmlPreview from './HtmlPreview';
import type { PreviewTarget } from './preview';
import { MONO } from '../theme';

const { Text } = Typography;

/**
 * The contents of the preview panel: a heading strip and the sandboxed frame.
 *
 * Only the inside. Whether this arrives as a docked column or as a drawer is a
 * question about the window's width, and that belongs to the page that knows
 * the breakpoint -- see Chat.tsx.
 */
export default function PreviewPanel({
  target, onRerun, onClose, showClose = true,
}: {
  target: PreviewTarget;
  onRerun: () => void;
  onClose: () => void;
  /** False inside a Drawer, which draws its own close button. */
  showClose?: boolean;
}) {
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 8, paddingInlineStart: 2,
      }}>
        <Text style={{ fontFamily: MONO, fontSize: 11, letterSpacing: 1, opacity: 0.45 }}>
          {target.language.toUpperCase()} 預覽
        </Text>
        <Space size={0}>
          <Tooltip title="重新執行">
            <Button type="text" size="small" icon={<ReloadOutlined />} onClick={onRerun} />
          </Tooltip>
          {showClose && (
            <Tooltip title="關閉">
              <Button type="text" size="small" icon={<CloseOutlined />} onClick={onClose} />
            </Tooltip>
          )}
        </Space>
      </div>
      {/* The frame fills what is left, rather than carrying a height of its own:
          a preview docked to the window edge should be as tall as the window. */}
      <div className="md-preview" style={{ flex: 1, minHeight: 0 }}>
        <HtmlPreview
          source={target.source}
          language={target.language}
          runId={target.runId}
        />
      </div>
    </div>
  );
}
