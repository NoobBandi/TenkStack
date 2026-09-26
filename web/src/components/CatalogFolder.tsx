import { Button, Collapse, Descriptions, Empty, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { CloudDownloadOutlined, PlusOutlined } from '@ant-design/icons';
import type { CatalogFolder, DownloadStatus, GpuDevice, Runtime } from '../api';
import { MONO } from '../theme';

const { Text } = Typography;

/** How a stored precision reads, as the model page names it. */
const PRECISION: Record<string, string> = {
  bf16: 'BF16', fp16: 'FP16', fp32: 'FP32', fp8: 'FP8', awq: 'AWQ 4-bit', gptq: 'GPTQ 4-bit',
  int4: 'Int4', int8: 'Int8', mxfp4: 'MXFP4', compressed: '已壓縮',
};

/**
 * What a server engine keeps on each card beside the weights, at the 0.9 of the
 * card it takes: measured on vLLM's Intel build with a 27B across two B70 --
 * 1.32 GiB peak activation, 0.91 non-torch, 0.12 for the decode graphs.
 */
const RUNTIME_GIB = 2.4;
/** Below this the model loads with room for a context too short to use. */
const USEFUL_CONTEXT_GIB = 4;

/** One way to run the model here: how many cards, and in what precision. */
export interface Plan {
  cards: number;
  /** An online quantisation to apply as it loads; '' is as published. */
  quantization: string;
  label: string;
  perCardGiB: number;
  /** What is left on each card for the context (KV cache). */
  leftGiB: number;
}

/**
 * Every way of running it on this machine's cards, from the fewest cards and
 * the published precision up. Tensor parallelism takes powers of two.
 */
export function plansFor(folder: CatalogFolder, runtime: Runtime | undefined, gpus: GpuDevice[]): Plan[] {
  const cards = gpus.filter((g) => !runtime || g.vendor === runtime.vendor);
  const sizes = cards.map((g) => (g.live?.memory_total_mib ?? 0) / 1024).filter((v) => v > 0);
  if (sizes.length === 0) return [];
  const perCard = Math.min(...sizes) * 0.9;
  const precisions = [
    { value: '', label: PRECISION[folder.precision] ?? (folder.precision || '原精度'), shrink: 1 },
    // A publisher's quantisation is applied by the engine itself; another on
    // top would be refused.
    ...(folder.quantized ? [] : (runtime?.quantizations ?? []).map((q) => ({
      value: q.value, label: q.label, shrink: q.shrink,
    }))),
  ];
  const out: Plan[] = [];
  for (const n of [1, 2, 4, 8].filter((c) => c <= cards.length)) {
    for (const p of precisions) {
      const weights = (folder.size_gib * p.shrink) / n;
      out.push({
        cards: n, quantization: p.value, label: p.label,
        perCardGiB: weights, leftGiB: perCard - weights - RUNTIME_GIB,
      });
    }
  }
  return out;
}

/** The plan to suggest: the highest precision that leaves room for a useful
 *  context, on as few cards as that takes. Precision first, since a second
 *  card costs nothing but a quantised model answers worse; a squeeze only
 *  when nothing leaves room. */
export function suggested(plans: Plan[]): Plan | undefined {
  const order = [...new Set(plans.map((p) => p.quantization))];
  for (const precision of order) {
    const fits = plans.find((p) => p.quantization === precision && p.leftGiB >= USEFUL_CONTEXT_GIB);
    if (fits) return fits;
  }
  return plans.find((p) => p.leftGiB > 0);
}

function fitTag(left: number) {
  if (left >= USEFUL_CONTEXT_GIB) return <Tag color="green">放得下</Tag>;
  if (left > 0) return <Tooltip title="權重放得下，但留給上下文的空間很少，只能開很短的上下文"><Tag color="gold">勉強</Tag></Tooltip>;
  return <Tag>放不下</Tag>;
}

const gib = (v: number) => `${v.toFixed(1)} GiB`;

export default function CatalogFolderPanel({
  folder, runtime, gpus, placed, download, onDownload, onCreate,
}: {
  folder: CatalogFolder;
  /** The installed server engine a download is for; undefined when none is. */
  runtime: Runtime | undefined;
  gpus: GpuDevice[];
  placed: (ref: string) => string;
  /** This repository's download, while one is running. */
  download: DownloadStatus | undefined;
  onDownload: () => void;
  onCreate: (plan: Plan | undefined) => void;
}) {
  if (!folder.loadable) {
    return (
      <Empty style={{ margin: 'auto' }}
             description="這個儲存庫沒有 safetensors 權重或 config.json，伺服器引擎載入不了" />
    );
  }
  const plans = plansFor(folder, runtime, gpus);
  const pick = suggested(plans);
  const verified = runtime?.precisions?.includes(folder.precision);
  const running = download && !['done', 'error', 'cancelled'].includes(download.state);
  const partial = !folder.on_disk && folder.present_bytes > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '10px 12px' }}>
      <Descriptions size="small" column={2} colon={false}
                    labelStyle={{ width: 72, opacity: 0.6 }}>
        <Descriptions.Item label="精度">
          <Space size={4} wrap>
            <span>{PRECISION[folder.precision] ?? (folder.precision || '未知')}</span>
            {folder.quantized && <Tooltip title="發布者已經量化過，引擎會照這個精度載入，不能再線上量化"><Tag>已量化</Tag></Tooltip>}
            {runtime && (verified
              ? <Tooltip title={`這個精度在 ${runtime.label} 上實測載入過`}><Tag color="green">已驗證</Tag></Tooltip>
              : <Tooltip title={`這個精度還沒在 ${runtime.label} 上實測載入過，可能載不起來`}><Tag color="orange">未驗證</Tag></Tooltip>)}
          </Space>
        </Descriptions.Item>
        <Descriptions.Item label="大小">
          {gib(folder.size_gib)}
          <Text type="secondary" style={{ fontSize: 12 }}>（{folder.files.length} 個檔案）</Text>
        </Descriptions.Item>
        <Descriptions.Item label="架構">
          <Text style={{ fontFamily: MONO, fontSize: 12 }}>{folder.architecture || '—'}</Text>
        </Descriptions.Item>
        <Descriptions.Item label="上下文">
          {folder.context_length ? `${Math.round(folder.context_length / 1024)}K` : '—'}
        </Descriptions.Item>
        <Descriptions.Item label="能力" span={2}>
          <Space size={4}>
            <Tag>文字</Tag>
            {folder.vision && <Tag color="purple">看圖</Tag>}
            {folder.mtp && <Tooltip title="權重帶有 MTP 預測頭，可以開推測解碼加速生成"><Tag color="blue">MTP</Tag></Tooltip>}
          </Space>
        </Descriptions.Item>
      </Descriptions>

      <div>
        <Text strong style={{ fontSize: 13 }}>在這台機器上</Text>
        {plans.length === 0 ? (
          <Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 6 }}>
            {runtime ? '讀不到顯示卡的容量，無法估算。' : '還沒有安裝能跑 safetensors 的推論引擎。'}
          </Text>
        ) : (
          <Table<Plan>
            size="small"
            style={{ marginTop: 6 }}
            pagination={false}
            rowKey={(p) => `${p.cards}:${p.quantization}`}
            dataSource={plans}
            columns={[
              { title: '卡數', width: 70, render: (_, p) => `${p.cards} 張` },
              {
                title: '精度',
                render: (_, p) => (
                  <Space size={4}>
                    <span>{p.label}</span>
                    {p === pick && <Tag color="blue">建議</Tag>}
                  </Space>
                ),
              },
              { title: '每張卡權重', width: 110, render: (_, p) => gib(p.perCardGiB) },
              { title: '留給上下文', width: 110, render: (_, p) => (p.leftGiB > 0 ? gib(p.leftGiB) : '—') },
              { title: '', width: 80, render: (_, p) => fitTag(p.leftGiB) },
            ]}
          />
        )}
        <Text type="secondary" style={{ display: 'block', fontSize: 11, marginTop: 6, opacity: 0.7 }}>
          估算：權重平均分到每張卡，每張卡用九成，另留約 {RUNTIME_GIB} GiB 給執行時需要的空間，剩下的給上下文（KV 快取）。
        </Text>
      </div>

      <Space wrap>
        {folder.on_disk ? (
          <Button type="primary" icon={<PlusOutlined />} disabled={!runtime}
                  onClick={() => onCreate(pick)}>
            建立模型
          </Button>
        ) : (
          <Button type="primary" icon={<CloudDownloadOutlined />} loading={running}
                  onClick={onDownload}>
            {running ? '下載中' : partial ? '繼續下載' : '下載整個資料夾'}
          </Button>
        )}
        <Text type="secondary" style={{ fontSize: 12 }}>
          {folder.on_disk
            ? `已在磁碟：${placed(folder.local_path)}`
            : partial
              ? `已有 ${gib(folder.present_bytes / 1024 ** 3)}，下載到 ${placed(folder.local_path)}`
              : `下載到 ${placed(folder.local_path)}`}
        </Text>
      </Space>

      <Collapse
        size="small"
        items={[{
          key: 'files',
          label: <Text style={{ fontSize: 12 }}>會下載的檔案（{folder.files.length}）</Text>,
          children: (
            <div style={{ maxHeight: 220, overflowY: 'auto' }}>
              {folder.files.map((f) => (
                <div key={f.name} style={{ display: 'flex', gap: 12, fontFamily: MONO, fontSize: 12 }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name}</span>
                  <span style={{ opacity: 0.6 }}>{(f.size_bytes / 1024 ** 3).toFixed(2)} GiB</span>
                </div>
              ))}
              <Text type="secondary" style={{ display: 'block', fontSize: 11, marginTop: 6 }}>
                不下載：重複的舊格式權重（.bin）、original/ 裡的原始檢查點、GGUF 與 ONNX 匯出、說明頁的圖片。
              </Text>
            </div>
          ),
        }]}
      />
    </div>
  );
}
