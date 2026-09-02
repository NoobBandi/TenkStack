/**
 * One language table and one palette, shared by everything that shows code.
 *
 * The file viewer and the chat composer were each about to grow their own. They
 * must not: a Python file open in the editor and a ```python block being typed
 * in a message are the same code, and colouring them differently would say they
 * were not.
 */

import { type Extension } from '@codemirror/state';
import {
  HighlightStyle, StreamLanguage, LanguageSupport, type Language,
} from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { yaml } from '@codemirror/lang-yaml';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { sql } from '@codemirror/lang-sql';
import { cpp } from '@codemirror/lang-cpp';
import { rust } from '@codemirror/lang-rust';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { nginx } from '@codemirror/legacy-modes/mode/nginx';
import { properties } from '@codemirror/legacy-modes/mode/properties';

/** Extension for a file suffix, or nothing when we have no parser for it.
 *
 *  Keyed on the suffix because that is what /api/fs/peek reports -- it does not
 *  sniff content, and a name is the only thing available before the bytes are. */
export function languageFor(suffix: string): Extension | null {
  switch (suffix.toLowerCase()) {
    case 'js': case 'mjs': case 'cjs': case 'jsx':
      return javascript({ jsx: true });
    case 'ts': case 'mts': case 'cts':
      return javascript({ typescript: true });
    case 'tsx':
      return javascript({ typescript: true, jsx: true });
    case 'py': case 'pyi':
      return python();
    case 'json': case 'jsonl': case 'ipynb':
      return json();
    case 'md': case 'markdown':
      return markdown();
    case 'yaml': case 'yml':
      return yaml();
    case 'html': case 'htm': case 'xml': case 'svg':
      return html();
    case 'css': case 'scss': case 'less':
      return css();
    case 'sql':
      return sql();
    case 'c': case 'h': case 'cpp': case 'cc': case 'hpp': case 'cu':
      return cpp();
    case 'rs':
      return rust();
    case 'sh': case 'bash': case 'zsh': case 'env':
      return StreamLanguage.define(shell);
    case 'toml':
      return StreamLanguage.define(toml);
    case 'dockerfile':
      return StreamLanguage.define(dockerFile);
    case 'conf': case 'caddy': case 'nginx':
      return StreamLanguage.define(nginx);
    case 'ini': case 'cfg': case 'properties':
      return StreamLanguage.define(properties);
    default:
      return null;
  }
}

/* The console's own palette rather than one of CodeMirror's themes, so a file
 * and a fenced block in chat colour the same tokens the same way. Hues follow
 * the highlight.js rules already in index.css; the two are meant to match. */
export const highlightStyle = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#6b7280', fontStyle: 'italic' },
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword], color: '#c792ea' },
  { tag: [t.string, t.special(t.string)], color: '#c3e88d' },
  { tag: [t.number, t.bool, t.null], color: '#f78c6c' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#82aaff' },
  { tag: [t.typeName, t.className, t.namespace], color: '#ffcb6b' },
  { tag: [t.propertyName, t.attributeName], color: '#80cbc4' },
  { tag: [t.operator, t.punctuation, t.separator], color: '#89ddff' },
  { tag: [t.tagName], color: '#f07178' },
  { tag: [t.heading], color: '#82aaff', fontWeight: '600' },
  { tag: [t.link, t.url], color: '#80cbc4', textDecoration: 'underline' },
  { tag: [t.invalid], color: '#ff5370' },
]);


/**
 * What a fence's info string names, as a parser.
 *
 * `languageFor` is keyed on file suffixes, because that is what the file viewer
 * has. A fence writes the language out -- ```python, not ```py -- so the names
 * that differ are mapped across rather than duplicated into the table.
 *
 * Only the first word is read: ```python title="x" is a real thing people
 * write, and the rest of that line is not a language name.
 */
const FENCE_NAMES: Record<string, string> = {
  javascript: 'js', typescript: 'ts', python: 'py', bash: 'sh', shell: 'sh',
  console: 'sh', rust: 'rs', 'c++': 'cpp', markdown: 'md', golang: 'go',
  docker: 'dockerfile', yml: 'yaml', htm: 'html', text: '', plaintext: '',
};

export function parserFor(info: string): Language | null {
  const word = info.trim().split(/[\s,]+/)[0].toLowerCase();
  const support = languageFor(FENCE_NAMES[word] ?? word);
  if (!support) return null;
  // A LanguageSupport bundles a parser with its extras -- autocompletion,
  // indentation. Nested inside Markdown only the parser is wanted; the extras
  // belong to an editor that is entirely that language.
  return support instanceof LanguageSupport ? support.language : support as Language;
}
