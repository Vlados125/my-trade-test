// Vercel Serverless Function (Node 18+)
// ENV: BOT_TOKEN, GEMINI_API_KEY, [ALLOWED_USER_IDS="123,456"]
const crypto = require("crypto");

const SYSTEM_PROMPT = `Ти — досвідчений свінг-трейдер (Smart Money Concepts: CHoCH, BOS, OB, FVG, Premium/Discount, Equilibrium, ліквідність; Price Action). Користувач торгує ПАСИВНО: ставить відкладені лімітні ордери, без підтверджень на молодших ТФ.
Надано 3 скріншоти ОДНОГО активу: 1) старший ТФ, 2) середній ТФ, 3) робочий ТФ (4H).
ПРАВИЛА:
- Рівні бери лише з того, що видно на скріншотах (ціни на осі, мітки, зони). Не вигадуй. Якщо скріншоти з різних активів або ціни не видно — bias "none" і поясни в summary.
- Старший ТФ задає напрямок, середній — зону, робочий — рівень входу.
- Вхід (entry) — всередині ключової зони, стоп (stop) — за фракталом/інвалідацією зони. Тейк НЕ потрібен: його рахує додаток за співвідношенням 1:2.
- Якщо до протилежної сильної зони менше 2R від входу, або ціна в середині діапазону (Equilibrium), або видимість слабка — bias "none".
- Якщо скріншотів недостатньо для висновку (новини, фандинг/OI, домінація BTC, макроподії FOMC/CPI, потоки ETF, події монети), скористайся пошуком Google і додай до 3 коротких факторів із датою. Якщо суттєвого нічого немає — порожній масив.
- Пиши українською, дуже стисло.
ВІДПОВІДЬ — ЛИШЕ JSON без markdown і без тексту навколо:
{"asset":"BTC","bias":"long|short|none","summary":"до 200 символів: тренд, де ціна в діапазоні, головна ідея","zones":[{"side":"buy|sell","from":0,"to":0,"type":"OB/FVG/ліквідність тощо","why":"до 60 символів"}],"scenarios":[{"name":"А: коротка назва","pct":50,"text":"до 80 символів"},{"name":"Б: ...","pct":30,"text":"..."},{"name":"В: флет / немає бачення","pct":20,"text":"..."}],"factors":["до 90 символів"],"order":{"entry":null,"stop":null,"note":"до 90 символів: умова входу або чому краще не торгувати"}}
Сума pct = 100. Максимум 4 зони. Числа — числами, не рядками.`;

function verifyInitData(initData, botToken) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheck = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const calc = crypto.createHmac("sha256", secret).update(dataCheck).digest("hex");
  const a = Buffer.from(calc, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const age = Date.now() / 1000 - Number(params.get("auth_date") || 0);
  if (age > 86400) return null;
  try {
    return JSON.parse(params.get("user") || "{}");
  } catch {
    return null;
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { BOT_TOKEN, GEMINI_API_KEY, ALLOWED_USER_IDS } = process.env;
  if (!BOT_TOKEN || !GEMINI_API_KEY) {
    return res.status(500).json({ error: "Не задано змінні середовища на сервері" });
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  const user = verifyInitData(body.initData, BOT_TOKEN);
  if (!user) return res.status(401).json({ error: "Відкрий додаток через Telegram" });

  if (ALLOWED_USER_IDS) {
    const allowed = ALLOWED_USER_IDS.split(",").map((s) => s.trim());
    if (!allowed.includes(String(user.id))) return res.status(403).json({ error: "Немає доступу" });
  }

  const images = body.images;
  if (!Array.isArray(images) || images.length !== 3) {
    return res.status(400).json({ error: "Потрібно рівно 3 скріншоти" });
  }
  for (const img of images) {
    if (typeof img !== "string" || !/^[A-Za-z0-9+/=]+$/.test(img) || img.length > 1_400_000) {
      return res.status(400).json({ error: "Некоректне або завелике зображення" });
    }
  }

  const labels = ["Старший ТФ", "Середній ТФ", "Робочий ТФ (4H)"];
  
  // Формуємо контент у форматі OpenAI Vision (з масивом об'єктів тексту та зображень)
  const contentParts = [
    { type: "text", text: SYSTEM_PROMPT + "\n\nСьогодні " + new Date().toISOString().slice(0, 10) + ". Проаналізуй зв'язку цих 3 скріншотів і відповідай виключно валідним JSON за шаблоном." }
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
        messages: [
          {
            role: "user",
            content: contentParts
          }
        ],
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
    if (!text) return res.status(502).json({ error: "Порожня відповідь моделі (можливо, спрацював фільтр)" });
    
    return res.status(200).json({ result: text });
  } catch (e) {
    return res.status(500).json({ error: "Помилка сервера: " + e.message });
  }
};
