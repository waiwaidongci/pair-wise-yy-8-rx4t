import http from "node:http";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "paper-pulp-fermentation.json");
const tmpPath = dbPath + ".tmp";
const port = Number(process.env.PORT || 3039);

const stages = ["入缸", "发酵中", "可抄纸", "异常观察"];
const statLabels = ["入缸", "发酵中", "可抄纸", "异常观察"];
const fields = [["code", "批次编号", "text"], ["source", "原料来源", "text"], ["vat", "浸泡缸", "text"], ["days", "发酵天数", "number"], ["owner", "负责人", "text"]];
const extraFields = [
  ["ticket", "现场单号", "text"],
  ["date", "观察日期", "date"],
  ["source", "班次来源", "text"],
  ["temperature", "温度", "text"],
  ["smell", "气味状态", "text"],
  ["fiber", "纤维松散度", "text"],
  ["changedWater", "是否换水", "text"],
  ["abnormal", "异味或霉点", "text"]
];

const seed = {
  version: 1,
  vats: [
    { id: "vat-1", name: "一号缸", status: "空闲", batchId: null },
    { id: "vat-2", name: "二号缸", status: "空闲", batchId: null },
    { id: "vat-3", name: "三号缸", status: "空闲", batchId: null },
    { id: "vat-4", name: "四号缸", status: "空闲", batchId: null }
  ],
  items: [
    {
      code: "PF-001",
      source: "构树皮",
      vat: "三号缸",
      days: 5,
      owner: "林素",
      status: "发酵中",
      logs: [
        { at: "2026-06-15", step: "观察", note: "温度24.6，气味微酸，纤维开始松散", abnormal: false }
      ]
    }
  ],
  tickets: {},
  idem: {}
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function genId() { return "PF-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7); }
function genTicket(dateStr) {
  const d = (dateStr || new Date().toISOString().slice(0, 10)).replace(/-/g, "");
  return "XC-" + d + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();
}
function todayStr() { return new Date().toISOString().slice(0, 10); }
function dateOf(obs) { return String(obs.date || obs.at || "").slice(0, 10); }
function truthy(v) { return String(v || "").includes("是") || String(v || "").includes("有") || String(v || "").toLowerCase() === "true"; }

function findVat(db, nameOrId) {
  return db.vats.find(v => v.id === nameOrId || v.name === nameOrId);
}
// 换水未确认前，缸位不分给下一批
function vatBusy(db, vat) {
  if (!vat || vat.status !== "占用" || !vat.batchId) return false;
  const batch = db.items.find(i => i.id === vat.batchId);
  return !!batch && !batch.waterConfirmedAt;
}

// 日期变化就重算状态：天数由入缸日与最近观察日决定，异常观察优先
function recompute(item) {
  const obs = item.observations || [];
  if (obs.length) {
    const entered = new Date(item.enteredAt || item.logs?.[0]?.at || obs[0].at);
    const latest = obs.map(o => new Date(dateOf(o))).sort((a, b) => b - a)[0];
    const computed = Math.round((latest - entered) / 86400000) + 1;
    item.days = Math.max(1, computed);
  }
  const abnormal = obs.some(o => o.abnormal);
  item.status = abnormal ? "异常观察" : (obs.length ? (Number(item.days) >= 7 ? "可抄纸" : "发酵中") : "入缸");
}

// 旧数据升级：补齐来源、补现场单号、补缸位台账、重算状态；原有记录仍能打开
function migrate(db) {
  let changed = false;
  db.version = db.version || 1;
  if (!Array.isArray(db.vats)) { db.vats = seed.vats.map(v => ({ ...v })); changed = true; }
  db.tickets = db.tickets || {};
  db.idem = db.idem || {};
  for (const item of db.items) {
    if (!item.id) { item.id = item.code || genId(); changed = true; }
    item.version = item.version || 1;
    if (!item.enteredAt) { item.enteredAt = (item.logs?.[0]?.at || new Date().toISOString()).slice(0, 10); changed = true; }
    if (!item.source) { item.source = "旧档补录"; changed = true; }
    let seq = 0;
    for (const obs of (item.observations || [])) {
      if (!obs.ticket) { obs.ticket = "XC-" + dateOf(obs).replace(/-/g, "") + "-" + String(++seq).padStart(3, "0"); changed = true; }
      db.tickets[obs.ticket] = item.id;
    }
    if (item.vat && !item.waterConfirmedAt) {
      const vat = findVat(db, item.vat);
      if (vat && vat.status === "空闲") { vat.status = "占用"; vat.batchId = item.id; changed = true; }
    }
    const before = item.status + "|" + item.days;
    recompute(item);
    if (item.status + "|" + item.days !== before) changed = true;
  }
  if (changed) db.version += 1;
  return { db, changed };
}

// 保存失败后从最后确认处恢复：写临时文件再原子改名；残留临时文件能补就补、不能就弃
async function saveDb(db) {
  await writeFile(tmpPath, JSON.stringify(db, null, 2));
  await rename(tmpPath, dbPath);
}
async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  if (existsSync(tmpPath)) {
    try {
      const candidate = JSON.parse(await readFile(tmpPath, "utf8"));
      if (candidate && Array.isArray(candidate.items)) {
        await rename(tmpPath, dbPath); // 完整的新状态，补确认
      } else {
        await unlink(tmpPath); // 残缺，弃用，主文件即最后确认处
      }
    } catch {
      await unlink(tmpPath);
    }
  }
  const { db, changed } = migrate(JSON.parse(await readFile(dbPath, "utf8")));
  if (changed) await saveDb(db); // 旧数据升级后落盘，原有记录仍能打开且 id/单号稳定
  return db;
}

// 串行化写操作：先到确认生效，后到的版本对不上即 409
let queue = Promise.resolve();
function mutate(fn) {
  const run = queue.then(async () => {
    const db = await loadDb();
    const out = await fn(db);
    await saveDb(db);
    return out;
  });
  queue = run.then(() => {}, () => {});
  return run;
}

function idemKey(req) { return req.headers["idempotency-key"] || ""; }
function checkVersion(req, item) {
  const want = req.headers["if-match"];
  if (want == null || want === "") return true;
  return Number(want) === item.version;
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of items) if (stats[item.status] !== undefined) stats[item.status] += 1;
  return stats;
}
function summarize(item) {
  const logCount = (item.logs || []).length + (item.tasks || []).reduce((n, t) => n + (t.logs || []).length, 0);
  return { ...item, logCount };
}

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古法纸浆发酵记录</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --busy:#b98a2f; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; } button.warn { background:var(--warn); }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:110px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    .vats { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:10px; margin-bottom:14px; }
    .vat { border:1px solid var(--line); border-radius:8px; padding:10px; font-size:13px; } .vat.busy { border-color:var(--busy); background:#fdf6e7; } .vat.free { border-color:var(--accent); }
    .vat b { font-size:15px; } .vat .who { color:var(--muted); }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>古法纸浆发酵记录</h1><div class="meta">纸浆批次、浸泡缸、换水和异常观察 · 入缸账</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="createForm"><h2>新增纸浆批次</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><button>保存纸浆批次</button></form>
      <form id="actionForm" style="margin-top:14px"><h2>每日观察记录</h2><label>选择纸浆批次</label><select name="id" id="itemSelect"></select><div id="extraFields"></div><button>提交记录</button></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="panel" style="margin-bottom:14px"><h2>浸泡缸占用（换水未确认前不分给下一批）</h2><div class="vats" id="vats"></div></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>'+s+'</option>').join('')}</select><input id="search" placeholder="搜索编号或关键词"></div>
      <div class="panel"><h2>每天记录温度、气味、纤维状态和换水情况，系统按观察日期重算天数与状态。</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <script>
    const fields = [["code","批次编号","text"],["source","原料来源","text"],["vat","浸泡缸","text"],["days","发酵天数","number"],["owner","负责人","text"]];
    const stages = ["入缸","发酵中","可抄纸","异常观察"];
    const extraFields = [
      ["ticket","现场单号","text"],
      ["date","观察日期","date"],
      ["source","班次来源","text"],
      ["temperature","温度","text"],
      ["smell","气味状态","text"],
      ["fiber","纤维松散度","text"],
      ["changedWater","是否换水","text"],
      ["abnormal","异味或霉点","text"]
    ];
    const createForm = document.querySelector('#createForm');
    const actionForm = document.querySelector('#actionForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const vatsEl = document.querySelector('#vats');
    const itemSelect = document.querySelector('#itemSelect');
    let items = [];
    let vats = [];
    async function api(path, options) {
      const opt = options || {};
      opt.headers = Object.assign({ 'Content-Type':'application/json' }, opt.headers || {});
      const res = await fetch(path, opt);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data.error || '请求失败');
        err.status = res.status;
        throw err;
      }
      return data;
    }
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      document.querySelector('#extraFields').innerHTML = extraFields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+(type||'text')+'">').join('');
    }
    function renderVats() {
      vatsEl.innerHTML = vats.map(v => {
        const batch = v.batchId ? items.find(i => i.id === v.batchId) : null;
        const who = batch ? (batch.code || batch.id) + (batch.waterConfirmedAt ? '（已确认换水）' : '（换水待确认）') : '空闲';
        return '<div class="vat '+(v.status==='占用'?'busy':'free')+'"><b>'+v.name+'</b><div class="who">'+who+'</div></div>';
      }).join('');
    }
    function render() {
      itemSelect.innerHTML = items.map(item => '<option value="'+(item.id || item.code)+'">'+(item.code || item.id)+' · '+(item.source || '')+'</option>').join('');
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      statsEl.innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      renderVats();
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(item => cardHtml(item)).join('');
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => {
        const id = sel.dataset.status;
        const item = items.find(i => (i.id || i.code) === id);
        try {
          await api('/api/items/'+id, { method:'PATCH', body: JSON.stringify({ status: sel.value }), headers: { 'If-Match': String(item ? item.version : '') } });
          await load();
        } catch (e) { if (e.status === 409) { alert('批次已被他人更新，请刷新后重试'); await load(); } else throw e; }
      });
      document.querySelectorAll('[data-confirm-water]').forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.confirmWater;
        const item = items.find(i => (i.id || i.code) === id);
        try {
          await api('/api/items/'+id+'/confirm-water', { method:'POST', headers: { 'If-Match': String(item ? item.version : '') } });
          await load();
        } catch (e) { if (e.status === 409) { alert('批次已被他人更新，请刷新后重试'); await load(); } else throw e; }
      });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.note;
        const note = prompt('记录备注');
        if (note) { await api('/api/items/'+id+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await load(); }
      });
    }
    function cardHtml(item) {
      const main = fields.slice(0,4).map(([key,label]) => '<div><b>'+label+'</b> '+(item[key] ?? '')+'</div>').join('');
      const obs = (item.observations || []).slice(-4).map(o => '<div>'+(o.date||'')+' '+(o.ticket||'')+' · '+(o.source||'')+'：温度'+(o.temperature||'')+'，'+(o.smell||'')+'，'+(o.fiber||'')+(o.changedWater?'，换水':''+(o.abnormal?' <span class="warn">异常</span>':''))+'</div>').join('');
      const logs = (item.logs || []).slice(-4).map(l => '<div>'+l.step+'：'+l.note+'</div>').join('');
      return '<article class="card"><h3>'+(item.code || item.id)+'</h3><span class="pill">'+item.status+'</span>'+main+'<div class="meta">入缸 '+(item.enteredAt||'')+' · 版本 '+(item.version||1)+'</div><label>状态</label><select data-status="'+(item.id || item.code)+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select><button class="secondary" data-confirm-water="'+(item.id || item.code)+'">换水确认（释放缸位）</button><button class="secondary" data-note="'+(item.id || item.code)+'">追加备注</button><div class="logs meta">'+(obs || logs || '暂无记录')+'</div></article>';
    }
    async function load() {
      const [its, v] = await Promise.all([api('/api/items'), api('/api/vats')]);
      items = its; vats = v; render();
    }
    createForm.onsubmit = async event => {
      event.preventDefault();
      const body = Object.fromEntries(new FormData(createForm).entries());
      const key = 'create-' + (body.code || '') + '-' + Date.now();
      await api('/api/items', { method:'POST', body: JSON.stringify(body), headers: { 'Idempotency-Key': key } });
      createForm.reset(); await load();
    };
    actionForm.onsubmit = async event => {
      event.preventDefault();
      const body = Object.fromEntries(new FormData(actionForm).entries());
      const id = itemSelect.value;
      const item = items.find(i => (i.id || i.code) === id);
      // 现场单号即幂等键：重复补传认首次；重试不重复追加
      const key = body.ticket ? ('ticket-' + body.ticket) : ('act-' + id + '-' + Date.now());
      try {
        await api('/api/items/'+id+'/action', { method:'POST', body: JSON.stringify(body), headers: { 'Idempotency-Key': key, 'If-Match': String(item ? item.version : '') } });
        actionForm.reset(); await load();
      } catch (e) { if (e.status === 409) { alert('批次已被他人更新，请刷新后重试'); await load(); } else throw e; }
    };
    document.querySelector('#statusFilter').onchange = render; document.querySelector('#search').oninput = render; document.querySelector('#reload').onclick = load;
    renderForms(); load();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/") return html(res, page());

    if (req.method === "GET" && url.pathname === "/api/items") {
      const db = await loadDb();
      return send(res, 200, db.items.map(summarize));
    }
    if (req.method === "GET" && url.pathname === "/api/vats") {
      const db = await loadDb();
      return send(res, 200, db.vats);
    }
    if (req.method === "GET" && url.pathname === "/api/stats") {
      const db = await loadDb();
      return send(res, 200, computeStats(db.items));
    }

    if (req.method === "POST" && url.pathname === "/api/items") {
      const out = await mutate(async (db) => {
        const key = idemKey(req);
        if (key && db.idem[key]) return db.idem[key]; // 重试不重复追加
        const input = await body(req);
        const code = String(input.code || "").trim();
        if (!code) throw new HttpError(400, "code_required");
        if (db.items.some(i => i.code === code)) throw new HttpError(409, "code_exists");
        let vat = null;
        if (input.vat) {
          vat = findVat(db, input.vat);
          if (!vat) throw new HttpError(400, "vat_not_found");
          if (vatBusy(db, vat)) throw new HttpError(409, "vat_occupied"); // 换水未确认前不分给下一批
        } else {
          vat = db.vats.find(v => v.status === "空闲");
          if (!vat) throw new HttpError(409, "no_free_vat");
        }
        const item = {
          id: genId(),
          code,
          source: input.source || "",
          vat: vat.name,
          days: Number(input.days) || 0,
          owner: input.owner || "",
          status: input.status || "入缸",
          enteredAt: input.enteredAt || todayStr(),
          version: 1,
          logs: [{ at: new Date().toISOString(), step: "建档", note: "创建纸浆批次，入" + vat.name }]
        };
        vat.status = "占用"; vat.batchId = item.id;
        db.items.unshift(item);
        if (key) db.idem[key] = item;
        return item;
      });
      return send(res, 201, out);
    }

    const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      const out = await mutate(async (db) => {
        const item = db.items.find(x => x.id === patch[1] || x.code === patch[1]);
        if (!item) throw new HttpError(404, "item_not_found");
        if (!checkVersion(req, item)) throw new HttpError(409, "version_conflict"); // 先到确认生效
        const input = await body(req);
        const allowed = ["code", "source", "vat", "days", "owner", "status", "enteredAt"];
        for (const k of allowed) if (input[k] !== undefined) item[k] = input[k];
        if (input.vat) {
          const vat = findVat(db, input.vat);
          if (!vat) throw new HttpError(400, "vat_not_found");
          if (vatBusy(db, vat) && vat.batchId !== item.id) throw new HttpError(409, "vat_occupied");
          const old = findVat(db, item.vat);
          if (old && old.batchId === item.id) { old.status = "空闲"; old.batchId = null; }
          vat.status = "占用"; vat.batchId = item.id;
        }
        recompute(item);
        item.version += 1;
        item.logs ||= [];
        item.logs.push({ at: new Date().toISOString(), step: "更新", note: "更新资料" });
        return item;
      });
      return send(res, 200, out);
    }

    const action = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
    if (action && req.method === "POST") {
      const out = await mutate(async (db) => {
        const item = db.items.find(x => x.id === action[1] || x.code === action[1]);
        if (!item) throw new HttpError(404, "item_not_found");
        const key = idemKey(req);
        if (key && db.idem[key]) return db.idem[key]; // 重试不重复追加
        if (!checkVersion(req, item)) throw new HttpError(409, "version_conflict"); // 先到确认生效
        const input = await body(req);
        const ticket = String(input.ticket || "").trim() || genTicket(input.date);
        if (db.tickets[ticket]) {
          // 重复补传认首次：已有同单号记录，不重复追加
          if (key) db.idem[key] = item;
          return item;
        }
        const obs = {
          ticket,
          at: new Date().toISOString(),
          date: input.date || todayStr(),
          source: input.source || "白班",
          temperature: input.temperature || "",
          smell: input.smell || "",
          fiber: input.fiber || "",
          changedWater: truthy(input.changedWater),
          abnormal: truthy(input.abnormal)
        };
        item.observations ||= [];
        item.observations.push(obs);
        db.tickets[ticket] = item.id;
        recompute(item); // 日期变化就重算状态
        item.version += 1;
        item.logs ||= [];
        item.logs.push({ at: new Date().toISOString(), step: "观察", note: "温度" + obs.temperature + "，" + obs.smell + "，" + obs.fiber + (obs.changedWater ? "，已换水" : "") });
        if (key) db.idem[key] = item;
        return item;
      });
      return send(res, 201, out);
    }

    const confirmWater = url.pathname.match(/^\/api\/items\/([^/]+)\/confirm-water$/);
    if (confirmWater && req.method === "POST") {
      const out = await mutate(async (db) => {
        const item = db.items.find(x => x.id === confirmWater[1] || x.code === confirmWater[1]);
        if (!item) throw new HttpError(404, "item_not_found");
        if (!checkVersion(req, item)) throw new HttpError(409, "version_conflict");
        if (item.waterConfirmedAt) return item; // 幂等
        item.waterConfirmedAt = new Date().toISOString();
        const vat = findVat(db, item.vat);
        if (vat && vat.batchId === item.id) { vat.status = "空闲"; vat.batchId = null; }
        item.version += 1;
        item.logs ||= [];
        item.logs.push({ at: new Date().toISOString(), step: "换水确认", note: item.vat + " 换水已确认，缸位释放" });
        return item;
      });
      return send(res, 200, out);
    }

    const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      const out = await mutate(async (db) => {
        const item = db.items.find(x => x.id === log[1] || x.code === log[1]);
        if (!item) throw new HttpError(404, "item_not_found");
        const input = await body(req);
        item.logs ||= [];
        item.logs.push({ at: new Date().toISOString(), step: input.step || "记录", note: input.note || "" });
        return item;
      });
      return send(res, 201, out);
    }

    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, error.status || 500, { error: error.message });
  }
});

server.listen(port, () => console.log("古法纸浆发酵记录 listening on http://localhost:" + port));
