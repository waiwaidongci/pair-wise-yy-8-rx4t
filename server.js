import http from "node:http";
import { mkdir, readFile, writeFile, copyFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "paper-pulp-fermentation.json");
const bakPath = dbPath + ".bak";
const tmpPath = dbPath + ".tmp";
const port = Number(process.env.PORT || 3039);

const DB_VERSION = 2;
const READY_DAYS = 7;
const stages = ["入缸", "发酵中", "可抄纸", "异常观察"];
const statLabels = stages;
const shifts = ["白班", "夜班"];

const seed = {
  version: DB_VERSION,
  items: [
    {
      id: "PF-SEED-001",
      code: "PF-001",
      schema: DB_VERSION,
      source: "构树皮",
      vat: "三号缸",
      owner: "林素",
      entryDate: "2026-06-15",
      days: 1,
      status: "发酵中",
      version: 1,
      abnormalCount: 0,
      pendingWater: false,
      vatReleasedAt: null,
      observations: [
        {
          slipNo: "YC-20260615-01",
          date: "2026-06-15",
          shift: "白班",
          source: "白班",
          temperature: "24.6",
          smell: "微酸",
          fiber: "开始松散",
          changedWater: false,
          waterConfirmed: false,
          abnormal: false,
          note: "温度24.6，气味微酸，纤维开始松散",
          recordedAt: "2026-06-15T08:00:00.000Z"
        }
      ],
      logs: [{ at: "2026-06-15T08:00:00.000Z", step: "建档", note: "创建纸浆批次", source: "系统" }]
    }
  ]
};

const now = () => new Date().toISOString();
const today = () => now().slice(0, 10);
function newId() { return "PF-" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase(); }
function isYes(v) {
  if (v === true) return true;
  const s = String(v ?? "").trim();
  return s.includes("是") || s.includes("有") || s.toLowerCase() === "true";
}
function asDate(v) { const s = String(v ?? "").trim(); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ""; }

