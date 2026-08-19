import { useCallback, useEffect, useState } from 'react';
import {
  Alert, App as AntApp, Button, Card, Empty, Space, Table, Tag, Tooltip, Typography,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { fetchRuntime, restartContainer, type RuntimeContainer, type RuntimeSurvey }
  from '../api';
import { MONO } from '../theme';

const { Text } = Typography;

/**
 * The containers this platform runs on.
 *
 * Nothing here is a fixed row. There is no "Intel" line and no "NVIDIA" line,
 * because a machine with one of those cards, or neither, or two of one, has to
 * produce a page that is right without anyone editing a table first -- so the
 * rows are whatever `docker ps` returns, and the card beside each one is read
 * from its device bindings rather than guessed from its name.
 *
 * Read-only apart from restart. Create, exec and remove are absent on purpose:
 * the console's own user is in the `docker` group, which makes those three
 * indistinguishable from a root shell, while restart only re-runs a
 * configuration somebody with access to this machine already chose.
 */

const STATE_COLOUR: Record<string, string> = {
  running: 'green', exited: 'default', created: 'default',
  restarting: 'orange', paused: 'orange', dead: 'red',
};

export default function Runtime() {
  const { message } = AntApp.useApp();
  const [survey, setSurvey] = useState<RuntimeSurvey | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchRuntime().then(setSurvey)
      .catch(() => setSurvey({ available: false, containers: [], idle_gpus: [] }));
  }, []);

  useEffect(() => {
    load();
    // Slow enough not to be a poll of any consequence, quick enough that a
    // restart is seen finishing rather than having to be checked for.
    const timer = setInterval(load, 10000);
    return () => clearInterval(timer);
  }, [load]);

  const onRestart = async (row: RuntimeContainer) => {
    setBusy(row.name);
    try {
      await restartContainer(row.name);
      message.success(`已重啟 ${row.name}`);
      load();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (survey && !survey.available) {
    return (
      <Card title="執行環境" size="small">
        <Empty description="這台機器上沒有 Docker，或主控台的使用者不在 docker 群組裡" />
      </Card>
    );
  }

  const orphans = survey?.containers.filter((c) => c.orphaned) ?? [];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {orphans.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message="有容器指定了不在這台機器上的顯示卡"
          description={
            <>
              {orphans.map((c) => c.name).join('、')} 要求了一張這裡找不到的卡。
              重啟政策會讓 Docker 一直把它拉起來，而它會失敗或悄悄退回 CPU——
              換卡之後圖生不出來，通常就是這裡。
            </>
          }
        />
      )}

      {survey && survey.idle_gpus.length > 0 && (
        <Alert
          type="info"
          showIcon
          message="有顯示卡沒有任何容器在用"
          description={
            <>
              {survey.idle_gpus.map((g) => g.name ?? g.pci_bdf_address).join('、')}
              ：沒有容器指定它。要用它得自己建一個實例——主控台不做 docker run，
              那個動作跟拿到 root shell 沒有差別。
            </>
          }
        />
      )}

      <Card
        title="執行環境"
        size="small"
        loading={survey === null}
        extra={
          <Button size="small" type="text" icon={<ReloadOutlined />} onClick={load}>
            重新整理
          </Button>
        }
      >
        <Table<RuntimeContainer>
          dataSource={survey?.containers ?? []}
          rowKey="name"
          size="small"
          pagination={false}
          columns={[
            {
              title: '容器', dataIndex: 'name', width: 170,
              render: (name: string, row) => (
                <Space size={6}>
                  <span style={{ fontFamily: MONO, fontSize: 12 }}>{name}</span>
                  {row.restart_policy !== 'no' && (
                    <Tooltip title={`重啟政策：${row.restart_policy}`}>
                      <Tag>自動重啟</Tag>
                    </Tooltip>
                  )}
                </Space>
              ),
            },
            {
              title: '映像', dataIndex: 'image',
              render: (image: string) => (
                <Text style={{ fontFamily: MONO, fontSize: 12 }} ellipsis>{image}</Text>
              ),
            },
            {
              title: '狀態', dataIndex: 'state', width: 150,
              render: (state: string, row) => (
                <Space size={6}>
                  <Tag color={STATE_COLOUR[state] ?? 'default'}>{state}</Tag>
                  <Text type="secondary" style={{ fontSize: 12 }}>{row.status}</Text>
                </Space>
              ),
            },
            {
              title: '顯示卡', width: 220,
              render: (_, row) => {
                if (!row.wants_gpu) return <Text type="secondary">—</Text>;
                if (row.orphaned) return <Tag color="warning">找不到指定的卡</Tag>;
                return (
                  <Space size={4} wrap>
                    {row.cards.map((card) => (
                      <Tooltip key={card.pci_bdf_address} title={card.pci_bdf_address}>
                        <Tag color={card.vendor === 'nvidia' ? 'green' : 'blue'}>
                          {card.name ?? card.pci_bdf_address}
                        </Tag>
                      </Tooltip>
                    ))}
                  </Space>
                );
              },
            },
            {
              title: '連接埠', dataIndex: 'ports', width: 190,
              render: (ports: string) => (
                <Text type="secondary" style={{ fontFamily: MONO, fontSize: 11 }}>
                  {ports || '—'}
                </Text>
              ),
            },
            {
              title: '', width: 100,
              render: (_, row) => (
                <Button size="small" icon={<ReloadOutlined />}
                        loading={busy === row.name}
                        onClick={() => onRestart(row)}>
                  重啟
                </Button>
              ),
            },
          ]}
        />
      </Card>
    </Space>
  );
}
