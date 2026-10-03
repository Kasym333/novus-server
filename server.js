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

const DEFAULT_PROMPT = `Ты — Novus, умный ассистент. Отвечай грамотно, по делу. Понимаешь сленг, опечатки. Если просят код — давай рабочий код. Держи контекст беседы.`;

/* ============ GROQ ============ */
async function callGroq(messages, temp, maxT) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + process.env.GROQ_API_KEY
    },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b',
      messages: messages,
      temperature: temp || 0.6,
      max_tokens: maxT || 2048
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ? data.error.message : 'Groq error');
  return data.choices[0].message.content;
}

/* ============ GEMINI ============ */
async function callGemini(messages, temp, maxT) {
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
  return data.candidates[0].content.parts[0].text;
}

/* ============ DEEPSEEK ============ */
async function callDeepSeek(messages, temp, maxT) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + process.env.DEEPSEEK_API_KEY
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: messages,
      temperature: temp || 0.6,
      max_tokens: maxT || 2048
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ? data.error.message : 'DeepSeek error');
  return data.choices[0].message.content;
}

/* ============ OPENROUTER (резерв) ============ */
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

/* ============ КАСКАД: Groq → Gemini → DeepSeek → OpenRouter ============ */
async function smartChat(messages, temp, maxT) {
  const providers = [
    { name: 'Groq', fn: function() { return callGroq(messages, temp, maxT); } },
    { name: 'Gemini', fn: function() { return callGemini(messages, temp, maxT); } },
    { name: 'DeepSeek', fn: function() { return callDeepSeek(messages, temp, maxT); } },
    { name: 'OpenRouter', fn: function() { return callOpenRouter(messages, temp, maxT); } }
  ];

  let lastError = null;
  for (const p of providers) {
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

/* ============ ЧАТ С ПАМЯТЬЮ ============ */
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

    if (!message && !image) return res.status(400).json({ error: 'Пустое сообщение' });

    const prompt = customPrompt || DEFAULT_PROMPT;
    const hint = nickname ? ('\nПользователя зовут ' + nickname + '.') : '';
    const messages = [{ role: 'system', content: prompt + hint }];

    // 🧠 ДОБАВЛЯЕМ ИСТОРИЮ
    if (Array.isArray(history)) {
      history.forEach(function(h) {
        if (h && h.role && h.content) {
          messages.push({ role: h.role, content: h.content });
        }
      });
    }

    // 🖼 Если фото — используем vision
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

    const result = await smartChat(messages, temperature, maxTokens);
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
    const result = await smartChat(messages, 0.3, 1500);
    res.json({ reply: result.reply });
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
    const result = await smartChat(messages, 0.5, 200);
    const cleaned = result.reply.trim().replace(/^["']|["']$/g, '');
    res.json({ englishPrompt: cleaned });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка перевода: ' + e.message });
  }
});

app.listen(PORT, function() {
  console.log('Сервер запущен на порту ' + PORT);
});
