import { useCallback, useEffect, useState } from 'react';
import {
  Alert, App as AntApp, Button, Card, Dropdown, Empty, Popconfirm, Progress, Space,
  Switch, Table, Tag, Tooltip, Typography,
} from 'antd';
import { DownOutlined, ReloadOutlined } from '@ant-design/icons';
import {
  comfyAction, controlContainer, fetchRuntime, fetchRuntimes, runtimeAction,
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

  const onComfy = async (
    row: RuntimeCoverage, action: 'update' | 'remove', deleteImage = false,
  ) => {
    if (!row.comfy.container) return;
    setBusy(row.pci_bdf_address);
    try {
      await comfyAction(row.comfy.container, action, deleteImage);
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
              // The one column without a width, so the spare space collects
              // here. Everything to its right is fixed and right-aligned, so
              // the two switches and the menu read as one group at the edge
              // rather than as three things adrift at different distances.
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
                    onChange={needsPull ? undefined : (on) => setRole(row, 'llm', on)}
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
                        onConfirm={() => setRole(row, 'llm', true)}
                      >
                        {control}
                      </Popconfirm>
                    ) : control}
                  </Space>
                );
              },
            },
            {
              title: '跑 ComfyUI', width: 240, align: 'right' as const,
              render: (_, row) => {
                const job = row.comfy.job;
                if (job && ['pulling', 'starting'].includes(job.state)) {
                  return (
                    <Space direction="vertical" size={2} style={{ width: '100%' }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {job.state === 'starting'
                          ? (job.action === 'update' ? '重建實例…' : '建立實例…')
                          : '下載映像…'}
                      </Text>
                      <Progress size="small" status="active"
                                percent={job.layers_total
                                  ? Math.round((job.layers_done / job.layers_total) * 100) : 0} />
                    </Space>
                  );
                }
                if (job?.state === 'error') {
                  return (
                    <Tooltip title={job.message}>
                      <Tag color="error">{job.action === 'update' ? '更新失敗' : '建立失敗'}</Tag>
                    </Tooltip>
                  );
                }
                const none = row.containers.length === 0;
                const template = row.comfy.template;
                const control = (
                  <Switch
                    size="small"
                    checked={row.images}
                    disabled={none && !template}
                    loading={busy === row.pci_bdf_address}
                    onChange={none ? undefined : (on) => setRole(row, 'images', on)}
                  />
                );
                return (
                  <Space size={8}>
                    <Text type="secondary" style={{ fontSize: 12, fontFamily: MONO,
                                                    whiteSpace: 'nowrap' }}>
                      {none
                        ? (template ? '尚未建立' : '—')
                        : `${row.containers.map((c) => c.name).join('、')}${
                            row.comfy.image_size ? ` · ${row.comfy.image_size}` : ''}`}
                    </Text>
                    {/* Nothing on this card yet, so On is a build: a new
                        container, its own output directory, and a download in
                        the tens of gigabytes. Asks first, and names it. */}
                    {none && template ? (
                      <Popconfirm
                        title="要在這張卡上建立 ComfyUI 嗎？"
                        description={<>
                          {template.image}<br />
                          會下載映像（十幾 GB）並建立 comfyui-{row.comfy.slot}，
                          模型目錄與現有實例共用。
                          {!template.verified && <><br />這份設定沒有在這台機器上驗證過。</>}
                        </>}
                        okText="建立" cancelText="取消"
                        onConfirm={() => setRole(row, 'images', true)}
                      >
                        {control}
                      </Popconfirm>
                    ) : (
                      <Tooltip title={none && !template ? '沒有這家廠商的 ComfyUI 映像範本' : undefined}>
                        {control}
                      </Tooltip>
                    )}
                  </Space>
                );
              },
            },
            {
              title: '', width: 96, align: 'right' as const,
              render: (_, row) => {
                const state = row.state;
                const comfy = row.comfy;
                const used = state?.used_by ?? [];
                const short = state?.image?.split('/').pop() ?? '映像';
                const comfyShort = comfy.image?.split('/').pop() ?? '映像';
                if (!state?.managed && !comfy.container) return null;
                // Two groups, because a card row has two images behind it and
                // they are nothing like the same size -- the RTX card here
                // runs models from a 6.98 GB llama.cpp image and draws with a
                // 16.5 GB ComfyUI one. "delete the image" without saying which
                // is a question, not an instruction.
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
                        ...(comfy.container ? [{
                          key: 'comfy', type: 'group' as const,
                          label: `跑 ComfyUI 用的 ${comfyShort}`,
                          children: [
                            {
                              key: 'comfy-update', label: '更新並重建這個實例',
                              onClick: () => onComfy(row, 'update'),
                            },
                            {
                              key: 'comfy-remove',
                              label: `移除 ${comfy.container}（保留映像與輸出）`,
                              danger: true,
                              onClick: () => onComfy(row, 'remove'),
                            },
                            {
                              key: 'comfy-purge',
                              label: `移除並刪除 ${comfyShort}${comfy.image_size ? `（釋出 ${comfy.image_size}）` : ''}`,
                              danger: true,
                              onClick: () => onComfy(row, 'remove', true),
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
