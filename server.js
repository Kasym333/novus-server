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

const DEFAULT_PROMPT = `Ты — Novus, умный и дружелюбный ассистент. Отвечай грамотно, по делу, без воды. Понимаешь сленг и опечатки. Если просят код — давай рабочий код. Держи контекст беседы. Если у тебя есть доступ к поиску в интернете — используй его для свежих данных.`;

/* ============ GROQ ============ */
async function callGroq(messages, temp, maxT, model) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + process.env.GROQ_API_KEY
    },
    body: JSON.stringify({
      model: model || 'openai/gpt-oss-120b',
      messages: messages,
      temperature: temp || 0.6,
      max_tokens: maxT || 2048
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ? data.error.message : 'Groq error');
  return data.choices[0].message.content;
}

/* ============ GEMINI С ПОИСКОМ GOOGLE ============ */
async function callGemini(messages, temp, maxT, useSearch) {
  const systemMsg = messages.find(function(m) { return m.role === 'system'; });
  const chatMsgs = messages.filter(function(m) { return m.role !== 'system'; });

  const contents = chatMsgs.map(function(m) {
    return {
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    };
  });

  const body = {
    contents: contents,
    generationConfig: {
      temperature: temp || 0.6,
      maxOutputTokens: maxT || 2048
    }
  };

  if (systemMsg) {
    body.systemInstruction = { parts: [{ text: systemMsg.content }] };
  }

  // 🌐 ПОИСК GOOGLE — включён по умолчанию
  if (useSearch !== false) {
    body.tools = [{ googleSearch: {} }];
  }

  const res = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + process.env.GEMINI_API_KEY,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ? data.error.message : 'Gemini error');
  if (!data.candidates || !data.candidates[0]) throw new Error('Gemini: пустой ответ');

  // Извлекаем текст
  let text = '';
  try {
    text = data.candidates[0].content.parts.map(function(p) { return p.text || ''; }).join('');
  } catch (e) {
    throw new Error('Gemini: ошибка парсинга');
  }
  return text;
}

/* ============ OPENROUTER ============ */
async function callOpenRouter(messages, temp, maxT) {
  const models = [
    'deepseek/deepseek-r1:free',
    'meta-llama/llama-3.3-70b-instruct:free',
    'google/gemini-2.0-flash-exp:free'
  ];
  for (const model of models) {
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
          model: model, messages: messages,
          temperature: temp || 0.6, max_tokens: maxT || 2048
        })
      });
      const data = await res.json();
      if (res.ok) return data.choices[0].message.content;
    } catch (e) {}
  }
  throw new Error('OpenRouter failed');
}

/* ============ РОУТЕР ============ */
async function smartChat(messages, temp, maxT, model, useSearch) {
  // Gemini выбран вручную
  if (model === 'gemini') {
    console.log('🎯 Выбрана модель: Gemini (поиск: ' + (useSearch !== false) + ')');
    return { reply: await callGemini(messages, temp, maxT, useSearch), provider: 'Gemini' };
  }
  // OpenRouter выбран вручную
  if (model === 'openrouter') {
    console.log('🎯 Выбрана модель: OpenRouter');
    return { reply: await callOpenRouter(messages, temp, maxT), provider: 'OpenRouter' };
  }
  // Конкретная модель Groq
  if (model && model !== 'auto') {
    try {
      console.log('🎯 Выбрана модель Groq: ' + model);
      return { reply: await callGroq(messages, temp, maxT, model), provider: 'Groq' };
    } catch (e) {
      console.warn('Groq не сработал: ' + e.message);
    }
  }

  // 🌊 АВТО-КАСКАД: Groq → Gemini → OpenRouter
  const cascade = [
    { name: 'Groq', fn: function() { return callGroq(messages, temp, maxT); } },
    { name: 'Gemini', fn: function() { return callGemini(messages, temp, maxT, useSearch); } },
    { name: 'OpenRouter', fn: function() { return callOpenRouter(messages, temp, maxT); } }
  ];

  let lastError = null;
  for (const p of cascade) {
    try {
      const reply = await p.fn();
      console.log('✅ Ответ от: ' + p.name);
      return { reply: reply, provider: p.name };
    } catch (e) {
      console.warn('❌ ' + p.name + ' упал: ' + e.message);
      lastError = e;
    }
  }
  throw lastError || new Error('Все ИИ недоступны');
}

