import express from 'express';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

const PROMPT = `
Ты — Novus_Куёвус, топовый senior-разработчик и эксперт по всем языкам программирования.
ПРАВИЛА:
1. Отвечай кратко, точно, по делу.
2. Давай рабочий код с комментариями.
3. Указывай язык в блоке кода.
4. Если не знаешь — честно скажи.
5. Пиши на русском, код — на английском.
6. Эмодзи 0–2 на сообщение.
`;

// 🔄 Список бесплатных моделей OpenRouter для fallback
const OPENROUTER_FREE_MODELS = [
  'deepseek/deepseek-r1:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemini-2.0-flash-exp:free',
  'qwen/qwen3-coder:free',
  'mistralai/mistral-7b-instruct:free'
];

// ============ ФУНКЦИЯ ВЫЗОВА ЧЕРЕЗ GROQ ============
async function callGroq(messages, temperature = 0.5, max_tokens = 2048) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b',
      messages,
      temperature,
      max_tokens,
      tools: [{ type: 'browser_search' }]
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Ошибка Groq');
  return { reply: data.choices[0].message.content, provider: 'Groq' };
}

// ============ ФУНКЦИЯ ВЫЗОВА ЧЕРЕЗ OPENROUTER ============
async function callOpenRouter(messages, temperature = 0.5, max_tokens = 2048) {
  // Пробуем модели по очереди, пока одна не ответит
  for (const model of OPENROUTER_FREE_MODELS) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'https://novus-server-0vtv.onrender.com',
          'X-Title': 'Novus_Kuevus'
        },
        body: JSON.stringify({ model, messages, temperature, max_tokens })
      });
      const data = await res.json();
      if (res.ok) {
        return { reply: data.choices[0].message.content, provider: `OpenRouter (${model})` };
      }
      console.warn(`OpenRouter ${model} не сработал:`, data.error?.message);
    } catch (e) {
      console.warn(`OpenRouter ${model} упал:`, e.message);
    }
  }
  throw new Error('Все бесплатные модели OpenRouter недоступны');
}

// ============ УМНЫЙ РОУТИНГ: Groq → OpenRouter ============
async function smartChat(messages, temperature = 0.5, max_tokens = 2048) {
  // 1. Сначала пробуем Groq
  try {
    return await callGroq(messages, temperature, max_tokens);
  } catch (e) {
    console.warn('Groq не сработал, переключаюсь на OpenRouter:', e.message);
  }
  // 2. Если Groq упал — пробуем OpenRouter
  return await callOpenRouter(messages, temperature, max_tokens);
}

/* ============ ОБЫЧНЫЙ ЧАТ ============ */
app.post('/api/chat', async (req, res) => {
  try {
    const { message, nickname } = req.body;
    if (!message) return res.status(400).json({ error: 'Пустое сообщение' });
    
    const hint = nickname ? `\nПользователя зовут ${nickname}.` : '';

    const result = await smartChat([
      { role: 'system', content: PROMPT + hint },
      { role: 'user', content: message }
    ]);

    res.json({ reply: result.reply, provider: result.provider });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка: ' + e.message });
  }
});

/* ============ ПОИСК В ИНТЕРНЕТЕ ============ */
app.post('/api/search', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'Пустой запрос' });
    let webContext = '';
    try {
      const ddgRes = await fetch('https://api.duckduckgo.com/?q=' + encodeURIComponent(query) + '&format=json&no_html=1&skip_disambig=1');
      const ddgData = await ddgRes.json();
      const parts = [];
      if (ddgData.AbstractText) parts.push('Кратко: ' + ddgData.AbstractText);
      if (ddgData.Answer) parts.push('Ответ: ' + ddgData.Answer);
      if (ddgData.RelatedTopics) {
        ddgData.RelatedTopics.slice(0, 5).forEach(t => { if (t.Text) parts.push('- ' + t.Text); });
      }
      webContext = parts.join('\n') || 'В интернете прямых данных не найдено.';
    } catch (e) { webContext = 'Не удалось получить данные.'; }

    const result = await smartChat([
      { role: 'system', content: 'Ты — Novus_Куёвус с доступом к свежим данным из интернета. Отвечай на основе результатов поиска, кратко.' },
      { role: 'user', content: `Запрос: ${query}\n\nДанные из поиска:\n${webContext}` }
    ], 0.3, 1500);

    res.json({ reply: result.reply, provider: result.provider });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка поиска: ' + e.message });
  }
});

/* ============ УМНЫЙ ПРОМПТ ДЛЯ КАРТИНОК ============ */
app.post('/api/translate', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Пустой промпт' });

    let webContext = '';
    try {
      const ddgRes = await fetch(
        'https://api.duckduckgo.com/?q=' + encodeURIComponent(prompt) + '&format=json&no_html=1&skip_disambig=1'
      );
      const ddgData = await ddgRes.json();
      const parts = [];
      if (ddgData.AbstractText) parts.push(ddgData.AbstractText);
      if (ddgData.RelatedTopics) {
        ddgData.RelatedTopics.slice(0, 5).forEach(t => { if (t.Text) parts.push(t.Text); });
      }
      webContext = parts.join(' ').slice(0, 1000);
    } catch (e) {}

    const systemPrompt = `Ты — эксперт по промптам для AI-генераторов картинок (Stable Diffusion, Flux, Midjourney).
Пользователь просит нарисовать что-то. Тебе дают данные из интернета о том, что это.
Создай ОДИН максимально точный английский промпт.
ПРАВИЛА:
1. Отвечай ТОЛЬКО английским текстом промпта. Без кавычек, без объяснений.
2. Максимум 40-50 слов.
3. Если это персонаж/игра/фильм — используй ТОЧНЫЕ детали внешности.
4. Обязательно добавляй: "highly detailed", "cinematic lighting", "8k", "professional", "masterpiece".
5. Указывай стиль: "digital art", "photorealistic", "anime style", "horror poster", "3d render".
6. Не выдумывай — используй данные из интернета.`;

    const userContent = webContext
      ? `Запрос: ${prompt}\n\nДанные из интернета: ${webContext}`
      : `Запрос: ${prompt}`;

    const result = await smartChat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ], 0.5, 200);

    let englishPrompt = result.reply.trim().replace(/^["']|["']$/g, '');
    res.json({ englishPrompt, usedWebSearch: webContext.length > 0, provider: result.provider });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка перевода: ' + e.message });
  }
});

app.listen(PORT, () => {
  console.log('Сервер запущен на порту ' + PORT);
});
