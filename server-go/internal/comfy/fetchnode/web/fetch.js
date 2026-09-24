// TenkStack model fetch: the panel that asks this server, rather than the
// browser, to download a workflow's missing models. See __init__.py.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const gib = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`);

// Every model a workflow names, from wherever the frontend keeps them:
// each node's properties.models, the same inside subgraph definitions, and
// the workflow-level list older templates use.
function modelsOf(graph) {
  const seen = new Map();
  const add = (m) => {
    if (m && m.name && m.directory) seen.set(`${m.directory}/${m.name}`, m);
  };
  const walk = (nodes) => (nodes ?? []).forEach((n) => (n?.properties?.models ?? []).forEach(add));
  walk(graph?.nodes);
  (graph?.definitions?.subgraphs ?? []).forEach((sg) => walk(sg.nodes));
  (graph?.models ?? []).forEach(add);
  return [...seen.values()];
}

async function post(path, body) {
  const r = await api.fetchApi(path, { method: "POST", body: JSON.stringify(body) });
  return r.json();
}

let panel = null;
let timer = null;
let current = [];

function el(tag, style, text) {
  const e = document.createElement(tag);
  if (style) e.style.cssText = style;
  if (text !== undefined) e.textContent = text;
  return e;
}

function close() {
  panel?.remove();
  panel = null;
  clearInterval(timer);
  timer = null;
}

function render(rows) {
  if (!panel) {
    panel = el("div", [
      "position:fixed", "right:16px", "bottom:16px", "z-index:100000", "width:420px", "max-height:60vh",
      "overflow:auto", "background:#1b1d22", "color:#e6e6e6", "border:1px solid #3a3d45", "border-radius:8px",
      "box-shadow:0 8px 24px rgba(0,0,0,.45)", "font:13px/1.5 system-ui,sans-serif", "padding:12px 14px",
    ].join(";"));
    document.body.appendChild(panel);
  }
  panel.replaceChildren();
  const missing = rows.filter((r) => r.state === "missing" && !(r.job && ["queued", "downloading"].includes(r.job.state)));
  const active = rows.filter((r) => r.job && ["queued", "downloading"].includes(r.job.state));
  const head = el("div", "display:flex;align-items:center;gap:8px;margin-bottom:8px");
  head.appendChild(el("div", "font-weight:600;flex:1",
    active.length ? `正在下載到伺服器（${active.length}）` : missing.length ? `這個工作流程缺少 ${missing.length} 個模型` : "模型都到齊了"));
  const x = el("button", "background:none;border:none;color:#999;cursor:pointer;font-size:16px", "×");
  x.onclick = close;
  head.appendChild(x);
  panel.appendChild(head);
  panel.appendChild(el("div", "color:#9aa0a6;font-size:12px;margin-bottom:10px",
    "在這裡按下載，檔案會直接存到這台 ComfyUI 伺服器的 models 資料夾，不經過你的電腦。"));

  for (const r of rows) {
    const row = el("div", "padding:6px 0;border-top:1px solid #2c2f36");
    const top = el("div", "display:flex;gap:8px;align-items:center");
    const label = el("div", "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap", r.name);
    label.title = `${r.directory}/${r.name}`;
    top.appendChild(label);
    top.appendChild(el("span", "color:#9aa0a6;font-size:11px", r.directory));
    const j = r.job;
    if (r.state === "present" || j?.state === "done") {
      top.appendChild(el("span", "color:#5ccf8f;font-size:12px", "已在伺服器"));
    } else if (j && ["queued", "downloading"].includes(j.state)) {
      const stop = el("button", "background:none;border:1px solid #555;color:#ccc;border-radius:4px;cursor:pointer;font-size:11px;padding:0 6px", "取消");
      stop.onclick = () => post("/tenkstack/models/cancel", r).then(refresh);
      top.appendChild(stop);
    } else if (r.state === "missing") {
      const go = el("button", "background:#2f6fed;border:none;color:#fff;border-radius:4px;cursor:pointer;font-size:12px;padding:2px 8px", "下載");
      go.onclick = () => post("/tenkstack/models/download", { models: [r] }).then(refresh);
      top.appendChild(go);
    } else {
      top.appendChild(el("span", "color:#e0a83c;font-size:11px", r.reason ?? r.state));
    }
    row.appendChild(top);
    if (j && ["queued", "downloading"].includes(j.state)) {
      const pct = j.total ? Math.floor((j.done / j.total) * 100) : 0;
      const bar = el("div", "height:4px;background:#2c2f36;border-radius:2px;margin-top:6px;overflow:hidden");
      bar.appendChild(el("div", `height:100%;width:${pct}%;background:#2f6fed`));
      row.appendChild(bar);
      row.appendChild(el("div", "color:#9aa0a6;font-size:11px;margin-top:2px",
        j.state === "queued" ? "排隊中" : `${gib(j.done)} / ${j.total ? gib(j.total) : "?"}${j.rate ? `・${gib(j.rate)}/s` : ""}`));
    } else if (j?.state === "error") {
      row.appendChild(el("div", "color:#e5534b;font-size:11px;margin-top:2px", j.error));
    }
    panel.appendChild(row);
  }

  if (missing.length > 1) {
    const all = el("button", "margin-top:10px;width:100%;background:#2f6fed;border:none;color:#fff;border-radius:4px;cursor:pointer;padding:6px",
      `全部下載到伺服器（${missing.length}）`);
    all.onclick = () => post("/tenkstack/models/download", { models: missing }).then(refresh);
    panel.appendChild(all);
  }
}

async function refresh() {
  if (!current.length) return;
  let rows;
  try {
    rows = await post("/tenkstack/models/check", { models: current });
  } catch {
    return;
  }
  const busy = rows.some((r) => r.job && ["queued", "downloading"].includes(r.job.state));
  const finished = rows.some((r) => r.job?.state === "done");
  render(rows);
  if (busy && !timer) timer = setInterval(refresh, 1500);
  if (!busy && timer) {
    clearInterval(timer);
    timer = null;
    // The new files are on disk; the loaders' dropdowns learn of them here.
    if (finished) app.refreshComboInNodes?.();
  }
}

async function inspect() {
  const graph = app.graph?.serialize?.();
  current = modelsOf(graph);
  if (!current.length) return;
  const rows = await post("/tenkstack/models/check", { models: current }).catch(() => []);
  // Only when something is actually missing and fetchable, or already on
  // its way: a workflow that loads cleanly gets no panel.
  if (rows.some((r) => r.state === "missing" || (r.job && ["queued", "downloading"].includes(r.job.state)))) {
    render(rows);
    refresh();
  } else {
    close();
  }
}

app.registerExtension({
  name: "TenkStack.ModelFetch",
  commands: [{ id: "TenkStack.FetchMissingModels", label: "下載缺少的模型到伺服器", function: () => inspect() }],
  menuCommands: [{ path: ["Workflow"], commands: ["TenkStack.FetchMissingModels"] }],
  async afterConfigureGraph() {
    // After the frontend has finished loading the graph and put up its own
    // missing-models dialog; this sits beside it.
    setTimeout(() => inspect(), 300);
  },
});
