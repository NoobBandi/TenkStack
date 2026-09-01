/**
 * A model's tensors, grouped by the layer they belong to.
 *
 * The flat table this replaces listed up to four thousand rows twenty-five at a
 * time. Every question anybody actually asks of it -- how is layer 12 put
 * together, which layers were left at higher precision, where did the size go
 * -- needs the layer, and a flat list buries the layer in a name that has to be
 * read character by character across two hundred pages.
 *
 * So: one row per layer, expandable to its tensors, with the shape of the layer
 * stated on the row itself. A mixed quantisation becomes visible without
 * opening anything, which is the whole point on a file whose name says Q6_K and
 * whose weights are half Q8_0.
 *
 * Names are `blk.12.attn_q.weight` in GGUF and `model.layers.12.self_attn...`
 * in safetensors; both put the index in the first numeric segment, which is
 * what this keys on. Anything without one -- embeddings, the output head, norms
 * -- is not a layer and is kept separate rather than forced into a bucket.
 */
import { useMemo, useState } from 'react';
import { Input, Space, Table, Tag, Typography } from 'antd';
import { MONO } from '../theme';

const { Text } = Typography;

export interface Tensor {
  name: string;
  dtype: string;
  shape: number[];
  params?: number;
  /** safetensors states this; GGUF does not, and it is left out rather than
   *  guessed from dtype and shape. */
  bytes?: number;
}

interface Group {
  key: string;
  label: string;
  /** Null for the tensors that belong to no layer. */
  index: number | null;
  tensors: Tensor[];
  params: number;
  bytes: number;
  dtypes: string[];
}

