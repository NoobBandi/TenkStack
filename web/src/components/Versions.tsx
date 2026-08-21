import { useEffect, useState } from 'react';
import { Card, Col, Row, Tag, Tooltip, Typography } from 'antd';
import { fetchVersions, type VersionReport } from '../api';
import { LINE, MONO } from '../theme';

const { Text } = Typography;

/**
 * What is actually installed.
 *
 * Version drift is the usual explanation when something that worked yesterday
 * does not today, and every component here reports itself somewhere different.
 *
 * Three of these rows used to read `—` on this machine and it was not because
 * anything was missing. The ComfyUI stack was asked of a fixed port, so
 * switching that card off made ComfyUI, PyTorch and Python all unknown; and the
 * running llama.cpp build was asked of a loaded model, which most of the time
 * there is not. Both are now asked of something that exists whether or not
 * anything is being served -- every instance that answers, and the launcher
 * binary itself.
 */

function Line({ label, value, hint }: { label: string; value?: string | null; hint?: string }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', gap: 10,
      padding: '3px 0', borderBottom: `1px solid ${LINE.faint}`,
    }}>
      <Text style={{ fontSize: 11, opacity: 0.55, whiteSpace: 'nowrap' }}>{label}</Text>
      <Tooltip title={hint ?? (value && value.length > 22 ? value : undefined)}>
        <Text style={{
          fontSize: 11, fontFamily: MONO, textAlign: 'right',
          // An unprobed component reads as unknown, not as absent.
          opacity: value ? 0.9 : 0.3,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          maxWidth: 170,
        }}>
          {value || '—'}
        </Text>
      </Tooltip>
    </div>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <Text style={{ fontSize: 10, letterSpacing: 1, opacity: 0.4 }}>{children}</Text>
  );
}

export default function Versions() {
  const [report, setReport] = useState<VersionReport | null>(null);

  useEffect(() => {
    fetchVersions().then(setReport).catch(() => setReport(null));
  }, []);

  const inference = report?.inference;

  return (
    <Card size="small" title={<span style={{ fontSize: 12, opacity: 0.75 }}>版本</span>}
          loading={report === null}>
      <Row gutter={[20, 14]}>
        <Col xs={24} md={8}>
          <Heading>推論</Heading>
          <div style={{ marginTop: 6 }}>
            {/* One row per launcher: a machine can have a native build for one
                card and a container for another, and they are different
                llama.cpp builds. */}
            {(inference?.launchers ?? []).map((launcher) => (
              <Line
                key={launcher.launcher}
                label={launcher.launcher}
                value={launcher.version}
                hint={launcher.built ? `built with ${launcher.built}` : undefined}
              />
            ))}
            {inference?.running && <Line label="服務中的 build" value={inference.running} />}
            <Line label="llama.cpp 原始碼" value={inference?.source} />
            <Line label="llama-swap" value={inference?.swap} />
          </div>
        </Col>

        <Col xs={24} md={8}>
          <Heading>圖像生成</Heading>
          <div style={{ marginTop: 6 }}>
            {(report?.comfyui ?? []).map((instance) => (
              <div key={instance.port} style={{ marginBottom: 8 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '2px 0' }}>
                  <Tag style={{ fontFamily: MONO, fontSize: 10, marginInlineEnd: 0 }}>
                    :{instance.port}
                  </Tag>
                  <Text style={{ fontSize: 11, opacity: 0.55, overflow: 'hidden',
                                 textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {instance.device.replace(/ : .*$/, '') || '—'}
                  </Text>
                </div>
                <Line label="ComfyUI" value={instance.comfyui} />
                <Line label="PyTorch" value={instance.pytorch} />
                <Line label="Python" value={instance.python} />
              </div>
            ))}
            {report && report.comfyui.length === 0 && (
              <Text style={{ fontSize: 11, opacity: 0.3 }}>沒有執行中的實例</Text>
            )}
          </div>
        </Col>

        <Col xs={24} md={8}>
          <Heading>系統</Heading>
          <div style={{ marginTop: 6 }}>
            {(report?.system ?? []).map((row) => (
              <Line key={row.label} label={row.label} value={row.value} />
            ))}
          </div>
        </Col>
      </Row>
    </Card>
  );
}
