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

const DEFAULT_PROMPT = `Ты — Novus, умный и дружелюбный ассистент, свободно говоришь на русском языке.

ЯЗЫК И ПОНИМАНИЕ:
- Пиши грамотным, живым русским языком, без ошибок и кальки с английского.
- Понимаешь сленг, мат, опечатки, сокращения и разговорную речь. Если пользователь написал с ошибками — пойми суть и ответь нормально.
- Понимаешь украинский, белорусский, английский — отвечай на языке пользователя.
- Не переспрашивай очевидное. Если смысл ясен — отвечай.
- Знай реалии: историю, культуру, быт, мемы, интернет-сленг русскоязычного мира.

ПРАВИЛА:
1. Отвечай по делу, без воды.
2. Если просят код — давай рабочий код с кратким пояснением.
3. Если не знаешь — честно скажи, не выдумывай.
4. Не читай морали без причины.
5. Держи контекст беседы.
6. Будь вежливым, но без подхалимства.`;

const ALLOWED_MODELS = [
  'openai/gpt-oss-120b',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'qwen/qwen3-32b',
  'moonshotai/kimi-k2-instruct'
];

const OPENROUTER_FALLBACK = [
  'deepseek/deepseek-r1:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemini-2.0-flash-exp:free',
  'qwen/qwen3-coder:free'
];

function pickModel(requested) {
  if (requested && ALLOWED_MODELS.includes(requested)) return requested;
  return 'openai/gpt-oss-120b';
}

async function callGroq(messages, temperature, maxTokens, model, useSearch) {
  const body = {
    model: model,
    messages: messages,
    temperature: temperature ?? 0.6,
    max_tokens: maxTokens ?? 2048
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
  for (const model of OPENROUTER_FALLBACK) {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + process.env.OPENROUTER_API_KEY,
          'HTTP-Referer': 'https://novus-server-0vtv.onrender.com',
          'X-Title': 'Novus'
        },
        body: JSON.stringify({
          model: model,
          messages: messages,
          temperature: temperature ?? 0.6,
          max_tokens: maxTokens ?? 2048
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
    const model = pickModel(body.model);
    const temperature = body.temperature;
    const maxTokens = body.maxTokens;
    const image = body.image;

    if (!message && !image) return res.status(400).json({ error: 'Пустое сообщение' });

    const basePrompt = customPrompt || DEFAULT_PROMPT;
    const hint = nickname ? ('\nПользователя зовут ' + nickname + '.') : '';
    const messages = [{ role: 'system', content: basePrompt + hint }];

    if (image) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: message || 'Опиши изображение подробно' },
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
      console.warn('Groq не сработал:', e.message);
      reply = await callOpenRouter(messages, temperature, maxTokens);
    }
    res.json({ reply: reply, model: model });
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
      { role: 'system', content: 'Ты — Novus. Отвечай на русском на основе данных поиска. Кратко, по делу.' },
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
