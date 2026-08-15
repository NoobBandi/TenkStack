import { useEffect, useState } from 'react';
import { Card, Col, Row, Tooltip, Typography } from 'antd';
import { fetchVersions, type VersionGroup } from '../api';
import { LINE, MONO } from '../theme';

const { Text } = Typography;

/**
 * What is actually installed.
 *
 * Version drift is the usual explanation when something that worked yesterday
 * does not today, and every component here reports itself somewhere different.
 * Note that llama.cpp appears twice on purpose: the checked-out source and the
 * build currently serving requests are separate facts, and they diverge as soon
 * as the repository is pulled without rebuilding.
 */
export default function Versions() {
  const [groups, setGroups] = useState<VersionGroup[] | null>(null);

  useEffect(() => {
    fetchVersions().then(setGroups).catch(() => setGroups([]));
  }, []);

  return (
    <Card size="small" title={<span style={{ fontSize: 12, opacity: 0.75 }}>版本</span>}
          loading={groups === null}>
      <Row gutter={[20, 14]}>
        {(groups ?? []).map((group) => (
          <Col key={group.title} xs={24} sm={12} xl={6}>
            <Text style={{ fontSize: 10, letterSpacing: 1, opacity: 0.4 }}>
              {group.title}
            </Text>
            <div style={{ marginTop: 6 }}>
              {group.rows.map((row) => (
                <div
                  key={row.label}
                  style={{
                    display: 'flex', justifyContent: 'space-between', gap: 10,
                    padding: '3px 0', borderBottom: `1px solid ${LINE.faint}`,
                  }}
                >
                  <Text style={{ fontSize: 11, opacity: 0.55, whiteSpace: 'nowrap' }}>
                    {row.label}
                  </Text>
                  <Tooltip title={row.value.length > 22 ? row.value : undefined}>
                    <Text style={{
                      fontSize: 11, fontFamily: MONO, textAlign: 'right',
                      // An unprobed component reads as unknown, not as absent.
                      opacity: row.value === '—' ? 0.3 : 0.9,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      maxWidth: 150,
                    }}>
                      {row.value}
                    </Text>
                  </Tooltip>
                </div>
              ))}
            </div>
          </Col>
        ))}
      </Row>
    </Card>
  );
}
