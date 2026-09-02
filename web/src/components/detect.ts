/**
 * What language a fenced block is written in, when it does not say.
 *
 * The shape of this follows what the tools that do it for a living do. GitHub's
 * Linguist runs an ordered cascade -- modeline, then filename, then shebang,
 * then extension, then regex heuristics, and a naive Bayesian classifier only
 * as the last resort -- where each step either decides outright or narrows what
 * the next one has to consider. VS Code drives its ML model the same way: a
 * confidence threshold it has to clear, sibling languages nudged together, and
 * the editor left in whatever mode it was in when the model is unsure. Both
 * spend their strongest evidence first and both are willing to give no answer.
 *
 * A chat composer has none of the strong evidence. There is no filename, no
 * extension, no modeline -- only the code, usually a few lines of it, which is
 * the case every one of these tools names as its weakest. So this is the
 * heuristics step from that cascade, running alone.
 *
 * The classifier step was tried and dropped. highlight.js ships one, the chat
 * renderer already uses it, and measured here it got 5 of 7 realistic multi-line
 * snippets -- Rust as `ini`, Python as `lua` -- and was wrong almost every time
 * on a single line. Its relevance score gave nothing to threshold on: a correct
 * SQL reading scored 7 and Python-misread-as-Lua also scored 7. VS Code
 * documents the same limit for a far better model, saying it "may not guess the
 * correct programming languages of very small code snippets". Colouring Rust as
 * an INI file is worse than leaving it grey.
 *
 * What is left is evidence, weighted by how much it proves. A shebang settles
 * the question; `fn main(` or `System.out.print` all but settles it; `const x =`
 * or an indented `key: value` barely leans. Scores are summed per language and
 * the highest wins, which is the part first-match-wins got wrong: a block whose
 * first line looks like one language and whose second is unmistakably another
 * went to whichever pattern happened to sit higher in the list.
 *
 * Measured against a corpus of 42 snippets, three of which are not code and
 * must come back with nothing.
 */

/** How much a match proves. Order still breaks ties, strongest first. */
const DECISIVE = 10;
const STRONG = 4;
const LEANS = 1;

interface Signature {
  language: string;
  weight: number;
  pattern: RegExp;
}

