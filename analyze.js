// ENV: BOT_TOKEN, GEMINI_API_KEY (ключ шлюзу), [AI_BASE_URL], [AI_MODEL], [ALLOWED_USER_IDS="123,456"]
const crypto = require("crypto");
const BASE = process.env.AI_BASE_URL || "https://anymodel.org/v1/chat/completions";
const MODEL = process.env.AI_MODEL || "ag/gemini-3-flash";
const F = "https://fapi.binance.com";
const COINS = ["BTC","ETH","BNB","SOL","XRP","DOGE","ADA","TRX","AVAX","LINK","DOT","LTC","BCH","NEAR","SUI","APT","UNI","ATOM","ARB","INJ"];
// [таймфрейм, кількість свічок]; win — вікно свічок для структури
const MODES = {
  swing: { name: "Свінг", tfs: [["1w", 400], ["1d", 1500], ["4h", 3000]], win: [150, 250, 300], rr: 2 },
  intra: { name: "Інтрадей", tfs: [["1d", 1000], ["4h", 3000], ["1h", 5000]], win: [250, 300, 300], rr: 3 },
};
const MS = { "1h": 36e5, "4h": 144e5, "1d": 864e5, "1w": 6048e5 };
const NF = { "1w": 2, "1d": 3, "4h": 4, "1h": 5 };
const BUCKET = 3e5; // 5 хв: всі дані фіксуються на початок вікна

const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const P = (n) => (n == null || !isFinite(n) ? "—" : String(+Number(n).toPrecision(6)));
const fm = (v) => (v >= 1e9 ? (v / 1e9).toFixed(2) + "B" : v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e3 ? (v / 1e3).toFixed(0) + "K" : String(Math.round(v)));
const gj = async (u) => { try { const r = await fetch(u, { signal: AbortSignal.timeout(12000) }); return r.ok ? await r.json() : null; } catch { return null; } };

async function klines(sym, tf, count, end) {
  const pages = Math.ceil(count / 1500), ms = MS[tf], jobs = [];
  for (let p = 0; p < pages; p++) jobs.push(gj(`${F}/fapi/v1/klines?symbol=${sym}&interval=${tf}&limit=${Math.min(1500, count - p * 1500)}&endTime=${end - p * 1500 * ms}`));
  const m = new Map();
  (await Promise.all(jobs)).forEach((a) => (a || []).forEach((k) => { if (k[6] < end) m.set(k[0], { t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }); }));
  return [...m.values()].sort((a, b) => a.t - b.t);
}

