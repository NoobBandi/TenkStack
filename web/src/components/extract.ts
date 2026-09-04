/**
 * Documents that hold text but do not hand it over.
 *
 * A PDF or a .docx dropped into the composer used to be refused, and the refusal
 * was the right answer at the time: sending the bytes as text gives the model
 * noise, and a model handed noise will usually answer politely anyway, which is
 * worse than a rejection because nobody can see it happen.
 *
 * The libraries are loaded on demand. Somebody who never drops a PDF should not
 * pay a megabyte for the possibility, so each parser arrives with the first file
 * that needs it and the main bundle does not carry either.
 *
 * Spreadsheets are still refused. The one maintained JavaScript reader on npm
 * is abandoned at 0.18.5 with two unfixed high-severity advisories -- prototype
 * pollution and a ReDoS -- and this code path exists to parse files a stranger
 * may have sent the user. "Export it as CSV" costs them one step and costs us no
 * parser at all.
 */

/** What can be turned into text here, by extension. */
export const EXTRACTABLE = new Set(['pdf', 'docx']);

/** Holds text, but nothing here can get at it. */
export const UNSUPPORTED: Record<string, string> = {
  doc: '舊版 Word 格式，請另存成 .docx',
  xlsx: '試算表請匯出成 CSV',
  xls: '試算表請匯出成 CSV',
  pptx: '簡報請匯出成 PDF',
  odt: '請另存成 .docx 或 PDF',
  epub: '請匯出成 PDF',
};

async function fromPdf(file: File): Promise<string> {
  // The legacy build, deliberately. The default one calls
  // Uint8Array.prototype.toHex, which is a 2025 addition -- Node 24 does not
  // have it and neither does any browser more than a version or two old, and
  // the failure is an unrelated-looking "hashOriginal.toHex is not a function"
  // rather than anything a reader would connect to their browser. Verified by
  // running both against a one-page PDF: the default build threw, the legacy
  // build returned the text. Same API, slightly larger download.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // The worker ships beside the library; Vite needs the URL form so it is
  // emitted as its own chunk rather than inlined into the module graph.
  const worker = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;

  // The loading task, not just the document: `destroy` lives on the task and is
  // what shuts the worker down. Leaving it running holds a thread and the whole
  // file in memory for as long as the tab is open.
  const task = pdfjs.getDocument({ data: await file.arrayBuffer() });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    // Items carry their own positions; joining on a space and letting the
    // model see the reading order is closer to the document than trying to
    // rebuild a layout that was never text in the first place.
    const text = content.items
      .map((item) => ('str' in item ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) pages.push(`--- 第 ${n} 頁 ---\n${text}`);
  }
  await task.destroy();
  return pages.join('\n\n');
}

async function fromDocx(file: File): Promise<string> {
  const mammoth = await import('mammoth');
  const { value } = await mammoth.extractRawText({
    arrayBuffer: await file.arrayBuffer(),
  });
  return value.trim();
}

/**
 * One document as plain text.
 *
 * Throws rather than returning an empty string on failure: an encrypted PDF and
 * a PDF of scanned images both come back with nothing, and the caller has to be
 * able to say which kind of nothing it was.
 */
export async function extract(file: File, extension: string): Promise<string> {
  const text = extension === 'pdf' ? await fromPdf(file) : await fromDocx(file);
  if (!text) {
    throw new Error(extension === 'pdf'
      ? '這個 PDF 沒有文字圖層，可能是掃描檔或受保護的檔案'
      : '這個檔案裡沒有文字');
  }
  return text;
}
