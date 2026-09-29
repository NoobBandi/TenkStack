import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert, App as AntApp, Button, Card, Checkbox, Drawer, Empty, Popconfirm, Progress, Space, Tag,
  Tooltip, Typography,
} from 'antd';
import { CheckCircleFilled, ExportOutlined, WarningFilled } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import {
  engineAction, type EngineAction, fetchProviders, pullPercent, pullText, type ProviderBuild, type ProviderCard, type ProvidersPage,
} from '../api';
import { useIsOwner } from '../identity';
import { ACCENT, LINE, MONO } from '../theme';

const { Text, Paragraph } = Typography;

/**
 * The inference engines: which are on this machine, which could be, and
 * installing or removing them.
 *
 * Engines are records in the registry under
 * server-go/internal/providers/engines, one directory each, so an engine
 * somebody adds there appears here with nothing else to change. A card
 * shows what a newcomer needs to choose -- what it is good at, which model
 * files it runs, whether it runs on this machine's cards -- and the drawer
 * behind it holds the builds, one per vendor with a card here, and what
 * each of them can do.
 */

const FORMAT_LABEL: Record<string, { tag: string; note: string }> = {
  gguf: { tag: 'GGUF', note: '單一檔案的量化模型，從「模型目錄」下載' },
  safetensors: { tag: 'safetensors', note: 'Hugging Face 原始格式的模型資料夾' },
};

const busy = (b: ProviderBuild) =>
  b.state.install?.state === 'pulling' || b.state.install?.state === 'writing';

/** Installed means something can start a model with it now. */
const installed = (card: ProviderCard) =>
  card.launchers.length > 0 || card.builds.some((b) => b.state.managed && b.state.enabled);

/** The icon on a light tile, so every project's mark reads on the dark
 *  console whatever colours it was drawn in. */
function EngineIcon({ card, size }: { card: ProviderCard; size: number }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: size * 0.22, background: '#f4f4f2', flex: 'none',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.06)',
    }}>
      <img src={card.icon} alt="" style={{ width: size * 0.72, height: size * 0.72, objectFit: 'contain' }} />
    </div>
  );
}

/** What this machine's cards can do with an engine, in a line. */
function MachineLine({ card }: { card: ProviderCard }) {
  const pulling = card.builds.find(busy);
  if (pulling?.state.install) {
    const i = pulling.state.install;
    const pct = pullPercent(i);
    return (
      <Space size={8} style={{ width: '100%' }}>
        <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          {i.state === 'writing' ? '設定中' : '下載中'}
        </Text>
        <Progress percent={pct} size="small" style={{ margin: 0, width: 140 }} />
      </Space>
    );
  }
  if (installed(card)) {
    return (
      <Text style={{ fontSize: 12 }}>
        <CheckCircleFilled style={{ color: ACCENT.ok, marginInlineEnd: 6 }} />
        可以使用{card.in_use.length > 0 ? `・${card.in_use.length} 個模型在用` : ''}
      </Text>
    );
  }
  if (card.builds.length === 0) {
    return <Text type="secondary" style={{ fontSize: 12 }}>這台的顯示卡沒有可用的版本</Text>;
  }
  return (
    <Space size={6} wrap>
      {card.builds.map((b) => (
        <Tag key={b.vendor} color={b.verified ? 'green' : 'gold'} style={{ marginInlineEnd: 0 }}>
          {b.vendor_label}{b.verified ? ' 已驗證' : ' 未驗證'}
        </Tag>
      ))}
    </Space>
  );
}

