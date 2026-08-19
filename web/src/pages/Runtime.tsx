import { useCallback, useEffect, useState } from 'react';
import {
  Alert, App as AntApp, Button, Card, Dropdown, Empty, Progress, Space, Table, Tag,
  Tooltip, Typography,
} from 'antd';
import {
  CloudDownloadOutlined, DownOutlined, ReloadOutlined,
} from '@ant-design/icons';
import {
  fetchRuntime, fetchRuntimes, restartContainer, runtimeAction,
  type RuntimeAction, type RuntimeContainer, type RuntimeCoverage, type RuntimeSurvey,
} from '../api';
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
  const [cards, setCards] = useState<RuntimeCoverage[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchRuntime().then(setSurvey)
      .catch(() => setSurvey({ available: false, containers: [], idle_gpus: [] }));
    fetchRuntimes().then(setCards).catch(() => undefined);
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

  const act = async (
    row: RuntimeCoverage, action: RuntimeAction,
    options: { variant?: string; delete_image?: boolean } = {},
  ) => {
    setBusy(row.vendor);
    try {
      await runtimeAction(row.vendor, action, options);
      load();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {/* Above the containers, because it answers the question they raise: a
          card with no runtime cannot run a model no matter what is installed
          beside it. Rows are the cards in the machine, so a host with one
          vendor, or three, needs nothing edited here. */}
      <Card title="推論執行環境" size="small" loading={cards.length === 0}>
        <Table<RuntimeCoverage>
          dataSource={cards}
          rowKey={(row) => row.pci_bdf_address ?? row.name ?? row.vendor}
          size="small"
          pagination={false}
          columns={[
            {
              title: '顯示卡',
              render: (_, row) => (
                <Space size={6}>
                  <span>{row.name ?? row.pci_bdf_address}</span>
                  <Tag color={row.vendor === 'nvidia' ? 'green' : 'blue'}>{row.vendor}</Tag>
                </Space>
              ),
            },
            {
              title: 'llama-server', width: 330,
              render: (_, row) => {
                if (row.covered) {
                  return (
                    <Space size={6} wrap>
                      <Tag color="green">可以跑模型</Tag>
                      {row.state?.image_size && (
                        <Text type="secondary" style={{ fontSize: 12, fontFamily: MONO }}>
                          {row.state.image?.split('/').pop()} · {row.state.image_size}
                        </Text>
                      )}
                    </Space>
                  );
                }
                if (row.state?.managed && !row.state.enabled) {
                  return <Tag>已安裝，未啟用</Tag>;
                }
                const job = row.state?.install ?? null;
                if (job && job.state !== 'error') {
                  const done = job.state === 'done';
                  return (
                    <Space direction="vertical" size={2} style={{ width: '100%' }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {done ? '已寫入啟動器' : job.state === 'writing' ? '寫入啟動器…' : '下載映像…'}
                      </Text>
                      <Progress
                        size="small"
                        status={done ? 'success' : 'active'}
                        percent={done ? 100 : job.layers_total
                          ? Math.round((job.layers_done / job.layers_total) * 100) : 0}
                      />
                    </Space>
                  );
                }
                if (job?.state === 'error') {
                  return <Tooltip title={job.message}><Tag color="error">安裝失敗</Tag></Tooltip>;
                }
                if (!row.runtime) {
                  return <Text type="secondary">沒有這家廠商的範本</Text>;
                }
                return (
                  <Space size={6} wrap>
                    <Text type="secondary" style={{ fontSize: 12, fontFamily: MONO }}>
                      {row.runtime.image.split('/').pop()}
                    </Text>
                    {!row.runtime.verified && (
                      <Tooltip title="這份設定是照官方文件寫的，沒有在這台機器上跑過">
                        <Tag color="warning">未驗證</Tag>
                      </Tooltip>
                    )}
                    {row.runtime.requires && (
                      <Tooltip title={`主機需要 ${row.runtime.requires}`}>
                        <Tag>需要 {row.runtime.requires}</Tag>
                      </Tooltip>
                    )}
                  </Space>
                );
              },
            },
            {
              title: '', width: 180,
              render: (_, row) => {
                if (!row.runtime) return null;
                const state = row.state;
                const working = !!state?.install
                  && ['pulling', 'writing'].includes(state.install.state);

                // A launcher this console did not write is not its business.
                // The native SYCL build covers the Arc here, and offering to
                // remove it would be offering to delete somebody's own work.
                if (!state?.managed) {
                  return row.covered ? (
                    <Text type="secondary" style={{ fontSize: 12 }}>非主控台安裝</Text>
                  ) : (
                    <Dropdown.Button
                      size="small"
                      loading={busy === row.vendor || working}
                      icon={<DownOutlined />}
                      onClick={() => act(row, 'install')}
                      menu={{
                        items: [{
                          key: 'vulkan',
                          label: '改用 Vulkan 通用映像（約 290 MB）',
                          onClick: () => act(row, 'install', { variant: 'vulkan' }),
                        }],
                      }}
                    >
                      <CloudDownloadOutlined /> 安裝
                    </Dropdown.Button>
                  );
                }

                const used = state.used_by;
                return (
                  <Dropdown.Button
                    size="small"
                    loading={busy === row.vendor || working}
                    icon={<DownOutlined />}
                    onClick={() => act(row, state.enabled ? 'update' : 'enable')}
                    menu={{
                      items: [
                        {
                          key: 'update', label: '更新映像',
                          onClick: () => act(row, 'update'),
                        },
                        {
                          key: 'disable',
                          label: used.length
                            ? `停用（${used.length} 個模型在用）`
                            : '停用（保留映像）',
                          disabled: !state.enabled || used.length > 0,
                          onClick: () => act(row, 'disable'),
                        },
                        { type: 'divider' as const },
                        {
                          key: 'remove', label: '移除啟動器',
                          danger: true, disabled: used.length > 0,
                          onClick: () => act(row, 'remove'),
                        },
                        {
                          key: 'purge',
                          label: `移除並刪除映像${state.image_size ? `（${state.image_size}）` : ''}`,
                          danger: true, disabled: used.length > 0,
                          onClick: () => act(row, 'remove', { delete_image: true }),
                        },
                      ],
                    }}
                  >
                    {state.enabled ? '更新' : '啟用'}
                  </Dropdown.Button>
                );
              },
            },
          ]}
        />
      </Card>

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