const SIGNATURES: Signature[] = [
  // A shebang or a processing instruction is a declaration, not a hint.
  { language: 'sh', weight: DECISIVE, pattern: /^#!.*\b(bash|sh|zsh|dash)\b/m },
  { language: 'py', weight: DECISIVE, pattern: /^#!.*\bpython/m },
  { language: 'php', weight: DECISIVE, pattern: /<\?php/ },
  { language: 'xml', weight: DECISIVE, pattern: /^\s*<\?xml\b/im },
  { language: 'dockerfile', weight: DECISIVE, pattern: /^FROM\s+\S+/m },
  { language: 'diff', weight: DECISIVE, pattern: /^diff --git |^@@ -\d+|^[+-]{3} [ab]?\//m },

  // Syntax that belongs to one language and would be a mistake in the others.
  { language: 'html', weight: STRONG, pattern: /^\s*<(!doctype|html|head|body|div|span|table|script|section|main)\b/im },
  { language: 'cpp', weight: STRONG, pattern: /^\s*#\s*include\s*[<"]|\bstd::(cout|cerr|cin|endl|string|vector|map|set|pair|unique_ptr|shared_ptr|move)\b|\bint\s+main\s*\(/m },
  { language: 'rs', weight: STRONG, pattern: /^\s*(pub\s+)?fn\s+\w+|^\s*impl\b|\blet\s+mut\b|\buse\s+std::|\bprintln!\s*\(/m },
  { language: 'go', weight: STRONG, pattern: /^package\s+\w+\s*$|\bfmt\.\w+\(|^\s*func\s+(\(\w+[^)]*\)\s*)?\w+\(/m },
  { language: 'java', weight: STRONG, pattern: /\bSystem\.out\.print|^\s*import\s+java\./m },
  // Python's import and JavaScript's are told apart by the quotes: a JS module
  // specifier is always a string, a Python one never is. Without that,
  // `import React from 'react'` -- the first line of half the JavaScript ever
  // written -- came back as Python.
  { language: 'py', weight: STRONG, pattern: /^\s*(async\s+)?(def|class)\s+\w+.*:\s*$|^\s*from\s+[\w.]*\s+import\s+\w|^\s*import\s+[\w.]+(\s*,\s*[\w.]+)*(\s+as\s+\w+)?\s*(#.*)?$|^if __name__/m },
  { language: 'ts', weight: STRONG, pattern: /^\s*(export\s+)?(interface|type)\s+\w+\s*[={]|\bas\s+const\b/m },
  { language: 'js', weight: STRONG, pattern: /^\s*import\b[^\n]*['"]|\bmodule\.exports\b|console\.log\(|\brequire\s*\(/m },
  { language: 'rb', weight: STRONG, pattern: /^\s*def\s+\w+[\s\S]*^\s*end\s*$|^\s*puts\s|^\s*require\s+['"]/m },
  { language: 'sql', weight: STRONG, pattern: /\bselect\b[\s\S]{0,200}\bfrom\b|\binsert\s+into\b|\bcreate\s+table\b|\bupdate\s+\w+\s+set\b|\balter\s+table\b/i },
  { language: 'ps1', weight: STRONG, pattern: /\$PSVersionTable|^\s*(Get|Set|New|Remove)-\w+/m },
  { language: 'go', weight: STRONG, pattern: /^\s*\w+\s*:=\s*\S/m },
  { language: 'java', weight: STRONG, pattern: /^\s*(public|private|protected)\s+(static\s+)?(final\s+)?(class|void|int|String)\b/m },

  // True of the language, but true of others too. These only decide a block
  // that offers nothing better.
  { language: 'py', weight: LEANS, pattern: /^\s*(if|for|while|with|try|except|elif|else)\b.*:\s*$|\bself\.\w/m },
  { language: 'cpp', weight: LEANS, pattern: /\bprintf\s*\(/ },
  { language: 'ts', weight: LEANS, pattern: /:\s*(string|number|boolean|void)\b/ },
  { language: 'js', weight: LEANS, pattern: /^\s*export\b|^\s*(const|let|var)\s+\w+\s*=|=>|\bfunction\s*\w*\s*\(/m },
  { language: 'css', weight: LEANS, pattern: /^\s*[.#@]?[\w-]+[^;{}]*\{\s*$|\{[^{}]*[\w-]+\s*:\s*[^;{}]+[;}]/m },
  { language: 'yaml', weight: LEANS, pattern: /^[\w-]+:\s*($|[|>])|^\s{2,}[\w-]+:\s/m },
  { language: 'toml', weight: LEANS, pattern: /^\[[\w.]+\]\s*$/m },
  // A terminal transcript is mostly ordinary words, so it wins only when
  // nothing with real syntax has scored at all.
  { language: 'sh', weight: LEANS, pattern: /^\s*(sudo|apt|apt-get|npm|npx|yarn|pnpm|git|cd|ls|cat|echo|export|source|curl|wget|systemctl|journalctl|docker|podman|mkdir|rm|cp|mv|chmod|chown|tar|grep|sed|awk|ssh|scp|pip|pip3|cargo|make|cmake|kubectl|brew)\s|^\s*\.\/\S+|\s\|\s*(grep|awk|sed|head|tail|sort|wc|jq)\b/m },
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
    const scores = new Map<string, number>();
    let best = 0;
    for (const signature of SIGNATURES) {
      if (!signature.pattern.test(text)) continue;
      const score = (scores.get(signature.language) ?? 0) + signature.weight;
      scores.set(signature.language, score);
      // Strictly greater, so the earlier -- stronger -- entry keeps a tie.
      if (score > best) { best = score; found = signature.language; }
    }
  }
  // Unbounded otherwise: a block retyped character by character leaves an entry
  // per keystroke behind it.
  if (answers.size > 200) answers.clear();
  answers.set(text, found);
  return found;
}