/* ---------- SMC-розрахунки ---------- */
function atr(c, n = 14) {
  let s = 0, m = 0;
  for (let i = Math.max(1, c.length - n); i < c.length; i++) { s += Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)); m++; }
  return m ? s / m : 0;
}
function swings(c, n) { // фрактали
  const s = [];
  for (let i = n; i < c.length - n; i++) {
    let H = true, L = true;
    for (let j = 1; j <= n; j++) {
      if (c[i].h < c[i - j].h || c[i].h <= c[i + j].h) H = false;
      if (c[i].l > c[i - j].l || c[i].l >= c[i + j].l) L = false;
      if (!H && !L) break;
    }
    if (H) s.push({ i, p: c[i].h, type: "H" });
    if (L) s.push({ i, p: c[i].l, type: "L" });
  }
  return s;
}
function structure(c, sw, n) { // BOS / CHoCH
  let trend = 0, lh = null, ll = null, si = 0;
  const ev = [];
  for (let k = 0; k < c.length; k++) {
    while (si < sw.length && sw[si].i + n <= k) { const s = sw[si++]; if (s.type === "H") lh = s; else ll = s; }
    if (lh && !lh.used && c[k].c > lh.p) { ev.push({ k, type: trend === -1 ? "CHoCH" : "BOS", dir: "up", lvl: lh.p, from: lh.i }); trend = 1; lh.used = true; }
    if (ll && !ll.used && c[k].c < ll.p) { ev.push({ k, type: trend === 1 ? "CHoCH" : "BOS", dir: "down", lvl: ll.p, from: ll.i }); trend = -1; ll.used = true; }
  }
  return { trend, ev };
}
function obs(c, ev) { // незмітиговані ордер-блоки
  const out = [];
  for (const e of ev.slice(-6)) {
    let idx = e.from;
    for (let j = e.from; j <= e.k; j++) if (e.dir === "up" ? c[j].l < c[idx].l : c[j].h > c[idx].h) idx = j;
    const z = { lo: c[idx].l, hi: c[idx].h, dir: e.dir === "up" ? "bull" : "bear" };
    let ok = true;
    for (let j = e.k + 1; j < c.length; j++) if (z.dir === "bull" ? c[j].c < z.lo : c[j].c > z.hi) { ok = false; break; }
    if (ok) out.push(z);
  }
  return out;
}
function fvgs(c, a) { // незаповнені імбаланси
  const out = [];
  for (let i = 2; i < c.length; i++) {
    const A = c[i - 2], C = c[i];
    let z = null;
    if (C.l > A.h && C.l - A.h >= a * 0.25) z = { lo: A.h, hi: C.l, dir: "bull" };
    else if (C.h < A.l && A.l - C.h >= a * 0.25) z = { lo: C.h, hi: A.l, dir: "bear" };
    if (!z) continue;
    const mid = (z.lo + z.hi) / 2;
    let filled = false;
    for (let j = i + 1; j < c.length; j++) if (z.dir === "bull" ? c[j].l <= mid : c[j].h >= mid) { filled = true; break; }
    if (!filled) out.push(z);
  }
  return out;
}
function eqs(c, sw, a) { // EQH / EQL (пули ліквідності)
  const tol = a * 0.25, res = { H: [], L: [] };
  for (const key of ["H", "L"]) {
    const arr = sw.filter((s) => s.type === key), found = [];
    for (let x = 0; x < arr.length; x++) for (let y = x + 1; y < arr.length; y++) {
      if (Math.abs(arr[x].p - arr[y].p) <= tol && arr[y].i - arr[x].i >= 5) {
        const p = (arr[x].p + arr[y].p) / 2;
        const intact = c.slice(arr[y].i + 1).every((k) => (key === "H" ? k.h <= p + tol : k.l >= p - tol));
        if (intact && !found.some((q) => Math.abs(q - p) <= tol)) found.push(p);
      }
    }
    res[key] = found;
  }
  return res;
}

