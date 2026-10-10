// ENV: BOT_TOKEN, GEMINI_API_KEY (ключ шлюзу), [AI_BASE_URL], [AI_MODEL], [ALLOWED_USER_IDS="123,456"]
const crypto = require("crypto");
const BASE = process.env.AI_BASE_URL || "https://anymodel.org/v1/chat/completions";
const MODEL = process.env.AI_MODEL || "ag/gemini-3-flash";
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

const INSTR = `Ти — досвідчений свінг-трейдер (Smart Money Concepts: CHoCH, BOS, OB, FVG, Premium/Discount, Equilibrium, ліквідність; Price Action). Користувач торгує ПАСИВНО: ставить відкладені лімітні ордери, без підтверджень на молодших ТФ.
Нижче 3 скріншоти ОДНОГО активу (старший, середній, робочий 4H).
ПРАВИЛА:
- Рівні бери лише зі скріншотів (ціни на осі, мітки, зони). Не вигадуй. Якщо скріншоти з різних активів або ціни не видно — bias "none".
- Старший ТФ задає напрямок, середній — зону, робочий — рівень входу.
- entry — всередині ключової зони, stop — за фракталом/інвалідацією. Тейк НЕ потрібен: додаток рахує його за схемою 1:2.
- Якщо до протилежної сильної зони менше 2R, або ціна в середині діапазону (Equilibrium), або видимість слабка — bias "none".
- Пиши українською, дуже стисло, без markdown-символів у текстових полях.`;

const SCHEMA = `ВІДПОВІДЬ — ЛИШЕ ОДИН JSON-ОБ'ЄКТ, без markdown, без тексту до і після:
{"asset":"BTC","bias":"long|short|none","summary":"до 200 символів: тренд, де ціна в діапазоні, головна ідея і рекомендація","zones":[{"side":"buy|sell","from":0,"to":0,"type":"OB/FVG/ліквідність","why":"до 60 символів"}],"scenarios":[{"name":"А: коротка назва","pct":50,"text":"до 80 символів"},{"name":"Б: ...","pct":30,"text":"..."},{"name":"В: флет / немає бачення","pct":20,"text":"..."}],"order":{"entry":null,"stop":null,"note":"до 90 символів: умова входу або чому краще не торгувати"}}
Рівно 3 сценарії, сума pct = 100. Максимум 4 зони. Числа — числами, не рядками.`;

async function fetchMarket(asset) {
  const out = { symbol: asset + "USDT", price: null, change: null, funding: null, facts: [] };
  try {
    const get = (u) => fetch(u, { signal: AbortSignal.timeout(6000) }).catch(() => null);
    const [fR, tR, kR] = await Promise.all([
      get(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${out.symbol}`),
      get(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${out.symbol}`),
      get(`https://fapi.binance.com/fapi/v1/klines?symbol=${out.symbol}&interval=1d&limit=100`),
    ]);
    if (!tR || !tR.ok) return out;
    const t = await tR.json();
    out.price = parseFloat(t.lastPrice);
    out.change = parseFloat(t.priceChangePercent).toFixed(2);
    if (fR && fR.ok) {
      const f = parseFloat((await fR.json()).lastFundingRate || 0) * 100;
      out.funding = f.toFixed(4) + "%";
      out.facts.push(
        f > 0.03 ? `Funding ${out.funding}: лонги перегріті, ризик корекції`
        : f < -0.01 ? `Funding ${out.funding}: перегріті шорти, можливий сквіз вгору`
        : `Funding ${out.funding}: нейтральний`
      );
    }
    if (kR && kR.ok) {
      const k = await kR.json();
      if (k.length) {
        const hi = Math.max(...k.map((x) => parseFloat(x[2])));
        const lo = Math.min(...k.map((x) => parseFloat(x[3])));
        const pos = Math.round(((out.price - lo) / (hi - lo)) * 100);
        out.facts.push(`Ціна на ${pos}% діапазону 100 днів: ${pos < 35 ? "зона Discount" : pos > 65 ? "зона Premium" : "біля Equilibrium"}`);
      }
    }
  } catch (e) {}
  return out;
}

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
      body: JSON.stringify({ model: MODEL, messages, temperature: 0.3, max_tokens: 8192, ...(useFmt ? { response_format: { type: "json_object" } } : {}) }),
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

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const { BOT_TOKEN, GEMINI_API_KEY, ALLOWED_USER_IDS } = process.env;
  if (!BOT_TOKEN || !GEMINI_API_KEY) return res.status(500).json({ error: "Не задано змінні середовища на сервері" });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const user = verifyInitData(body.initData, BOT_TOKEN);
  if (!user) return res.status(401).json({ error: "Відкрий додаток через Telegram" });
  if (ALLOWED_USER_IDS && !ALLOWED_USER_IDS.split(",").map((s) => s.trim()).includes(String(user.id))) {
    return res.status(403).json({ error: "Немає доступу" });
  }

  const { images } = body;
  const asset = /^[A-Za-z0-9]{2,12}$/.test(body.asset || "") ? body.asset.toUpperCase() : "BTC";
  if (!Array.isArray(images) || images.length !== 3 || images.some((d) => typeof d !== "string" || d.length > 1400000)) {
    return res.status(400).json({ error: "Потрібно рівно 3 скріншоти (не завеликих)" });
  }

  const market = await fetchMarket(asset);
  const labels = ["Старший ТФ", "Середній ТФ", "Робочий ТФ (4H)"];
  const parts = [{ type: "text", text: `${INSTR}\n\n${SCHEMA}\n\nСьогодні ${new Date().toISOString().slice(0, 10)}. Актив: ${asset}.` }];
  images.forEach((data, i) => {
    let mime = "image/jpeg";
    if (data.startsWith("iVBORw0KGgo")) mime = "image/png";
    else if (data.startsWith("UklGR")) mime = "image/webp";
    parts.push({ type: "text", text: `Скріншот ${i + 1}: ${labels[i]}` });
    parts.push({ type: "image_url", image_url: { url: `data:${mime};base64,${data}` } });
  });
  parts.push({ type: "text", text: `${market.price != null ? `Поточна ціна ${asset} (Binance): ${market.price}. ` : ""}Відповідай ТІЛЬКИ JSON-об'єктом за шаблоном.` });

  try {
    const { r, data } = await callAI([{ role: "user", content: parts }], GEMINI_API_KEY);
    if (!r.ok) return res.status(r.status).json({ error: data?.error?.message || "Помилка API" });
    const text = data.choices?.[0]?.message?.content || "";
    if (!text) return res.status(502).json({ error: "Порожня відповідь моделі" });

    let obj = parse(text);
    if (!obj) {
      const fix = await callAI([{ role: "user", content: [{ type: "text", text: `Перетвори аналіз нижче у JSON за шаблоном. Використовуй лише дані з аналізу; якщо чіткого входу немає — bias "none", entry і stop null.\n\n${SCHEMA}\n\nАНАЛІЗ:\n${text.slice(0, 12000)}` }] }], GEMINI_API_KEY);
      obj = parse(fix.data?.choices?.[0]?.message?.content);
    }
    const m = { symbol: market.symbol, price: market.price, change: market.change, funding: market.funding, facts: market.facts };
    return res.status(200).json({ analysis: obj, result: obj ? "" : text, market: m });
  } catch (e) {
    return res.status(500).json({ error: "Помилка сервера: " + e.message });
  }
};