function EngineTile({ card, onOpen }: { card: ProviderCard; onOpen: () => void }) {
  return (
    <Card size="small" hoverable onClick={onOpen} styles={{ body: { padding: 14 } }}
          style={{ cursor: 'pointer' }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <EngineIcon card={card} size={44} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <Space size={6} wrap>
            <Text strong style={{ fontSize: 14 }}>{card.name}</Text>
            {card.default && <Tag color="blue" style={{ marginInlineEnd: 0 }}>預設</Tag>}
            {card.formats.map((f) => (
              <Tag key={f} style={{ marginInlineEnd: 0 }}>{FORMAT_LABEL[f]?.tag ?? f}</Tag>
            ))}
          </Space>
          <Paragraph type="secondary" ellipsis={{ rows: 2 }}
                     style={{ fontSize: 12, margin: '6px 0 10px', lineHeight: 1.6 }}>
            {card.summary}
          </Paragraph>
          <MachineLine card={card} />
        </div>
      </div>
    </Card>
  );
}

/** One vendor's build of an engine, with what can be done to it. */
function BuildRow({ card, build, onAction }: {
  card: ProviderCard; build: ProviderBuild;
  onAction: (action: EngineAction, opts?: { delete_image?: boolean }) => Promise<void>;
}) {
  const [dropImage, setDropImage] = useState(true);
  const st = build.state;
  const install = st.install;
  const inUse = st.used_by.length > 0;
  const lastDefault = card.default && card.launchers.length === 0
    && card.builds.filter((b) => b.state.managed && b.state.enabled).length <= 1;

  let body: React.ReactNode;
  if (busy(build) && install) {
    const pct = pullPercent(install);
    body = (
      <div>
        <Progress percent={pct} size="small" style={{ margin: 0 }} />
        <Text type="secondary" style={{ fontSize: 12 }}>
          {install.state === 'writing' ? '寫入啟動設定中' : `下載映像中（${pullText(install)}）`}
        </Text>
      </div>
    );
  } else if (!st.managed) {
    body = (
      <Space direction="vertical" size={6} style={{ width: '100%' }}>
        {install?.state === 'error' && <Alert type="error" showIcon message={install.message} />}
        {!build.verified && (
          <Text type="warning" style={{ fontSize: 12 }}>
            <WarningFilled style={{ marginInlineEnd: 6 }} />
            這個版本是照官方文件寫的，還沒在 {build.vendor_label} 的卡上實際跑過。
          </Text>
        )}
        <Popconfirm
          title={`安裝 ${card.name}（${build.vendor_label}）？`}
          description={(
            <div style={{ maxWidth: 300 }}>
              會下載映像 <code>{build.image}</code>，通常好幾 GB，時間看網速。
              {build.requires && <div>主機需要先有：{build.requires}</div>}
            </div>
          )}
          okText="安裝"
          cancelText="取消"
          onConfirm={() => onAction('install')}
        >
          <Button type="primary" size="small">安裝</Button>
        </Popconfirm>
      </Space>
    );
  } else {
    body = (
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Space size={8} wrap>
          {st.enabled
            ? <Tag color="green" style={{ marginInlineEnd: 0 }}>已安裝</Tag>
            : <Tag style={{ marginInlineEnd: 0 }}>已安裝・停用中</Tag>}
          {st.image_size && <Text type="secondary" style={{ fontSize: 12 }}>映像 {st.image_size}</Text>}
          {inUse && <Text type="secondary" style={{ fontSize: 12 }}>{st.used_by.length} 個模型在用</Text>}
        </Space>
        {st.recipe === 'outdated' && st.recommended && (
          <Alert
            type="info" showIcon
            message="有建議的新版本"
            description={(
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                <div style={{ fontFamily: MONO, fontSize: 11, wordBreak: 'break-all' }}>
                  {st.image} → {st.recommended}
                </div>
                <Popconfirm
                  title="更新到建議版本？"
                  description={(
                    <div style={{ maxWidth: 300 }}>
                      會下載 <code>{st.recommended}</code> 並改寫啟動腳本。正在跑的模型不受影響，下次載入時才會用新版。
                    </div>
                  )}
                  okText="更新" cancelText="取消"
                  onConfirm={() => onAction('upgrade')}
                >
                  <Button type="primary" size="small">更新到建議版本</Button>
                </Popconfirm>
              </Space>
            )}
          />
        )}
        {st.recipe === 'edited' && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            啟動腳本手動改過，建議版本不會自動套用。
          </Text>
        )}
        <Space size={6} wrap>
          <Popconfirm
            title="重新下載最新的映像？"
            description="正在跑的模型不受影響，下次載入時才會用新版。"
            okText="更新" cancelText="取消"
            onConfirm={() => onAction('update')}
          >
            <Button size="small">更新</Button>
          </Popconfirm>
          {!st.enabled && <Button size="small" onClick={() => onAction('enable')}>啟用</Button>}
          <Tooltip title={inUse
            ? `還有模型用它啟動：${st.used_by.join('、')}`
            : lastDefault ? '預設引擎至少要留一個能用的' : undefined}>
            <Popconfirm
              title={`移除 ${card.name}（${build.vendor_label}）？`}
              description={(
                <Checkbox checked={dropImage} onChange={(e) => setDropImage(e.target.checked)}>
                  同時刪除映像{st.image_size ? `（${st.image_size}）` : ''}
                </Checkbox>
              )}
              okText="移除" cancelText="取消" okButtonProps={{ danger: true }}
              disabled={inUse || lastDefault}
              onConfirm={() => onAction('remove', { delete_image: dropImage })}
            >
              <Button size="small" danger disabled={inUse || lastDefault}>移除</Button>
            </Popconfirm>
          </Tooltip>
        </Space>
      </Space>
    );
  }

  return (
    <div style={{ padding: '12px 0', borderBottom: `1px solid ${LINE.faint}` }}>
      <Space size={6} style={{ marginBottom: 6 }} wrap>
        <Text strong style={{ fontSize: 13 }}>{build.vendor_label}</Text>
        <Tag color={build.verified ? 'green' : 'gold'} style={{ marginInlineEnd: 0 }}>
          {build.verified ? '已驗證' : '未驗證'}
        </Tag>
      </Space>
      <div style={{ fontFamily: MONO, fontSize: 11, opacity: 0.6, marginBottom: 8, wordBreak: 'break-all' }}>
        {(st.managed && st.image) || build.image}
      </div>
      {body}
    </div>
  );
}