function tfBlock(tf, c, W, price) {
  if (c.length < 30) return { text: `[${tf.toUpperCase()}] замало даних`, liq: { lows: [], highs: [] } };
  const a = atr(c), w = c.slice(-W), n = NF[tf], sw = swings(w, n), st = structure(w, sw, n);
  const hi = w.reduce((m, x) => Math.max(m, x.h), -Infinity), lo = w.reduce((m, x) => Math.min(m, x.l), Infinity);
  const pos = ((price - lo) / (hi - lo)) * 100;
  const mh = c.reduce((m, x) => Math.max(m, x.h), -Infinity), ml = c.reduce((m, x) => Math.min(m, x.l), Infinity);
  const sma = c.length >= 200 ? avg(c.slice(-200).map((x) => x.c)) : null;
  const v20 = avg(c.slice(-20).map((x) => x.v)), v50 = avg(c.slice(-70, -20).map((x) => x.v));
  const near = (arr, dir) => arr.filter((z) => z.dir === dir && (dir === "bull" ? z.lo < price : z.hi > price))
    .sort((x, y) => Math.abs(price - (x.lo + x.hi) / 2) - Math.abs(price - (y.lo + y.hi) / 2)).slice(0, 2);
  const lst = (arr) => (arr.length ? arr.map((z) => `${P(z.lo)}–${P(z.hi)}`).join(", ") : "—");
  const O = obs(w, st.ev), Fv = fvgs(w, a), E = eqs(w, sw, a);
  const sh = sw.filter((s) => s.type === "H" && s.p > price && w.slice(s.i + 1).every((k) => k.h <= s.p)).sort((x, y) => x.p - y.p).slice(0, 2).map((s) => P(s.p));
  const sl = sw.filter((s) => s.type === "L" && s.p < price && w.slice(s.i + 1).every((k) => k.l >= s.p)).sort((x, y) => y.p - x.p).slice(0, 2).map((s) => P(s.p));
  const eqh = E.H.filter((p) => p > price).sort((x, y) => x - y).slice(0, 2).map(P), eql = E.L.filter((p) => p < price).sort((x, y) => y - x).slice(0, 2).map(P);
  const evT = st.ev.slice(-3).map((e) => `${e.type}${e.dir === "up" ? "↑" : "↓"} ${P(e.lvl)} (${w.length - 1 - e.k} св. тому)`).join("; ") || "—";
  const text =
`[${tf.toUpperCase()} | ${c.length} св. | ATR ${P(a)} (${((a / price) * 100).toFixed(1)}%)]
Тренд: ${st.trend === 1 ? "висхідний" : st.trend === -1 ? "низхідний" : "флет"}; події: ${evT}
Діапазон ${W} св.: ${P(lo)}–${P(hi)}, EQ ${P((hi + lo) / 2)}, ціна на ${pos.toFixed(0)}% (${pos > 55 ? "Premium" : pos < 45 ? "Discount" : "Equilibrium"})
Макро: хай ${P(mh)}, лоу ${P(ml)}, ціна vs SMA200 ${sma ? ((price / sma - 1) * 100).toFixed(1) + "%" : "—"}, обʼєм 20/50 ×${v50 ? (v20 / v50).toFixed(2) : "—"}
OB bull: ${lst(near(O, "bull"))} | bear: ${lst(near(O, "bear"))}; FVG bull: ${lst(near(Fv, "bull"))} | bear: ${lst(near(Fv, "bear"))}
EQH: ${eqh.join(", ") || "—"}; EQL: ${eql.join(", ") || "—"}; swing H над ціною: ${sh.join(", ") || "—"}; swing L під ціною: ${sl.join(", ") || "—"}`;
  return { text, liq: { lows: sw.filter((s) => s.type === "L").slice(-2).map((s) => s.p), highs: sw.filter((s) => s.type === "H").slice(-2).map((s) => s.p) } };
}

async function deriv(sym, end) {
  const q = (p, x) => gj(`${F}${p}?symbol=${sym}${x}&endTime=${end}`);
  const [oi, fr, ls, tp, tk] = await Promise.all([
    q("/futures/data/openInterestHist", "&period=4h&limit=42"), q("/fapi/v1/fundingRate", "&limit=10"),
    q("/futures/data/globalLongShortAccountRatio", "&period=4h&limit=6"), q("/futures/data/topLongShortPositionRatio", "&period=4h&limit=6"),
    q("/futures/data/takerlongshortRatio", "&period=4h&limit=6"),
  ]);
  const L = [];
  if (oi && oi.length > 7) { const v = oi.map((x) => +x.sumOpenInterestValue), l = v[v.length - 1]; L.push(`OI $${fm(l)} (24г ${((l / v[v.length - 7] - 1) * 100).toFixed(1)}%, 7д ${((l / v[0] - 1) * 100).toFixed(1)}%)`); }
  if (fr && fr.length) { const v = fr.map((x) => +x.fundingRate * 100); L.push(`Funding ${v[v.length - 1].toFixed(4)}% (сер. 10 вир. ${avg(v).toFixed(4)}%)`); }
  if (ls && ls.length) L.push(`L/S акаунтів ${(+ls[ls.length - 1].longShortRatio).toFixed(2)} (сер. 24г ${avg(ls.map((x) => +x.longShortRatio)).toFixed(2)})`);
  if (tp && tp.length) L.push(`L/S топ-трейдерів (позиції) ${(+tp[tp.length - 1].longShortRatio).toFixed(2)}`);
  if (tk && tk.length) L.push(`Taker buy/sell ${(+tk[tk.length - 1].buySellRatio).toFixed(2)} (сер. 24г ${avg(tk.map((x) => +x.buySellRatio)).toFixed(2)})`);
  return L.length ? "Деривативи: " + L.join("; ") : "Деривативи: недоступні";
}

