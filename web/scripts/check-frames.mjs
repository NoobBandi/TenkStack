/**
 * The documents this app injects into sandboxed frames are template literals,
 * and a template literal eats escapes.
 *
 * Three separate bugs came from that before this existed, each found by
 * accident and each invisible until something ran. A word-boundary regex
 * arrived as a backspace character. An escaped newline inside a joined string
 * became a real one and left an unterminated literal. A backtick inside a
 * comment ended the document early -- that one the compiler caught; the other
 * two it could not.
 *
 * None of it is visible in the source, because the source is valid JavaScript
 * either way: the mistake exists only in the string the browser is handed. So
 * this evaluates each document the way the browser receives it and checks
 * that, which is the only place the question can be answered.
 *
 * Run by `pnpm check:frames`, and by `pnpm build` ahead of the build.
 */

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Every template that becomes a document, by the constant holding it. */
const DOCUMENTS = [
  ['src/components/pythonRuntime.tsx', 'RUNTIME_DOC'],
  ['src/components/HtmlPreview.tsx', 'ERROR_REPORTER'],
  ['src/components/HtmlPreview.tsx', 'PYTHON_BOOTSTRAP'],
  ['src/components/HtmlPreview.tsx', 'REACT_BOOTSTRAP'],
  ['src/components/HtmlPreview.tsx', 'STORAGE_SHIM'],
];

// Stand-ins for what the templates interpolate. Only the shape matters here:
// the question is whether the result parses, not where it points.
const PYODIDE_VERSION = '0.0.0';
const PYODIDE_CDN = 'https://example.invalid/';
const REACT_VERSION = '0.0.0';
const ESM = 'https://example.invalid';
void PYODIDE_VERSION; void PYODIDE_CDN; void REACT_VERSION; void ESM;

/**
 * Anything that should never survive into a document: the C0 controls, less
 * tab, newline and carriage return, which belong there. A backspace in the
 * middle of a regex is what this is looking for.
 */
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;

const scratch = mkdtempSync(join(tmpdir(), 'frames-'));
let failures = 0;

for (const [file, name] of DOCUMENTS) {
  const source = readFileSync(file, 'utf8');
  const opener = 'const ' + name + ' = `';
  const from = source.indexOf(opener);
  if (from < 0) {
    console.error('  MISSING  ' + name + ' in ' + file);
    failures += 1;
    continue;
  }

  // To the closing backtick of that template -- the first one not escaped.
  // Some documents contain escaped backticks of their own, for the templates
  // they build in turn, and a naive search for a backtick ends inside one of
  // those. This checker found that in itself on its first run.
  const body = source.slice(from + opener.length);
  let close = -1;
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === '\\') { i += 1; continue; }
    if (body[i] === '`') { close = i; break; }
  }
  if (close < 0) {
    console.error('  UNCLOSED ' + name + ': no closing backtick found');
    failures += 1;
    continue;
  }
  const evaluated = eval('`' + body.slice(0, close) + '`');

  if (CONTROL.test(evaluated)) {
    const line = evaluated.split('\n').findIndex((l) => CONTROL.test(l));
    console.error('  CONTROL  ' + name + ': control character on line ' + (line + 1)
      + ' -- an escape survived the template that should not have');
    failures += 1;
  }

  // Every script in the document, parsed the way the browser would parse it.
  // As modules, because these use top-level await and a plain parse rejects it.
  const scripts = [...evaluated.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  scripts.forEach(([, code], index) => {
    if (!code.trim()) return;
    const path = join(scratch, name + '-' + index + '.mjs');
    writeFileSync(path, code);
    try {
      execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
    } catch (error) {
      const detail = String(error.stderr || error.message)
        .split('\n').slice(0, 4).join('\n    ');
      console.error('  SYNTAX   ' + name + ' script ' + index + ':\n    ' + detail);
      failures += 1;
    }
  });
}

if (failures) {
  console.error('\n' + failures + ' problem(s) in the injected documents.');
  process.exit(1);
}
console.log('checked ' + DOCUMENTS.length + ' injected documents: all parse');
