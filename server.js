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

const DEFAULT_PROMPT = 'Ты — Novus_Куёвус, senior-разработчик и эксперт по всем языкам программирования. Отвечай кратко, по делу. Давай рабочий код с комментариями. Пиши на русском, код — на английском.';

const OPENROUTER_FREE_MODELS = [
  'deepseek/deepseek-r1:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemini-2.0-flash-exp:free'
];

async function callGroq(messages, temperature, maxTokens, model, useSearch) {
  const body = {
    model: model || 'openai/gpt-oss-120b',
    messages: messages,
    temperature: temperature || 0.5,
    max_tokens: maxTokens || 2048
  };
  if (useSearch) body.tools = [{ type: 'browser_search' }];

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + process.env.GROQ_API_KEY
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ? data.error.message : 'Groq error');
  return data.choices[0].message.content;
}

async function callOpenRouter(messages, temperature, maxTokens) {
  for (const model of OPENROUTER_FREE_MODELS) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + process.env.OPENROUTER_API_KEY,
          'HTTP-Referer': 'https://novus-server-0vtv.onrender.com',
          'X-Title': 'Novus_Kuevus'
        },
        body: JSON.stringify({
          model: model,
          messages: messages,
          temperature: temperature || 0.5,
          max_tokens: maxTokens || 2048
        })
      });
      const data = await res.json();
      if (res.ok) return data.choices[0].message.content;
    } catch (e) {}
  }
  throw new Error('OpenRouter недоступен');
}

app.post('/api/chat', async (req, res) => {
  try {
    const body = req.body || {};
    const message = body.message;
    const nickname = body.nickname;
    const customPrompt = body.customPrompt;
    const model = body.model;
    const temperature = body.temperature;
    const maxTokens = body.maxTokens;
    const image = body.image;

    if (!message && !image) return res.status(400).json({ error: 'Пустое сообщение' });

    const basePrompt = customPrompt || DEFAULT_PROMPT;
    const hint = nickname ? ('\nПользователя зовут ' + nickname + '.') : '';
    const messages = [{ role: 'system', content: basePrompt + hint }];

    // Фото → vision
    if (image) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: message || 'Опиши изображение' },
          { type: 'image_url', image_url: { url: image } }
        ]
      });
      const vRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + process.env.GROQ_API_KEY
        },
        body: JSON.stringify({
          model: 'meta-llama/llama-4-scout-17b-16e-instruct',
          messages: messages,
          temperature: 0.5,
          max_tokens: 1024
        })
      });
      const vData = await vRes.json();
      if (!vRes.ok) return res.status(500).json({ error: vData.error ? vData.error.message : 'Vision error' });
      return res.json({ reply: vData.choices[0].message.content });
    }

    messages.push({ role: 'user', content: message });

    let reply;
    try {
      reply = await callGroq(messages, temperature, maxTokens, model, true);
    } catch (e) {
      console.warn('Groq упал:', e.message);
      reply = await callOpenRouter(messages, temperature, maxTokens);
    }
    res.json({ reply: reply });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка: ' + e.message });
  }
});

app.post('/api/search', async (req, res) => {
  try {
    const body = req.body || {};
    const query = body.query;
    if (!query) return res.status(400).json({ error: 'Пустой запрос' });

    let webContext = '';
    try {
      const ddgRes = await fetch('https://api.duckduckgo.com/?q=' + encodeURIComponent(query) + '&format=json&no_html=1&skip_disambig=1');
      const ddgData = await ddgRes.json();
      const parts = [];
      if (ddgData.AbstractText) parts.push(ddgData.AbstractText);
      if (ddgData.RelatedTopics) {
        ddgData.RelatedTopics.slice(0, 5).forEach(function(t) {
          if (t.Text) parts.push(t.Text);
        });
      }
      webContext = parts.join(' ') || 'Нет данных';
    } catch (e) {
      webContext = 'Ошибка поиска';
    }

    const messages = [
      { role: 'system', content: 'Ты — Novus_Куёвус. Отвечай на основе данных поиска, кратко.' },
      { role: 'user', content: 'Запрос: ' + query + '\n\nДанные: ' + webContext }
    ];
    const reply = await callGroq(messages, 0.3, 1500, 'openai/gpt-oss-120b', false);
    res.json({ reply: reply });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка поиска: ' + e.message });
  }
});

app.post('/api/translate', async (req, res) => {
  try {
    const body = req.body || {};
    const prompt = body.prompt;
    if (!prompt) return res.status(400).json({ error: 'Пустой промпт' });

    const messages = [
      { role: 'system', content: 'Ты переводишь запросы в английские промпты для AI-генераторов. Отвечай ТОЛЬКО английским текстом промпта, до 40 слов. Добавляй: highly detailed, cinematic lighting, 8k, masterpiece.' },
      { role: 'user', content: prompt }
    ];
    const reply = await callGroq(messages, 0.5, 200, 'openai/gpt-oss-120b', false);
    const cleaned = reply.trim().replace(/^["']|["']$/g, '');
    res.json({ englishPrompt: cleaned });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка перевода: ' + e.message });
  }
});

app.listen(PORT, function() {
  console.log('Сервер запущен на порту ' + PORT);
});
