import {
  Alert, Button, Collapse, Descriptions, Empty, Space, Table, Tag, Tooltip, Typography,
} from 'antd';
import { CloudDownloadOutlined, LockOutlined, PlusOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import type { CatalogFolder, CatalogVariant, DownloadStatus, GpuDevice, Runtime } from '../api';
import { MONO } from '../theme';

const { Text } = Typography;

/** How a stored precision reads, as the model page names it. */
const PRECISION: Record<string, string> = {
  bf16: 'BF16', fp16: 'FP16', fp32: 'FP32', fp8: 'FP8', awq: 'AWQ 4-bit', gptq: 'GPTQ 4-bit',
  int4: 'Int4', int8: 'Int8', mxfp4: 'MXFP4', compressed: '已壓縮', bnb: 'bitsandbytes',
  bitsandbytes: 'bitsandbytes',
};

/**
 * What a server engine keeps on each card beside the weights, at the 0.9 of the
 * card it takes: measured on vLLM's Intel build with a 27B across two B70 --
 * 1.32 GiB peak activation, 0.91 non-torch, 0.12 for the decode graphs.
 */
const RUNTIME_GIB = 2.4;
/** Below this the model loads with room for a context too short to use. */
const USEFUL_CONTEXT_GIB = 4;
/**
 * What vLLM's cache costs beyond the attention layers' own K and V, for a
 * hybrid model: its MTP layer's cache and the padding it adds to line the
 * state layers up. Measured on Qwen3.8-27B: 71.3 KiB a token against the
 * 64 KiB its 16 attention layers need.
 */
const HYBRID_OVERHEAD = 1.12;

/** One way to run the model here: how many cards, and in what precision. */
export interface Plan {
  cards: number;
  /** An online quantisation to apply as it loads; '' is as published. */
  quantization: string;
  label: string;
  perCardGiB: number;
  /** What is left on each card for the context (KV cache). */
  leftGiB: number;
  /** How many tokens of context that holds, all cards together; undefined
   *  when the config does not say what a token costs. */
  tokens?: number;
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
  const perToken = folder.kv_bytes_per_token * (folder.hybrid ? HYBRID_OVERHEAD : 1);
  const out: Plan[] = [];
  for (const n of [1, 2, 4, 8].filter((c) => c <= cards.length)) {
    for (const p of precisions) {
      const weights = (folder.size_gib * p.shrink) / n;
      const left = perCard - weights - RUNTIME_GIB;
      out.push({
        cards: n, quantization: p.value, label: p.label,
        perCardGiB: weights, leftGiB: left,
        // Tensor parallelism splits the cache across the cards with the heads.
        tokens: perToken > 0 && left > 0 ? Math.floor((left * n * 1024 ** 3) / perToken) : undefined,
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

/** A context length the way people say it: 262144 is 256K. */
const kTokens = (n: number) => (n >= 1024 ? `${Math.floor(n / 1024)}K` : `${n}`);

/** What the context left over holds, against what the model was built for. */
function contextCell(p: Plan, full: number) {
  if (p.leftGiB <= 0) return '—';
  if (p.tokens === undefined) return gib(p.leftGiB);
  const reach = full > 0 && p.tokens >= full
    ? <Tag color="green" style={{ marginInlineStart: 4 }}>跑得滿 {kTokens(full)}</Tag>
    : null;
  return (
    <Tooltip title={`${gib(p.leftGiB)}／卡，約 ${p.tokens.toLocaleString()} token（所有請求合計）`}>
      <span>約 {kTokens(p.tokens)}{reach}</span>
    </Tooltip>
  );
}

const PRECISION_SHORT: Record<string, string> = { ...PRECISION, nvfp4: 'NVFP4' };

/** The same model in other precisions: pick one to see it here instead. */
function Variants({ variants, runtime, onPick }: {
  variants: CatalogVariant[] | null; runtime: Runtime | undefined; onPick: (repo: string) => void;
}) {
  if (variants === null) {
    return <Text type="secondary" style={{ fontSize: 12 }}>讀取其他版本…</Text>;
  }
  if (variants.length === 0) {
    return <Text type="secondary" style={{ fontSize: 12 }}>Hugging Face 上沒有這個模型的其他精度版本。</Text>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {variants.map((v) => {
        const verified = runtime?.precisions?.includes(v.precision);
        return (
          <div key={v.repo_id} onClick={() => onPick(v.repo_id)}
               className="catalog-variant"
               style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px', cursor: 'pointer', borderRadius: 4 }}>
            <Text style={{ flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {v.repo_id}
            </Text>
            {v.base && <Tag>原始模型</Tag>}
            {v.gated && <Tooltip title="需要授權"><LockOutlined style={{ opacity: 0.6 }} /></Tooltip>}
            <Tooltip title={verified ? '這個精度在這台機器的引擎上實測載入過' : '這個精度還沒在這台機器的引擎上實測過'}>
              <Tag color={verified ? 'green' : undefined} style={{ marginInlineEnd: 0 }}>
                {PRECISION_SHORT[v.precision] ?? (v.precision || '未知')}
              </Tag>
            </Tooltip>
            <Text type="secondary" style={{ fontSize: 12, width: 64, textAlign: 'right' }}>{v.size_gib ? gib(v.size_gib) : ''}</Text>
            <Text type="secondary" style={{ fontSize: 11, width: 72, textAlign: 'right', fontFamily: MONO }}>↓ {v.downloads.toLocaleString()}</Text>
          </div>
        );
      })}
    </div>
  );
}

export default function CatalogFolderPanel({
  folder, runtime, gpus, placed, download, onDownload, onCreate, variants, onPickVariant,
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
  /** The same model in other precisions; null while they load. */
  variants: CatalogVariant[] | null;
  onPickVariant: (repo: string) => void;
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
  const locked = folder.needs_access !== '';
  const running = download && !['done', 'error', 'cancelled'].includes(download.state);
  const partial = !folder.on_disk && folder.present_bytes > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '10px 12px' }}>
      {locked && (
        <Alert
          type="warning"
          showIcon
          icon={<LockOutlined />}
          message={folder.needs_access}
          description={(
            <Space size={12}>
              <a href={`https://huggingface.co/${folder.repo_id}`} target="_blank" rel="noreferrer">到模型頁同意條款</a>
              <Link to="/settings">到設定填 token</Link>
            </Space>
          )}
        />
      )}
      <Descriptions size="small" column={2} colon={false}
                    labelStyle={{ width: 72, opacity: 0.6 }}>
        <Descriptions.Item label="精度">
          <Space size={4} wrap>
            <span>{PRECISION[folder.precision] ?? (folder.precision || (locked ? '授權後才讀得到' : '未知'))}</span>
            {folder.quantized && <Tooltip title="發布者已經量化過，引擎會照這個精度載入，不能再線上量化"><Tag>已量化</Tag></Tooltip>}
            {runtime && folder.precision && (verified
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
              { title: '上下文', width: 150, render: (_, p) => contextCell(p, folder.context_length) },
              { title: '', width: 80, render: (_, p) => fitTag(p.leftGiB) },
            ]}
          />
        )}
        <Text type="secondary" style={{ display: 'block', fontSize: 11, marginTop: 6, opacity: 0.7 }}>
          估算：權重平均分到每張卡，每張卡用九成，另留約 {RUNTIME_GIB} GiB 給執行時需要的空間，剩下的給上下文（KV 快取）。
          {folder.kv_bytes_per_token > 0
            ? `每個 token 的快取約 ${Math.round(folder.kv_bytes_per_token * (folder.hybrid ? HYBRID_OVERHEAD : 1) / 1024)} KiB`
              + (folder.hybrid ? '（只有部分層是完整注意力，已加上 vLLM 實測的額外開銷）' : '') + '，上下文是所有同時進行的請求共用。'
            : '這個模型的設定檔沒寫出注意力的形狀，只能用 GiB 表示。'}
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
                  disabled={locked} onClick={onDownload}>
            {running ? '下載中' : partial ? '繼續下載' : '下載整個資料夾'}
          </Button>
        )}
        <Text type="secondary" style={{ fontSize: 12 }}>
          {locked && !folder.on_disk
            ? '取得授權後才能下載'
            : folder.on_disk
            ? `已在磁碟：${placed(folder.local_path)}`
            : partial
              ? `已有 ${gib(folder.present_bytes / 1024 ** 3)}，下載到 ${placed(folder.local_path)}`
              : `下載到 ${placed(folder.local_path)}`}
        </Text>
      </Space>

      <div>
        <Text strong style={{ fontSize: 13 }}>同一模型的其他精度</Text>
        <div style={{ marginTop: 6 }}>
          <Variants variants={variants} runtime={runtime} onPick={onPickVariant} />
        </div>
      </div>

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
