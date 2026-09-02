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
  HighlightStyle, StreamLanguage, LanguageSupport, LanguageDescription,
  type Language, type StreamParser,
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
 * Everything else, fetched the first time it is needed.
 *
 * The set above is what the console itself is written in, so it is worth having
 * loaded before anyone asks. This is the rest -- around fifty more languages,
 * which is what a chat about code actually turns out to need -- and importing
 * them eagerly would put 1.1 MB of parsers in the bundle for the sake of the one
 * Fortran snippet a year. Each `import()` is a literal, so the bundler can split
 * each into its own chunk; a mode is fetched when a fence first names it and
 * then stays.
 *
 * CodeMirror takes an unloaded LanguageDescription and re-parses once it
 * arrives, so a pasted block colours a moment after it lands rather than not at
 * all.
 */
const stream = (
  name: string, alias: string[], extensions: string[],
  load: () => Promise<StreamParser<unknown>>,
) => LanguageDescription.of({
  name, alias, extensions,
  load: async () => new LanguageSupport(StreamLanguage.define(await load())),
});

const EXTRA: LanguageDescription[] = [
  // Parsers written for CodeMirror 6, where they exist: they understand the
  // language rather than colouring it by regular expression.
  LanguageDescription.of({
    name: 'PHP', alias: ['php'], extensions: ['php', 'phtml'],
    load: () => import('@codemirror/lang-php').then((m) => m.php()),
  }),
  LanguageDescription.of({
    name: 'Go', alias: ['go', 'golang'], extensions: ['go'],
    load: () => import('@codemirror/lang-go').then((m) => m.go()),
  }),
  LanguageDescription.of({
    name: 'Java', alias: ['java'], extensions: ['java'],
    load: () => import('@codemirror/lang-java').then((m) => m.java()),
  }),
  LanguageDescription.of({
    name: 'XML', alias: ['xml', 'xsd', 'xsl'], extensions: ['xml', 'xsd', 'xsl', 'plist'],
    load: () => import('@codemirror/lang-xml').then((m) => m.xml()),
  }),
  LanguageDescription.of({
    name: 'Vue', alias: ['vue'], extensions: ['vue'],
    load: () => import('@codemirror/lang-vue').then((m) => m.vue()),
  }),

  // The C-family modes all live in one file, so naming six of them costs one
  // chunk rather than six.
  stream('C#', ['csharp', 'cs', 'c#'], ['cs'],
    () => import('@codemirror/legacy-modes/mode/clike').then((m) => m.csharp)),
  stream('Kotlin', ['kotlin', 'kt'], ['kt', 'kts'],
    () => import('@codemirror/legacy-modes/mode/clike').then((m) => m.kotlin)),
  stream('Scala', ['scala'], ['scala', 'sc'],
    () => import('@codemirror/legacy-modes/mode/clike').then((m) => m.scala)),
  stream('Dart', ['dart'], ['dart'],
    () => import('@codemirror/legacy-modes/mode/clike').then((m) => m.dart)),
  stream('Objective-C', ['objectivec', 'objc'], ['m', 'mm'],
    () => import('@codemirror/legacy-modes/mode/clike').then((m) => m.objectiveC)),

  stream('Ruby', ['ruby', 'rb'], ['rb', 'gemspec'],
    () => import('@codemirror/legacy-modes/mode/ruby').then((m) => m.ruby)),
  stream('Perl', ['perl', 'pl'], ['pl', 'pm'],
    () => import('@codemirror/legacy-modes/mode/perl').then((m) => m.perl)),
  stream('Lua', ['lua'], ['lua'],
    () => import('@codemirror/legacy-modes/mode/lua').then((m) => m.lua)),
  stream('R', ['r', 'rscript'], ['r'],
    () => import('@codemirror/legacy-modes/mode/r').then((m) => m.r)),
  stream('Julia', ['julia', 'jl'], ['jl'],
    () => import('@codemirror/legacy-modes/mode/julia').then((m) => m.julia)),
  stream('Haskell', ['haskell', 'hs'], ['hs'],
    () => import('@codemirror/legacy-modes/mode/haskell').then((m) => m.haskell)),
  stream('Erlang', ['erlang', 'erl'], ['erl'],
    () => import('@codemirror/legacy-modes/mode/erlang').then((m) => m.erlang)),
  stream('Clojure', ['clojure', 'clj'], ['clj', 'cljs', 'edn'],
    () => import('@codemirror/legacy-modes/mode/clojure').then((m) => m.clojure)),
  stream('Common Lisp', ['lisp', 'commonlisp', 'elisp'], ['lisp', 'cl', 'el'],
    () => import('@codemirror/legacy-modes/mode/commonlisp').then((m) => m.commonLisp)),
  stream('Scheme', ['scheme', 'racket'], ['scm', 'ss', 'rkt'],
    () => import('@codemirror/legacy-modes/mode/scheme').then((m) => m.scheme)),
  stream('OCaml', ['ocaml', 'ml'], ['ml', 'mli'],
    () => import('@codemirror/legacy-modes/mode/mllike').then((m) => m.oCaml)),
  stream('F#', ['fsharp', 'fs', 'f#'], ['fs', 'fsi'],
    () => import('@codemirror/legacy-modes/mode/mllike').then((m) => m.fSharp)),
  stream('Swift', ['swift'], ['swift'],
    () => import('@codemirror/legacy-modes/mode/swift').then((m) => m.swift)),
  stream('PowerShell', ['powershell', 'ps1', 'pwsh'], ['ps1', 'psm1'],
    () => import('@codemirror/legacy-modes/mode/powershell').then((m) => m.powerShell)),
  stream('Visual Basic', ['vb', 'vbnet'], ['vb'],
    () => import('@codemirror/legacy-modes/mode/vb').then((m) => m.vb)),
  stream('VBScript', ['vbscript', 'vbs'], ['vbs'],
    () => import('@codemirror/legacy-modes/mode/vbscript').then((m) => m.vbScript)),
  stream('Pascal', ['pascal', 'delphi'], ['pas'],
    () => import('@codemirror/legacy-modes/mode/pascal').then((m) => m.pascal)),
  stream('Fortran', ['fortran', 'f90'], ['f', 'f90', 'f95'],
    () => import('@codemirror/legacy-modes/mode/fortran').then((m) => m.fortran)),
  stream('COBOL', ['cobol'], ['cob', 'cbl'],
    () => import('@codemirror/legacy-modes/mode/cobol').then((m) => m.cobol)),
  stream('Tcl', ['tcl'], ['tcl'],
    () => import('@codemirror/legacy-modes/mode/tcl').then((m) => m.tcl)),
  stream('Verilog', ['verilog', 'systemverilog'], ['v', 'sv'],
    () => import('@codemirror/legacy-modes/mode/verilog').then((m) => m.verilog)),
  stream('VHDL', ['vhdl'], ['vhd', 'vhdl'],
    () => import('@codemirror/legacy-modes/mode/vhdl').then((m) => m.vhdl)),
  stream('Elm', ['elm'], ['elm'],
    () => import('@codemirror/legacy-modes/mode/elm').then((m) => m.elm)),
  stream('Crystal', ['crystal'], ['cr'],
    () => import('@codemirror/legacy-modes/mode/crystal').then((m) => m.crystal)),
  stream('Groovy', ['groovy', 'gradle'], ['groovy', 'gradle'],
    () => import('@codemirror/legacy-modes/mode/groovy').then((m) => m.groovy)),
  stream('Haxe', ['haxe'], ['hx'],
    () => import('@codemirror/legacy-modes/mode/haxe').then((m) => m.haxe)),
  stream('CoffeeScript', ['coffeescript', 'coffee'], ['coffee'],
    () => import('@codemirror/legacy-modes/mode/coffeescript').then((m) => m.coffeeScript)),
  stream('D', ['d'], ['d'],
    () => import('@codemirror/legacy-modes/mode/d').then((m) => m.d)),
  stream('Smalltalk', ['smalltalk'], ['st'],
    () => import('@codemirror/legacy-modes/mode/smalltalk').then((m) => m.smalltalk)),

  // Not programming languages, but things that get pasted into a message and
  // are unreadable without colour.
  stream('Diff', ['diff', 'patch'], ['diff', 'patch'],
    () => import('@codemirror/legacy-modes/mode/diff').then((m) => m.diff)),
  stream('Protobuf', ['protobuf', 'proto'], ['proto'],
    () => import('@codemirror/legacy-modes/mode/protobuf').then((m) => m.protobuf)),
  stream('CMake', ['cmake'], ['cmake'],
    () => import('@codemirror/legacy-modes/mode/cmake').then((m) => m.cmake)),
  stream('Assembly', ['asm', 'gas', 'nasm'], ['s', 'asm'],
    () => import('@codemirror/legacy-modes/mode/gas').then((m) => m.gas)),
  stream('HTTP', ['http'], ['http'],
    () => import('@codemirror/legacy-modes/mode/http').then((m) => m.http)),
  stream('Sass', ['sass'], ['sass'],
    () => import('@codemirror/legacy-modes/mode/sass').then((m) => m.sass)),
  stream('Stylus', ['stylus', 'styl'], ['styl'],
    () => import('@codemirror/legacy-modes/mode/stylus').then((m) => m.stylus)),
  stream('LaTeX', ['latex', 'tex'], ['tex', 'sty', 'cls'],
    () => import('@codemirror/legacy-modes/mode/stex').then((m) => m.stex)),
  stream('Pug', ['pug', 'jade'], ['pug', 'jade'],
    () => import('@codemirror/legacy-modes/mode/pug').then((m) => m.pug)),
  stream('Jinja2', ['jinja', 'jinja2', 'j2'], ['j2', 'jinja'],
    () => import('@codemirror/legacy-modes/mode/jinja2').then((m) => m.jinja2)),
  stream('Puppet', ['puppet'], ['pp'],
    () => import('@codemirror/legacy-modes/mode/puppet').then((m) => m.puppet)),
  stream('Gherkin', ['gherkin', 'cucumber'], ['feature'],
    () => import('@codemirror/legacy-modes/mode/gherkin').then((m) => m.gherkin)),
  stream('WebAssembly', ['wasm', 'wat', 'wast'], ['wat', 'wast'],
    () => import('@codemirror/legacy-modes/mode/wast').then((m) => m.wast)),
  stream('MATLAB', ['matlab', 'octave'], ['octave'],
    () => import('@codemirror/legacy-modes/mode/octave').then((m) => m.octave)),
  stream('SPARQL', ['sparql'], ['rq'],
    () => import('@codemirror/legacy-modes/mode/sparql').then((m) => m.sparql)),
  stream('Brainfuck', ['brainfuck', 'bf'], ['bf'],
    () => import('@codemirror/legacy-modes/mode/brainfuck').then((m) => m.brainfuck)),
];

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
  console: 'sh', rust: 'rs', 'c++': 'cpp', markdown: 'md', docker: 'dockerfile',
  yml: 'yaml', htm: 'html', text: '', plaintext: '',
};

export function parserFor(info: string): Language | LanguageDescription | null {
  const word = info.trim().split(/[\s,]+/)[0].toLowerCase();
  if (!word) return null;
  const support = languageFor(FENCE_NAMES[word] ?? word);
  if (support) {
    // A LanguageSupport bundles a parser with its extras -- autocompletion,
    // indentation. Nested inside Markdown only the parser is wanted; the extras
    // belong to an editor that is entirely that language.
    return support instanceof LanguageSupport ? support.language : support as Language;
  }
  // Unloaded is fine: CodeMirror fetches it and re-parses.
  return LanguageDescription.matchLanguageName(EXTRA, word, true);
}

/** The same long tail, found by file suffix, for the file viewer. */
export function descriptionFor(suffix: string): LanguageDescription | null {
  if (!suffix) return null;
  return LanguageDescription.matchFilename(EXTRA, `x.${suffix.toLowerCase()}`);
}
