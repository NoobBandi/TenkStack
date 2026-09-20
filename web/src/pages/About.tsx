import { useCallback, useEffect, useState } from 'react';
import { App as AntApp, Button, Tooltip, Typography } from 'antd';
import {
  CheckCircleFilled, GithubOutlined, ReloadOutlined, SyncOutlined, WarningFilled,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { applyRelease, checkRelease, fetchConsoleVersion, fetchRelease, type Release } from '../api';
import { useIsOwner } from '../identity';
import Markdown from '../components/Markdown';
import { ACCENT, LINE, MONO } from '../theme';

const { Text } = Typography;

/**
 * About: the mark, a sentence, the way to the source, and whether there is
 * a newer one. Composed like an about dialog -- centred in the space, one
 * column, generous air -- because that is all it has to say and a page of
 * cards would be furniture around nothing.
 *
 * The update check is per installation. Each console asks GitHub for the
 * newest release itself, a few times a day, and marks the version in the
 * sidebar when there is one. Nothing phones home; a machine with no route
 * out says it could not ask. Updating is one press for the administrator:
 * the release's binary for this architecture, checked against the release's
 * own SHA256SUMS, swapped in under the running process, and the service
 * restarted -- the same file the installer fetches, in the same place.
 */

const REPO_URL = 'https://github.com/NoobBandi/TenkStack';

const when = (t: number) => dayjs(t * 1000).format('YYYY/MM/DD HH:mm');

export default function About() {
  const { message, modal } = AntApp.useApp();
  const owner = useIsOwner();
  const [version, setVersion] = useState('');
  const [release, setRelease] = useState<Release | null>(null);
  const [checking, setChecking] = useState(false);
  const [notes, setNotes] = useState(false);
  const [applying, setApplying] = useState<'' | 'downloading' | 'restarting'>('');

  useEffect(() => {
    fetchConsoleVersion().then(setVersion).catch(() => undefined);
    fetchRelease().then(setRelease).catch(() => undefined);
  }, []);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const found = await checkRelease();
      setRelease(found);
      if (found.error) message.warning(found.error);
      else message.success(found.newer ? `有新版 v${found.latest}` : '已是最新');
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setChecking(false);
    }
  }, [message]);

  // After the swap the old process restarts itself. The page waits for the
  // version endpoint to answer with the new number, then reloads so the
  // frontend inside the new binary is the one on screen.
  const apply = () => {
    if (!release?.latest) return;
    const target = release.latest;
    modal.confirm({
      title: `更新到 v${target}？`,
      content: '會下載這個 release 的主控台、核對校驗碼、換掉現在的檔案，然後重啟主控台。大約十秒，這段時間頁面會斷線一下；正在進行的對話會中斷。',
      okText: '更新', cancelText: '取消',
      onOk: async () => {
        setApplying('downloading');
        try {
          const result = await applyRelease();
          if (!result.restarting) {
            setApplying('');
            message.warning(result.detail ?? '檔案換好了，請自己重啟主控台');
            return;
          }
          setApplying('restarting');
          const deadline = Date.now() + 90000;
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 2000));
            try {
              if ((await fetchConsoleVersion()) === target) {
                window.location.reload();
                return;
              }
            } catch {
              // Still restarting.
            }
          }
          setApplying('');
          message.error('主控台沒有在時間內回來；看一下日誌，舊的檔案還在旁邊叫 tenkstack.prev');
        } catch (error) {
          setApplying('');
          message.error(`更新失敗：${(error as Error).message}`);
        }
      },
    });
  };

  const latest = release?.latest ?? null;
  const newer = !!release?.newer;

  return (
    <div style={{
      minHeight: 'calc(100vh - 56px - 48px)', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '24px 0 48px',
    }}>
      {/* The sidebar's mark, served from the console itself. */}
      <img src="/logo.webp" alt="TenkStack" style={{ height: 96, display: 'block', opacity: 0.95 }} />
      <Text style={{ fontSize: 12, fontFamily: MONO, letterSpacing: 2, opacity: 0.45, marginTop: 14 }}>
        {version ? `v${version}` : ''}
      </Text>

      <Text style={{ fontSize: 15, marginTop: 28 }}>一台設備搭配一款平台，即可運作本地模型</Text>
      <Text type="secondary" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.8, maxWidth: 520 }}>
        TenkStack 是一款在本地端運作的 AI 平台。透過瀏覽器介面即可安裝模型、與模型對話、生成圖片與影片；
        所有運算都在你的機器上完成，資料不會離開。同時提供與 OpenAI、Anthropic 相容的 API，
        Claude Code、Codex 等工具可直接連接使用。
      </Text>

      <div style={{ marginTop: 22 }}>
        <Button icon={<GithubOutlined />} href={REPO_URL} target="_blank" rel="noreferrer">GitHub</Button>
      </div>

      {/* ---- update ------------------------------------------------------------ */}
      <div style={{
        marginTop: 44, width: '100%', maxWidth: 560, textAlign: 'left',
        borderTop: `1px solid ${LINE.faint}`, paddingTop: 20,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {newer
            ? <WarningFilled style={{ color: ACCENT.warn, fontSize: 16 }} />
            : latest
              ? <CheckCircleFilled style={{ color: ACCENT.ok, fontSize: 16 }} />
              : <span style={{ width: 14, height: 14, borderRadius: '50%', border: `1px solid ${LINE.medium}`, flex: 'none' }} />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ fontSize: 13, display: 'block' }}>
              {newer ? `有新版 v${latest}` : latest ? '已是最新' : '查不到最新版本'}
            </Text>
            <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 2 }}>
              {release?.error
                ? release.error
                : newer && release?.published_at
                  ? `發布於 ${when(release.published_at)}`
                  : release?.checked_at ? `上次檢查 ${when(release.checked_at)}` : '還沒查過'}
            </Text>
          </div>
          {newer && release?.body && (
            <Button size="small" type="text" onClick={() => setNotes((v) => !v)}>
              {notes ? '收起' : '說明'}
            </Button>
          )}
          {owner && (
            <Tooltip title="現在就問 GitHub 一次">
              <Button size="small" icon={<ReloadOutlined />} loading={checking} onClick={() => void check()}>
                檢查更新
              </Button>
            </Tooltip>
          )}
          {newer && owner && (
            <Tooltip title={release?.apply_note || undefined}>
              <Button size="small" type="primary" ghost
                      icon={applying ? <SyncOutlined spin /> : undefined}
                      disabled={!release?.can_apply || !!applying} onClick={apply}>
                {applying === 'downloading' ? '下載中…' : applying === 'restarting' ? '重啟中…' : '更新'}
              </Button>
            </Tooltip>
          )}
        </div>

        {newer && notes && release?.body && (
          <div style={{
            marginTop: 14, padding: '10px 14px', borderRadius: 6, border: `1px solid ${LINE.faint}`, fontSize: 12,
          }}>
            {release.name && <Text style={{ fontSize: 12, fontFamily: MONO, display: 'block', marginBottom: 6 }}>{release.name}</Text>}
            <Markdown>{release.body}</Markdown>
            {release.url && (
              <a href={release.url} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>在 GitHub 看這個 release</a>
            )}
          </div>
        )}

        <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 14, lineHeight: 1.7, opacity: 0.8 }}>
          每台裝了 TenkStack 的機器都自己向 GitHub 問最新的 release，一天幾次；有新版時側欄的版本號旁邊會亮起來。
          更新會抓這個 release 的主控台、核對 SHA256SUMS、換掉檔案並重啟，舊的留在旁邊叫
          <span style={{ fontFamily: MONO }}> tenkstack.prev</span>。
        </Text>
      </div>

      {/* The colophon, where an about screen keeps it: last, small, out of
          the way of anything that is pressed. */}
      <Text type="secondary" style={{ fontSize: 10, letterSpacing: 0.6, marginTop: 40, opacity: 0.6 }}>
        以 Apache License 2.0 開源
      </Text>
    </div>
  );
}
