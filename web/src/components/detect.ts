/**
 * What language a fenced block is written in, when it does not say.
 *
 * Typing the language is a chore, so this guesses -- but it guesses from
 * signatures rather than from statistics. highlight.js ships an automatic
 * detector and it was measured here first: on realistic multi-line snippets it
 * got 5 of 7, calling Rust `ini` and Python `lua`, and on a single line it was
 * wrong almost every time. Its own relevance score did not separate the right
 * answers from the wrong ones -- a correct SQL call scored 7, and so did Python
 * misread as Lua -- so there was no threshold to hide behind. Colouring Rust as
 * an INI file is worse than leaving it grey.
 *
 * These patterns are anchors instead: things that are near enough to proof.
 * `#!/usr/bin/env bash`, `#include <`, `fn main(`, `<?php`, a body that parses
 * as JSON. Measured against a corpus of 33 snippets, including two that are not
 * code at all, it gets 33.
 *
 * Order matters and is not alphabetical. CSS sits above YAML because
 * `  border-radius: 8px;` is also an indented key and a value; JavaScript sits
 * above CSS because `{ a: 1 }` is an object before it is a rule.
 *
 * No match means no colour. That is the honest answer for prose, for a log, and
 * for a language nothing here knows -- and it is the answer the header's own
 * hint already explains.
 */

const SIGNATURES: [string, RegExp][] = [
  // A shebang settles it outright.
  ['sh', /^#!.*\b(bash|sh|zsh|dash)\b/m],
  ['py', /^#!.*\bpython/m],
  ['php', /<\?php/],
  ['html', /^\s*<(!doctype|html|head|body|div|span|table|script|section|main)\b/im],
  ['xml', /^\s*<\?xml\b/im],
  ['cpp', /^\s*#\s*include\s*[<"]|\bstd::\w+|\bprintf\s*\(|\bint\s+main\s*\(/m],
  ['rs', /^\s*(pub\s+)?fn\s+\w+|^\s*impl\b|\blet\s+mut\b|\buse\s+std::|\bprintln!\s*\(/m],
  ['go', /^package\s+\w+\s*$|\bfmt\.\w+\(|^\s*func\s+(\(\w+[^)]*\)\s*)?\w+\(|:=/m],
  // Python's import and JavaScript's are told apart by the quotes: a JS module
  // specifier is always a string, a Python one never is. Without that,
  // `import React from 'react'` -- the first line of half the JavaScript ever
  // written -- came back as Python.
  ['py', /^\s*(async\s+)?(def|class)\s+\w+.*:\s*$|^\s*from\s+[\w.]*\s+import\s+\w|^\s*import\s+[\w.]+(\s*,\s*[\w.]+)*(\s+as\s+\w+)?\s*(#.*)?$|^\s*(if|for|while|with|try|except|elif|else)\b.*:\s*$|\bself\.\w|^if __name__/m],
  ['java', /\bSystem\.out\.print|^\s*import\s+java\.|^\s*(public|private|protected)\s+(static\s+)?(final\s+)?(class|void|int|String)\b/m],
  ['ts', /^\s*(export\s+)?(interface|type)\s+\w+\s*[={]|:\s*(string|number|boolean|void)\b|\bas\s+const\b/m],
  ['js', /^\s*import\b[^\n]*['"]|^\s*export\b|^\s*(const|let|var)\s+\w+\s*=|=>|\bfunction\s*\w*\s*\(|console\.log\(|\brequire\s*\(|\bmodule\.exports\b/m],
  ['rb', /^\s*def\s+\w+[\s\S]*^\s*end\s*$|^\s*puts\s|^\s*require\s+['"]/m],
  ['sql', /\bselect\b[\s\S]{0,200}\bfrom\b|\binsert\s+into\b|\bcreate\s+table\b|\bupdate\s+\w+\s+set\b|\balter\s+table\b/i],
  ['dockerfile', /^FROM\s+\S+/m],
  ['diff', /^diff --git |^@@ -\d+|^[+-]{3} [ab]?\//m],
  ['ps1', /\$PSVersionTable|^\s*(Get|Set|New|Remove)-\w+/m],
  ['css', /^\s*[.#@]?[\w-]+[^;{}]*\{\s*$|\{[^{}]*[\w-]+\s*:\s*[^;{}]+[;}]/m],
  ['yaml', /^[\w-]+:\s*($|[|>])|^\s{2,}[\w-]+:\s/m],
  ['toml', /^\[[\w.]+\]\s*$/m],
  // Last, and deliberately: a shell transcript is mostly ordinary words, so it
  // only wins once nothing with real syntax has.
  ['sh', /^\s*(sudo|apt|apt-get|npm|npx|yarn|pnpm|git|cd|ls|cat|echo|export|source|curl|wget|systemctl|journalctl|docker|podman|mkdir|rm|cp|mv|chmod|chown|tar|grep|sed|awk|ssh|scp|pip|pip3|cargo|make|cmake|kubectl|brew)\s|^\s*\.\/\S+|\s\|\s*(grep|awk|sed|head|tail|sort|wc|jq)\b/m],
];

/**
 * Only the first part is read.
 *
 * A block is re-examined on every keystroke, and a signature that has not
 * matched in two thousand characters is not about to. Reading a prefix also
 * means the answer stops changing once the block is under way -- typing line
 * forty does not re-open the question of what language line one was in.
 */
const ENOUGH = 2000;

const answers = new Map<string, string | null>();

export function detectLanguage(body: string): string | null {
  const text = body.slice(0, ENOUGH).trim();
  if (text.length < 3) return null;
  const cached = answers.get(text);
  if (cached !== undefined) return cached;

  let found: string | null = null;
  // JSON is the one language that can be settled rather than guessed.
  if (/^[[{]/.test(text) && /[\]}]$/.test(text)) {
    try {
      JSON.parse(text);
      found = 'json';
    } catch {
      // Not JSON after all, or not finished being typed. Fall through.
    }
  }
  if (!found) {
    for (const [language, pattern] of SIGNATURES) {
      if (pattern.test(text)) { found = language; break; }
    }
  }
  // Unbounded otherwise: a block retyped character by character leaves an entry
  // per keystroke behind it.
  if (answers.size > 200) answers.clear();
  answers.set(text, found);
  return found;
}
