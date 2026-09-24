import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, App as AntApp, Button, Card, Checkbox, Descriptions, Drawer, Empty, Form, Input,
  InputNumber, Modal, Popconfirm, Segmented, Select, Space, Table, Tag, Tooltip, Typography,
} from 'antd';
import {
  DeleteOutlined, EditOutlined, ImportOutlined, PlayCircleOutlined, PlusOutlined,
  PoweroffOutlined, ReloadOutlined,
} from '@ant-design/icons';
import { useStream } from '../stream';
import {
  deleteFile, deleteModel, deletePartial, fetchBackendDevices, fetchModelFiles,
  fetchModelSpec, fetchPartials, fetchProviders, fetchQuant, fetchRecommendedSampling, loadModel,
  modelFileRefs, saveModel, unloadAll,
  unloadModel,
  type BackendDevice, type ModelFile, type ModelFileRef, type ModelInfo,
  type ModelSpec, type ModelWeight, type PartialFile, type QuantJob, type Runtime,
} from '../api';
import { MONO } from '../theme';
import FlagPicker from '../components/FlagPicker';
import { QuantJobs, QuantizeModal } from '../components/Quantize';

const { Text, Paragraph } = Typography;

const STATE_COLOURS: Record<string, string> = {
  ready: 'green', starting: 'processing', stopping: 'orange', stopped: 'default',
};

const EMPTY: ModelSpec = {
  id: '', name: '', description: '', model_file: '',
  ctx_size: 16384, n_gpu_layers: 99, ttl: 900, group: 'large', extra: '', mmproj: null,
  // Empty, not zero: an unset box writes no flag, and zero means something
  // different (and real) for four of the six.
  sampling: {},
  device: [] as string[],
  runtime: '',
  // vLLM's own: as published, and most of the card. Ignored by llama.cpp.
  quantization: '', gpu_memory_utilization: 0.85,
};



/**
 * The six sampling defaults the form owns.
 *
 * They were reachable only by typing them into the free-text field, which put
 * the settings people most often want to change behind the one control that
 * assumes you already know their names. Defaults are the program's own, printed
 * as placeholders rather than filled in: leaving a box empty writes no flag at
 * all, which is what keeps the entry correct the day llama.cpp moves one.
 */
const SAMPLING: { field: string; hint: string; step: number }[] = [
  { field: 'temperature', hint: '0.80', step: 0.05 },
  { field: 'top_k', hint: '40（0 關閉）', step: 1 },
  { field: 'top_p', hint: '0.95（1.0 關閉）', step: 0.01 },
  { field: 'min_p', hint: '0.05（0 關閉）', step: 0.01 },
  { field: 'repeat_penalty', hint: '1.00（1.0 不罰）', step: 0.05 },
  { field: 'presence_penalty', hint: '0.00（0 不罰）', step: 0.1 },
];


const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;

/** Basename first, then which repo it came from -- which is the only thing
 *  separating two files that are otherwise identically named. */
const fileLabel = (f: ModelFile) =>
  `${f.filename.split('/').pop()}${f.repo ? ` — ${f.repo}` : ''} (${f.size_gib} GiB${f.precision ? ` · ${PRECISION[f.precision] ?? f.precision.toUpperCase()}` : ''})`;

/**
 * The vLLM flags a model family needs, offered when its folder is picked.
 *
 * Reasoning and tool-call parsers are per family: without them the
 * thinking arrives inline in the answer and tool calls come back as text.
 * The Qwen3.5/3.8 hybrid models also corrupt their output under
 * torch.compile on the Intel build, so they run eager.
 */
function recommendedFlags(architecture?: string): string[] {
  if (!architecture) return [];
  const flags: string[] = [];
  if (/^Qwen3_5/i.test(architecture)) flags.push('--enforce-eager');
  if (/^Qwen3/i.test(architecture)) {
    flags.push('--reasoning-parser qwen3', '--enable-auto-tool-choice', '--tool-call-parser hermes');
  }
  return flags;
}

/** How a safetensors model is stored, as the label reads. */
const PRECISION: Record<string, string> = {
  bf16: 'BF16', fp16: 'FP16', fp32: 'FP32', fp8: 'FP8', awq: 'AWQ 4-bit', gptq: 'GPTQ 4-bit',
  int4: 'Int4', int8: 'Int8', mxfp4: 'MXFP4', compressed: '已壓縮',
};



/**
 * What one entry is made of.
 *
 * The shared marker is the point of this. A vision projector is BF16 and
 * unquantised, so one of them serves every quantisation of its model -- two
 * entries pointing at the same mmproj is the intended arrangement, not a
 * mistake. Saying so here is what stops removing one entry from looking like
 * it takes the other's projector with it, which is also exactly what the
 * delete dialog refuses to do.
 */
function WeightList({ weights }: { weights: ModelWeight[] }) {
  if (weights.length === 0) return <Text type="secondary">—</Text>;
  const total = weights.reduce((sum, w) => sum + w.size_bytes, 0);
  return (
    <Space direction="vertical" size={2} style={{ width: '100%' }}>
      {weights.map((w) => (
        <Space key={w.filename} size={8} wrap>
          <Tag style={{ fontSize: 10, marginInlineEnd: 0 }}
               color={w.role === 'mmproj' ? 'purple' : 'default'}>
            {w.role === 'mmproj' ? '視覺投影' : '權重'}
          </Tag>
          <Text style={{ fontSize: 12, fontFamily: MONO }}>{w.filename}</Text>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {w.exists ? gib(w.size_bytes) : '檔案不存在'}
          </Text>
          {w.shared_with.length > 0 && (
            <Tooltip title={`也被 ${w.shared_with.join('、')} 使用。移除任一個模型都不會刪掉它。`}>
              <Tag color="blue" style={{ fontSize: 10, marginInlineEnd: 0 }}>
                與 {w.shared_with.length} 個模型共用
              </Tag>
            </Tooltip>
          )}
        </Space>
      ))}
      <Text type="secondary" style={{ fontSize: 11 }}>
        合計 {gib(total)} —— 載入時大致就是這些進顯存，再加上 KV 快取
      </Text>
    </Space>
  );
}

