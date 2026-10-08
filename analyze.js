// ENV: BOT_TOKEN, GEMINI_API_KEY (ключ шлюзу), [AI_BASE_URL], [AI_MODEL], [ALLOWED_USER_IDS="123,456"]
const crypto = require("crypto");
const BASE = process.env.AI_BASE_URL || "https://anymodel.org/v1/chat/completions";
const MODEL = process.env.AI_MODEL || "ag/gemini-3-flash";

const SYSTEM_PROMPT = `Ти — досвідчений свінг-трейдер (Smart Money Concepts: CHoCH, BOS, OB, FVG, Premium/Discount, Equilibrium, ліквідність; Price Action). Користувач торгує ПАСИВНО: ставить відкладені лімітні ордери, без підтверджень на молодших ТФ.
Надано 3 скріншоти ОДНОГО активу (старший, середній, робочий 4H) і ринкові дані Binance.
ПРАВИЛА:
- Рівні бери лише зі скріншотів (ціни на осі, мітки, зони). Не вигадуй. Якщо скріншоти з різних активів або ціни не видно — bias "none".
- Старший ТФ задає напрямок, середній — зону, робочий — рівень входу.
- entry — всередині ключової зони, stop — за фракталом/інвалідацією. Тейк НЕ потрібен: додаток рахує його за схемою 1:2.
- Якщо до протилежної сильної зони менше 2R, або ціна в середині діапазону (Equilibrium), або видимість слабка — bias "none".
- Додаткові фактори бери з даних Binance (funding, зміна 24г, положення ціни в діапазоні 100 днів). Новини не вигадуй.
- Пиши українською, дуже стисло.
ВІДПОВІДЬ — ЛИШЕ JSON без markdown і без тексту навколо:
{"asset":"BTC","bias":"long|short|none","summary":"до 200 символів: тренд, де ціна в діапазоні, головна ідея","zones":[{"side":"buy|sell","from":0,"to":0,"type":"OB/FVG/ліквідність","why":"до 60 символів"}],"scenarios":[{"name":"А: коротка назва","pct":50,"text":"до 80 символів"},{"name":"Б: ...","pct":30,"text":"..."},{"name":"В: флет / немає бачення","pct":20,"text":"..."}],"factors":["до 90 символів"],"order":{"entry":null,"stop":null,"note":"до 90 символів: умова входу або чому краще не торгувати"}}
Рівно 3 сценарії, сума pct = 100. Максимум 4 зони. Числа — числами.`;

async function fetchDeepMarketData(assetSymbol = "BTC") {
  const out = { symbol: "", price: null, change: null, funding: null, text: "Дані Binance недоступні." };
  try {
    const symbol = (assetSymbol || "BTC").toUpperCase() + "USDT";
    out.symbol = symbol;
    const get = (u) => fetch(u, { signal: AbortSignal.timeout(6000) }).catch(() => null);
    const [fundingRes, tickerRes, klinesRes] = await Promise.all([
      get(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`),
      get(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${symbol}`),
      get(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=100`),
    ]);
    if (tickerRes && tickerRes.ok) {
      const ticker = await tickerRes.json();
      const funding = fundingRes && fundingRes.ok ? await fundingRes.json() : null;
      out.price = parseFloat(ticker.lastPrice);
      out.change = parseFloat(ticker.priceChangePercent).toFixed(2);
      out.funding = funding ? (parseFloat(funding.lastFundingRate || 0) * 100).toFixed(4) + "%" : "N/A";
      let range = "";
      if (klinesRes && klinesRes.ok) {
        const k = await klinesRes.json();
        if (k.length) {
          const hi = Math.max(...k.map((x) => parseFloat(x[2])));
          const lo = Math.min(...k.map((x) => parseFloat(x[3])));
          range = ` Діапазон 100 днів: Max ${hi}, Min ${lo}, позиція ціни в діапазоні ${(((out.price - lo) / (hi - lo)) * 100).toFixed(0)}%.`;
        }
      }
      out.text = `${symbol}: ціна ${out.price}, зміна 24г ${out.change}%, funding ${out.funding}.${range}`;
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

  const market = await fetchDeepMarketData(asset);
  const labels = ["Старший ТФ", "Середній ТФ", "Робочий ТФ (4H)"];
  const contentParts = [{ type: "text", text: `Сьогодні ${new Date().toISOString().slice(0, 10)}. Актив: ${asset}.\nДані Binance: ${market.text}\nПроаналізуй 3 скріншоти і відповідай JSON за шаблоном.` }];
  images.forEach((data, i) => {
    let mime = "image/jpeg";
    if (data.startsWith("iVBORw0KGgo")) mime = "image/png";
    else if (data.startsWith("UklGR")) mime = "image/webp";
    contentParts.push({ type: "text", text: `Скріншот ${i + 1}: ${labels[i]}` });
    contentParts.push({ type: "image_url", image_url: { url: `data:${mime};base64,${data}` } });
  });

  try {
    let r, data;
    for (let n = 0; n < 2; n++) {
      r = await fetch(BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${GEMINI_API_KEY}` },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: contentParts }],
          temperature: 0.3,
          max_tokens: 8192,
        }),
      });
      data = await r.json().catch(() => ({}));
      if (![502, 503, 504].includes(r.status)) break;
      await new Promise((s) => setTimeout(s, 3000));
    }
    if (!r.ok) return res.status(r.status).json({ error: data?.error?.message || "Помилка API" });
    const text = data.choices?.[0]?.message?.content || "";
    if (!text) return res.status(502).json({ error: "Порожня відповідь моделі" });
    return res.status(200).json({ result: text, market: { symbol: market.symbol, price: market.price, change: market.change, funding: market.funding } });
  } catch (e) {
    return res.status(500).json({ error: "Помилка сервера: " + e.message });
  }
};
