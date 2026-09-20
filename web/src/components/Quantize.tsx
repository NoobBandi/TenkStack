import { useEffect, useMemo, useState } from 'react';
import {
  Alert, App as AntApp, Button, Modal, Popconfirm, Progress, Radio, Segmented, Select, Space, Typography,
} from 'antd';
import { CloseOutlined, ReloadOutlined } from '@ant-design/icons';
import {
  buildQuantTool, cancelQuant, fetchQuant, startQuant, unloadAll,
  type GpuSample, type ModelFile, type QuantJob, type QuantPage, type QuantScheme,
} from '../api';
import { ACCENT, MONO } from '../theme';

const { Text } = Typography;

/**
 * Quantising a model on this machine.
 *
 * A bf16 safetensors directory goes in; a smaller directory comes out beside
 * it, named the way publishers name their own quantised repos, and shows up
 * in the file list like a download would: FP8 or Int8 in minutes, AutoRound
 * Int4 tuned against calibration text, all of them for vLLM. GGUF stays
 * with llama.cpp's own tools and the quants publishers already ship.
 *
 * The tool is auto-round in a container built from the vLLM image, so the
 * first use on a vendor builds that image. One job at a time: the card is
 * the bottleneck, and the tuning wants it to itself.
 */

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

// Timed on one Arc Pro B70 with an 8B model; a bigger model takes
// proportionally longer, a faster card less.
const SPEED: Record<string, { label: string; note: string }> = {
  standard: { label: '標準', note: '200 輪校準，8B 模型在一張卡上約 40 分鐘' },
  fast: { label: '快速', note: '50 輪校準，8B 約 10 分鐘，品質略降' },
  rtn: { label: '不校準', note: '直接四捨五入，幾分鐘；品質跟線上量化一樣' },
};

const FAMILY: Record<string, string> = { safetensors: '給 vLLM', gguf: '給 llama.cpp' };

