import { useState } from 'react';
import { App as AntApp, Button, Popconfirm, Progress, Space, Tooltip, Typography } from 'antd';
import { cancelBench, startBench, type BenchProgress } from '../../api';
import { benchActive, clockHM, useBenchStatus } from '../../benchState';
import { MONO } from '../../theme';
import { ResultsTable } from './BenchResults';
import { caseLabel, fmtDuration, tierLabel } from './labels';

const { Text } = Typography;

/** Draining this long with requests still in flight, and 強制開始 is offered.
 *  The backend has its own drain limit; this only decides when the button
 *  stops being a distraction and starts being the way out. */
const FORCE_AFTER_S = 30;

function elapsed(status: BenchProgress): number {
  if (status.elapsed_s !== undefined) return status.elapsed_s;
  return status.started_at ? Math.max(0, Date.now() / 1000 - status.started_at) : 0;
}

/**
 * A run in progress: what it is doing, how far it is, the results so far,
 * and the way to stop it. Shown in the drawer that started it and at the top
 * of 跑分紀錄, so an administrator who navigated away can still find it.
 */
export default function BenchProgressView({ status, showModel }: {
  status: BenchProgress; showModel?: boolean;
}) {
  const { message } = AntApp.useApp();
  const { refresh } = useBenchStatus();
  const [cancelling, setCancelling] = useState(false);
  const [forcing, setForcing] = useState(false);
  const draining = status.state === 'draining';
  const seconds = elapsed(status);
  const percent = status.total > 0 ? Math.round((status.done / status.total) * 100) : 0;

  const cancel = async () => {
    setCancelling(true);
    try {
      await cancelBench();
      await refresh();
    } catch (e) {
      message.error(`取消失敗：${(e as Error).message}`);
    } finally {
      setCancelling(false);
    }
  };

  const force = async () => {
    if (!status.model || !status.tier) return;
    setForcing(true);
    try {
      await startBench(status.model, { tier: status.tier, cases: status.cases, repeats: status.repeats }, true);
      await refresh();
    } catch (e) {
      message.error(`無法強制開始：${(e as Error).message}`);
    } finally {
      setForcing(false);
    }
  };

  const headline = draining
    ? (status.in_flight > 0 ? `等待 ${status.in_flight} 個進行中的請求結束` : '準備開始…')
    : status.case ? `正在跑：${caseLabel(status.case)}` : '準備中…';

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <div>
        {showModel && status.model && (
          <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
            <span style={{ fontFamily: MONO }}>{status.model}</span>・{tierLabel(status.tier)}檔
          </Text>
        )}
        <Text strong style={{ fontSize: 15 }}>{headline}</Text>
        {status.message && (
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 2 }}>
            {status.message}
          </Text>
        )}
      </div>

      <div>
        <Progress
          percent={percent}
          status={benchActive(status) ? 'active' : undefined}
          format={() => `${status.done} / ${status.total}`}
          // The label is "3 / 9", which is wider than the default "100%".
          styles={{ indicator: { minWidth: 52, textAlign: 'right' } }}
        />
        <Text type="secondary" style={{ fontSize: 12, fontFamily: MONO }}>
          已經過 {fmtDuration(seconds)}
          {status.resume_at ? `・對外 API 預計 ${clockHM(status.resume_at)} 恢復` : ''}
        </Text>
      </div>

      <Space wrap>
        <Popconfirm
          title="取消跑分？"
          description="對外 API 會立即恢復。"
          okText="取消跑分" cancelText="繼續跑"
          okButtonProps={{ danger: true }}
          onConfirm={cancel}
        >
          <Button danger loading={cancelling}>取消跑分</Button>
        </Popconfirm>
        {draining && status.in_flight > 0 && seconds >= FORCE_AFTER_S && (
          <Popconfirm
            title="不等了，直接開始？"
            description={`還有 ${status.in_flight} 個請求在跑，會跟跑分搶同一張卡，前幾項的數字可能偏低。`}
            okText="強制開始" cancelText="再等等"
            onConfirm={force}
          >
            <Tooltip title="進行中的請求太久沒結束時用">
              <Button loading={forcing}>強制開始</Button>
            </Tooltip>
          </Popconfirm>
        )}
      </Space>

      {draining && status.drain_timed_out && (
        <Text type="warning">進行中的請求等太久了：再過 2 分鐘沒有回應會自動取消，可以強制開始或取消。</Text>
      )}

      <ResultsTable results={status.results} running={draining ? undefined : status.case} />
      {!!status.skipped?.length && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          略過：{status.skipped.map((s) => {
            const [id, ...why] = s.split(': ');
            return `${caseLabel(id)}（${why.join(': ')}）`;
          }).join('、')}
        </Text>
      )}
    </Space>
  );
}
