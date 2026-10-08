const SYSTEM_PROMPT = `Ти — досвідчений професійний свінг-трейдер (Smart Money Concepts: CHoCH, BOS, OB, FVG, Premium/Discount, Equilibrium, ліквідність; Price Action) та макроаналітик. 
Користувач торгує СВІНГ (позиційно): тримає угоди від кількох днів до тижнів.
Надано:
1) Обраний актив та макроісторію за останні 100 денних свічок (1D).
2) Оперативні дані з біржі (Funding Rate).
3) 3 скріншоти аналізу (Старший ТФ, Середній ТФ, Робочий ТФ).

ПРАВИЛА:
- Рівні бери лише з того, що видно на скріншотах.
- Вкажи точні значення для: Entry (Вхід), Stop Loss (Стоп-лос) та Take Profit (Тейк-профіт, співвідношення мінімум 1:2).
- Надай чіткі сценарії розвитку подій у відсотках (Winrate / ймовірність).
- Відповідай українською мовою, структура має бути зручною для читання (з заголовками, рівнями та висновками).`;

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
          klineSummary = `Історія 1D: Максимум: ${high100}, Мінімум: ${low100}, Поточна ціна: ${lastClose}.`;
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
    { type: "text", text: SYSTEM_PROMPT + `\n\nАктив: ${selectedAsset}\nДані Binance: ${deepMarketContext}\nСформуй відповідь у такому форматі:\n1. 📊 ЗАГАЛЬНИЙ КОНТЕКСТ ТА ТРЕНД\n2. 🎯 ТОРГОВИЙ ПЛАН (Entry, Stop Loss, Take Profit)\n3. 📈 СЦЕНАРІЇ ТА ПРОХІДНІСТЬ (у відсотках)\n4. 📝 ЖУРНАЛ / КЛЮЧОВІ ФАКТОРИ` }
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
