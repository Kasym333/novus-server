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

/* ============ ОБЫЧНЫЙ ЧАТ (с автоматическим поиском) ============ */
app.post('/api/chat', async (req, res) => {
  try {
    const { message, nickname } = req.body;
    if (!message) return res.status(400).json({ error: 'Пустое сообщение' });
    
    const hint = nickname ? `\nПользователя зовут ${nickname}.` : '';

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}` 
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: PROMPT + hint },
          { role: 'user', content: message }
        ],
        temperature: 0.5, 
        max_tokens: 2048,
        // 🔍 Включаем инструмент автоматического поиска в интернете
        tools: [{ type: 'browser_search' }]
      })
    });
    
    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: data.error?.message || 'Ошибка Groq' });
    res.json({ reply: data.choices[0].message.content });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка: ' + e.message });
  }
});

/* ============ ПОИСК В ИНТЕРНЕТЕ (ручной) ============ */
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

    const aiRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: 'Ты — Novus_Куёвус с доступом к свежим данным из интернета. Отвечай на основе результатов поиска, кратко.' },
          { role: 'user', content: `Запрос: ${query}\n\nДанные из поиска:\n${webContext}` }
        ],
        temperature: 0.3, max_tokens: 1500
      })
    });
    const aiData = await aiRes.json();
    if (!aiRes.ok) return res.status(500).json({ error: aiData.error?.message || 'Ошибка Groq' });
    res.json({ reply: aiData.choices[0].message.content });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка поиска: ' + e.message });
  }
});

/* ============ УМНЫЙ ПРОМПТ: ПОИСК + ПЕРЕВОД ДЛЯ КАРТИНОК ============ */
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

    const aiRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [
          {
            role: 'system',
            content: `Ты — эксперт по промптам для AI-генераторов картинок (Stable Diffusion, Flux, Midjourney).
Пользователь просит нарисовать что-то. Тебе дают данные из интернета о том, что это.
Создай ОДИН максимально точный английский промпт.
ПРАВИЛА:
1. Отвечай ТОЛЬКО английским текстом промпта. Без кавычек, без объяснений.
2. Максимум 40-50 слов.
3. Если это персонаж/игра/фильм — используй ТОЧНЫЕ детали внешности (цвет, форма, одежда, стиль).
4. Обязательно добавляй: "highly detailed", "cinematic lighting", "8k", "professional", "masterpiece".
5. Указывай стиль: "digital art", "photorealistic", "anime style", "horror poster", "3d render".
6. Если это FNAF/игра — описывай конкретных персонажей.
7. Не выдумывай — используй данные из интернета.`
          },
          {
            role: 'user',
            content: webContext
              ? `Запрос: ${prompt}\n\nДанные из интернета: ${webContext}`
              : `Запрос: ${prompt}`
          }
        ],
        temperature: 0.5,
        max_tokens: 200
      })
    });

    const aiData = await aiRes.json();
    if (!aiRes.ok) return res.status(500).json({ error: aiData.error?.message || 'Ошибка Groq' });

    let englishPrompt = aiData.choices[0].message.content.trim().replace(/^["']|["']$/g, '');
    res.json({ englishPrompt, usedWebSearch: webContext.length > 0 });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка перевода: ' + e.message });
  }
});

app.listen(PORT, () => {
  console.log('Сервер запущен на порту ' + PORT);
});
