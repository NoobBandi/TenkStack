import { Card, Tooltip, Typography } from 'antd';
import { InfoCircleOutlined } from '@ant-design/icons';

const { Text } = Typography;

/**
 * Cards of rows, shared by the settings and connections pages so the two read
 * alike.
 *
 * One group as a card: its title, with an info mark when the group needs
 * explaining, anything that acts on the whole group at the header's right,
 * and its rows edge to edge, divided by hairlines (index.css). It fills its
 * grid cell, so cards side by side match in height.
 */
export function Panel({ title, info, extra, children }: {
  title: string; info?: React.ReactNode; extra?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <Card
      size="small"
      style={{ height: '100%' }}
      styles={{ body: { padding: 0 } }}
      extra={extra}
      title={(
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {title}
          {info && (
            <Tooltip title={info} styles={{ root: { maxWidth: 360 } }}>
              <InfoCircleOutlined style={{ fontSize: 12, opacity: 0.45, cursor: 'help', fontWeight: 400 }} />
            </Tooltip>
          )}
        </span>
      )}
    >
      <div className="settings-box">{children}</div>
    </Card>
  );
}

/**
 * One row: the name with an info mark when there is more to say, a line
 * under it, the control on the right, and anything that opens from the row
 * below them at full width.
 */
export function Row({ label, note, detail, right, children }: {
  label: React.ReactNode; note?: React.ReactNode; detail?: React.ReactNode;
  right?: React.ReactNode; children?: React.ReactNode;
}) {
  return (
    <div style={{ padding: '12px 16px' }}>
      {/* The name gives way first -- its line wraps -- so a card three to a
          row keeps its controls beside it; only on a phone do they go under.
          240 px here put the controls of a 450 px card on a line of their own. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 16, rowGap: 8 }}>
        <div style={{ flex: '1 1 140px', minWidth: 0 }}>
          <div style={{ fontSize: 14, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {label}
            {detail && (
              <Tooltip title={detail} styles={{ root: { maxWidth: 360 } }}>
                <InfoCircleOutlined style={{ fontSize: 12, opacity: 0.45, cursor: 'help' }} />
              </Tooltip>
            )}
          </div>
          {note && (
            <Text type="secondary" style={{
              fontSize: 12, display: 'block', marginTop: 2, lineHeight: 1.5, overflowWrap: 'anywhere',
            }}>
              {note}
            </Text>
          )}
        </div>
        {right && (
          <div style={{ flex: 'none', maxWidth: '100%', display: 'flex', alignItems: 'center', gap: 8 }}>
            {right}
          </div>
        )}
      </div>
      {children && <div style={{ marginTop: 12 }}>{children}</div>}
    </div>
  );
}