function EngineDrawer({ card, onClose, onAction }: {
  card: ProviderCard | null; onClose: () => void;
  onAction: (card: ProviderCard, build: ProviderBuild, action: EngineAction, opts?: { delete_image?: boolean }) => Promise<void>;
}) {
  return (
    <Drawer open={!!card} onClose={onClose} width={520} title={null} destroyOnClose>
      {card && (
        <Space direction="vertical" size={18} style={{ width: '100%' }}>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
            <EngineIcon card={card} size={64} />
            <div>
              <Space size={6}>
                <Text strong style={{ fontSize: 18 }}>{card.name}</Text>
                {card.default && <Tag color="blue" style={{ marginInlineEnd: 0 }}>預設</Tag>}
              </Space>
              <div>
                <a href={card.site} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                  官方網站 <ExportOutlined />
                </a>
              </div>
            </div>
          </div>

          <Text style={{ fontSize: 13, lineHeight: 1.8 }}>{card.summary}</Text>

          <div>
            <Text type="secondary" style={{ fontSize: 11, letterSpacing: 1 }}>能跑的模型</Text>
            {card.formats.map((f) => (
              <div key={f} style={{ marginTop: 6 }}>
                <Tag style={{ marginInlineEnd: 8 }}>{FORMAT_LABEL[f]?.tag ?? f}</Tag>
                <Text type="secondary" style={{ fontSize: 12 }}>{FORMAT_LABEL[f]?.note}</Text>
              </div>
            ))}
          </div>

          <div>
            <Text type="secondary" style={{ fontSize: 11, letterSpacing: 1 }}>在這台機器上</Text>
            {card.launchers.map((l) => (
              <div key={l} style={{ padding: '12px 0', borderBottom: `1px solid ${LINE.faint}` }}>
                <Space size={6} wrap>
                  <Text strong style={{ fontSize: 13 }}>本機編譯版</Text>
                  <Tag color="green" style={{ marginInlineEnd: 0 }}>使用中</Tag>
                  <Text type="secondary" style={{ fontFamily: MONO, fontSize: 11 }}>{l}</Text>
                </Space>
                <div>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    直接在主機上執行、手動登記在 llama-swap 設定檔裡的版本，這裡只顯示，不會更動它。
                  </Text>
                </div>
              </div>
            ))}
            {card.builds.map((b) => (
              <BuildRow key={b.vendor} card={card} build={b}
                        onAction={(action, opts) => onAction(card, b, action, opts)} />
            ))}
            {card.builds.length === 0 && card.launchers.length === 0 && (
              <Alert style={{ marginTop: 8 }} type="info" showIcon
                     message="這台機器的顯示卡目前沒有這個引擎的版本" />
            )}
          </div>

          {card.in_use.length > 0 && (
            <div>
              <Text type="secondary" style={{ fontSize: 11, letterSpacing: 1 }}>用它啟動的模型</Text>
              <div style={{ marginTop: 6 }}>
                <Space size={4} wrap>
                  {card.in_use.map((id) => <Tag key={id}>{id}</Tag>)}
                </Space>
              </div>
              <Link to="/models" style={{ fontSize: 12 }}>到「模型」頁</Link>
            </div>
          )}

          {card.default && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {card.name} 是預設引擎：新增模型時沒有特別選擇就用它，所以至少要留一個能用的版本。
            </Text>
          )}
        </Space>
      )}
    </Drawer>
  );
}

