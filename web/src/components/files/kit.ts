import type { FsEntry } from '../../api';

/**
 * What the file manager's parts share: how a size and a time are written,
 * how an entry is identified, what a transfer in flight looks like.
 */

export function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KiB`;
  return `${n} B`;
}

export function when(seconds: number): string {
  if (!seconds) return '';
  return new Date(seconds * 1000).toLocaleString('zh-TW', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

export function whenLong(seconds: number): string {
  if (!seconds) return '';
  return new Date(seconds * 1000).toLocaleString('zh-TW', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

/** Kind and name together: a file and a folder may share a name. */
export const keyOf = (e: FsEntry) => `${e.kind}:${e.name}`;

export interface Transfer {
  id: string;
  name: string;
  /** Where it is going, so a transfer started three folders ago still says. */
  root: string;
  path: string;
  size: number;
  sent: number;
  error?: string;
  abort: AbortController;
}

/** A directory's recursive size, once somebody has asked for it. */
export type Measured = { files: number; bytes: number } | 'working';

/**
 * Whether the grid is worth offering here.
 *
 * A grid of filenames is a worse list, so it only earns its place where there
 * are pictures. Two of them is enough to mean "this is an output folder" and
 * few enough that one stray screenshot in a directory of scripts does not
 * change the view on somebody.
 */
export function looksVisual(entries: FsEntry[]): boolean {
  let seen = 0;
  for (const entry of entries) {
    if (entry.media === 'image' || entry.media === 'video') seen += 1;
    if (seen >= 2) return true;
  }
  return false;
}

/** Written out once, so the dialog cannot describe a binding that is not bound. */
export const SHORTCUTS: [string, string][] = [
  ['Ctrl / ⌘ + L', '編輯路徑，直接貼絕對路徑跳過去'],
  ['/', '搜尋這個資料夾'],
  ['Backspace', '回上一層'],
  ['Enter', '打開選取的資料夾或檔案'],
  ['Ctrl / ⌘ + A', '全選'],
  ['Esc', '取消選取'],
  ['Ctrl / ⌘ + U', '上傳檔案'],
  ['N', '新增資料夾'],
  ['F2', '重新命名（選一項時）'],
  ['Delete', '刪除已選取的'],
  ['G', '清單／格狀切換'],
  ['Ctrl / ⌘ + S', '編輯中：儲存'],
  ['← →', '檢視器開著時，走前後一個檔案'],
  ['?', '這張表'],
];

/** The file's suffix, the way the backend names a text file's language. */
export function suffixOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}
