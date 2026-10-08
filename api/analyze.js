// Vercel Serverless Function (Node 18+)
const crypto = require("crypto");

const SYSTEM_PROMPT = `Ти — досвідчений професійний свінг-трейдер (Smart Money Concepts: CHoCH, BOS, OB, FVG, Premium/Discount, Equilibrium, ліквідність; Price Action) та макроаналітик. 
Користувач торгує СВІНГ (позиційно): тримає угоди від кількох днів до тижнів.
Надано:
1) Обраний актив та макроісторію за останні 100 денних свічок (1D: тренд, діапазон, динаміка).
2) Оперативні дані з біржі (Funding Rate, Open Interest зміни).
3) 3 скріншоти аналізу (Старший ТФ 1W/1D, Середній ТФ 1D/4H, Робочий ТФ 4H).

ПРАВИЛА ТОРГІВЛІ ТА РИЗИКУ:
- Рівні бери лише з того, що видно на скріншотах. Не вигадуй. Якщо скріншоти з інших активів або ціни не видно — bias "none".
- СВІНГ-ПІДХІД: Стоп-лос (stop) має ховатися за глобальними структурами старшого ТФ (1D / 1W), щоб захистити від ринкового шуму.
- Вхід (entry) — у якісній зоні старшого/середнього ТФ.
- Тейк-профіт автоматично рахується як співвідношення 1:2 відносно свінг-стопу.
- ОБОВ'ЯЗКОВО поєднуй технічний аналіз зі скріншотів з макроісторією 1D (тренд 100 днів) та ринковими даними (Фандинг).
- Пиши українською, розгорнуто та професійно у валідному JSON.

ВІДПОВІДЬ — ЛИШЕ JSON без markdown і без тексту навколо:
{"asset":"BTC","bias":"long|short|none","summary":"до 350 символів: свінг-контекст, тренд за 100 днів 1D, вплив фандингу та головна ідея угоди","zones":[{"side":"buy|sell","from":0,"to":0,"type":"OB/FVG/ліквідність тощо","why":"до 80 символів"}],"scenarios":[{"name":"А: назва сценарію","pct":50,"text":"до 120 символів"},{"name":"Б: ...","pct":30,"text":"..."},{"name":"В: ...","pct":20,"text":"..."}],"factors":["до 120 символів: техніка, історія 1D, фандинг"],"order":{"entry":null,"stop":null,"note":"до 120 символів: умова входу та обґрунтування свінг-стопу"}}
Сума pct = 100. Максимум 4 зони. Числа — числами, не рядками.`;

// Потужна функція збору макроданих та історії 1D (100 свічок) з Binance
async function fetchDeepMarketData(assetSymbol = "BTC") {
  try {
    const symbol = (assetSymbol || "BTC").toUpperCase() + "USDT";
    
    // Паралельні запити: фандинг, тікер за 24г, та історія 1D свічок (100 штук)
    const [fundingRes, tickerRes, klinesRes] = await Promise.all([
      fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`).catch(() => null),
      fetch(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${symbol}`).catch(() => null),
      fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=100`).catch(() => null)
    ]);

    let report = `Актив: ${symbol}. Дані з ринку обмежені.`;
    
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
          const firstOpen = parseFloat(klines[0][1]);
          const lastClose = parseFloat(klines[klines.length - 1][4]);
          const change100d = (((lastClose - firstOpen) / firstOpen) * 100).toFixed(2);
          
          klineSummary = `Історія 1D (100 свічок): Максимум періоду: ${high100}, Мінімум періоду: ${low100}, Зміна за 100 днів: ${change100d}%. Поточна ціна близько ${lastClose}.`;
        }
      }

      report = `Актив: ${symbol}, Поточна ціна: ${ticker.lastPrice}, Зміна 24г: ${ticker.priceChangePercent}%, Ставка фінансування (Funding): ${fundingRatePct}%. ${klineSummary}`;
    }
    return report;
  } catch (e) {
    return "Не вдалося завантажити розширені ринкові дані.";
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
  for (const img of images) {
    if (typeof img !== "string" || !/^[A-Za-z0-9+/=]+$/.test(img) || img.length > 1_400_000) {
      return res.status(400).json({ error: "Некоректне або завелике зображення" });
    }
  }

  // Отримуємо глибокі ринкові дані по обраній монеті (напр. BTC, ETH тощо)
  const selectedAsset = asset || "BTC";
  const deepMarketContext = await fetchDeepMarketData(selectedAsset);

  const labels = ["Старший ТФ (1W/1D)", "Середній ТФ (1D/4H)", "Робочий ТФ (4H)"];
  
  const contentParts = [
    { type: "text", text: SYSTEM_PROMPT + `\n\nОбраний користувачем актив: ${selectedAsset}\nМакроекономічні та історичні дані 1D (100 свічок) з Binance: ${deepMarketContext}\nСьогодні ${new Date().toISOString().slice(0, 10)}. Проаналізуй зв'язку цих скріншотів з урахуванням свінг-підходу та макроісторії і дай розширену відповідь у валідному JSON.` }
  ];

  images.forEach((data, i) => {
    contentParts.push({ type: "text", text: `Скріншот ${i + 1}: ${labels[i]}` });
    contentParts.push({
      type: "image_url",
      image_url: {
        url: `data:image/jpeg;base64,${data}`
      }
    });
  });

  const url = "https://anymodel.org/v1/chat/completions";

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GEMINI_API_KEY}`
      },
      body: JSON.stringify({
        model: "ag/gem/3-flash", // або ваша поточна модельag/gemini-3-flash
        messages: [{ role: "user", content: contentParts }],
        temperature: 0.3,
        max_tokens: 8192
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      const msg = data?.error?.message || "Помилка API запиту";
      return res.status(r.status === 429 ? 429 : 502).json({ error: msg });
    }

    const text = data.choices?.[0]?.message?.content || "";
    if (!text) return res.status(502).json({ error: "Порожня відповідь моделі" });
    
    return res.status(200).json({ result: text });
  } catch (e) {
    return res.status(500).json({ error: "Помилка сервера: " + e.message });
  }
};