export default function Engines() {
  const owner = useIsOwner();
  const { message } = AntApp.useApp();
  const [page, setPage] = useState<ProvidersPage | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const load = useCallback(() => {
    fetchProviders().then(setPage).catch(() => setPage({ providers: [], runtimes: [] }));
  }, []);

  useEffect(() => { if (owner) load(); }, [owner, load]);

  // While something is downloading, ask again every two seconds; the
  // images are many gigabytes and the bar is the only sign of progress.
  const pulling = page?.providers.some((p) => p.builds.some(busy)) ?? false;
  useEffect(() => {
    window.clearInterval(timer.current);
    if (pulling) timer.current = window.setInterval(load, 2000);
    return () => window.clearInterval(timer.current);
  }, [pulling, load]);

  const onAction = async (
    card: ProviderCard, build: ProviderBuild,
    action: EngineAction, opts: { delete_image?: boolean } = {},
  ) => {
    try {
      await engineAction(card.key, build.vendor, action, opts);
      message.success({
        install: '開始下載', update: '開始更新', upgrade: '開始更新到建議版本', enable: '已啟用', disable: '已停用', remove: '已移除',
      }[action]);
      load();
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  if (!owner) {
    return <Alert type="info" showIcon message="推論引擎由管理員管理" />;
  }
  if (!page) return <Card loading />;

  const mine = page.providers.filter(installed);
  const more = page.providers.filter((p) => !installed(p));
  const open = page.providers.find((p) => p.key === openKey) ?? null;

  const grid: React.CSSProperties = {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(300px, 100%), 1fr))', gap: 12,
  };

  return (
    <Space direction="vertical" size={20} style={{ width: '100%', maxWidth: 1080 }}>
      <Text type="secondary" style={{ fontSize: 13, lineHeight: 1.8 }}>
        推論引擎是實際把模型跑起來的程式。llama.cpp 是預設的，任何顯示卡都能跑 GGUF 模型；
        想直接跑 Hugging Face 的 safetensors 模型、或讓很多人同時使用，可以再裝 vLLM 或 SGLang。
      </Text>

      <div>
        <Text strong style={{ display: 'block', marginBottom: 10 }}>已安裝</Text>
        {mine.length
          ? <div style={grid}>{mine.map((c) => <EngineTile key={c.key} card={c} onOpen={() => setOpenKey(c.key)} />)}</div>
          : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="還沒有安裝任何推論引擎" />}
      </div>

      {more.length > 0 && (
        <div>
          <Text strong style={{ display: 'block', marginBottom: 10 }}>可安裝</Text>
          <div style={grid}>
            {more.map((c) => <EngineTile key={c.key} card={c} onOpen={() => setOpenKey(c.key)} />)}
          </div>
        </div>
      )}

      <EngineDrawer card={open} onClose={() => setOpenKey(null)} onAction={onAction} />
    </Space>
  );
}
