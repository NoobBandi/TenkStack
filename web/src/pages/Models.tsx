import { useCallback, useEffect, useState } from 'react';
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
  deleteFile, deleteModel, deletePartial, fetchModelFiles, fetchModelSpec, fetchPartials,
  loadModel, modelFileRefs, saveModel, unloadAll, unloadModel,
  type ModelFile, type ModelFileRef, type ModelInfo, type ModelSpec, type PartialFile,
} from '../api';

const { Text, Paragraph } = Typography;

const STATE_COLOURS: Record<string, string> = {
  ready: 'green', starting: 'processing', stopping: 'orange', stopped: 'default',
};

const EMPTY: ModelSpec = {
  id: '', name: '', description: '', model_file: '',
  ctx_size: 16384, n_gpu_layers: 99, ttl: 900, group: 'large', extra: '', mmproj: null,
};

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;

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

  const onSave = async () => {
    const values = await form.validateFields();
    try {
      await saveModel({ ...values, name: values.name || values.id });
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
      form.setFieldsValue(spec);
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
              <Descriptions size="small" column={1} style={{ maxWidth: 720 }}>
                <Descriptions.Item label="說明">{row.description || '—'}</Descriptions.Item>
                <Descriptions.Item label="上游">{row.proxy || '未載入'}</Descriptions.Item>
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
          orphans.length > 0 && (
            <Text type="warning" style={{ fontSize: 12 }}>
              {orphans.length} 個未使用檔案，共 {gib(orphanBytes)}
            </Text>
          )
        }
      >
        <Table<ModelFile>
          dataSource={files}
          rowKey="filename"
          size="small"
          pagination={false}
          locale={{ emptyText: '~/ai/models 中沒有 GGUF 檔' }}
          columns={[
            { title: '檔名', dataIndex: 'filename' },
            { title: '大小', dataIndex: 'size_gib', width: 110, render: (v: number) => `${v} GiB` },
            {
              title: '使用中的模型', dataIndex: 'used_by', width: 220,
              render: (used: string[]) =>
                used.length ? (
                  <Space size={4} wrap>{used.map((id) => <Tag key={id}>{id}</Tag>)}</Space>
                ) : (
                  <Tag color="warning">未使用</Tag>
                ),
            },
            {
              title: '', width: 90,
              render: (_, row) => (
                <Popconfirm
                  title={`刪除 ${row.filename}？`}
                  description={`會從磁碟永久移除 ${row.size_gib} GiB，無法復原。`}
                  onConfirm={() => onDeleteFile(row.filename)}
                  okText="刪除" cancelText="取消" okButtonProps={{ danger: true }}
                  disabled={row.used_by.length > 0}
                >
                  <Tooltip title={row.used_by.length ? '仍被模型設定使用，需先移除該模型' : undefined}>
                    <Button size="small" danger icon={<DeleteOutlined />}
                            disabled={row.used_by.length > 0} />
                  </Tooltip>
                </Popconfirm>
              ),
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
              options={ggufFiles.map((f) => ({
                value: f.filename, label: `${f.filename} (${f.size_gib} GiB)`,
              }))}
            />
          </Form.Item>
          <Form.Item name="mmproj" label="視覺投影檔（選用）"
                     extra="視覺模型才需要，會額外佔用顯存">
            <Select
              allowClear
              placeholder="無"
              options={mmprojFiles.map((f) => ({
                value: f.filename, label: `${f.filename} (${f.size_gib} GiB)`,
              }))}
            />
          </Form.Item>
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
