import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, App as AntApp, Button, Card, Empty, Space, Spin, Typography } from 'antd';
import { FieldTimeOutlined, HistoryOutlined, LoadingOutlined } from '@ant-design/icons';
import { useSearchParams } from 'react-router-dom';
import {
  benchRun, benchRuns, deleteBenchRun, type BenchRun, type BenchRunRow,
} from '../api';
import { benchActive, useBenchStatus } from '../benchState';
import { useIsOwner } from '../identity';
import BenchProgressView from '../components/bench/BenchProgressView';
import BenchDetail from '../components/bench/BenchDetail';
import BenchDrawer from '../components/bench/BenchDrawer';
import BenchReport, { CopyReport, RunHeader } from '../components/bench/BenchReport';
import RunsDialog from '../components/bench/RunList';
import { runView, type RunView } from '../components/bench/metrics';
import { usePresence } from '../components/bench/presence';

const { Text, Paragraph } = Typography;

/** Side by side stops being readable past three column groups. */
const MAX_COMPARE = 3;

const viewKey = (v: RunView) => v.key;

/** What the page is showing: the runs, their views, and the letter each wears. */
interface Shown { runs: BenchRun[]; views: RunView[]; marks: number[] }
const NOTHING: Shown = { runs: [], views: [], marks: [] };

/**
 * Which run mark (A, B, C and their colours) each selected run wears.
 *
 * A run keeps its mark while it stays selected: unticking A leaves B as B, in
 * its own colour, rather than repainting it as A, because a colour that
 * moves to another run misreads every chart already looked at. A newly
 * picked run takes the first free mark.
 */
function assignMarks(ids: number[], prev: Record<number, number>): Record<number, number> {
  const out: Record<number, number> = {};
  for (const id of ids) if (prev[id] !== undefined) out[id] = prev[id];
  const taken = new Set(Object.values(out));
  for (const id of ids) {
    if (out[id] !== undefined) continue;
    let m = 0;
    while (taken.has(m)) m += 1;
    out[id] = m;
    taken.add(m);
  }
  return out;
}

function parseIds(param: string | null): number[] {
  if (!param) return [];
  return param.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, MAX_COMPARE);
}

/** For someone who has never run one: what this is, and where to start. */
function Introduction({ onStart }: { onStart: () => void }) {
  return (
    <Card size="small">
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={(
          <div style={{ maxWidth: 520, margin: '0 auto', textAlign: 'left' }}>
            <Paragraph style={{ marginBottom: 8, fontSize: 15 }}>還沒有跑分紀錄</Paragraph>
            <Paragraph type="secondary" style={{ fontSize: 13 }}>
              跑分用一組固定的測試量一個模型在這台機器上有多快：第一個字要等多久（TTFT）、
              讀入提示多快（Prefill）、每秒生成幾個字（Decode），以及上下文變長或多人同時用時慢多少。每次跑完都會存在這裡。
            </Paragraph>
            <Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 0 }}>
              改了模型的參數（例如 KV 快取型別、推測解碼、顯存比例）之後再跑一次，勾選兩筆並排比較，
              就看得出哪組設定比較快、差在哪幾個參數。
            </Paragraph>
          </div>
        )}
      >
        <Button type="primary" icon={<FieldTimeOutlined />} onClick={onStart}>開始跑分</Button>
      </Empty>
    </Card>
  );
}