/** A file's part in a model, in the order a repo is worth reading in. */
const ROLE_ORDER: ModelFile['role'][] = ['weights', 'draft', 'projector', 'lora', 'control'];

const ROLE_NAME: Record<ModelFile['role'], string> = {
  weights: '權重', draft: '草稿', projector: '視覺投影', lora: 'LoRA', control: '控制向量',
};

// Colour carries the distinction that matters most here: weights are the model,
// everything else only makes sense beside one.
const ROLE_COLOUR: Record<ModelFile['role'], string | undefined> = {
  weights: undefined, draft: 'purple', projector: 'cyan', lora: 'geekblue', control: 'geekblue',
};

/** Files that predate the `<owner>/<repo>/` layout, or were put there by hand. */
const LOOSE = '（散落的檔案）';

interface RepoGroup {
  repo: string;
  owner: string;
  name: string;
  files: ModelFile[];
  bytes: number;
  unused: number;
  roles: Partial<Record<ModelFile['role'], number>>;
}

export default function Models() {
  const { message } = AntApp.useApp();
  const { models, refreshModels, gpus } = useStream();
  const [files, setFiles] = useState<ModelFile[]>([]);
  const [partials, setPartials] = useState<PartialFile[]>([]);
  const [open, setOpen] = useState(false);
  // Non-null while editing an existing model; its id must stay fixed, because
  // changing it would create a second entry rather than rename the first.
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [form] = Form.useForm<ModelSpec>();
  /**
   * The cards a llama-server here can actually drive.
   *
   * Asked for, not assumed: a machine with two cards and one runtime still has
   * one answer, and a field with a single option is a question that should not
   * have been put. The picker below appears only when this has more than one
   * entry, which today it does not -- the SYCL build cannot see the NVIDIA
   * card -- and will start appearing on its own once a CUDA runtime is
   * configured, with nobody having to remember to switch it on.
   */
  const [devices, setDevices] = useState<BackendDevice[]>([]);
  /**
   * The launchers a model can be started through. One is no question and the
   * picker stays hidden; a second -- vLLM beside llama.cpp -- decides which
   * files are offered and which fields the rest of the form shows.
   */
  const [runtimes, setRuntimes] = useState<Runtime[]>([]);
  const runtime = Form.useWatch('runtime', form);
  const provider = runtimes.find((r) => r.macro === runtime)?.provider
    ?? runtimes[0]?.provider ?? 'llamacpp';
  const vllm = provider === 'vllm';
  const chosenFile = Form.useWatch('model_file', form);
  const chosenQuant = Form.useWatch('quantization', form) ?? '';
  const folder = vllm ? files.find((f) => f.filename === chosenFile) : undefined;
  // The online quantisations come from the runtime's own image, not from a
  // list written here; the first option is always to load as published.
  const online = runtimes.find((r) => r.macro === runtime)?.quantizations ?? [];
  const quantOptions = [{ value: '', label: '照原精度載入', note: '', shrink: 1 }, ...online];
  const chosenOption = quantOptions.find((q) => q.value === chosenQuant);
  const shrink = chosenOption?.shrink ?? 1;

  // Quantising: which directory the modal is open for, and the jobs above
  // the file list. Polled while one runs, so the bar moves and the output
  // appears without anybody pressing anything.
  const [quantSource, setQuantSource] = useState<ModelFile | null>(null);
  const [quantJobs, setQuantJobs] = useState<QuantJob[]>([]);
  const refreshQuant = useCallback(() => {
    fetchQuant().then((p) => setQuantJobs(p.jobs)).catch(() => undefined);
  }, []);
  useEffect(() => { refreshQuant(); }, [refreshQuant]);
  const quantRunning = quantJobs.some((j) => j.state === 'running');
  useEffect(() => {
    if (!quantRunning) return;
    const timer = setInterval(refreshQuant, 3000);
    return () => clearInterval(timer);
  }, [quantRunning, refreshQuant]);
  // Deletion is a two-step dialogue: what would go, then whether to take it.
  const [pending, setPending] = useState<ModelInfo | null>(null);
  const [pendingFiles, setPendingFiles] = useState<ModelFileRef[]>([]);
  const [alsoDeleteFiles, setAlsoDeleteFiles] = useState(true);
  const [deleting, setDeleting] = useState(false);

  const refresh = useCallback(() => {
    refreshModels();
    fetchModelFiles().then(setFiles).catch(() => undefined);
    fetchPartials().then(setPartials).catch(() => undefined);
  }, [refreshModels]);

  useEffect(() => { refresh(); }, [refresh]);
  // A finished quantisation left a new directory behind.
  const quantDone = quantJobs.filter((j) => j.state !== 'running').length;
  useEffect(() => { if (quantDone) refresh(); }, [quantDone, refresh]);
  useEffect(() => {
    fetchBackendDevices().then(setDevices).catch(() => setDevices([]));
    fetchProviders().then((p) => setRuntimes(p.runtimes)).catch(() => setRuntimes([]));
  }, []);

  // The runtime decides which format the file list shows, so a change of one
  // clears a file the new one could not run.
  // Picking a folder fills in the flags its family needs, when the box is
  // still empty: what is there was typed on purpose.
  const onFolder = (name: string) => {
    if (!vllm) return;
    const picked = files.find((f) => f.filename === name);
    const current: string = form.getFieldValue('extra') ?? '';
    if (picked && !current.trim()) {
      form.setFieldValue('extra', recommendedFlags(picked.architecture).join('\n'));
    }
  };

  const onRuntime = (macro: string) => {
    const next = runtimes.find((r) => r.macro === macro);
    const chosen: string | undefined = form.getFieldValue('model_file');
    const format = files.find((f) => f.filename === chosen)?.format;
    if (next && format && !next.formats.includes(format)) {
      form.setFieldValue('model_file', '');
    }
  };

  /** Which device entries a model's stored environment corresponds to. Matched
   *  on the variables themselves rather than on a name written beside them, so
   *  an entry edited by hand is still recognised.
   *
   *  A selector can name more than one card -- `level_zero:0,1` is how a model
   *  gets both -- so each card is tested against its own index inside whatever
   *  the stored variable holds, rather than against the whole string. Matching
   *  the whole string was why a two-card model came back as "unspecified": the
   *  form then showed an empty select, and saving that empty select deleted
   *  the selector and dropped the model to one card.
   */
  const deviceOf = (env?: Record<string, string>): string[] => {
    if (!env) return [];
    return devices
      .filter((d) => Object.entries(d.env).every(([key, value]) => {
        const stored = env[key];
        if (stored === undefined) return false;
        if (stored === value) return true;
        // `level_zero:0` against a stored `level_zero:0,1`: same prefix, and
        // this card's index is one of the listed ones.
        const cut = value.lastIndexOf(':') + 1;
        const prefix = value.slice(0, cut);
        return stored.startsWith(prefix)
          && stored.slice(prefix.length).split(',').includes(value.slice(cut));
      }))
      .map((d) => `${d.backend}:${d.index}`);
  };

  const onSave = async () => {
    const values = await form.validateFields();
    try {
      // `device` is always sent, as a string, even when the select was
      // cleared: omitting it means "leave the card alone", which is right for
      // an API client and wrong for a form the user just emptied.
      await saveModel({
        ...values,
        name: values.name || values.id,
        device: devices.length > 1 ? values.device ?? [] : undefined,
        // The only launcher is sent too: the entry then says which it uses,
        // rather than falling back to whatever the config's default is.
        runtime: values.runtime || runtimes[0]?.macro || '',
        quantization: folder?.quantized ? '' : values.quantization,
      });
      message.success('已寫入設定，llama-swap 會自動重載');
      setOpen(false);
      setEditing(null);
      form.resetFields();
      window.setTimeout(refresh, 2500);
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  /**
   * The values the model file itself carries.
   *
   * Every publisher states them: they start as `generation_config.json` in the
   * HuggingFace repo, and llama.cpp's converter writes them into the GGUF as
   * `general.sampling.*`. Nothing in llama.cpp reads them back -- the keys are
   * defined and never fetched -- so they sit in the file unused, and the usual
   * way to find them is to copy them off a model card. This reads them out of
   * the header of the file that was picked.
   */
  const importRecommended = async () => {
    const file: string | undefined = form.getFieldValue('model_file');
    if (!file) {
      message.info('先選模型檔');
      return;
    }
    setImporting(true);
    try {
      const { sampling } = await fetchRecommendedSampling(file);
      const names = Object.keys(sampling);
      if (!names.length) {
        // Not a failure. A model converted without a generation_config.json
        // carries no such keys, and saying so beats an empty success.
        message.info('這個模型檔沒有內建建議值');
        return;
      }
      // Merged, not replaced: a field the file says nothing about keeps
      // whatever was already typed there.
      form.setFieldValue('sampling',
        { ...(form.getFieldValue('sampling') ?? {}), ...sampling });
      message.success(`已帶入 ${names.join('、')}`);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const openEdit = async (id: string) => {
    try {
      const spec = await fetchModelSpec(id);
      const device = deviceOf(spec.env);
      form.setFieldsValue({ ...spec, device });
      setEditing(id);
      setOpen(true);
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  const onUnload = async (id: string) => {
    setBusy(id);
    try {
      await unloadModel(id);
      message.success(`已卸載 ${id}`);
      refresh();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const onLoad = async (id: string) => {
    setBusy(id);
    message.info('載入中，大模型可能需要數分鐘…');
    try {
      await loadModel(id);
      refresh();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const openDelete = async (row: ModelInfo) => {
    setPending(row);
    setAlsoDeleteFiles(true);
    try {
      setPendingFiles(await modelFileRefs(row.id));
    } catch {
      setPendingFiles([]);
    }
  };

  const confirmDelete = async () => {
    if (!pending) return;
    setDeleting(true);
    try {
      const result = await deleteModel(pending.id, alsoDeleteFiles);
      const freed = result.deleted.reduce((sum, f) => sum + f.size_bytes, 0);
      message.success(
        result.deleted.length
          ? `已移除 ${pending.id}，釋放 ${gib(freed)}`
          : `已移除 ${pending.id}`,
      );
      // Files kept against an explicit request need saying out loud, or the
      // disk quietly fails to shrink and nobody knows why.
      result.kept.forEach((k) => message.warning(`保留 ${k.filename}：${k.reason}`));
      setPending(null);
      window.setTimeout(refresh, 2500);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  const onDeleteFile = async (filename: string) => {
    try {
      await deleteFile(filename);
      message.success(`已刪除 ${filename}`);
      refresh();
    } catch (error) {
      message.error((error as Error).message);
    }
  };

  const wanted = vllm ? 'safetensors' : 'gguf';
  const ggufFiles = files.filter((f) => !f.is_mmproj && (f.format ?? 'gguf') === wanted);
  const mmprojFiles = files.filter((f) => f.is_mmproj);
  const orphans = files.filter((f) => f.used_by.length === 0);
  const orphanBytes = orphans.reduce((sum, f) => sum + f.size_bytes, 0);

  // One row per repo. A repo is what a model is downloaded as and what it is
  // deleted as, and its total is the number anyone reading this table is after:
  // flat, a repo's weights, its projector and its draft model were three
  // unrelated rows with no total between them.
  const repos = useMemo<RepoGroup[]>(() => {
    const groups = new Map<string, RepoGroup>();
    for (const file of files) {
      // Files predating the `<owner>/<repo>/` layout, or put there by hand, are
      // a group of their own rather than being hidden under a blank heading.
      const repo = file.repo || LOOSE;
      let group = groups.get(repo);
      if (!group) {
        const cut = repo.lastIndexOf('/');
        group = {
          repo,
          owner: cut > 0 ? repo.slice(0, cut) : '',
          name: cut > 0 ? repo.slice(cut + 1) : repo,
          files: [], bytes: 0, unused: 0, roles: {},
        };
        groups.set(repo, group);
      }
      group.files.push(file);
      group.bytes += file.size_bytes;
      if (!file.used_by.length) group.unused += 1;
      group.roles[file.role] = (group.roles[file.role] ?? 0) + 1;
    }
    for (const group of groups.values()) {
      // Weights first inside a repo, then what hangs off them; the quant a
      // model entry points at is what anyone is looking for.
      group.files.sort((a, b) =>
        ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)
        || b.size_bytes - a.size_bytes);
    }
    // What is taking the space, which is the question this table answers.
    return [...groups.values()].sort((a, b) => b.bytes - a.bytes);
  }, [files]);
  const partialBytes = partials.reduce((sum, f) => sum + f.size_bytes, 0);

  /**
   * The models by the engine that runs them. llama.cpp first, as the one
   * every install has; the rest in the order the store lists them. A bar of
   * one engine is no choice, so it only appears once there is a second.
   */
  const [engine, setEngine] = useState<string>('all');
  const engines = useMemo(() => {
    const seen = new Map<string, { key: string; name: string; count: number }>();
    for (const m of models) {
      const key = m.provider ?? 'llamacpp';
      const entry = seen.get(key) ?? { key, name: m.provider_name ?? key, count: 0 };
      entry.count += 1;
      seen.set(key, entry);
    }
    return [...seen.values()].sort((a, b) =>
      (a.key === 'llamacpp' ? -1 : 0) - (b.key === 'llamacpp' ? -1 : 0) || a.name.localeCompare(b.name));
  }, [models]);
  const shownEngine = engines.some((e) => e.key === engine) ? engine : 'all';
  const shown = shownEngine === 'all'
    ? [...models].sort((a, b) =>
        engines.findIndex((e) => e.key === (a.provider ?? 'llamacpp'))
        - engines.findIndex((e) => e.key === (b.provider ?? 'llamacpp')))
    : models.filter((m) => (m.provider ?? 'llamacpp') === shownEngine);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title="已設定的模型"
        size="small"
        extra={
          <Space>
            <Button size="small" icon={<ReloadOutlined />} onClick={refresh}>重新整理</Button>
            <Button size="small" onClick={() => unloadAll().then(refresh)}
                    disabled={!models.some((m) => m.running)}>
              全部卸載
            </Button>
            <Button size="small" type="primary" icon={<PlusOutlined />}
                    onClick={() => {
                      form.setFieldsValue({ ...EMPTY, runtime: runtimes[0]?.macro ?? '' });
                      setEditing(null);
                      setOpen(true);
                    }}>
              新增模型
            </Button>
          </Space>
        }
      >
        {engines.length > 1 && (
          <Segmented
            size="small"
            style={{ marginBottom: 12 }}
            value={shownEngine}
            onChange={(v) => setEngine(String(v))}
            options={[
              { value: 'all', label: `全部（${models.length}）` },
              ...engines.map((e) => ({ value: e.key, label: `${e.name}（${e.count}）` })),
            ]}
          />
        )}
        <Table<ModelInfo>
          dataSource={shown}
          rowKey="id"
          size="small"
          pagination={false}
          // Fixed: under auto the long filenames widened their column past
          // its width and the name was squeezed into three lines.
          tableLayout="fixed"
          locale={{ emptyText: '設定檔中沒有模型' }}
          expandable={{
            expandedRowRender: (row) => (
              <Descriptions size="small" column={1} style={{ maxWidth: 860 }}>
                <Descriptions.Item label="說明">{row.description || '—'}</Descriptions.Item>
                <Descriptions.Item label="上游">{row.proxy || '未載入'}</Descriptions.Item>
                <Descriptions.Item label="檔案">
                  <WeightList weights={row.weights ?? []} />
                </Descriptions.Item>
              </Descriptions>
            ),
          }}
          columns={[
            {
              title: '名稱', dataIndex: 'name',
              render: (name: string | undefined, row) => (
                <div>
                  <div>{name || row.id}</div>
                  <Text type="secondary" style={{ fontSize: 12 }}>{row.id}</Text>
                </div>
              ),
            },
            // The engine, only in 全部: filtered to one engine the column
            // would repeat what the bar above says on every row.
            ...(engines.length > 1 && shownEngine === 'all' ? [{
              title: '推論引擎', width: 100,
              render: (_: unknown, row: ModelInfo) => (
                <Tag color={row.provider === 'vllm' ? 'geekblue' : 'default'}
                     style={{ fontSize: 11, marginInlineEnd: 0 }}>
                  {row.provider_name ?? 'llama.cpp'}
                </Tag>
              ),
            }] : []),
            {
              // The one column that separates two entries of the same model at
              // different quantisations, which is now an ordinary thing to
              // have: the name, the description and the capabilities are all
              // identical between them, and only the file is not.
              title: '模型檔', width: 300,
              render: (_, row) => {
                const weights = row.weights ?? [];
                if (weights.length === 0) return <Text type="secondary">—</Text>;
                const main = weights.find((w) => w.role === 'model') ?? weights[0];
                const total = weights.reduce((sum, w) => sum + w.size_bytes, 0);
                const missing = weights.filter((w) => !w.exists);
                return (
                  // One flex row rather than a block with things under it.
                  // `Text` with `ellipsis` renders a span, so anything after it
                  // sits on the same line -- previously against it, with no gap
                  // at all.
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                    {/* The size is on the tooltip rather than the row. The
                        column is here to tell two quantisations of one model
                        apart, and the filename does that on its own; a number
                        beside every row is weight the row does not need, and
                        the expanded view and the file list both carry it. */}
                    <Tooltip title={`${main.filename}　${gib(total)}`}>
                      <Text
                        // `0 1 auto`, not `1`: growing would pin the tag to the
                        // far edge of the column with a gap of whatever is left
                        // over. The name takes what it needs, the tag follows
                        // it, and only a name too long for the column shrinks.
                        style={{ fontSize: 12, fontFamily: MONO, flex: '0 1 auto', minWidth: 0 }}
                        ellipsis
                      >
                        {main.basename}
                      </Text>
                    </Tooltip>
                    {weights.some((w) => w.role === 'mmproj') && (
                      <Tooltip title="含視覺投影檔，一起佔用顯存">
                        <Tag color="purple"
                             style={{ fontSize: 10, marginInlineEnd: 0, flex: 'none' }}>
                          + 視覺
                        </Tag>
                      </Tooltip>
                    )}
                    {missing.length > 0 && (
                      <Tooltip title={missing.map((w) => w.filename).join('，')}>
                        <Tag color="error"
                             style={{ fontSize: 10, marginInlineEnd: 0, flex: 'none' }}>
                          檔案不見了
                        </Tag>
                      </Tooltip>
                    )}
                  </div>
                );
              },
            },
            {
              title: '狀態', dataIndex: 'state', width: 110,
              render: (state: string) => <Tag color={STATE_COLOURS[state] ?? 'default'}>{state}</Tag>,
            },
            {
              title: 'TTL', dataIndex: 'ttl', width: 90,
              render: (ttl: number | null | undefined) => (ttl ? `${Math.round(ttl / 60)} 分` : '—'),
            },
            {
              // Every one of these says what it does. They were icons alone,
              // and a power symbol beside a play symbol is two guesses in a
              // column where one of the guesses frees 30 GiB of video memory
              // out from under whoever is using the model.
              title: '操作', width: 240,
              render: (_, row) => (
                <Space size={6}>
                  {/* One button, because it is one question: is this model in memory
                      or not. Two buttons meant one of them was always disabled, and a
                      greyed-out control says nothing about which state the row is in --
                      the 狀態 column had to be read to find out. Now the button itself
                      is the answer.

                      The two states do not look alike. Unloading is the one action in
                      this row that takes something away from whoever is using the
                      model right now, so it is filled and amber; loading is a plain
                      button. Amber rather than red: red belongs to 移除, which is the
                      one thing here that cannot be undone. */}
                  {row.running ? (
                    <Tooltip title="卸載，釋放顯存">
                      <Button size="small" color="orange" variant="filled"
                              icon={<PoweroffOutlined />}
                              loading={busy === row.id}
                              onClick={() => onUnload(row.id)}>
                        卸載
                      </Button>
                    </Tooltip>
                  ) : (
                    <Tooltip title="送一個極小的請求把模型載入顯存">
                      <Button size="small" icon={<PlayCircleOutlined />}
                              loading={busy === row.id}
                              onClick={() => onLoad(row.id)}>
                        載入
                      </Button>
                    </Tooltip>
                  )}
                  <Tooltip title="修改設定">
                    <Button size="small" icon={<EditOutlined />}
                            onClick={() => openEdit(row.id)}>
                      修改
                    </Button>
                  </Tooltip>
                  <Tooltip title="從 llama-swap 設定中移除這個模型">
                    <Button size="small" danger icon={<DeleteOutlined />}
                            onClick={() => openDelete(row)}>
                      移除
                    </Button>
                  </Tooltip>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Card
        title="磁碟上的模型檔"
        size="small"
        extra={
          <Space size={10}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {repos.length} 個來源・{gib(files.reduce((n, f) => n + f.size_bytes, 0))}
            </Text>
            {orphans.length > 0 && (
              <Text type="warning" style={{ fontSize: 12 }}>
                {orphans.length} 個未使用，共 {gib(orphanBytes)}
              </Text>
            )}
          </Space>
        }
      >
        {/* Grouped by the repo the files came from, because that is the unit
            they arrive in and the unit they leave in. Flat, a repo's weights,
            its projector and its draft model were three unrelated rows sorted
            between other repos' files, and the only number that mattered --
            what this model costs on disk -- was not written anywhere.

            Sorted by size, since the question this table answers is what is
            taking the space. */}
        <QuantJobs jobs={quantJobs} onChange={refreshQuant} />
        <Table<RepoGroup>
          dataSource={repos}
          rowKey="repo"
          size="small"
          pagination={false}
          showHeader={false}
          locale={{ emptyText: '~/ai/models 中沒有 GGUF 檔' }}
          // A repo with something unused in it is the one worth opening, so it
          // opens itself.
          defaultExpandedRowKeys={repos.filter((r) => r.unused > 0).map((r) => r.repo)}
          expandable={{
            expandedRowRender: (group) => (
              <Table<ModelFile>
                dataSource={group.files}
                rowKey="filename"
                size="small"
                pagination={false}
                showHeader={false}
                columns={[
                  {
                    title: '檔名',
                    dataIndex: 'filename',
                    render: (name: string, row) => (
                      <Space size={8}>
                        <Tag color={ROLE_COLOUR[row.role]} style={{ marginInlineEnd: 0 }}>
                          {ROLE_NAME[row.role]}
                        </Tag>
                        <Text style={{ fontSize: 12, fontFamily: MONO }}>
                          {name.split('/').pop()}
                        </Text>
                      </Space>
                    ),
                  },
                  {
                    title: '大小', dataIndex: 'size_gib', width: 90, align: 'right',
                    render: (v: number) => (
                      <Text style={{
                        fontSize: 12, fontFamily: MONO,
                        fontVariantNumeric: 'tabular-nums',
                      }}>{v} GiB</Text>
                    ),
                  },
                  {
                    title: '使用中的模型', dataIndex: 'used_by', width: 260,
                    render: (used: string[]) =>
                      used.length ? (
                        <Space size={4} wrap>
                          {used.map((id) => <Tag key={id}>{id}</Tag>)}
                        </Space>
                      ) : (
                        <Tag color="warning">未使用</Tag>
                      ),
                  },
                  {
                    title: '', width: 60, align: 'right',
                    render: (_, row) => (
                      <Popconfirm
                        title={`刪除 ${row.filename}？`}
                        description={`會從磁碟永久移除 ${row.size_gib} GiB，無法復原。`}
                        onConfirm={() => onDeleteFile(row.filename)}
                        okText="刪除" cancelText="取消" okButtonProps={{ danger: true }}
                        disabled={row.used_by.length > 0}
                      >
                        <Tooltip title={row.used_by.length
                          ? '仍被模型設定使用，需先移除該模型' : undefined}>
                          <Button size="small" danger icon={<DeleteOutlined />}
                                  disabled={row.used_by.length > 0} />
                        </Tooltip>
                      </Popconfirm>
                    ),
                  },
                ]}
              />
            ),
          }}
          columns={[
            {
              title: '來源',
              dataIndex: 'repo',
              render: (_: string, group) => (
                <div style={{ minWidth: 0 }}>
                  <Text style={{ fontSize: 13 }}>{group.name}</Text>
                  {group.owner && (
                    <Text type="secondary" style={{ fontSize: 11, marginInlineStart: 8 }}>
                      {group.owner}
                    </Text>
                  )}
                </div>
              ),
            },
            {
              // What the repo is made of, which is the thing the flat list
              // could not say: two quants of the same weights and one projector
              // is a different situation from two unrelated models.
              title: '內容', width: 250,
              render: (_, group) => (
                <Space size={4} wrap>
                  {ROLE_ORDER.map((role) => [role, group.roles[role] ?? 0] as const)
                    .filter(([, n]) => n > 0)
                    .map(([role, n]) => (
                      <Tag key={role} color={ROLE_COLOUR[role]} style={{ marginInlineEnd: 0 }}>
                        {ROLE_NAME[role]}{n > 1 ? ` ×${n}` : ''}
                      </Tag>
                    ))}
                </Space>
              ),
            },
            {
              title: '大小', width: 110, align: 'right',
              render: (_, group) => (
                <Text style={{
                  fontSize: 13, fontFamily: MONO, fontVariantNumeric: 'tabular-nums',
                }}>
                  {gib(group.bytes)}
                </Text>
              ),
            },
            {
              title: '', width: 170, align: 'right',
              render: (_, group) => {
                // A bf16 safetensors model can be made smaller here; a GGUF
                // or an already-quantised repo cannot.
                const bf16 = group.files.find((f) => f.format === 'safetensors' && !f.quantized);
                return (
                  <Space size={8}>
                    {group.unused > 0 && (
                      <Tag color="warning" style={{ marginInlineEnd: 0 }}>
                        {group.unused} 個未使用
                      </Tag>
                    )}
                    {bf16 && (
                      <Button size="small" onClick={(e) => { e.stopPropagation(); setQuantSource(bf16); }}>
                        量化
                      </Button>
                    )}
                  </Space>
                );
              },
            },
          ]}
        />
      </Card>

      <QuantizeModal
        source={quantSource}
        gpus={gpus}
        open={!!quantSource}
        onClose={() => setQuantSource(null)}
        onStarted={refreshQuant}
      />

      {partials.length > 0 && (
        <Card
          title="未完成的下載"
          size="small"
          extra={<Text type="secondary" style={{ fontSize: 12 }}>共佔用 {gib(partialBytes)}</Text>}
        >
          <Paragraph type="secondary" style={{ fontSize: 12 }}>
            這些是中斷的下載，保留著是為了續傳——在「模型目錄」重新下載同一個檔案會接續而不是重來。
            確定不需要再刪除。
          </Paragraph>
          <Table<PartialFile>
            dataSource={partials}
            rowKey="filename"
            size="small"
            pagination={false}
            columns={[
              { title: '檔名', dataIndex: 'filename' },
              { title: '已下載', dataIndex: 'size_gib', width: 120, render: (v: number) => `${v} GiB` },
              {
                title: '', width: 90,
                render: (_, row) => (
                  <Popconfirm
                    title="捨棄這個未完成的下載？"
                    description="下次下載會從頭開始。"
                    onConfirm={() =>
                      deletePartial(row.filename)
                        .then(() => { message.success('已捨棄'); refresh(); })
                        .catch((e) => message.error((e as Error).message))
                    }
                    okText="捨棄" cancelText="取消" okButtonProps={{ danger: true }}
                  >
                    <Button size="small" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                ),
              },
            ]}
          />
        </Card>
      )}

      <Modal
        title={`移除模型 ${pending?.id ?? ''}`}
        open={pending !== null}
        onCancel={() => setPending(null)}
        onOk={confirmDelete}
        okText="移除"
        cancelText="取消"
        okButtonProps={{ danger: true, loading: deleting }}
      >
        <Paragraph>
          會從 <code>config.yaml</code> 移除這個模型設定。
        </Paragraph>

        {pendingFiles.length === 0 ? (
          <Empty description="找不到對應的模型檔" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <>
            <Checkbox
              checked={alsoDeleteFiles}
              onChange={(e) => setAlsoDeleteFiles(e.target.checked)}
            >
              同時刪除磁碟上的模型檔
            </Checkbox>
            <div style={{ marginTop: 12 }}>
              {pendingFiles.map((f) => (
                <div key={f.filename} style={{ marginBottom: 6 }}>
                  <Space size={6} wrap>
                    <Text code style={{ fontSize: 12 }}>{f.filename}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {f.exists ? gib(f.size_bytes) : '不在磁碟上'}
                    </Text>
                    {f.shared_with.length > 0 && (
                      <Tag color="warning">{f.shared_with.join('、')} 也在用</Tag>
                    )}
                  </Space>
                </div>
              ))}
            </div>
            {pendingFiles.some((f) => f.shared_with.length > 0) && (
              <Alert
                type="warning"
                showIcon
                style={{ marginTop: 12 }}
                message="部分檔案會被保留"
                description="被其他模型設定使用的檔案不會刪除——刪了會讓那些模型指向不存在的檔案。"
              />
            )}
            {alsoDeleteFiles && pendingFiles.some((f) => f.exists && !f.shared_with.length) && (
              <Alert
                type="error"
                showIcon
                style={{ marginTop: 12 }}
                message="這個動作無法復原"
                description="檔案會直接從磁碟刪除，需要重新下載才能取回。"
              />
            )}
          </>
        )}
      </Modal>

      <Drawer
        title={editing ? `修改 ${editing}` : '新增模型'}
        width={560}
        open={open}
        onClose={() => { setOpen(false); setEditing(null); }}
        extra={<Button type="primary" onClick={onSave}>儲存</Button>}
      >
        <Paragraph type="secondary" style={{ fontSize: 12 }}>
          儲存後會寫入 <code>~/ai/llama-swap/config.yaml</code>，llama-swap 以
          <code> -watch-config </code>自動重載，不需要重啟服務。設定檔中的註解會被保留。
        </Paragraph>
        <Form form={form} layout="vertical" initialValues={EMPTY}>
          <Form.Item name="id" label="模型 ID" rules={[{ required: true }]}
                     extra={editing
                       ? '既有模型的 ID 不可更改——改了會另外建立一筆，而不是改名。'
                       : 'API 請求時使用的名稱，例如 hermes-35b-apex'}>
            <Input placeholder="my-model" disabled={!!editing} />
          </Form.Item>
          <Form.Item name="name" label="顯示名稱"><Input /></Form.Item>
          <Form.Item name="description" label="說明"><Input.TextArea rows={2} /></Form.Item>
          {runtimes.length > 1 && (
            <Form.Item name="runtime" label="執行環境"
                       extra={vllm
                         ? 'vLLM 跑 Hugging Face 的 safetensors 模型，載入時預先佔滿顯存，同時多人使用最快。'
                         : 'llama.cpp 跑 GGUF 模型，可以只放一部分進顯存。'}>
              <Select
                onChange={onRuntime}
                options={runtimes.map((r) => ({ value: r.macro, label: r.label }))}
              />
            </Form.Item>
          )}
          <Form.Item name="model_file" label={vllm ? '模型資料夾' : '模型檔'} rules={[{ required: true }]}
                     extra={vllm && !ggufFiles.length
                       ? '模型目錄裡沒有 safetensors 模型。到「模型目錄」下載一個，或把 Hugging Face 的整個 repo 放進 ~/ai/models/<作者>/<名稱>/。'
                       : undefined}>
            <Select
              showSearch
              onChange={onFolder}
              placeholder={vllm ? '從 ~/ai/models 選一個資料夾' : '從 ~/ai/models 選擇'}
              // The basename first, the repo after it: with weights under
              // <owner>/<repo>/ the path leads with a directory, and a list of
              // twenty quants would sort and read by publisher rather than by
              // what the file is. A string rather than a node because Select's
              // search matches against the label.
              options={ggufFiles.map((f) => ({
                value: f.filename, label: fileLabel(f),
              }))}
            />
          </Form.Item>
          {!vllm && (
          <Form.Item name="mmproj" label="視覺投影檔（選用）"
                     extra="視覺模型才需要，會額外佔用顯存">
            <Select
              allowClear
              placeholder="無"
              options={mmprojFiles.map((f) => ({
                value: f.filename, label: fileLabel(f),
              }))}
            />
          </Form.Item>
          )}
          {devices.length > 1 && (
            <Form.Item
              label="顯示卡"
              // How many cards is not a separate question: it is however many are
              // picked here. A segmented control asking it first was a second place
              // for the same answer to live, and one that could disagree with the
              // list right underneath it.
              extra={vllm
                ? '選到的卡就是這個模型會用到的卡；選幾張，tensor-parallel 就是幾。不選就是第一張。'
                : '選到的卡就是這個模型會用到的卡，不選就是不指定、由 llama-server 自己挑。選一張以上時模型會分攤過去，預設 --split-mode layer（按層切）。另一種 tensor（按張量切）在部分機器上比較快，但限制較多：必須開 flash attention、KV 快取不能是量化的（-ctk/-ctv 要 f16），而且部分模型架構不支援。要試就在額外參數寫 --split-mode tensor。'}
            >
              <Form.Item name="device" noStyle>
                <Select
                  mode="multiple"
                  allowClear
                  placeholder="選要用的卡"
                  options={devices.map((d) => ({
                    value: `${d.backend}:${d.index}`,
                    label: `${d.name}（${d.backend}${d.index}，${Math.round(d.total_mib / 1024)} GiB）`,
                  }))}
                />
              </Form.Item>
            </Form.Item>
          )}
          {/* Labelled by what it decides, not by where it is stored.
              The value goes into llama-swap's `groups:`, so "群組" was accurate
              about the file and silent about the question -- and the two names
              it offers, large and small, read as model size when what they
              actually set is whether loading this model evicts everything else.
              A 3B model in "large" is exclusive too. So the name leads and the
              behaviour follows it: whoever is reading config.yaml sees the
              value they will find in the file, and whoever is not reads past
              it to the part that answers the question. */}
          <Form.Item name="group" label="載入策略"
                     extra={vllm
                       ? 'vLLM 一啟動就把整張卡的顯存佔走，所以要獨佔：載入時會把其他模型卸下來。'
                       : '獨佔在載入時會把其他模型卸下來，共存不會。前面的名字就是寫進設定檔的值，在設定頁看得到。'}>
            <Select
              allowClear
              options={[
                { value: 'large', label: 'large 獨佔 — 載入時卸載其他模型' },
                { value: 'small', label: 'small 共存 — 可與 ComfyUI 或其他模型並存' },
              ]}
            />
          </Form.Item>
          {/* A plain flex row, not Space.
              Space wraps every child in an item of its own, so the `flex: 1`
              sitting on the Form.Item inside never reached the box that decides
              the width -- the two fields sized to their contents and came out
              different. And both carry an `extra` now: one line of help under
              one field and none under the other left the pair with different
              heights and no bottom edge to share. */}
          <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
            <Form.Item name="ctx_size" label={vllm ? '最大長度（max-model-len）' : 'Context 長度'} style={{ flex: 1 }}
                       extra={vllm ? '一個請求的輸入加輸出上限，也決定 KV 快取要留多少' : '每個 slot 分到的是這個數字除以 --parallel'}>
              <InputNumber min={512} max={1048576} step={1024} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="ttl" label="閒置卸載（秒）" style={{ flex: 1 }}
                       extra="0 表示不自動卸載">
              <InputNumber min={0} step={60} style={{ width: '100%' }} />
            </Form.Item>
          </div>
          {vllm ? (
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
              {/* The precision is the folder's, not the entry's. A repo the
                  publisher quantised says so in its config.json and vLLM
                  applies it by itself; the choice here exists only for a
                  bf16 repo, where the weights can be compressed on the way
                  in at the cost of a slower start. */}
              {folder?.quantized ? (
                <Form.Item label="精度" style={{ flex: 1 }}
                           extra="模型檔已經是量化過的，vLLM 載入時自動套用，不用再設。">
                  <Input value={`${PRECISION[folder.precision ?? ''] ?? folder.precision}（模型檔已量化）`} disabled />
                </Form.Item>
              ) : (
                <Form.Item name="quantization" label="精度" style={{ flex: 1 }}
                           extra={folder
                             ? `模型檔是 ${PRECISION[folder.precision ?? ''] ?? folder.precision ?? '未知精度'}，約 ${folder.size_gib} GiB；${chosenQuant ? `線上量化後權重約 ${(folder.size_gib * shrink).toFixed(1)} GiB，${chosenOption?.note ?? ''}，載入時多花些時間壓縮` : '照原精度載入就是這個大小'}，再加 KV 快取。`
                             : '載入時線上量化，模型檔本身不變。'}>
                  <Select options={quantOptions.map(({ value, label }) => ({ value, label }))} />
                </Form.Item>
              )}
              <Form.Item name="gpu_memory_utilization" label="顯存佔用比例" style={{ flex: 1 }}
                         extra="模型加 KV 快取最多用到卡的幾成；卡上還有別的東西在跑就調低。">
                <InputNumber min={0.3} max={0.98} step={0.05} style={{ width: '100%' }} />
              </Form.Item>
            </div>
          ) : (
          <Form.Item name="n_gpu_layers" label="GPU 層數"
                     extra="0 表示不指定，讓 llama.cpp 自行決定。放不進顯存的模型必須用 0，否則 llama.cpp 會拒絕自動調整而直接失敗。">
            <InputNumber min={0} max={999} style={{ width: '100%' }} />
          </Form.Item>
          )}
          {/* The sampling defaults, as fields.
              They were reachable only by typing them into 額外參數, which put
              the six settings people most often want to change behind the one
              control that assumes you already know their spelling -- and this
              machine's own config spells them three different ways. Blank means
              the flag is not written at all, which is not the same as writing
              llama.cpp's current default and staying wrong when it moves. */}
          {!vllm && (
          <Form.Item
            label={(
              <Space size={8}>
                取樣預設值
                <Button type="link" size="small" icon={<ImportOutlined />}
                        loading={importing} onClick={importRecommended}
                        style={{ padding: 0, height: 'auto', fontSize: 12 }}>
                  帶入模型建議值
                </Button>
              </Space>
            )}
            extra="留白就用 llama.cpp 自己的預設（灰字），不會寫進設定檔。「帶入模型建議值」讀的是模型檔自己帶的那份，llama-server 不會自動套用。這裡設的是伺服器端預設，聊天視窗送出的參數會覆蓋它。"
          >
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              {SAMPLING.map(({ field, hint, step }) => (
                <Form.Item
                  key={field}
                  name={['sampling', field]}
                  label={<Text style={{ fontSize: 12, fontFamily: MONO }}>
                    {field}
                  </Text>}
                  style={{ flex: '1 1 30%', minWidth: 120, marginBottom: 0 }}
                >
                  <InputNumber min={0} step={step} placeholder={hint}
                               style={{ width: '100%' }} />
                </Form.Item>
              ))}
            </div>
          </Form.Item>
          )}
          {vllm ? (
            <Form.Item name="extra" label="額外參數"
                       extra="vllm serve 的其他旗標，一行一個。選資料夾時會依模型家族帶入需要的（思考、工具呼叫的解析器，Qwen3.5/3.8 要 --enforce-eager），可以改。模型、長度、卡數、量化和佔用比例由上面的欄位負責。">
              <Input.TextArea rows={3} style={{ fontFamily: MONO, fontSize: 12 }} />
            </Form.Item>
          ) : (
          <Form.Item name="extra" label="額外參數"
                     extra="要細調的參數從這裡加，一行一個 —— 上面沒有的旗標都寫在這，例如 --parallel、--flash-attn、--split-mode 的細節。模型檔、context、GPU 層數、顯示卡和上面的取樣值由各自的欄位負責，不用重複寫。">
            {/* The list used to be a sentence of examples. Asked of the binary
                instead, because llama.cpp's flags move between builds -- this
                one's own help names five that have been removed -- and a model
                launched with a switch its server does not have simply refuses
                to start. */}
            <FlagPicker
              source={{ kind: 'llama-server' }}
              // Every one of these is written by the form above from a field of
              // its own; a typed copy would be the second opinion.
              // Both spellings of the sampling flags, because llama.cpp takes
              // either and offering one would let a second copy be typed in
              // beside the field that already writes it.
              reserved={['--model', '--mmproj', '--ctx-size', '--n-gpu-layers',
                         '--port', '--host',
                         ...SAMPLING.flatMap(({ field }) => [
                           `--${field}`, `--${field.replace(/_/g, '-')}`,
                         ]), '--temp']}
            />
          </Form.Item>
          )}
        </Form>
      </Drawer>
    </Space>
  );
}
