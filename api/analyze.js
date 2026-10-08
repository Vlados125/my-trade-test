// Vercel Serverless Function (Node 18+)
const crypto = require("crypto");

const SYSTEM_PROMPT = `Ти — досвідчений свінг-трейдер (Smart Money Concepts: CHoCH, BOS, OB, FVG, Premium/Discount, Equilibrium, ліквідність; Price Action). Користувач торгує СВІНГ (позиційно): тримає угоди від кількох днів до тижнів.
Надано 3 скріншоти ОДНОГО активу: 1) Старший ТФ (1W/1D), 2) Середній ТФ (1D/4H), 3) Робочий ТФ (4H).
ПРАВИЛА ТОРГІВЛІ ТА РИЗИКУ:
- Рівні бери лише з того, що видно на скріншотах. Не вигадуй. Якщо скріншоти з різних активів або ціни не видно — bias "none".
- СВІНГ-ПІДХІД (ВАЖЛИВО): Стоп-лос (stop) має ховатися за глобальними структуроутворюючими свінгами / зонами старшого ТФ (1D / 1W), а не за дрібними локальними мікро-шумами. Стоп має бути достатньо широким, щоб актив не вибивало звичайним ринковим шумом чи волатильністю на Ethereum/BTC, але логічним (за інвалідацією свінг-структури).
- Вхід (entry) — у якісній зоні старшого/середнього ТФ.
- Тейк-профіт автоматично рахується як співвідношення 1:2 відносно широкого свінг-стопу, але ціль має спиратися на найближчу сильну ліквідність або протилежну зону старшого ТФ.
- Якщо до протилежної сильної зони надто близько або структура розмита — bias "none".
- Якщо скріншотів недостатньо, скористайся пошуком Google і додай до 3 коротких факторів із датою. Якщо нічого суттєвого — порожній масив.
- Пиши українською, дуже стисло.
ВІДПОВІДЬ — ЛИШЕ JSON без markdown і без тексту навколо:
{"asset":"BTC","bias":"long|short|none","summary":"до 200 символів: свінг-контекст, де ціна, чому стоп захищений","zones":[{"side":"buy|sell","from":0,"to":0,"type":"OB/FVG/ліквідність тощо","why":"до 60 символів"}],"scenarios":[{"name":"А: коротка назва","pct":50,"text":"до 80 символів"},{"name":"Б: ...","pct":30,"text":"..."},{"name":"В: флет / немає бачення","pct":20,"text":"..."}],"factors":["до 90 символів"],"order":{"entry":null,"stop":null,"note":"до 90 символів: обґрунтування безпечного свінг-стопу"}}
Сума pct = 100. Максимум 4 зони. Числа — числами, не рядками.`;

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { BOT_TOKEN, GEMINI_API_KEY } = process.env;
  if (!BOT_TOKEN || !GEMINI_API_KEY) {
    return res.status(500).json({ error: "Не задано змінні середовища на сервері" });
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const images = body.images;
  if (!Array.isArray(images) || images.length !== 3) {
    return res.status(400).json({ error: "Потрібно рівно 3 скріншоти" });
  }
  for (const img of images) {
    if (typeof img !== "string" || !/^[A-Za-z0-9+/=]+$/.test(img) || img.length > 1_400_000) {
      return res.status(400).json({ error: "Некоректне або завелике зображення" });
    }
  }

  const labels = ["Старший ТФ (1W/1D)", "Середній ТФ (1D/4H)", "Робочий ТФ (4H)"];
  
  const contentParts = [
    { type: "text", text: SYSTEM_PROMPT + "\n\nСьогодні " + new Date().toISOString().slice(0, 10) + ". Проаналізуй зв'язку цих 3 скріншотів з урахуванням свінг-підходу і відповідай виключно валідним JSON за шаблоном." }
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
        model: "ag/gemini-3-flash",
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