export default function Bench() {
  const owner = useIsOwner();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const { message } = AntApp.useApp();
  const { status } = useBenchStatus();
  const [rows, setRows] = useState<BenchRunRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [params, setParams] = useSearchParams();
  const selected = useMemo(() => parseIds(params.get('run')), [params]);
  const [details, setDetails] = useState<Record<number, BenchRun>>({});
  const [markState, setMarkState] = useState<Record<number, number>>({});
  // Derived on every render from the last assignment, so a selection that
  // arrives through the URL (back, a link) still gets marks.
  const marks = useMemo(() => assignMarks(selected, markState), [selected, markState]);
  // What `select` assigns from: the marks on screen, not the last stored ones,
  // which are empty for a selection that came in through the URL.
  const marksNow = useRef(marks);
  useEffect(() => { marksNow.current = marks; }, [marks]);
  const [detailError, setDetailError] = useState<string | null>(null);

  // In mark order: A first, which is what the percentages compare against.
  // Memoised, like everything drawn from it, so the charts' data stays the
  // same array between the page's polls.
  // Only once every selected run has arrived: until then the result on
  // screen stays as it was, so picking another run in the dialog moves
  // from one result to the next without an empty frame between them.
  const fresh = useMemo<Shown | null>(() => {
    if (!selected.every((id) => details[id])) return null;
    const runs = [...selected].sort((a, b) => marks[a] - marks[b]).map((id) => details[id]);
    return { runs, views: runs.map((r) => runView(r, marks[r.id])), marks: runs.map((r) => marks[r.id]) };
  }, [selected, details, marks]);
  const [kept, setKept] = useState<Shown>(NOTHING);
  if (fresh && fresh !== kept) setKept(fresh);
  const { runs: shown, views, marks: shownMarks } = fresh ?? kept;
  // A run unticked stays a moment, folding away, rather than vanishing.
  const present = usePresence(views, viewKey);
  const drawn = useMemo(() => present.map((p) => (p.leaving ? { ...p.item, leaving: true } : p.item)), [present]);

  const select = useCallback((ids: number[]) => {
    setMarkState(assignMarks(ids, marksNow.current));
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (ids.length) next.set('run', ids.join(','));
      else next.delete('run');
      return next;
    }, { replace: true });
  }, [setParams]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const found = await benchRuns();
      setRows(found);
      setError(null);
      return found;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  // The newest run is selected when nothing is, so the page opens on a result
  // rather than on a list that asks to be clicked first.
  useEffect(() => {
    if (!owner) return;
    void load().then((found) => {
      if (found?.length && !parseIds(new URLSearchParams(window.location.search).get('run')).length) {
        select([found[0].id]);
      }
    });
  }, [owner, load, select]);

  // A run that finishes while the page is open joins the list.
  // Asked once per run, so a list that somehow lacks it does not loop.
  const fetchedFor = useRef<number | undefined>(undefined);
  useEffect(() => {
    const id = status?.run_id;
    if (status?.state !== 'done' || id === undefined || rows === null) return;
    if (rows.some((r) => r.id === id) || fetchedFor.current === id) return;
    fetchedFor.current = id;
    void load();
  }, [status?.state, status?.run_id, rows, load]);

  // Every run's details as the dialog opens, so a pick there shows at once
  // rather than after a round trip.
  useEffect(() => {
    if (!listOpen || !rows) return;
    const missing = rows.map((r) => r.id).filter((id) => !details[id]);
    if (!missing.length) return;
    Promise.all(missing.map(benchRun))
      .then((got) => setDetails((prev) => ({ ...prev, ...Object.fromEntries(got.map((r) => [r.id, r])) })))
      .catch(() => { /* the pick fetches its own and reports a failure */ });
  }, [listOpen, rows, details]);

  // Details for what is selected, fetched once each.
  useEffect(() => {
    const missing = selected.filter((id) => !details[id]);
    if (!missing.length) return;
    Promise.all(missing.map(benchRun))
      .then((got) => {
        setDetails((prev) => ({ ...prev, ...Object.fromEntries(got.map((r) => [r.id, r])) }));
        setDetailError(null);
      })
      .catch((e: Error) => setDetailError(e.message));
  }, [selected, details]);

  const remove = async (id: number) => {
    try {
      await deleteBenchRun(id);
      message.success('已刪除');
      select(selected.filter((s) => s !== id));
      setDetails((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      void load();
    } catch (e) {
      message.error(`刪除失敗：${(e as Error).message}`);
    }
  };

  if (!owner) {
    return <Alert type="info" showIcon message="只有管理員可以查看跑分紀錄" />;
  }

  const toggle = (id: number) => {
    if (selected.includes(id)) select(selected.filter((s) => s !== id));
    else if (selected.length < MAX_COMPARE) select([...selected, id]);
    else message.info(`最多並排比較 ${MAX_COMPARE} 筆`);
  };

  const empty = rows !== null && rows.length === 0 && !error;

  // Starting lives here, on the page whose records it adds to: the drawer
  // picks the model. While a run holds /v1 the same button opens its progress.
  const running = benchActive(status);
  const actions = (
    <Space size={8} wrap>
      {drawn.length > 0 && <CopyReport runs={drawn} />}
      <Button size="small" icon={<HistoryOutlined />} onClick={() => setListOpen(true)}>跑分紀錄</Button>
      <Button size="small" type="primary" onClick={() => setDrawerOpen(true)}
              icon={running ? <LoadingOutlined /> : <FieldTimeOutlined />}>
        {running ? '查看進度' : '開始跑分'}
      </Button>
    </Space>
  );

  // What is being read, and the two ways off this page's subject: the
  // records in a dialog, a new run in the drawer. The whole width below is
  // the result's.
  const header = (
    <Card size="small" styles={{ body: { display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' } }}>
      <div style={{ flex: 1, minWidth: 240 }}>
        {drawn.length ? <RunHeader runs={drawn} /> : rows === null && !error ? <Spin size="small" /> : (
          <Text type="secondary">{selected.length ? '讀取中…' : '到「跑分紀錄」勾一筆來看'}</Text>
        )}
      </div>
      {actions}
    </Card>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingBottom: 24 }}>
      {benchActive(status) && status && (
        <Card size="small" title="目前跑分">
          <BenchProgressView status={status} showModel />
        </Card>
      )}

      {error && <Alert type="error" showIcon message="讀不到跑分紀錄" description={error} />}

      {empty ? <Introduction onStart={() => setDrawerOpen(true)} /> : (
        <>
          {header}
          {detailError && <Alert type="error" showIcon message="讀不到這筆紀錄" description={detailError} />}
          {drawn.length > 0 ? <BenchReport runs={drawn} /> : rows !== null && (
            <Card size="small">
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="還沒選要看的紀錄">
                <Button onClick={() => setListOpen(true)}>打開跑分紀錄</Button>
              </Empty>
            </Card>
          )}
          {shown.length > 0 && <BenchDetail runs={shown} marks={shownMarks} />}
        </>
      )}

      <RunsDialog
        open={listOpen} onClose={() => setListOpen(false)}
        rows={rows} loading={loading} onReload={() => void load()}
        selected={selected} marks={marks} max={MAX_COMPARE}
        onPick={(id) => select([id])} onToggle={toggle} onDelete={(id) => void remove(id)}
      />
      <BenchDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </div>
  );
}
