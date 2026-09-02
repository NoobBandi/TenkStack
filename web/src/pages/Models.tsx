import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, App as AntApp, Button, Card, Checkbox, Descriptions, Drawer, Empty, Form, Input,
  InputNumber, Modal, Popconfirm, Select, Space, Table, Tag, Tooltip, Typography,
} from 'antd';
import {
  DeleteOutlined, EditOutlined, PlayCircleOutlined, PlusOutlined, PoweroffOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useStream } from '../stream';
import {
  deleteFile, deleteModel, deletePartial, fetchBackendDevices, fetchModelFiles,
  fetchModelSpec, fetchPartials, loadModel, modelFileRefs, saveModel, unloadAll,
  unloadModel,
  type BackendDevice, type ModelFile, type ModelFileRef, type ModelInfo,
  type ModelSpec, type ModelWeight, type PartialFile,
} from '../api';
import { MONO } from '../theme';

const { Text, Paragraph } = Typography;

const STATE_COLOURS: Record<string, string> = {
  ready: 'green', starting: 'processing', stopping: 'orange', stopped: 'default',
};

const EMPTY: ModelSpec = {
  id: '', name: '', description: '', model_file: '',
  ctx_size: 16384, n_gpu_layers: 99, ttl: 900, group: 'large', extra: '', mmproj: null,
  device: [] as string[],
};

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;

/** Basename first, then which repo it came from -- which is the only thing
 *  separating two files that are otherwise identically named. */
const fileLabel = (f: ModelFile) =>
  `${f.filename.split('/').pop()}${f.repo ? ` — ${f.repo}` : ''} (${f.size_gib} GiB)`;

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
  const { models, refreshModels } = useStream();
  const [files, setFiles] = useState<ModelFile[]>([]);
  const [partials, setPartials] = useState<PartialFile[]>([]);
  const [open, setOpen] = useState(false);
  // Non-null while editing an existing model; its id must stay fixed, because
  // changing it would create a second entry rather than rename the first.
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
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
  useEffect(() => {
    fetchBackendDevices().then(setDevices).catch(() => setDevices([]));
  }, []);

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

  const openEdit = async (id: string) => {
    try {
      const spec = await fetchModelSpec(id);
      form.setFieldsValue({ ...spec, device: deviceOf(spec.env) });
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

  const ggufFiles = files.filter((f) => !f.is_mmproj);
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
                    onClick={() => { form.setFieldsValue(EMPTY); setEditing(null); setOpen(true); }}>
              新增模型
            </Button>
          </Space>
        }
      >
        <Table<ModelInfo>
          dataSource={models}
          rowKey="id"
          size="small"
          pagination={false}
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
              title: '操作', width: 230,
              render: (_, row) => (
                <Space size="small">
                  <Tooltip title="送一個極小的請求把模型載入顯存">
                    <Button size="small" icon={<PlayCircleOutlined />}
                            loading={busy === row.id} disabled={row.running}
                            onClick={() => onLoad(row.id)}>
                      載入
                    </Button>
                  </Tooltip>
                  <Tooltip title="卸載，釋放顯存">
                    <Button size="small" icon={<PoweroffOutlined />}
                            loading={busy === row.id} disabled={!row.running}
                            onClick={() => onUnload(row.id)} />
                  </Tooltip>
                  <Tooltip title="修改設定">
                    <Button size="small" icon={<EditOutlined />}
                            onClick={() => openEdit(row.id)} />
                  </Tooltip>
                  <Button size="small" danger onClick={() => openDelete(row)}>移除</Button>
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
              title: '', width: 90, align: 'right',
              render: (_, group) => (group.unused > 0 ? (
                <Tag color="warning" style={{ marginInlineEnd: 0 }}>
                  {group.unused} 個未使用
                </Tag>
              ) : null),
            },
          ]}
        />
      </Card>

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
          <Form.Item name="model_file" label="模型檔" rules={[{ required: true }]}>
            <Select
              showSearch
              placeholder="從 ~/ai/models 選擇"
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
          {/* Only when there is a choice. One usable card means one option,
              and a select with one option is a question that should not have
              been asked -- the same rule as the log page's per-instance row
              and the paginator's size list. */}
          {devices.length > 1 && (
            <Form.Item name="device" label="顯示卡"
                       extra="只列出這台的 llama-server 真的看得到的卡。留空表示不指定；選兩張以上要搭配 --split-mode。">
              {/* Multiple, because one llama-server can hold more than one
                  card and splitting a model across them is the reason to own
                  a second. A single-value select could not represent that, so
                  it showed nothing for a two-card model and then saved the
                  nothing it showed. */}
              <Select
                mode="multiple"
                allowClear
                placeholder="不指定"
                options={devices.map((d) => ({
                  value: `${d.backend}:${d.index}`,
                  label: `${d.name}（${d.backend}${d.index}，${Math.round(d.total_mib / 1024)} GiB）`,
                }))}
              />
            </Form.Item>
          )}
          <Space size={16} style={{ display: 'flex' }}>
            <Form.Item name="ctx_size" label="Context 長度" style={{ flex: 1 }}>
              <InputNumber min={512} max={1048576} step={1024} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="ttl" label="閒置卸載（秒）" style={{ flex: 1 }}
                       extra="0 表示不自動卸載">
              <InputNumber min={0} step={60} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Form.Item name="n_gpu_layers" label="GPU 層數"
                     extra="0 表示不指定，讓 llama.cpp 自行決定。放不進顯存的模型必須用 0，否則 llama.cpp 會拒絕自動調整而直接失敗。">
            <InputNumber min={0} max={999} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="group" label="群組"
                     extra="large 為互斥（載入時會卸載其他模型），適合佔滿顯示卡的模型；small 可與 ComfyUI 並存。">
            <Select
              allowClear
              options={[
                { value: 'large', label: 'large — 互斥，佔滿顯示卡' },
                { value: 'small', label: 'small — 可與其他並存' },
              ]}
            />
          </Form.Item>
          <Form.Item name="extra" label="額外參數"
                     extra="每行一個，例如 --n-cpu-moe 20（把 MoE 專家層放到記憶體）">
            <Input.TextArea rows={3} placeholder="--flash-attn on" />
          </Form.Item>
        </Form>
      </Drawer>
    </Space>
  );
}
