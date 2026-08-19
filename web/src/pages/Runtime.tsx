import { useCallback, useEffect, useState } from 'react';
import {
  Alert, App as AntApp, Button, Card, Dropdown, Empty, Popconfirm, Progress, Space,
  Switch, Table, Tag, Tooltip, Typography,
} from 'antd';
import { DownOutlined, ReloadOutlined } from '@ant-design/icons';
import {
  controlContainer, fetchRuntime, fetchRuntimes, runtimeAction, setCardRole,
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
      await controlContainer(row.name, 'restart');
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

  const setRole = async (
    row: RuntimeCoverage, capability: 'llm' | 'images', on: boolean,
  ) => {
    setBusy(capability === 'llm' ? row.vendor : row.pci_bdf_address);
    try {
      await setCardRole(row.pci_bdf_address ?? '', capability, on);
      load();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  };

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
      {/* What each card is for.
          
          One row per card, two switches, because that is the decision anyone
          actually makes about a machine with more than one GPU: this one
          serves models, that one draws images, the big one does both. Neither
          switch is a stored preference -- both read the machine, and flipping
          one changes the machine rather than a record of intent. */}
      <Card title="顯示卡用途" size="small" loading={cards.length === 0}>
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
              title: '跑模型', width: 210,
              render: (_, row) => {
                const state = row.state;
                const job = state?.install ?? null;
                const working = !!job && ['pulling', 'writing'].includes(job.state);
                if (working) {
                  return (
                    <Space direction="vertical" size={2} style={{ width: '100%' }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {job!.state === 'writing' ? '寫入啟動器…' : '下載映像…'}
                      </Text>
                      <Progress size="small" status="active"
                                percent={job!.layers_total
                                  ? Math.round((job!.layers_done / job!.layers_total) * 100) : 0} />
                    </Space>
                  );
                }
                if (!row.runtime && !row.llm) {
                  return <Text type="secondary" style={{ fontSize: 12 }}>沒有這家廠商的範本</Text>;
                }
                // Turning it on for the first time is a multi-gigabyte pull, so
                // it asks; every later flip is instant and does not.
                const needsPull = !row.llm && !state?.managed;
                const why = row.llm
                  ? (state?.managed
                      ? `${state.image?.split('/').pop()}${state.image_size ? ` · ${state.image_size}` : ''}`
                      : '原生建置，非主控台安裝')
                  : state?.managed ? '已安裝，未啟用' : `要下載 ${row.runtime?.image.split('/').pop()}`;
                const control = (
                  <Switch
                    size="small"
                    checked={row.llm}
                    loading={busy === row.vendor}
                    disabled={!row.runtime && !row.llm}
                    onChange={needsPull ? undefined : (on) => setRole(row, 'llm', on)}
                    onClick={needsPull ? () => undefined : undefined}
                  />
                );
                return (
                  <Space size={8}>
                    {needsPull ? (
                      <Popconfirm
                        title="要下載這個執行環境嗎？"
                        description={<>
                          {row.runtime?.image}<br />
                          {row.runtime && !row.runtime.verified && '這份設定沒有在這台機器上驗證過。'}
                        </>}
                        okText="下載並啟用"
                        cancelText="取消"
                        onConfirm={() => setRole(row, 'llm', true)}
                      >
                        {control}
                      </Popconfirm>
                    ) : control}
                    <Tooltip title={row.shared_switch
                      ? '這台有多張同廠商的卡，這個開關會一起影響它們'
                      : undefined}>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {why}{row.shared_switch ? '（同廠商共用）' : ''}
                      </Text>
                    </Tooltip>
                  </Space>
                );
              },
            },
            {
              title: '跑 ComfyUI', width: 200,
              render: (_, row) => {
                const none = row.containers.length === 0;
                return (
                  <Space size={8}>
                    <Tooltip title={none ? '這張卡上沒有 ComfyUI 容器' : undefined}>
                      <Switch
                        size="small"
                        checked={row.images}
                        disabled={none}
                        loading={busy === row.pci_bdf_address}
                        onChange={(on) => setRole(row, 'images', on)}
                      />
                    </Tooltip>
                    <Text type="secondary" style={{ fontSize: 12, fontFamily: MONO }}>
                      {none ? '—' : row.containers.map((c) => c.name).join('、')}
                    </Text>
                  </Space>
                );
              },
            },
            {
              title: '', width: 90,
              render: (_, row) => {
                const state = row.state;
                if (!state?.managed) return null;
                const used = state.used_by;
                return (
                  <Dropdown
                    menu={{
                      items: [
                        { key: 'update', label: '更新映像', onClick: () => act(row, 'update') },
                        { type: 'divider' as const },
                        {
                          key: 'remove', label: '移除啟動器', danger: true,
                          disabled: used.length > 0,
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
                    <Button size="small" type="text">
                      維護 <DownOutlined />
                    </Button>
                  </Dropdown>
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