/* ---------- промпт ---------- */
const SCHEMA = `ВІДПОВІДЬ — ЛИШЕ ОДИН JSON-ОБ'ЄКТ, без markdown, без тексту до і після:
{"asset":"BTC","bias":"long|short|none","trend":"до 70 символів: напрямок старшого ТФ і структура","position":"до 70 символів: Premium/Discount/Equilibrium і де ціна відносно зон","idea":"до 100 символів: короткий висновок-рекомендація","zones":[{"side":"buy|sell","from":0,"to":0,"type":"OB/FVG/ліквідність","why":"до 40 символів"}],"scenarios":[{"name":"А: коротка назва","pct":50,"text":"до 60 символів"},{"name":"Б: ...","pct":30,"text":"..."},{"name":"В: флет / немає бачення","pct":20,"text":"..."}],"order":{"entry":null,"stop":null,"take":null,"note":"до 70 символів: умова входу або чому краще не торгувати"}}
Рівно 3 сценарії, сума pct = 100. Максимум 3 зони. Числа — числами, не рядками.`;

const instr = (cfg, sym) => `Ти — досвідчений трейдер (Smart Money Concepts, Price Action). Режим: ${cfg.name}, ТФ ${cfg.tfs.map((t) => t[0].toUpperCase()).join("/")}. Користувач ставить лімітні ордери без підтверджень на молодших ТФ.
Нижче дані ${sym} (Binance Futures), пораховані кодом за закритими свічками: структура (BOS/CHoCH), OB, FVG, ліквідність, зони Premium/Discount, ATR, OI, funding, L/S, taker. Використовуй ЛИШЕ ці рівні, нічого не вигадуй.
Правила: старший ТФ — напрямок, середній — зона, робочий — вхід. entry — у незмітигованому OB/FVG у зоні Discount (long) або Premium (short). stop — за інвалідацією зони/swing із запасом ≈0.5 ATR робочого ТФ${cfg.rr === 2 ? "; для свінгу стоп за значущим swing на D1, щоб не вибило шумом" : ""}. take — найближчий значущий рівень старшого ТФ (swing/EQH/EQL/протилежний OB). R:R мінімум 1:${cfg.rr}; якщо не виходить, або ціна біля Equilibrium, або дані суперечливі — bias "none". Деривативи та оцінені ліквідації використовуй як підтвердження чи ризик перегріву.
Українською, дуже стисло, без markdown-символів.`;

