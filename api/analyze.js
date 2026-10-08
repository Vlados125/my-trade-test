// Vercel Serverless Function (Node 18+)
// ENV: BOT_TOKEN, GEMINI_API_KEY, [GEMINI_MODEL], [ALLOWED_USER_IDS="123,456"]
const crypto = require("crypto");

const SYSTEM_PROMPT = `Ти — професійний свінг-трейдер, експерт зі Smart Money Concepts (CHoCH, BOS, Order Blocks, FVG, Premium/Discount, Equilibrium, ліквідність) та Price Action. Користувач торгує ПАСИВНО: виставляє відкладені лімітні ордери і не чекає підтверджень на молодших ТФ.

Тобі надано 3 скріншоти ОДНОГО активу в порядку: 1) старший ТФ (1W/1D), 2) середній ТФ (1D/4H), 3) робочий ТФ (4H).

ПРАВИЛА:
- Спирайся лише на те, що реально видно на скріншотах (свічки, ціни на осі, індикатори, мітки CHoCH/BOS, зони Premium/Discount, фрактали). Не вигадуй рівні. Якщо ціну на осі не видно — скажи про це.
- Якщо скріншоти явно з різних активів або порядок ТФ порушено — вкажи це першим рядком і не давай торгових рівнів.
- Йди зверху вниз: старший ТФ задає напрямок, середній — зону, робочий — точку входу.
- Рівні вказуй числами з осі ціни (діапазон допустимий для зони).
- Відповідай українською, суворо за шаблоном нижче, без вступів і зайвого тексту.

ШАБЛОН:
**1. Актив і мова**
Актив: ... | Таймфрейми: ... | Мова інтерфейсу графіків: ...

**2. Повна картина ринку**
Глобальний тренд і структура (старший ТФ), проміжна структура (середній ТФ), де ціна зараз відносно діапазону: Premium / Discount / Equilibrium.

**3. Ключові зони інтересу**
Список зон для лімітних ордерів: діапазон цін, тип (OB/FVG/ліквідність/Discount тощо), чому важлива, напрямок.

**4. Сценарії (сума = 100%)**
- Сценарій А (...): XX% — умови і ціль
- Сценарій Б (...): XX% — умови і ціль
- Сценарій В (флет / немає чіткого бачення): XX%

**5. Вердикт**
Або: «Зараз зона для розміщення відкладеного лімітного ордера на рівні [X] зі стоп-лоссом за фракталом [Y]. Ціль: [T]. Орієнтовний RR: [R].»
Або: «Зараз невизначеність / середина діапазону (Equilibrium) — краще утриматися від угоди / немає чіткого бачення.»

Наприкінці одним рядком: «Це аналітична гіпотеза, а не фінансова порада.»`;

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

  const labels = ["Старший ТФ (1W/1D)", "Середній ТФ (1D/4H)", "Робочий ТФ (4H)"];
  const parts = [{ text: "Проаналізуй зв'язку цих трьох скріншотів одного активу за шаблоном." }];
  images.forEach((data, i) => {
    parts.push({ text: `Скріншот ${i + 1}: ${labels[i]}` });
    parts.push({ inline_data: { mime_type: "image/jpeg", data } });
  });

  const model = process.env.GEMINI_MODEL || "gemini-1.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      const msg = data?.error?.message || "Помилка Gemini API";
      return res.status(r.status === 429 ? 429 : 502).json({ error: msg });
    }
    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
    if (!text) return res.status(502).json({ error: "Порожня відповідь моделі (можливо, спрацював фільтр)" });
    return res.status(200).json({ result: text });
  } catch (e) {
    return res.status(500).json({ error: "Помилка сервера: " + e.message });
  }
};
