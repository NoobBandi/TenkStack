import {
  Button, Checkbox, Empty, Modal, Popconfirm, Space, Spin, Tag, Tooltip, Typography,
} from 'antd';
import { DeleteOutlined, DownloadOutlined, ReloadOutlined } from '@ant-design/icons';
import { exportBenchRun, type BenchRunRow } from '../../api';
import { LINE, MONO } from '../../theme';
import { RunMark } from './BenchResults';
import { fmtMs, fmtTps, fmtWhen, tierLabel } from './labels';

const { Text } = Typography;

const num: React.CSSProperties = { fontFamily: MONO, fontVariantNumeric: 'tabular-nums' };

/**
 * One saved run: picked or not, the letter it wears while comparing, what
 * ran and when, its two headline numbers, and export and delete.
 *
 * The row and its checkbox do different things. The row reads that run
 * alone, in place of whatever was shown; only the checkbox adds a run to
 * a comparison. A click on a second row used to add it, and somebody
 * opening another record found it set beside the last as A and B.
 */
function RunItem({ row, checked, mark, comparing, disabled, onPick, onToggle, onDelete }: {
  row: BenchRunRow; checked: boolean; mark?: number; comparing: boolean; disabled: boolean;
  onPick: () => void; onToggle: () => void; onDelete: () => void;
}) {
  return (
    <div
      role="button" tabIndex={0}
      onClick={onPick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(); } }}
      style={{
        display: 'flex', gap: 10, padding: '10px 12px', cursor: 'pointer',
        borderTop: `1px solid ${LINE.faint}`,
        background: checked ? 'rgba(255,255,255,0.06)' : undefined,
        transition: 'background 0.2s, box-shadow 0.2s',
        boxShadow: checked ? `inset 2px 0 0 ${LINE.strong}` : undefined,
      }}
    >
      {/* The checkbox and a slot the letter always has room in, so picking a
          second run does not shift the names. */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, paddingTop: 2, flex: 'none' }}
           onClick={(e) => e.stopPropagation()}>
        <Tooltip title={disabled ? undefined : checked ? '移出比較' : '加入比較'} mouseEnterDelay={0.4}>
          <Checkbox checked={checked} disabled={disabled} onChange={onToggle} aria-label="加入比較" />
        </Tooltip>
        <span style={{ width: 18, display: 'inline-flex' }}>
          {mark !== undefined && checked && comparing && <RunMark index={mark} />}
        </span>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, lineHeight: 1.4, overflowWrap: 'anywhere' }}>{row.name || row.model}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 3 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>{row.engine}</Text>
          <Tag style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: '16px', paddingInline: 5 }}>{tierLabel(row.tier)}</Tag>
          <Text type="secondary" style={{ fontSize: 12, ...num }}>{fmtWhen(row.started_at)}</Text>
        </div>
        <Text style={{ fontSize: 12, display: 'block', marginTop: 3, opacity: 0.8 }}>
          Decode <span style={num}>{fmtTps(row.gen_tps_1k)}</span> tok/s
          <span style={{ opacity: 0.5 }}> · </span>
          TTFT <span style={num}>{fmtMs(row.ttft_ms_1k)}</span> ms
        </Text>
      </div>
      <div style={{ display: 'flex', gap: 2, flex: 'none', alignItems: 'flex-start' }}
           onClick={(e) => e.stopPropagation()}>
        <Tooltip title="匯出 JSON（不含本機路徑與啟動指令）">
          <Button size="small" type="text" icon={<DownloadOutlined />}
                  aria-label="匯出" onClick={() => exportBenchRun(row.id)} />
        </Tooltip>
        <Popconfirm
          title="刪除這筆跑分紀錄？" description="刪除後無法復原。"
          okText="刪除" cancelText="取消" okButtonProps={{ danger: true }}
          onConfirm={onDelete}
        >
          <Tooltip title="刪除">
            <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label="刪除" />
          </Tooltip>
        </Popconfirm>
      </div>
    </div>
  );
}

/**
 * 跑分紀錄 as a dialog: every saved run, newest first. A row is read on its
 * own and the checkboxes build a comparison of up to `max`; either applies
 * at once to the page behind, and the dialog stays open to pick again.
 */
export default function RunsDialog({ open, onClose, rows, loading, onReload, selected, marks, max, onPick, onToggle, onDelete }: {
  open: boolean; onClose: () => void;
  rows: BenchRunRow[] | null; loading: boolean; onReload: () => void;
  selected: number[]; marks: Record<number, number>; max: number;
  onPick: (id: number) => void; onToggle: (id: number) => void; onDelete: (id: number) => void;
}) {
  const comparing = selected.length > 1;
  return (
    <Modal
      open={open} onCancel={onClose} width={640}
      title={(
        <Space size={8}>
          <span>跑分紀錄</span>
          <Tooltip title="重新整理">
            <Button size="small" type="text" icon={<ReloadOutlined />} loading={loading}
                    aria-label="重新整理" onClick={onReload} />
          </Tooltip>
        </Space>
      )}
      footer={<Button type="primary" onClick={onClose}>完成</Button>}
      styles={{ body: { padding: 0 } }}
    >
      <Text type="secondary" style={{ fontSize: 12, display: 'block', padding: '4px 12px 8px' }}>
        點一筆查看；勾左邊的方框加入比較，最多 {max} 筆
        {selected.length > 1 && <>・比較中 {selected.length} 筆</>}
      </Text>
      {rows === null ? (
        <div style={{ padding: 24, textAlign: 'center' }}><Spin /></div>
      ) : rows.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="還沒有跑分紀錄" style={{ padding: 24 }} />
      ) : (
        <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          {rows.map((row) => (
            <RunItem
              key={row.id} row={row}
              checked={selected.includes(row.id)}
              mark={marks[row.id]} comparing={comparing}
              disabled={selected.length >= max && !selected.includes(row.id)}
              onPick={() => onPick(row.id)}
              onToggle={() => onToggle(row.id)}
              onDelete={() => onDelete(row.id)}
            />
          ))}
        </div>
      )}
    </Modal>
  );
}