/* ---------- сервісне ---------- */
function verifyInitData(initData, botToken) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheck = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const calc = crypto.createHmac("sha256", secret).update(dataCheck).digest("hex");
  const a = Buffer.from(calc, "hex"), b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Date.now() / 1000 - Number(params.get("auth_date") || 0) > 86400) return null;
  try { return JSON.parse(params.get("user") || "{}"); } catch { return null; }
}
async function callAI(messages, key) {
  let useFmt = true, r, data;
  for (let n = 0; n < 3; n++) {
    r = await fetch(BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: MODEL, messages, temperature: 0.2, max_tokens: 3000, ...(useFmt ? { response_format: { type: "json_object" } } : {}) }),
    });
    data = await r.json().catch(() => ({}));
    if (r.status === 400 && useFmt) { useFmt = false; continue; }
    if (![502, 503, 504].includes(r.status)) break;
    await sleep(3000);
  }
  return { r, data };
}
function parse(t) {
  t = String(t || "").replace(/```json|```/g, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { const o = JSON.parse(t.slice(a, b + 1)); return o && Array.isArray(o.scenarios) ? o : null; } catch { return null; }
}
const cache = global.__ac || (global.__ac = new Map());

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const { BOT_TOKEN, GEMINI_API_KEY, ALLOWED_USER_IDS } = process.env;
  if (!BOT_TOKEN || !GEMINI_API_KEY) return res.status(500).json({ error: "Не задано змінні середовища на сервері" });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const user = verifyInitData(body.initData, BOT_TOKEN);
  if (!user) return res.status(401).json({ error: "Відкрий додаток через Telegram" });
  if (ALLOWED_USER_IDS && !ALLOWED_USER_IDS.split(",").map((s) => s.trim()).includes(String(user.id))) return res.status(403).json({ error: "Немає доступу" });

  const asset = String(body.asset || "").toUpperCase();
  if (!COINS.includes(asset)) return res.status(400).json({ error: "Невідома монета" });
  const mode = MODES[body.mode] ? body.mode : "swing", cfg = MODES[mode];
  const bucket = Math.floor(Date.now() / BUCKET), end = bucket * BUCKET, key = `${asset}|${mode}|${bucket}`;
  if (cache.has(key)) return res.status(200).json({ ...cache.get(key), cached: true });

  try {
    const sym = asset + "USDT";
    const [k0, k1, k2, px, dv] = await Promise.all([
      ...cfg.tfs.map(([tf, n]) => klines(sym, tf, n, end)),
      gj(`${F}/fapi/v1/klines?symbol=${sym}&interval=1m&limit=3&endTime=${end}`),
      deriv(sym, end),
    ]);
    const series = [k0, k1, k2];
    if (!k2.length || !k1.length) return res.status(502).json({ error: "Binance недоступний або немає даних по монеті" });
    const closed = (px || []).filter((k) => k[6] < end);
    const price = closed.length ? +closed[closed.length - 1][4] : k2[k2.length - 1].c;

    const blocks = cfg.tfs.map(([tf], i) => tfBlock(tf, series[i], cfg.win[i], price));
    const wk = blocks[2].liq;
    const lq = [
      ...wk.lows.flatMap((p) => [25, 50].map((L) => p * (1 - 1 / L))).filter((p) => p < price).sort((a, b) => b - a).slice(0, 3).map((p) => "лонги ~" + P(p)),
      ...wk.highs.flatMap((p) => [25, 50].map((L) => p * (1 + 1 / L))).filter((p) => p > price).sort((a, b) => a - b).slice(0, 3).map((p) => "шорти ~" + P(p)),
    ];
    const last = k2.slice(-8).map((c) => `${P(c.o)}/${P(c.h)}/${P(c.l)}/${P(c.c)} v${fm(c.v)}`).join("; ");
    const data =
`Ціна: ${P(price)}. Дата: ${new Date(end).toISOString().slice(0, 16)}Z.
${blocks.map((b) => b.text).join("\n")}
${dv}
Оцінені ліквідації (25x/50x від останніх swing ${cfg.tfs[2][0].toUpperCase()}): ${lq.join(", ") || "—"}
Останні 8 свічок ${cfg.tfs[2][0].toUpperCase()} (O/H/L/C, обʼєм): ${last}`;

    const prompt = `${instr(cfg, sym)}\n\n${SCHEMA}\n\nДАНІ:\n${data}\n\nВідповідай ТІЛЬКИ JSON-об'єктом за шаблоном.`;
    const { r, data: d } = await callAI([{ role: "user", content: prompt }], GEMINI_API_KEY);
    if (!r.ok) return res.status(r.status).json({ error: d?.error?.message || "Помилка API" });
    const text = d.choices?.[0]?.message?.content || "";
    if (!text) return res.status(502).json({ error: "Порожня відповідь моделі" });
    let tk = d.usage?.total_tokens || 0, obj = parse(text);
    if (!obj) {
      const fix = await callAI([{ role: "user", content: `Перетвори аналіз нижче у JSON за шаблоном. Використовуй лише дані з аналізу; якщо чіткого входу немає — bias "none", entry/stop/take null.\n\n${SCHEMA}\n\nАНАЛІЗ:\n${text.slice(0, 12000)}` }], GEMINI_API_KEY);
      tk += fix.data?.usage?.total_tokens || 0;
      obj = parse(fix.data?.choices?.[0]?.message?.content);
    }
    const payload = { analysis: obj, result: obj ? "" : text, market: { symbol: sym, price }, tokens: tk, mode };
    cache.set(key, payload);
    for (const k of cache.keys()) if (!k.endsWith("|" + bucket)) cache.delete(k);
    return res.status(200).json(payload);
  } catch (e) {
    return res.status(500).json({ error: "Помилка сервера: " + e.message });
  }
};