function si(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KiB`;
  return `${n} B`;
}

/** The layer index in a tensor name, or null when it names something that is
 *  not part of the repeating stack. */
function layerOf(name: string): number | null {
  const m = name.match(/(?:^|\.)(?:blk|layers|h|block)\.(\d+)\./)
    ?? name.match(/(?:^|\.)(\d+)\./);
  return m ? Number(m[1]) : null;
}

/** What a tensor is for, taken from the part of the name after the layer.
 *  Coarse on purpose: the point is to see attention against feed-forward
 *  against norms, not to name every projection. */
function roleOf(name: string): string {
  const tail = name.toLowerCase();
  if (tail.includes('norm') || tail.includes('_ln') || tail.includes('layernorm')) return 'norm';
  if (tail.includes('attn') || tail.includes('attention')) return 'attn';
  if (tail.includes('ffn') || tail.includes('mlp') || tail.includes('feed')) return 'ffn';
  if (tail.includes('expert') || tail.includes('gate')) return 'moe';
  if (tail.includes('embd') || tail.includes('embed')) return 'embed';
  if (tail.includes('output') || tail.includes('lm_head')) return 'output';
  return '—';
}

const ROLE_COLOUR: Record<string, string> = {
  attn: 'geekblue', ffn: 'green', moe: 'purple', norm: 'default',
  embed: 'gold', output: 'volcano',
};

export default function TensorTable({ tensors, truncated }: {
  tensors: Tensor[];
  truncated?: boolean;
}) {
  const [needle, setNeedle] = useState('');

  const filtered = useMemo(() => {
    const q = needle.trim().toLowerCase();
    return q ? tensors.filter((t) => t.name.toLowerCase().includes(q)) : tensors;
  }, [tensors, needle]);

  const groups = useMemo(() => {
    const map = new Map<string, Group>();
    for (const t of filtered) {
      const index = layerOf(t.name);
      const key = index === null ? 'other' : `L${index}`;
      let g = map.get(key);
      if (!g) {
        g = {
          key,
          label: index === null ? '不屬於任何層' : `第 ${index} 層`,
          index,
          tensors: [],
          params: 0,
          bytes: 0,
          dtypes: [],
        };
        map.set(key, g);
      }
      g.tensors.push(t);
      g.params += t.params ?? 0;
      g.bytes += t.bytes ?? 0;
      if (t.dtype && !g.dtypes.includes(t.dtype)) g.dtypes.push(t.dtype);
    }
    return [...map.values()].sort((a, b) => {
      // Layers in order, and the odds and ends -- embeddings, output head --
      // last, since they are context rather than the thing being examined.
      if (a.index === null) return 1;
      if (b.index === null) return -1;
      return a.index - b.index;
    });
  }, [filtered]);

  const totals = useMemo(() => ({
    params: filtered.reduce((n, t) => n + (t.params ?? 0), 0),
    bytes: filtered.reduce((n, t) => n + (t.bytes ?? 0), 0),
  }), [filtered]);

  const hasBytes = totals.bytes > 0;

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Space size={10} wrap>
        <Input.Search
          size="small"
          allowClear
          placeholder="篩選張量名稱，例如 attn 或 blk.12"
          value={needle}
          onChange={(e) => setNeedle(e.target.value)}
          style={{ width: 260 }}
        />
        <Text type="secondary" style={{ fontSize: 11, fontFamily: MONO }}>
          {groups.length} 組 ・ {filtered.length} 個張量 ・ {si(totals.params)} 參數
          {hasBytes ? ` ・ ${bytes(totals.bytes)}` : ''}
        </Text>
        {truncated && (
          <Text type="warning" style={{ fontSize: 11 }}>只讀了前 {tensors.length} 個</Text>
        )}
      </Space>

      <Table<Group>
        size="small"
        dataSource={groups}
        rowKey="key"
        pagination={groups.length > 40 ? { pageSize: 40, size: 'small' } : false}
        expandable={{
          expandedRowRender: (group) => (
            <Table<Tensor>
              size="small"
              dataSource={group.tensors}
              rowKey="name"
              pagination={false}
              showHeader={false}
              columns={[
                {
                  dataIndex: 'name',
                  render: (v: string) => (
                    <Text style={{ fontSize: 11, fontFamily: MONO }}>{v}</Text>
                  ),
                },
                {
                  dataIndex: 'name', key: 'role', width: 70,
                  render: (v: string) => {
                    const role = roleOf(v);
                    return role === '—'
                      ? <Text type="secondary" style={{ fontSize: 10 }}>—</Text>
                      : <Tag color={ROLE_COLOUR[role]} style={{ fontSize: 10 }}>{role}</Tag>;
                  },
                },
                {
                  dataIndex: 'dtype', width: 80,
                  render: (v: string) => (
                    <Text style={{ fontSize: 11, fontFamily: MONO, opacity: 0.75 }}>{v}</Text>
                  ),
                },
                {
                  dataIndex: 'shape', width: 170, align: 'right',
                  render: (v: number[]) => (
                    <Text style={{ fontSize: 11, fontFamily: MONO, opacity: 0.6 }}>
                      {v.join(' × ')}
                    </Text>
                  ),
                },
                {
                  dataIndex: 'params', width: 70, align: 'right',
                  render: (v?: number) => (
                    <Text style={{ fontSize: 11, fontFamily: MONO, opacity: 0.6 }}>
                      {v ? si(v) : ''}
                    </Text>
                  ),
                },
              ]}
            />
          ),
        }}
        columns={[
          {
            title: '層',
            dataIndex: 'label',
            width: 130,
            render: (v: string) => <Text style={{ fontSize: 12 }}>{v}</Text>,
          },
          {
            title: '量化型別',
            dataIndex: 'dtypes',
            render: (v: string[]) => (
              <Space size={4} wrap>
                {v.map((d) => (
                  <Tag
                    key={d}
                    style={{ fontSize: 10, fontFamily: MONO, marginInlineEnd: 0 }}
                    // F32 and F16 are the unquantised remainder -- norms and
                    // biases -- and are present in every layer, so they are
                    // dimmed rather than coloured: what a reader is looking for
                    // is which layer differs, and that is never the F32.
                    color={d.startsWith('F') || d.startsWith('BF') ? undefined : 'blue'}
                  >
                    {d}
                  </Tag>
                ))}
              </Space>
            ),
          },
          {
            title: '張量', dataIndex: 'tensors', width: 70, align: 'right',
            render: (v: Tensor[]) => (
              <Text style={{ fontSize: 11, fontFamily: MONO, opacity: 0.7 }}>{v.length}</Text>
            ),
          },
          {
            title: '參數', dataIndex: 'params', width: 80, align: 'right',
            render: (v: number) => (
              <Text style={{ fontSize: 11, fontFamily: MONO, opacity: 0.7 }}>
                {v ? si(v) : ''}
              </Text>
            ),
          },
          ...(hasBytes ? [{
            title: '大小', dataIndex: 'bytes', width: 90, align: 'right' as const,
            render: (v: number) => (
              <Text style={{ fontSize: 11, fontFamily: MONO, opacity: 0.7 }}>
                {v ? bytes(v) : ''}
              </Text>
            ),
          }] : []),
        ]}
      />
    </Space>
  );
}