// ---- 写操作串行化：两人同时提交同一批次时，先到者先确认生效 ----
let chain = Promise.resolve();
function locked(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

// ---- 状态重算：观察乱序到齐后，按日期重排，天数和异常以日期为准 ----
function sortObservations(item) {
  item.observations.sort((a, b) =>
    String(a.date).localeCompare(String(b.date)) ||
    String(a.recordedAt).localeCompare(String(b.recordedAt)) ||
    String(a.slipNo).localeCompare(String(b.slipNo)));
  return item.observations;
}
function recompute(item) {
  const obs = sortObservations(item);
  item.abnormalCount = obs.filter(o => o.abnormal).length;
  item.pendingWater = obs.some(o => o.changedWater && !o.waterConfirmed);
  if (!obs.length) return;
  item.days = new Set(obs.map(o => o.date)).size;
  const first = obs[0].date;
  if (!item.entryDate || first < item.entryDate) item.entryDate = first;
  const latest = obs[obs.length - 1];
  item.status = latest.abnormal ? "异常观察" : item.days >= READY_DAYS ? "可抄纸" : "发酵中";
}
// 换水未确认前缸位不分给下一批；出缸（可抄纸）且换水都确认后才释放
function maybeReleaseVat(item) {
  if (!item.vatReleasedAt && item.status === "可抄纸" && !item.pendingWater) {
    item.vatReleasedAt = now();
  }
}

// ---- 旧数据升级：补齐单号、来源、入缸日期，原有记录仍能打开 ----
function migrateItem(item) {
  if (item.schema === DB_VERSION) return false; // 已升级的批次不在读取时重算，重算只随观察日期变化发生
  let changed = false;
  if (!item.id) { item.id = item.code || newId(); changed = true; }
  if (!item.code) { item.code = item.id; changed = true; }
  item.logs ||= [];
  item.observations ||= [];
  item.observations.forEach((obs, i) => {
    if (!obs.slipNo) { obs.slipNo = "LEGACY-" + item.code + "-" + String(i + 1).padStart(3, "0"); changed = true; }
    const date = asDate(obs.date) || asDate(String(obs.at || "").slice(0, 10)) || today();
    if (obs.date !== date) { obs.date = date; changed = true; }
    if (!obs.source) { obs.source = obs.shift || "旧数据补齐"; changed = true; }
    if (typeof obs.changedWater !== "boolean") { obs.changedWater = isYes(obs.changedWater); changed = true; }
    if (typeof obs.abnormal !== "boolean") { obs.abnormal = isYes(obs.abnormal); changed = true; }
    obs.waterConfirmed = Boolean(obs.waterConfirmed);
    if (!obs.recordedAt) { obs.recordedAt = obs.at || now(); changed = true; }
  });
  for (const log of item.logs) {
    if (!log.source) { log.source = "旧数据补齐"; changed = true; }
  }
  if (typeof item.version !== "number") { item.version = 1; changed = true; }
  if (item.vatReleasedAt === undefined) { item.vatReleasedAt = null; changed = true; }
  if (!item.entryDate) {
    const dates = [
      ...item.observations.map(o => asDate(o.date)),
      ...item.logs.map(l => asDate(String(l.at || "").slice(0, 10)))
    ].filter(Boolean).sort();
    item.entryDate = dates[0] || today();
    changed = true;
  }
  const before = JSON.stringify([item.days, item.status, item.pendingWater, item.abnormalCount, item.entryDate]);
  recompute(item);
  if (JSON.stringify([item.days, item.status, item.pendingWater, item.abnormalCount, item.entryDate]) !== before) changed = true;
  item.schema = DB_VERSION;
  return changed;
}
function migrateDb(db) {
  db.items ||= [];
  if (db.version !== DB_VERSION) db.version = DB_VERSION;
  for (const item of db.items) migrateItem(item);
  return db;
}

// ---- 保存：临时文件 + 备份 + 原子改名；失败时主文件保持最后确认状态 ----
async function saveDb(db) {
  await mkdir(dirname(dbPath), { recursive: true });
  await writeFile(tmpPath, JSON.stringify(db, null, 2));
  if (existsSync(dbPath)) await copyFile(dbPath, bakPath);
  await rename(tmpPath, dbPath);
}
async function loadDb() {
  let db = null;
  if (existsSync(dbPath)) {
    try { db = JSON.parse(await readFile(dbPath, "utf8")); }
    catch { db = null; } // 主文件损坏，从最后确认的备份恢复
  }
  if (!db && existsSync(bakPath)) db = JSON.parse(await readFile(bakPath, "utf8"));
  if (!db) db = JSON.parse(JSON.stringify(seed));
  return migrateDb(db);
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
function findItem(db, key) { return db.items.find(x => x.id === key || x.code === key); }
function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of items) {
    if (stats[item.status] !== undefined) stats[item.status] += 1;
  }
  return stats;
}
function summarize(item) {
  const logCount = (item.logs || []).length + (item.observations || []).length;
  return { ...item, logCount };
}
function vatOverview(db) {
  const map = new Map();
  for (const item of db.items) {
    if (!item.vat) continue;
    if (!map.has(item.vat)) map.set(item.vat, { vat: item.vat, occupiedBy: null, pendingWater: false, batches: [] });
    const v = map.get(item.vat);
    const released = Boolean(item.vatReleasedAt);
    v.batches.push({ code: item.code, status: item.status, released });
    if (!released && !v.occupiedBy) {
      v.occupiedBy = item.code;
      v.pendingWater = Boolean(item.pendingWater);
    }
  }
  return [...map.values()];
}
function checkVersion(item, input, res) {
  if (input.baseVersion !== undefined && Number(input.baseVersion) !== item.version) {
    send(res, 409, { error: "version_conflict", version: item.version });
    return false;
  }
  return true;
}

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古法纸浆发酵记录</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:120px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>古法纸浆发酵记录</h1><div class="meta">浸泡缸、纸浆批次、观察记录入缸账 · 观察凭现场单号入账，重复补传以首次为准</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="createForm"><h2>新增纸浆批次</h2><div id="fields"></div><label>入缸日期</label><input name="entryDate" type="date" id="entryDate"><button>保存纸浆批次</button></form>
      <form id="actionForm" style="margin-top:14px"><h2>每日观察记录</h2><label>选择纸浆批次</label><select name="id" id="itemSelect"></select><div id="extraFields"></div><label>备注</label><input name="note"><button>提交记录</button></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="panel" style="margin-bottom:14px"><h2>缸位占用</h2><div id="vats"></div></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>'+s+'</option>').join('')}</select><input id="search" placeholder="搜索编号、单号或关键词"></div>
      <div class="panel"><h2>夜班白班补录按现场单号入账，乱序到齐后按日期重算天数与异常；换水未确认的缸位不分给下一批。</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <script>
    const fields = [["code","批次编号","text"],["source","原料来源","text"],["vat","浸泡缸","text"],["owner","负责人","text"]];
    const stages = ${JSON.stringify(stages)};
    const shifts = ${JSON.stringify(shifts)};
    const extraFields = [["slipNo","现场单号"],["date","观察日期"],["shift","班次"],["temperature","温度"],["smell","气味状态"],["fiber","纤维松散度"],["changedWater","是否换水"],["abnormal","异味或霉点"]];
    const createForm = document.querySelector('#createForm');
    const actionForm = document.querySelector('#actionForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    let items = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) { const err = new Error(data.error || '请求失败'); err.data = data; throw err; }
      return data;
    }
    function todayLocal() { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0,10); }
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      document.querySelector('#extraFields').innerHTML = extraFields.map(([key,label]) => {
        if (key === 'date') return '<label>'+label+'</label><input name="date" type="date" id="obsDate" required>';
        if (key === 'shift') return '<label>'+label+'</label><select name="shift">'+shifts.map(s => '<option>'+s+'</option>').join('')+'</select>';
        if (key === 'changedWater') return '<label>'+label+'</label><select name="changedWater"><option>否</option><option>是</option></select>';
        if (key === 'abnormal') return '<label>'+label+'</label><select name="abnormal"><option>无</option><option>有</option></select>';
        return '<label>'+label+'</label><input name="'+key+'" '+(key==='slipNo'?'required placeholder="现场单号，重复补传以首次为准"':'')+'>';
      }).join('');
      setDates();
    }
    function setDates() {
      const obs = document.querySelector('#obsDate'); if (obs) obs.value = todayLocal();
      const ent = document.querySelector('#entryDate'); if (ent) ent.value = todayLocal();
    }
    function render(vats) {
      itemSelect.innerHTML = items.map(item => '<option value="'+(item.id || item.code)+'">'+(item.code || item.id)+' · '+(item.source || '')+' · '+(item.vat || '未分缸')+'</option>').join('');
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      stats['换水待确认'] = items.filter(i => i.pendingWater).length;
      statsEl.innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      document.querySelector('#vats').innerHTML = (vats && vats.length) ? vats.map(v =>
        '<div class="meta">'+v.vat+'：'+(v.occupiedBy ? '占用中 ← '+v.occupiedBy+(v.pendingWater ? '（<span class="warn">换水待确认</span>）' : '') : '空闲，可分给下一批')+'</div>').join('') : '<div class="meta">暂无缸位</div>';
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(item => cardHtml(item)).join('');
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => {
        const item = items.find(i => (i.id || i.code) === sel.dataset.status);
        try { await api('/api/items/'+sel.dataset.status, { method:'PATCH', body: JSON.stringify({ status: sel.value, baseVersion: item && item.version }) }); await load(); }
        catch (err) { if (err.data && err.data.error === 'version_conflict') { alert('该批次已被他人先确认，请刷新后再改'); await load(); } else alert(err.message); }
      });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => { const id = btn.dataset.note; const note = prompt('记录备注'); if (note) { await api('/api/items/'+id+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await load(); } });
      document.querySelectorAll('[data-water]').forEach(btn => btn.onclick = async () => {
        const data = await api('/api/items/'+btn.dataset.water+'/confirm-water', { method:'POST', body: '{}' });
        if (data.noop) alert('没有待确认的换水'); await load();
      });
    }
    function cardHtml(item) {
      const main = '<div><b>原料来源</b> '+(item.source ?? '')+'</div><div><b>浸泡缸</b> '+(item.vat ? item.vat + (item.vatReleasedAt ? '（已释放）' : '（占用中）') : '未分配')+'</div><div><b>负责人</b> '+(item.owner ?? '')+'</div><div><b>入缸日期</b> '+(item.entryDate ?? '')+' · <b>发酵天数</b> '+(item.days ?? 0)+' · <b>异常次数</b> '+(item.abnormalCount ?? 0)+'</div>';
      const water = item.pendingWater ? '<div><span class="warn">换水待确认，缸位不分给下一批</span> <button class="secondary" data-water="'+item.id+'">确认换水</button></div>' : '';
      const obs = (item.observations || []).slice(-4).map(o => '<div>'+o.date+' · 单号'+o.slipNo+(o.shift ? ' · '+o.shift : '')+' · 温度'+(o.temperature || '-')+' · '+(o.smell || '-')+' · '+(o.fiber || '-')+(o.changedWater ? (o.waterConfirmed ? ' · 换水已确认' : ' · <span class="warn">换水待确认</span>') : '')+(o.abnormal ? ' · <span class="warn">异常</span>' : '')+(o.source ? ' · 来源:'+o.source : '')+'</div>').join('');
      const logs = (item.logs || []).slice(-3).map(l => '<div>'+l.step+'：'+l.note+(l.source ? '（'+l.source+'）' : '')+'</div>').join('');
      return '<article class="card"><h3>'+(item.code || item.id)+'</h3><span class="pill">'+item.status+'</span>'+main+water+'<label>状态</label><select data-status="'+(item.id || item.code)+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select><button class="secondary" data-note="'+(item.id || item.code)+'">追加备注</button><div class="logs meta">'+(obs || '')+(logs || '暂无记录')+'</div></article>';
    }
    async function load() {
      const [itemsData, vatsData] = await Promise.all([api('/api/items'), api('/api/vats')]);
      items = itemsData; render(vatsData);
    }
    createForm.onsubmit = async event => {
      event.preventDefault();
      try {
        await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) });
        createForm.reset(); setDates(); await load();
      } catch (err) {
        if (err.data && err.data.error === 'duplicate_code') alert('批次编号已存在，不能重复建档');
        else if (err.data && err.data.error === 'vat_occupied') alert(err.data.vat + ' 正被 ' + err.data.holder + ' 占用' + (err.data.pendingWater ? '（换水未确认）' : '') + '，不能分给下一批');
        else alert(err.message);
      }
    };
    actionForm.onsubmit = async event => {
      event.preventDefault();
      const item = items.find(i => (i.id || i.code) === itemSelect.value);
      const payload = Object.fromEntries(new FormData(actionForm).entries());
      if (item) payload.baseVersion = item.version;
      try {
        const data = await api('/api/items/'+itemSelect.value+'/action', { method:'POST', body: JSON.stringify(payload) });
        if (data.deduplicated) alert('单号 ' + payload.slipNo + ' 已入账，重复补传以首次记录为准');
        actionForm.reset(); setDates(); await load();
      } catch (err) {
        if (err.data && err.data.error === 'version_conflict') { alert('该批次已被他人先确认，请刷新后重试'); await load(); }
        else alert(err.message);
      }
    };
    document.querySelector('#statusFilter').onchange = () => render();
    document.querySelector('#search').oninput = () => render();
    document.querySelector('#reload').onclick = load;
    renderForms(); load();
  </script>
