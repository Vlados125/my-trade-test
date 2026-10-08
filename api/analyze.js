const SYSTEM_PROMPT = `Ти — професійний свінг-трейдер (Smart Money Concepts та Price Action). 
Проаналізуй актив та 3 скріншоти. Обов'язково поверни відповідь у вигляді структурованого блоку, який містить:
1. Загальний контекст (тренд, старші ТФ).
2. Торговий план з конкретними числовими значеннями: Актив, Напрямок (LONG/SHORT), Точка входу (Entry), Стоп-лос (Stop Loss), Тейк-профіти (Take Profit), співвідношення R:R.
3. Сценарії розвитку подій із відсотковою ймовірністю (прохідністю).
4. Таблицю / журнал угоди (asset, direction, entry, stop, take, winrate, status).

Пиши українською мовою, чітко, професійно, без зайвої «води».`;

async function fetchDeepMarketData(assetSymbol = "BTC") {
  try {
    const symbol = (assetSymbol || "BTC").toUpperCase() + "USDT";
    const [fundingRes, tickerRes, klinesRes] = await Promise.all([
      fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`).catch(() => null),
      fetch(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${symbol}`).catch(() => null),
      fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=100`).catch(() => null)
    ]);

    let report = `Актив: ${symbol}. Дані обмежені.`;
    if (tickerRes && tickerRes.ok) {
      const ticker = await tickerRes.json();
      const funding = fundingRes && fundingRes.ok ? await fundingRes.json() : null;
      const fundingRatePct = funding ? (parseFloat(funding.lastFundingRate || 0) * 100).toFixed(4) : "N/A";
      
      let klineSummary = "";
      if (klinesRes && klinesRes.ok) {
        const klines = await klinesRes.json();
        if (klines.length > 0) {
          const high100 = Math.max(...klines.map(k => parseFloat(k[2])));
          const low100 = Math.min(...klines.map(k => parseFloat(k[3])));
          const lastClose = parseFloat(klines[klines.length - 1][4]);
          klineSummary = `Історія 1D (100 днів): Max: ${high100}, Min: ${low100}, Поточна ціна: ${lastClose}.`;
        }
      }
      report = `Актив: ${symbol}, Ціна: ${ticker.lastPrice}, Зміна 24г: ${ticker.priceChangePercent}%, Funding: ${fundingRatePct}%. ${klineSummary}`;
    }
    return report;
  } catch (e) {
    return "Не вдалося завантажити ринкові дані.";
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { BOT_TOKEN, GEMINI_API_KEY } = process.env;
  if (!BOT_TOKEN || !GEMINI_API_KEY) {
    return res.status(500).json({ error: "Не задано змінні середовища на сервері" });
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const { asset, images } = body;

  if (!Array.isArray(images) || images.length !== 3) {
    return res.status(400).json({ error: "Потрібно рівно 3 скріншоти" });
  }

  const selectedAsset = asset || "BTC";
  const deepMarketContext = await fetchDeepMarketData(selectedAsset);
  const labels = ["Старший ТФ (1W/1D)", "Середній ТФ (1D/4H)", "Робочий ТФ (4H)"];
  
  const contentParts = [
    { type: "text", text: SYSTEM_PROMPT + `\n\nАктив: ${selectedAsset}\nДані Binance: ${deepMarketContext}\nСформуй розгорнутий аналіз із журналом угод та чіткими рівнями Entry, Stop, Take.` }
  ];

  images.forEach((data, i) => {
    let mimeType = "image/jpeg";
    if (data.startsWith("iVBORw0KGgo")) mimeType = "image/png";
    else if (data.startsWith("UklGR")) mimeType = "image/webp";

    contentParts.push({ type: "text", text: `Скріншот ${i + 1}: ${labels[i]}` });
    contentParts.push({ type: "image_url", image_url: { url: `data:${mimeType};base64,${data}` } });
  });

  try {
    const r = await fetch("https://anymodel.org/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GEMINI_API_KEY}`
      },
      body: JSON.stringify({
        model: "ag/gemini-3-flash",
        messages: [{ role: "user", content: contentParts }],
        temperature: 0.3,
        max_tokens: 8192
      }),
    });

    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data?.error?.message || "Помилка API" });

    const text = data.choices?.[0]?.message?.content || "";
    return res.status(200).json({ result: text });
  } catch (e) {
    return res.status(500).json({ error: "Помилка сервера: " + e.message });
  }
};
