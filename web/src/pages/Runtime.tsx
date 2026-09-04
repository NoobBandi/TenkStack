import { useCallback, useEffect, useState } from 'react';
import {
  Alert, App as AntApp, Button, Card, Dropdown, Empty, Popconfirm, Progress, Space,
  Switch, Table, Tag, Tooltip, Typography,
} from 'antd';
import { DownOutlined, ReloadOutlined } from '@ant-design/icons';
import {
  controlContainer, fetchRuntime, fetchRuntimes, runtimeAction,
  setCardRole,
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

const STATE_LABEL: Record<string, string> = {
  running: '執行中', exited: '已停止', created: '已建立',
  restarting: '重啟中', paused: '已暫停', dead: '異常',
};

/**
 * The time out of Docker's status line, in this page's language.
 *
 * `docker ps` answers with a sentence -- "Up 2 days", "Exited (0) 5 minutes
 * ago" -- whose first half is the state the tag beside it already carries. So
 * the state is dropped and only the duration kept, which is the part the tag
 * cannot say. Left as it came if the shape is unfamiliar: a Docker version
 * that words it differently should show something rather than nothing.
 */
const UNITS: [RegExp, string][] = [
  [/\bLess than a second\b/, '不到 1 秒'],
  // "About an hour" means one of them, and dropping the article would drop the
  // count with it -- the result read 約 小時.
  [/\bAbout an? \b/, '約 1 '],
  [/\bseconds?\b/, '秒'], [/\bminutes?\b/, '分鐘'], [/\bhours?\b/, '小時'],
  [/\bdays?\b/, '天'], [/\bweeks?\b/, '週'], [/\bmonths?\b/, '個月'],
  [/\byears?\b/, '年'],
];

function since(status: string): string {
  // The state word, and the exit code that comes with it, are what the tag
  // beside this already says.
  let text = status.trim()
    .replace(/^(Exited|Restarting)\s*\([^)]*\)\s*/, '')
    .replace(/^(Up|Created|Paused|Dead)\s*/, '')
    .replace(/\s*\((healthy|unhealthy|health: starting)\)/, '');
  for (const [pattern, word] of UNITS) text = text.replace(pattern, word);
  return text.replace(/\s*ago$/, '前').trim() || '—';
}

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

  // Models only. The images half of this call is the ComfyUI page's, and a
  // card's llm role belongs to a backend rather than to the card -- which is
  // why the busy marker is keyed on the vendor: two cards of one make can only
  // have the runtime installed or not, together.
  const setRole = async (row: RuntimeCoverage, on: boolean) => {
    setBusy(row.vendor);
    try {
      await setCardRole(row.pci_bdf_address ?? '', 'llm', on);
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
          
          One row per card and one switch: does this card serve models. That is
          a setup decision rather than a daily one -- turning it on is a
          multi-gigabyte pull the first time -- and it is not a stored
          preference: the switch reads the machine, and flipping it changes the
          machine rather than a record of intent.
      
          Drawing images used to be a second switch beside it. It belongs to
          the ComfyUI page, which decides the same thing with everything that
          actually goes into it: which cards, which port, which arguments. */}
      <Card title="推論執行環境" size="small" loading={cards.length === 0}
            extra={<Text type="secondary" style={{ fontSize: 12 }}>
              每張卡要不要能跑模型。第一次開啟會下載映像，通常只設定一次。
            </Text>}>
        <Table<RuntimeCoverage>
          dataSource={cards}
          rowKey={(row) => row.pci_bdf_address ?? row.name ?? row.vendor}
          size="small"
          pagination={false}
          columns={[
            {
              // The one column without a width, so the spare space collects
                // here. Everything to its right is fixed and right-aligned, so
                // the switch and the menu read as one group at the edge rather
                // than as two things adrift at different distances.
                title: '顯示卡',
              render: (_, row) => (
                <Space size={6}>
                  <span>{row.name ?? row.pci_bdf_address}</span>
                  <Tag color={row.vendor === 'nvidia' ? 'green' : 'blue'}>{row.vendor}</Tag>
                </Space>
              ),
            },
            {
              title: '跑模型', width: 210, align: 'right' as const,
              render: (_, row) => {
                const state = row.state;
                const job = state?.install ?? null;
                const working = !!job && ['pulling', 'writing'].includes(job.state);
                if (working) {
                  return (
                    <Space direction="vertical" size={2} style={{ width: '100%' }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {job!.state === 'writing' ? '寫入設定…' : '下載映像…'}
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
                // Short enough not to wrap in the column it lives in: the tag
                // alone identifies these images, and the repository in front
                // of it wrapped the cell onto two ragged lines.
                const tagOf = (image?: string | null) => image?.split(':').pop() ?? '';
                const why = row.llm
                  ? (state?.managed
                      ? `${tagOf(state.image)}${state.image_size ? ` · ${state.image_size}` : ''}`
                      : '原生建置')
                  : state?.managed ? '已安裝，未啟用' : `要下載 ${tagOf(row.runtime?.image)}`;
                const control = (
                  <Switch
                    size="small"
                    checked={row.llm}
                    loading={busy === row.vendor}
                    disabled={!row.runtime && !row.llm}
                    onChange={needsPull ? undefined : (on) => setRole(row, on)}
                    onClick={needsPull ? () => undefined : undefined}
                  />
                );
                return (
                  <Space size={8}>
                    <Tooltip title={[
                      state?.image,
                      row.shared_switch && '這台有多張同廠商的卡，這個開關會一起影響它們',
                      !state?.managed && row.llm && '這個執行環境不是主控台安裝的',
                    ].filter(Boolean).join('　')}>
                      <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                        {why}
                      </Text>
                    </Tooltip>
                    {needsPull ? (
                      <Popconfirm
                        title="要下載這個執行環境嗎？"
                        description={<>
                          {row.runtime?.image}<br />
                          {row.runtime && !row.runtime.verified && '這份設定沒有在這台機器上驗證過。'}
                        </>}
                        okText="下載並啟用"
                        cancelText="取消"
                        onConfirm={() => setRole(row, true)}
                      >
                        {control}
                      </Popconfirm>
                    ) : control}
                  </Space>
                );
              },
            },
            {
              title: '', width: 96, align: 'right' as const,
              render: (_, row) => {
                const state = row.state;
                const used = state?.used_by ?? [];
                const short = state?.image?.split('/').pop() ?? '映像';
                if (!state?.managed) return null;
                // Only the inference runtime. The ComfyUI image that used to sit
                // beside it here belongs to the ComfyUI page, which builds, updates
                // and removes an instance with all the detail that actually decides
                // one -- which cards, which port, which extra arguments. Two pages
                // issuing the same command was one too many, and this was the weaker.
                return (
                  <Dropdown
                    menu={{
                      items: [
                        ...(state?.managed ? [{
                          key: 'llm', type: 'group' as const,
                          label: `跑模型用的 ${short}`,
                          children: [
                            { key: 'update', label: '更新這個映像',
                              onClick: () => act(row, 'update') },
                            // Two removals, because reclaiming disk and
                            // changing what a card does are different
                            // decisions, and only one takes a long download to
                            // undo.
                            {
                              key: 'remove', label: '解除安裝（保留映像）', danger: true,
                              disabled: used.length > 0,
                              onClick: () => act(row, 'remove'),
                            },
                            {
                              key: 'purge',
                              label: `解除安裝並刪除 ${short}${state.image_size ? `（釋出 ${state.image_size}）` : ''}`,
                              danger: true, disabled: used.length > 0,
                              onClick: () => act(row, 'remove', { delete_image: true }),
                            },
                          ],
                        }] : []),
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
        title="容器"
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
              title: '狀態', dataIndex: 'state', width: 160, align: 'right' as const,
              render: (state: string, row) => (
                <Tooltip title={row.status}>
                  <Space size={6}>
                    <Text type="secondary" style={{ fontSize: 12 }}>{since(row.status)}</Text>
                    <Tag color={STATE_COLOUR[state] ?? 'default'} style={{ marginInlineEnd: 0 }}>
                      {STATE_LABEL[state] ?? state}
                    </Tag>
                  </Space>
                </Tooltip>
              ),
            },
            {
              title: '顯示卡', width: 220, align: 'right' as const,
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
              title: '連接埠', dataIndex: 'ports', width: 190, align: 'right' as const,
              render: (ports: string) => (
                <Text type="secondary" style={{ fontFamily: MONO, fontSize: 11 }}>
                  {ports || '—'}
                </Text>
              ),
            },
            {
              title: '', width: 104, align: 'right' as const,
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