</body>
</html>`;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/") return html(res, page());
  if (req.method === "GET" && url.pathname === "/api/items") {
    const db = await loadDb();
    return send(res, 200, db.items.map(summarize));
  }
  if (req.method === "GET" && url.pathname === "/api/stats") {
    const db = await loadDb();
    return send(res, 200, computeStats(db.items));
  }
  if (req.method === "GET" && url.pathname === "/api/vats") {
    const db = await loadDb();
    return send(res, 200, vatOverview(db));
  }
  const one = url.pathname.match(/^\/api\/items\/([^/]+)$/);
  if (one && req.method === "GET") {
    const db = await loadDb();
    const item = findItem(db, one[1]);
    return item ? send(res, 200, summarize(item)) : send(res, 404, { error: "item_not_found" });
  }

  // 新增批次：缸位被占用（尤其换水未确认）时不分给下一批
  if (req.method === "POST" && url.pathname === "/api/items") {
    return locked(async () => {
      const db = await loadDb();
      const input = await body(req);
      const code = String(input.code || "").trim();
      if (!code) return send(res, 400, { error: "code_required" });
      if (db.items.some(x => x.code === code)) return send(res, 409, { error: "duplicate_code", code });
      const vat = String(input.vat || "").trim();
      if (vat) {
        const holder = db.items.find(x => x.vat === vat && !x.vatReleasedAt);
        if (holder) return send(res, 409, { error: "vat_occupied", vat, holder: holder.code, pendingWater: Boolean(holder.pendingWater) });
      }
      const item = {
        id: newId(),
        code,
        schema: DB_VERSION,
        source: String(input.source || ""),
        vat,
        owner: String(input.owner || ""),
        entryDate: asDate(input.entryDate) || today(),
        days: 0,
        abnormalCount: 0,
        pendingWater: false,
        status: stages.includes(input.status) ? input.status : "入缸",
        version: 1,
        vatReleasedAt: null,
        observations: [],
        logs: [{ at: now(), step: "建档", note: "创建纸浆批次", source: "前台录入" }]
      };
      db.items.unshift(item);
      await saveDb(db);
      return send(res, 201, item);
    });
  }

  // 每日观察：凭现场单号入账，重复补传认首次；日期变化即重算状态
  const action = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
  if (action && req.method === "POST") {
    return locked(async () => {
      const db = await loadDb();
      const item = findItem(db, action[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      if (!checkVersion(item, input, res)) return;
      const date = asDate(input.date) || today();
      let slipNo = String(input.slipNo || "").trim();
      if (!slipNo) slipNo = "AUTO-" + item.code + "-" + date.replaceAll("-", "") + "-" + String(item.observations.filter(o => o.date === date).length + 1).padStart(2, "0");
      const dup = item.observations.find(o => o.slipNo === slipNo);
      if (dup) return send(res, 200, { ...item, deduplicated: true, slipNo });
      const obs = {
        slipNo,
        date,
        shift: String(input.shift || ""),
        source: String(input.shift || input.source || "现场"),
        temperature: String(input.temperature || ""),
        smell: String(input.smell || ""),
        fiber: String(input.fiber || ""),
        changedWater: isYes(input.changedWater),
        waterConfirmed: false,
        abnormal: isYes(input.abnormal),
        note: String(input.note || ""),
        recordedAt: now()
      };
      item.observations.push(obs);
      recompute(item);
      maybeReleaseVat(item);
      item.version += 1;
      item.logs.push({
        at: now(), step: "观察", slipNo, source: obs.source,
        note: "温度" + (obs.temperature || "-") + "，" + (obs.smell || "-") + "，" + (obs.fiber || "-") + (obs.abnormal ? "，异常" : "")
      });
      await saveDb(db);
      return send(res, 201, item);
    });
  }

  // 换水确认：确认后缸位才可能释放；重复确认不重复入账
  const confirmWater = url.pathname.match(/^\/api\/items\/([^/]+)\/confirm-water$/);
  if (confirmWater && req.method === "POST") {
    return locked(async () => {
      const db = await loadDb();
      const item = findItem(db, confirmWater[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      let confirmed = 0;
      for (const obs of item.observations) {
        if (obs.changedWater && !obs.waterConfirmed) { obs.waterConfirmed = true; confirmed++; }
      }
      if (!confirmed) return send(res, 200, { ...item, noop: true });
      recompute(item);
      maybeReleaseVat(item);
      item.version += 1;
      item.logs.push({
        at: now(), step: "换水确认", source: "前台",
        note: "确认换水" + confirmed + "次" + (item.vatReleasedAt ? "，缸位" + item.vat + "已释放" : "，缸位仍占用")
      });
      await saveDb(db);
      return send(res, 200, item);
    });
  }

  const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
  if (patch && req.method === "PATCH") {
    return locked(async () => {
      const db = await loadDb();
      const item = findItem(db, patch[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      if (!checkVersion(item, input, res)) return;
      const { baseVersion, ...rest } = input;
      Object.assign(item, rest);
      maybeReleaseVat(item);
      item.version += 1;
      item.logs.push({ at: now(), step: "状态", note: "更新为" + item.status, source: "前台" });
      await saveDb(db);
      return send(res, 200, item);
    });
  }

  const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
  if (log && req.method === "POST") {
    return locked(async () => {
      const db = await loadDb();
      const item = findItem(db, log[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      item.logs ||= [];
      item.logs.push({ at: now(), step: input.step || "记录", note: input.note || "", source: input.source || "前台" });
      item.version += 1;
      await saveDb(db);
      return send(res, 201, item);
    });
  }

  send(res, 404, { error: "not_found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(error => send(res, 500, { error: error.message }));
});
server.listen(port, () => console.log("古法纸浆发酵记录 listening on http://localhost:" + port));

// 启动时落盘一次：首次运行写种子，旧数据升级补齐来源后保存
locked(async () => { const db = await loadDb(); await saveDb(db); })
  .catch(error => console.error("启动迁移失败:", error));