/** The modal that asks what to make of one directory. */
export function QuantizeModal({ source, gpus, open, onClose, onStarted }: {
  source: ModelFile | null;
  gpus: GpuSample[];
  open: boolean;
  onClose: () => void;
  onStarted: () => void;
}) {
  const { message } = AntApp.useApp();
  const [page, setPage] = useState<QuantPage | null>(null);
  const [scheme, setScheme] = useState('');
  const [speed, setSpeed] = useState('standard');
  const [card, setCard] = useState(0);
  const [busy, setBusy] = useState(false);

  const load = () => fetchQuant().then(setPage).catch(() => undefined);
  useEffect(() => {
    if (!open) return;
    void load();
    // The tool build takes a minute; the modal watches it finish.
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [open]);

  const chosen = page?.schemes.find((s) => s.key === scheme);
  const vendor = gpus[card]?.vendor ?? '';
  const tool = page?.tools.find((t) => t.vendor === vendor);

  const families = useMemo(() => {
    const out: Record<string, QuantScheme[]> = {};
    for (const s of page?.schemes ?? []) (out[s.family] ??= []).push(s);
    return out;
  }, [page]);

  const build = async () => {
    setBusy(true);
    try {
      await buildQuantTool(vendor);
      await load();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (!source || !chosen) return;
    setBusy(true);
    try {
      // The card has to be empty: a resident model and the tuning would
      // fight over it, and the tuning would lose.
      await unloadAll();
      await startQuant(source.filename, chosen.key, chosen.tuned ? speed : 'rtn', card);
      message.success('開始量化，進度在下面');
      onStarted();
      onClose();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const outName = source && chosen ? `${source.filename}-${chosen.suffix}` : '';
  const ready = tool?.state === 'ready';

  return (
    <Modal
      title={source ? `量化 ${source.filename.split('/').pop()}` : '量化'}
      open={open}
      onCancel={onClose}
      width={620}
      okText="開始量化"
      okButtonProps={{ disabled: !chosen || !ready || busy, loading: busy }}
      onOk={() => void start()}
      cancelText="取消"
    >
      {source && (
        <Space direction="vertical" size={16} style={{ width: '100%', marginTop: 8 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            來源是 {source.precision?.toUpperCase() ?? '原精度'} 的 {gib(source.size_bytes)}，量完會多一個資料夾放在旁邊，原本的不動。
          </Text>

          <div>
            <Text style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>目標</Text>
            <Radio.Group value={scheme} onChange={(e) => setScheme(e.target.value)} style={{ width: '100%' }}>
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                {Object.entries(families).map(([family, list]) => (
                  <div key={family}>
                    <Text type="secondary" style={{ fontSize: 11, letterSpacing: 0.6, display: 'block', marginBottom: 4 }}>
                      {FAMILY[family] ?? family}
                    </Text>
                    <Space direction="vertical" size={2}>
                      {list.map((s) => (
                        <Radio key={s.key} value={s.key}>
                          <Text style={{ fontSize: 13 }}>{s.label}</Text>
                          <Text type="secondary" style={{ fontSize: 11, marginInlineStart: 8 }}>
                            約 {gib(source.size_bytes * s.shrink)}・{s.note}
                          </Text>
                        </Radio>
                      ))}
                    </Space>
                  </div>
                ))}
              </Space>
            </Radio.Group>
          </div>

          {chosen?.tuned && (
            <div>
              <Text style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>校準</Text>
              <Segmented
                value={speed}
                onChange={(v) => setSpeed(String(v))}
                options={(page?.speeds ?? []).map((k) => ({ value: k, label: SPEED[k]?.label ?? k }))}
              />
              <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 6 }}>
                {SPEED[speed]?.note}。校準資料第一次會從 Hugging Face 抓一小份文字，之後留在本機。
              </Text>
            </div>
          )}

          {gpus.length > 1 && (
            <div>
              <Text style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>用哪張卡</Text>
              <Select
                value={card}
                onChange={setCard}
                style={{ width: '100%' }}
                options={gpus.map((g) => ({
                  value: g.index,
                  label: `${g.name}（${g.memory_total_mib ? `${Math.round(g.memory_total_mib / 1024)} GiB` : ''}）`,
                }))}
              />
            </div>
          )}

          {chosen && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              輸出到 <span style={{ fontFamily: MONO }}>{outName}</span>
              ；開始前會先把載入中的模型卸掉，ComfyUI 若佔著這張卡也請先停一下。
            </Text>
          )}

          {tool && tool.state !== 'ready' && (
            <Alert
              type={tool.state === 'error' ? 'error' : 'info'}
              showIcon
              message={
                tool.state === 'building' ? '正在建立量化工具…'
                  : tool.state === 'no-base' ? '先到「執行環境」安裝 vLLM'
                    : tool.state === 'unsupported' ? '這張卡沒有 vLLM 的版本，量化工具建立不了'
                      : tool.state === 'error' ? '量化工具建立失敗' : '還沒有量化工具'
              }
              description={
                tool.state === 'error' ? <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', margin: 0 }}>{tool.message}</pre>
                  : tool.state === 'absent' || tool.state === 'error'
                    ? '從 vLLM 的映像多裝一個 auto-round，大約一分鐘、幾百 MB，只做一次。'
                    : tool.state === 'building' ? '大約一分鐘。' : undefined
              }
              action={(tool.state === 'absent' || tool.state === 'error') && (
                <Button size="small" loading={busy} onClick={() => void build()}>建立</Button>
              )}
            />
          )}
        </Space>
      )}
    </Modal>
  );
}

/** Running and recent jobs, above the file list. */
export function QuantJobs({ jobs, onChange }: { jobs: QuantJob[]; onChange: () => void }) {
  const { message } = AntApp.useApp();
  const [open, setOpen] = useState<string | null>(null);
  if (!jobs.length) return null;
  const cancel = async (id: string) => {
    try {
      await cancelQuant(id);
      onChange();
    } catch (error) {
      message.error((error as Error).message);
    }
  };
  return (
    <Space direction="vertical" size={8} style={{ width: '100%', marginBottom: 12 }}>
      {jobs.map((j) => {
        const percent = j.blocks_total ? Math.round((j.blocks_done / j.blocks_total) * 100) : 0;
        const colour = j.state === 'error' ? ACCENT.error : j.state === 'done' ? ACCENT.ok : undefined;
        return (
          <div key={j.id} style={{ padding: '8px 12px', borderRadius: 6, background: 'rgba(255,255,255,0.03)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ fontSize: 12, fontFamily: MONO }}>{j.source}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}> → </Text>
                <Text style={{ fontSize: 12, fontFamily: MONO }}>{j.output}</Text>
                <Text type="secondary" style={{ fontSize: 11, marginInlineStart: 8 }}>
                  {j.state === 'running' ? (j.blocks_total ? `第 ${j.blocks_done}/${j.blocks_total} 層` : '準備中')
                    : j.state === 'done' ? '完成' : j.state === 'cancelled' ? '已取消' : '失敗'}
                </Text>
              </div>
              {j.state === 'running' && (
                <Popconfirm title="停止這次量化？" description="已經算好的部分會丟掉。" okText="停止" cancelText="繼續"
                            onConfirm={() => void cancel(j.id)}>
                  <Button size="small" type="text" icon={<CloseOutlined />} />
                </Popconfirm>
              )}
              {j.state !== 'running' && (
                <Button size="small" type="text" onClick={() => setOpen(open === j.id ? null : j.id)}>
                  {open === j.id ? '收起' : '記錄'}
                </Button>
              )}
            </div>
            {j.state === 'running' && (
              <Progress percent={percent} size="small" status="active" showInfo={!!j.blocks_total} />
            )}
            <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO, display: 'block', color: colour,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {j.message}
            </Text>
            {open === j.id && (
              <pre style={{ fontSize: 11, marginTop: 6, maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                {j.log.join('\n')}
              </pre>
            )}
          </div>
        );
      })}
      <Button size="small" type="text" icon={<ReloadOutlined />} onClick={onChange} style={{ alignSelf: 'flex-end' }}>
        重新整理
      </Button>
    </Space>
  );
}
