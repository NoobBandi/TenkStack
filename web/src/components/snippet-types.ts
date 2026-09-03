/**
 * Which machine the reader is on, so the commands are the ones they can run.
 *
 * Detected rather than asked, and still overridable: someone reading this on a
 * phone is setting up a laptop, and someone on a Mac may be configuring the
 * Windows box next to them. Guessing right for the common case and getting out
 * of the way for the rest is cheaper than a question everybody has to answer.
 */
export type Os = 'mac' | 'linux' | 'windows';

export function detectOs(): Os {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/Windows|Win32|Win64/i.test(ua)) return 'windows';
  // iPadOS reports as Macintosh, which is close enough: both want the same
  // paths and the same open command.
  if (/Mac OS X|Macintosh|iPhone|iPad/i.test(ua)) return 'mac';
  return 'linux';
}

/** One step in the sequence, as a box to copy. */
export interface Step {
  /** What this step is. Shown above the box. */
  title: string;
  /** A highlight.js language id, from the five registered in ClientSnippets. */
  lang: string;
  body: string;
  note?: string;
}

export interface Snippet {
  key: string;
  label: string;
  group: 'agent' | 'raw';
  caption: string;
  steps: Step[];
}

/**
 * The command that opens a config file, on the reader's machine.
 *
 * The directory is made and the file touched first, because neither exists
 * until something writes them and an editor pointed at a missing file in a
 * missing directory fails differently on all three platforms. `New-Item -Force`
 * on a file makes its parents too, which is why Windows needs one line fewer.
 */
export function openCommand(os: Os, unixPath: string, winPath: string): string {
  if (os === 'windows') {
    return `New-Item -ItemType File -Force "${winPath}" | Out-Null\nnotepad "${winPath}"`;
  }
  const dir = unixPath.slice(0, unixPath.lastIndexOf('/'));
  const editor = os === 'mac' ? `open -e ${unixPath}` : `\${EDITOR:-nano} ${unixPath}`;
  return `mkdir -p ${dir}\ntouch ${unixPath}\n${editor}`;
}

/** Where a key file lives, for the tools that read one. */
export const KEY_FILE = { unix: '~/.tenks-key', win: '$env:USERPROFILE\\.tenks-key' };

/** Its absolute form, which is what a config file has to name -- `~` is the
 *  shell's, and nothing expands it inside JSON or TOML. */
export const KEY_FILE_ABS = {
  unix: '/home/<你的帳號>/.tenks-key',
  mac: '/Users/<你的帳號>/.tenks-key',
};

/** Writing that file, with the permissions it should have. */
export function writeKeyCommand(os: Os): string {
  if (os === 'windows') {
    return `Set-Content -NoNewline "${KEY_FILE.win}" 'sk-console-...'`;
  }
  // printf rather than echo: echo adds a newline, and a newline inside a bearer
  // token is a 401 nobody can see.
  return `printf '%s' 'sk-console-...' > ${KEY_FILE.unix}\nchmod 600 ${KEY_FILE.unix}`;
}

export const shellLang = (os: Os) => (os === 'windows' ? 'powershell' : 'bash');
