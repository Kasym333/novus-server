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

const OPENROUTER_FREE_MODELS = [
  'deepseek/deepseek-r1:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemini-2.0-flash-exp:free',
  'qwen/qwen3-coder:free'
];

async function callGroq(messages, temperature = 0.5, max_tokens = 2048, useSearch = true) {
  const body = { model: 'openai/gpt-oss-120b', messages, temperature, max_tokens };
  if (useSearch) body.tools = [{ type: 'browser_search' }];

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Ошибка Groq');
  return { reply: data.choices[0].message.content, provider: 'Groq' };
}

async function callOpenRouter(messages, temperature = 0.5, max_tokens = 2048) {
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
      if (res.ok) return { reply: data.choices[0].message.content, provider: `OpenRouter (${model})` };
    } catch (e) {}
  }
  throw new Error('Все модели OpenRouter недоступны');
}

async function smartChat(messages, temperature = 0.5, max_tokens = 2048, useSearch = true) {
  try {
    return await callGroq(messages, temperature, max_tokens, useSearch);
  } catch (e) {
    console.warn('Groq упал, переключаюсь:', e.message);
  }
  return await callOpenRouter(messages, temperature, max_tokens);
}

/* ============ ЧАТ (с фото + памятью) ============ */
app.post('/api/chat', async (req, res) => {
  try {
    const { message, nickname, summary, history, image } = req.body;
    if (!message && !image) return res.status(400).json({ error: 'Пустое сообщение' });

    const hint = nickname ? `\nПользователя зовут ${nickname}.` : '';
    const summaryBlock = summary ? `\n\n[КРАТКАЯ СВОДКА ПРОШЛОЙ БЕСЕДЫ]\n${summary}\n[КОНЕЦ СВОДКИ]` : '';

    const msgs = [{ role: 'system', content: PROMPT + hint + summaryBlock }];

    if (Array.isArray(history)) {
      history.forEach(h => {
        if (h.role && h.content) msgs.push({ role: h.role, content: h.content });
      });
    }

    // 🖼 Если есть фото — vision
    if (image) {
      const visionMsgs = [
        ...msgs,
        {
          role: 'user',
          content: [
            { type: 'text', text: message || 'Опиши изображение.' },
            { type: 'image_url', image_url: { url: image } }
          ]
        }
      ];

      const visionRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: 'meta-llama/llama-4-scout-17b-16e-instruct',
          messages: visionMsgs,
          temperature: 0.5,
          max_tokens: 1024
        })
      });
      const vData = await visionRes.json();
      if (!visionRes.ok) return res.status(500).json({ error: vData.error?.message || 'Ошибка vision' });
      return res.json({ reply: vData.choices[0].message.content, provider: 'Groq Vision' });
    }

    msgs.push({ role: 'user', content: message });
    const result = await smartChat(msgs, 0.5, 2048, true);
    res.json({ reply: result.reply, provider: result.provider });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка: ' + e.message });
  }
});

/* ============ СВОДКА ============ */
app.post('/api/summary', async (req, res) => {
  try {
    const { oldSummary, messages } = req.body;
    if (!Array.isArray(messages) || !messages.length) {
      return res.json({ summary: oldSummary || '' });
    }
    let dialog = '';
    messages.forEach(m => {
      if (m.type === 'image') dialog += `[картинка]\n`;
      else dialog += `${m.role === 'user' ? 'Пользователь' : 'ИИ'}: ${m.content}\n`;
    });
    const prompt = `Сожми переписку в краткую сводку (до 300 слов). Сохрани факты, темы, имена. Убери воду.
${oldSummary ? `\n[Предыдущая сводка]\n${oldSummary}\n` : ''}

Переписка:
${dialog}

Верни только текст сводки.`;

    const result = await smartChat([{ role: 'user', content: prompt }], 0.3, 800, false);
    res.json({ summary: result.reply.trim() });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сводки: ' + e.message });
  }
});

/* ============ ПОИСК ============ */
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
      { role: 'system', content: 'Ты — Novus_Куёвус. Отвечай на основе результатов поиска, кратко.' },
      { role: 'user', content: `Запрос: ${query}\n\nДанные:\n${webContext}` }
    ], 0.3, 1500, false);

    res.json({ reply: result.reply, provider: result.provider });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка поиска: ' + e.message });
  }
});

/* ============ ПЕРЕВОД ДЛЯ КАРТИНОК ============ */
app.post('/api/translate', async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Пустой промпт' });

    let webContext = '';
    try {
      const ddgRes = await fetch('https://api.duckduckgo.com/?q=' + encodeURIComponent(prompt) + '&format=json&no_html=1&skip_disambig=1');
      const ddgData = await ddgRes.json();
      const parts = [];
      if (ddgData.AbstractText) parts.push(ddgData.AbstractText);
      if (ddgData.RelatedTopics) ddgData.RelatedTopics.slice(0, 5).forEach(t => { if (t.Text) parts.push(t.Text); });
      webContext = parts.join(' ').slice(0, 1000);
    } catch (e) {}

    const sysPrompt = `Ты — эксперт по промптам для AI-генераторов картинок.
Создай ОДИН точный английский промпт (макс 40-50 слов).
ПРАВИЛА:
1. Только английский текст, без кавычек.
2. Добавляй: "highly detailed", "cinematic lighting", "8k", "masterpiece".
3. Стиль: "digital art", "photorealistic", "anime style", "horror poster".
4. Если персонаж/игра — точные детали внешности.
5. Не выдумывай — используй данные из интернета.`;

    const userContent = webContext
      ? `Запрос: ${prompt}\n\nДанные: ${webContext}`
      : `Запрос: ${prompt}`;

    const result = await smartChat([
      { role: 'system', content: sysPrompt },
      { role: 'user', content: userContent }
    ], 0.5, 200, false);

    let englishPrompt = result.reply.trim().replace(/^["']|["']$/g, '');
    res.json({ englishPrompt, usedWebSearch: webContext.length > 0 });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка перевода: ' + e.message });
  }
});

app.listen(PORT, () => {
  console.log('Сервер запущен на порту ' + PORT);
});