/* ============ ЧАТ ============ */
app.post('/api/chat', async (req, res) => {
  try {
    const body = req.body || {};
    const message = body.message;
    const nickname = body.nickname;
    const customPrompt = body.customPrompt;
    const temperature = body.temperature;
    const maxTokens = body.maxTokens;
    const history = body.history;
    const image = body.image;
    const model = body.model || 'auto';

    if (!message && !image) return res.status(400).json({ error: 'Пустое сообщение' });

    const prompt = customPrompt || DEFAULT_PROMPT;
    const hint = nickname ? ('\nПользователя зовут ' + nickname + '.') : '';
    const messages = [{ role: 'system', content: prompt + hint }];

    if (Array.isArray(history)) {
      history.forEach(function(h) {
        if (h && h.role && h.content) {
          messages.push({ role: h.role, content: h.content });
        }
      });
    }

    // Фото — через Groq Vision
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
      return res.json({ reply: vData.choices[0].message.content, provider: 'Groq Vision' });
    }

    messages.push({ role: 'user', content: message });

    // Проверяем, нужен ли поиск (если модель Gemini — всегда да)
    const lower = message.toLowerCase();
    const needsSearch = /(найди|поищи|погугли|новости|последни|свежи|актуальн|today|latest|news)/i.test(lower);

    const result = await smartChat(messages, temperature, maxTokens, model, needsSearch || model === 'gemini');
    res.json({ reply: result.reply, provider: result.provider });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка: ' + e.message });
  }
});

/* ============ ПОИСК ============ */
app.post('/api/search', async (req, res) => {
  try {
    const body = req.body || {};
    const query = body.query;
    if (!query) return res.status(400).json({ error: 'Пустой запрос' });

    // 🌐 Сначала пробуем Gemini с Google-поиском
    try {
      const geminiMessages = [
        { role: 'system', content: 'Ты — Novus. Найди информацию в интернете и ответь кратко на русском.' },
        { role: 'user', content: query }
      ];
      const geminiReply = await callGemini(geminiMessages, 0.3, 1500, true);
      return res.json({ reply: geminiReply, provider: 'Gemini Search' });
    } catch (e) {
      console.warn('Gemini Search упал: ' + e.message);
    }

    // Резерв: DuckDuckGo + Groq
    let webContext = '';
    try {
      const ddgRes = await fetch('https://api.duckduckgo.com/?q=' + encodeURIComponent(query) + '&format=json&no_html=1&skip_disambig=1');
      const ddgData = await ddgRes.json();
      const parts = [];
      if (ddgData.AbstractText) parts.push(ddgData.AbstractText);
      if (ddgData.RelatedTopics) {
        ddgData.RelatedTopics.slice(0, 5).forEach(function(t) { if (t.Text) parts.push(t.Text); });
      }
      webContext = parts.join(' ') || 'Нет данных';
    } catch (e) { webContext = 'Ошибка поиска'; }

    const messages = [
      { role: 'system', content: 'Ты — Novus. Отвечай на основе данных поиска, кратко.' },
      { role: 'user', content: 'Запрос: ' + query + '\n\nДанные: ' + webContext }
    ];
    const result = await smartChat(messages, 0.3, 1500, 'auto', false);
    res.json({ reply: result.reply, provider: result.provider });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка поиска: ' + e.message });
  }
});

/* ============ ПЕРЕВОД ДЛЯ КАРТИНОК ============ */
app.post('/api/translate', async (req, res) => {
  try {
    const body = req.body || {};
    const prompt = body.prompt;
    if (!prompt) return res.status(400).json({ error: 'Пустой промпт' });

    const messages = [
      { role: 'system', content: 'You translate requests into English prompts for AI image generators. Reply ONLY with the English prompt, up to 40 words. Add: highly detailed, cinematic lighting, 8k, masterpiece.' },
      { role: 'user', content: prompt }
    ];
    const result = await smartChat(messages, 0.5, 200, 'auto', false);
    const cleaned = result.reply.trim().replace(/^["']|["']$/g, '');
    res.json({ englishPrompt: cleaned });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка перевода: ' + e.message });
  }
});

app.listen(PORT, function() {
  console.log('Сервер запущен на порту ' + PORT);
});
