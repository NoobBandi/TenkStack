import { useCallback, useEffect, useState } from 'react';
import {
  Alert, App as AntApp, Button, Card, Dropdown, Empty, Popconfirm, Progress, Space,
  Switch, Table, Tag, Tooltip, Typography,
} from 'antd';
import { DownOutlined, ReloadOutlined } from '@ant-design/icons';
import Sparkline from '../components/Sparkline';
import { useStream } from '../stream';
import {
  controlContainer, fetchContainerHistory, fetchRuntime, fetchRuntimes,
  pullPercent, runtimeAction,
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

/** Bytes as the unit a container's memory is actually discussed in. */
const mib = (bytes: number) =>
  (bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GiB`
    : `${Math.round(bytes / 1024 ** 2)} MiB`);

/** Bytes per second, in the unit the number is actually read in. */
const rate = (bytes: number) =>
  (bytes >= 1024 ** 2
    ? `${(bytes / 1024 ** 2).toFixed(1)} MB/s`
    : bytes >= 1024
      ? `${Math.round(bytes / 1024)} kB/s`
      : `${Math.round(bytes)} B/s`);

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
  // The window before the page opened, from the server's buffer; the live feed
  // below only carries what happens next, and an empty chart on a page somebody
  // opened *because* something went wrong is the wrong answer.
  type Point = { t: number; memory: number; cpu: number | null;
                 rx: number | null; tx: number | null };
  const [usage, setUsage] = useState<Record<string, Point[]>>({});
  const { containers: live } = useStream();

  useEffect(() => {
    fetchContainerHistory(900, 240)
      .then((h) => setUsage(h.series))
      .catch(() => undefined);
  }, []);

  // Each live sample appended to the series it belongs to, capped so a page
  // left open overnight does not grow without bound.
  useEffect(() => {
    if (!live.length) return;
    setUsage((prev) => {
      const next = { ...prev };
      for (const sample of live) {
        const series = next[sample.name] ?? [];
        if (series.length && series[series.length - 1].t === sample.t) continue;
        next[sample.name] = [...series, {
          t: sample.t, memory: sample.memory, cpu: sample.cpu_percent,
          rx: sample.net_rx, tx: sample.net_tx,
        }].slice(-240);
      }
      return next;
    });
  }, [live]);

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

  // The switch, with the first-time pull it may set off. Lifted out of the
  // column it used to be, because this side of the page is a third of a
  // screen wide now and the controls stack under the card's name.
  /** One metric of one container: its shape over the window, and its value now.
   *  Stacked, because a chart and its number side by side in a table column
   *  leaves the chart too narrow to have a shape at all. */
  const trace = (
    points: Point[] | undefined,
    pick: (p: Point) => number | null,
    format: (v: number) => string,
    colour: string,
  ) => {
    const series = (points ?? []).map(pick);
    const live = series.length ? series[series.length - 1] : null;
    if (live == null) {
      return <Text type="secondary" style={{ fontSize: 12 }}>—</Text>;
    }
    return (
      <Space direction="vertical" size={2} align="end" style={{ width: '100%' }}>
        <Sparkline values={series.map((v) => v ?? 0)} width={110} height={26}
                   colour={colour} title={`最近 15 分鐘，目前 ${format(live)}`} />
        <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO }}>
          {format(live)}
        </Text>
      </Space>
    );
  };

  const runtimeCell = (row: RuntimeCoverage) => {
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
                      percent={pullPercent(job!)} />
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
  };

  // Update or uninstall the runtime image on this card.
  const maintenanceCell = (row: RuntimeCoverage) => {
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
      {/* Two columns, because the page holds two unrelated jobs.

          On the left, setting the machine up: which cards can serve models,
          which is answered once and then not thought about again. On the right,
          watching it run: what is up, on what, since when, and what its memory
          has been doing. Stacked, the setup table sat across the full width for
          two rows and pushed the thing anyone actually opens this page for below
          the fold.

          The warnings stay above both. They are conditions, not a section --
          somebody arriving because a container will not start needs to meet them
          before deciding which half to read. */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'stretch',
                    flexWrap: 'wrap' }}>
        {/* Stretched, not flex-start. The two cards hold different amounts --
            two cards of hardware against however many containers -- so left to
            themselves they end at different heights and the pair reads as
            ragged. Both fill the row instead; each Card takes height 100% so
            the stretch reaches the card rather than stopping at the div. */}
        <div style={{ flex: '1 1 320px', minWidth: 0, maxWidth: 420, display: 'flex' }}>
        {/* What each card is for.
          
            One row per card and one switch: does this card serve models. That is
            a setup decision rather than a daily one -- turning it on is a
            multi-gigabyte pull the first time -- and it is not a stored
            preference: the switch reads the machine, and flipping it changes the
            machine rather than a record of intent.
      
            Drawing images used to be a second switch beside it. It belongs to
            the ComfyUI page, which decides the same thing with everything that
            actually goes into it: which cards, which port, which arguments. */}
        {/* The sentence sits in the body, not in `extra`.
            In a column a third of a screen wide it wrapped to three lines and
            made this card's header taller than the one beside it, so the two
            tables started at different heights and the columns read as
            misaligned. Both headers are one line now. */}
        <Card title="推論執行環境" size="small" loading={cards.length === 0}
                style={{ width: '100%' }}>
          <Text type="secondary"
                style={{ fontSize: 12, display: 'block', marginBottom: 10 }}>
            每張卡要不要能跑模型。第一次開啟會下載映像，通常只設定一次。
          </Text>
          <Table<RuntimeCoverage>
            dataSource={cards}
            rowKey={(row) => row.pci_bdf_address ?? row.name ?? row.vendor}
            size="small"
            pagination={false}
            // One column of stacked blocks: a header saying 顯示卡 over a list
            // of cards, directly under a card titled 推論執行環境, is a label
            // for something already labelled twice.
            showHeader={false}
            columns={[
              {
                // The one column without a width, so the spare space collects
                  // here. Everything to its right is fixed and right-aligned, so
                  // the switch and the menu read as one group at the edge rather
                  // than as two things adrift at different distances.
                  title: '顯示卡',
                render: (_, row) => (
                  // Stacked rather than side by side: "Intel(R) Arc(TM) Pro B70
                  // Graphics" is thirty-three characters and this column is a
                  // third of a screen wide, so a name and a switch on one line
                  // would either truncate the name or wrap it mid-word.
                  <Space direction="vertical" size={6} style={{ width: '100%' }}>
                    <Space size={6}>
                      <Text style={{ fontSize: 12 }}>{row.name ?? row.pci_bdf_address}</Text>
                      <Tag color={row.vendor === 'nvidia' ? 'green' : 'blue'}
                           style={{ marginInlineEnd: 0 }}>{row.vendor}</Tag>
                    </Space>
                    <Space size={8} style={{ width: '100%', justifyContent: 'space-between' }}>
                      {runtimeCell(row)}
                      {maintenanceCell(row)}
                    </Space>
                  </Space>
                ),
              },
            ]}
          />
        </Card>
        </div>
        <div style={{ flex: '3 1 520px', minWidth: 0, display: 'flex' }}>
        <Card
          title="容器"
          size="small"
          style={{ width: '100%' }}
          loading={survey === null}
          extra={
            <Button size="small" type="text" icon={<ReloadOutlined />} onClick={load}>
              重新整理
            </Button>
          }
        >
          <Table<RuntimeContainer>
            // Stacked cells make tall rows, and antd's small table still pads as
            // though every row were one line. Tightened here rather than by
            // shrinking the content: the second line in each cell is the point.
            className="rt-tight"
            dataSource={survey?.containers ?? []}
            rowKey="name"
            size="small"
            pagination={false}
            columns={[
              {
                // The name with the ports under it. They were separate columns
                // at opposite ends of the row, and together they answer one
                // question: this is the thing, and this is where you reach it.
                title: '容器', dataIndex: 'name',
                render: (name: string, row) => (
                  <Space direction="vertical" size={0}>
                    <Space size={6}>
                      <span style={{ fontFamily: MONO, fontSize: 12 }}>{name}</span>
                      {row.restart_policy !== 'no' && (
                        <Tooltip title={`重啟政策：${row.restart_policy}`}>
                          <Tag style={{ marginInlineEnd: 0 }}>自動重啟</Tag>
                        </Tooltip>
                      )}
                    </Space>
                    {row.ports && (
                      <Text type="secondary" style={{ fontFamily: MONO, fontSize: 11 }}>
                        {row.ports}
                      </Text>
                    )}
                  </Space>
                ),
              },
              {
                // The image with the cards it claimed under it -- also one
                // question rather than two: what is running, and on what.
                title: '映像', dataIndex: 'image',
                render: (image: string, row) => (
                  <Space direction="vertical" size={2} style={{ minWidth: 0 }}>
                    <Text style={{ fontFamily: MONO, fontSize: 12 }} ellipsis>{image}</Text>
                    {row.wants_gpu && (
                      row.orphaned
                        ? <Tag color="warning" style={{ marginInlineEnd: 0 }}>找不到指定的卡</Tag>
                        : (
                          <Space size={4} wrap>
                            {row.cards.map((card) => (
                              <Tooltip key={card.pci_bdf_address} title={card.pci_bdf_address}>
                                <Tag color={card.vendor === 'nvidia' ? 'green' : 'blue'}
                                     style={{ marginInlineEnd: 0 }}>
                                  {card.name ?? card.pci_bdf_address}
                                </Tag>
                              </Tooltip>
                            ))}
                          </Space>
                        )
                    )}
                  </Space>
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
              // Three columns rather than three charts in one cell: they are
              // three different questions -- is it working, is it growing, is it
              // talking -- and a reader compares one metric down the rows, not
              // three metrics across a row.
              //
              // Each one scales from zero to its own window maximum. A CPU axis
              // fixed at 100% would draw every one of these containers as a flat
              // line on the floor, which is true and useless; what the reader
              // wants to see is whether this container is doing more than it was
              // a minute ago.
              title: 'CPU', width: 130, align: 'right' as const,
              render: (_, row) => trace(usage[row.name], (p) => p.cpu,
                                        (v) => `${v.toFixed(1)}%`, '#6ea8d8'),
            },
            {
              title: '記憶體', width: 130, align: 'right' as const,
              render: (_, row) => trace(usage[row.name], (p) => p.memory,
                                        mib, '#7fb069'),
            },
            {
              title: '網路', width: 150, align: 'right' as const,
              render: (_, row) => {
                const points = usage[row.name] ?? [];
                const live = points.length ? points[points.length - 1] : null;
                if (!live || live.rx == null) {
                  return <Text type="secondary" style={{ fontSize: 12 }}>—</Text>;
                }
                // In and out on one pair of axes, because they are the same
                // quantity measured in two directions and the interesting
                // moments -- a model coming down, an image going out -- are
                // exactly when one of them is not like the other.
                return (
                  <Space direction="vertical" size={2} align="end"
                         style={{ width: '100%' }}>
                    <Sparkline
                      values={points.map((p) => p.rx ?? 0)}
                      second={points.map((p) => p.tx ?? 0)}
                      title={`最近 15 分鐘的網路：下載 ${rate(live.rx)}，上傳 ${rate(live.tx ?? 0)}`}
                      width={130}
                      height={26}
                      colour="#c98f4b"
                      secondColour="#a8709e"
                    />
                    <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO }}>
                      ↓{rate(live.rx)}　↑{rate(live.tx ?? 0)}
                    </Text>
                  </Space>
                );
              },
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
        </div>
      </div>
    </Space>
  );
}
