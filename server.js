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

const DEFAULT_PROMPT = `Ты — Novus, умный и дружелюбный ассистент. Отвечай грамотно, по делу, без воды. Понимаешь сленг и опечатки. Если просят код — давай рабочий код с комментариями. Держи контекст беседы.`;

/* ============ GROQ (актуальные модели) ============ */
async function callGroq(messages, temp, maxT, model) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.GROQ_API_KEY },
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

/* ============ GEMINI 3.8 ============ */
async function callGemini(messages, temp, maxT, useSearch) {
  const systemMsg = messages.find(m => m.role === 'system');
  const chatMsgs = messages.filter(m => m.role !== 'system');
  const contents = chatMsgs.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));
  const body = { contents, generationConfig: { temperature: temp || 0.6, maxOutputTokens: maxT || 2048 } };
  if (systemMsg) body.systemInstruction = { parts: [{ text: systemMsg.content }] };
  if (useSearch !== false) body.tools = [{ googleSearch: {} }];

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=' + process.env.GEMINI_API_KEY;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ? data.error.message : 'Gemini error');
  if (!data.candidates || !data.candidates[0]) throw new Error('Gemini: пустой ответ');
  return data.candidates[0].content.parts.map(p => p.text || '').join('');
}

/* ============ DEEPSEEK ============ */
async function callDeepSeek(messages, temp, maxT) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.DEEPSEEK_API_KEY },
    body: JSON.stringify({ model: 'deepseek-chat', messages, temperature: temp || 0.6, max_tokens: maxT || 2048 })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ? data.error.message : 'DeepSeek error');
  return data.choices[0].message.content;
}

/* ============ OPENROUTER ============ */
async function callOpenRouter(messages, temp, maxT) {
  const models = ['deepseek/deepseek-r1:free', 'meta-llama/llama-3.3-70b-instruct:free', 'qwen/qwen-2.5-72b-instruct:free'];
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
        body: JSON.stringify({ model, messages, temperature: temp || 0.6, max_tokens: maxT || 2048 })
      });
      const data = await res.json();
      if (res.ok) return data.choices[0].message.content;
    } catch (e) {}
  }
  throw new Error('OpenRouter failed');
}

/* ============ УМНЫЙ КАСКАД ============ */
async function smartChat(messages, temp, maxT, model, useSearch) {
  const errors = [];

  if (model === 'gemini') {
    try { return { reply: await callGemini(messages, temp, maxT, useSearch), provider: 'Gemini 3.8' }; }
    catch (e) { errors.push('Gemini: ' + e.message); }
  }
  if (model === 'openrouter') {
    try { return { reply: await callOpenRouter(messages, temp, maxT), provider: 'OpenRouter' }; }
    catch (e) { errors.push('OpenRouter: ' + e.message); }
  }
  if (model && model !== 'auto' && model !== 'gemini' && model !== 'openrouter') {
    try { return { reply: await callGroq(messages, temp, maxT, model), provider: 'Groq' }; }
    catch (e) { errors.push('Groq: ' + e.message); }
  }

  // Каскад: Groq → Gemini → DeepSeek → OpenRouter
  const cascade = [
    { name: 'Groq', fn: () => callGroq(messages, temp, maxT) },
    { name: 'Gemini 3.8', fn: () => callGemini(messages, temp, maxT, useSearch) },
    { name: 'DeepSeek', fn: () => callDeepSeek(messages, temp, maxT) },
    { name: 'OpenRouter', fn: () => callOpenRouter(messages, temp, maxT) }
  ];

  for (const p of cascade) {
    try {
      const reply = await p.fn();
      console.log('✅ ' + p.name);
      return { reply, provider: p.name };
    } catch (e) {
      console.warn('❌ ' + p.name + ': ' + e.message);
      errors.push(p.name + ': ' + e.message);
    }
  }
  throw new Error('Все ИИ недоступны. Попробуй позже.');
}

/* ============ ЧАТ ============ */
app.post('/api/chat', async (req, res) => {
  try {
    const { message, nickname, customPrompt, temperature, maxTokens, history, image, model } = req.body || {};
    if (!message && !image) return res.status(400).json({ error: 'Пустое сообщение' });

    const messages = [{
      role: 'system',
      content: (customPrompt || DEFAULT_PROMPT) + (nickname ? '\nПользователя зовут ' + nickname + '.' : '')
    }];

    if (Array.isArray(history)) {
      history.forEach(h => {
        if (h && h.role && h.content) messages.push({ role: h.role, content: h.content });
      });
    }

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
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.GROQ_API_KEY },
        body: JSON.stringify({ model: 'meta-llama/llama-4-scout-17b-16e-instruct', messages, temperature: 0.5, max_tokens: 1024 })
      });
      const vData = await vRes.json();
      if (!vRes.ok) return res.status(500).json({ error: vData.error ? vData.error.message : 'Vision error' });
      return res.json({ reply: vData.choices[0].message.content, provider: 'Groq Vision' });
    }

    messages.push({ role: 'user', content: message });

    const needsSearch = /(найди|поищи|погугли|новости|последни|свежи|актуальн)/i.test(message.toLowerCase());
    const result = await smartChat(messages, temperature, maxTokens, model || 'auto', needsSearch || model === 'gemini');
    res.json({ reply: result.reply, provider: result.provider });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ============ ПОИСК ============ */
app.post('/api/search', async (req, res) => {
  try {
    const { query } = req.body || {};
    if (!query) return res.status(400).json({ error: 'Пустой запрос' });

    try {
      const reply = await callGemini([
        { role: 'system', content: 'Ты — Novus. Найди информацию в интернете и ответь кратко на русском.' },
        { role: 'user', content: query }
      ], 0.3, 1500, true);
      return res.json({ reply, provider: 'Gemini Search' });
    } catch (e) { console.warn('Gemini Search: ' + e.message); }

    let webContext = '';
    try {
      const ddgRes = await fetch('https://api.duckduckgo.com/?q=' + encodeURIComponent(query) + '&format=json&no_html=1&skip_disambig=1');
      const ddgData = await ddgRes.json();
      const parts = [];
      if (ddgData.AbstractText) parts.push(ddgData.AbstractText);
      if (ddgData.RelatedTopics) ddgData.RelatedTopics.slice(0, 5).forEach(t => { if (t.Text) parts.push(t.Text); });
      webContext = parts.join(' ') || 'Нет данных';
    } catch (e) { webContext = 'Ошибка поиска'; }

    const result = await smartChat([
      { role: 'system', content: 'Ты — Novus. Отвечай на основе данных поиска.' },
      { role: 'user', content: 'Запрос: ' + query + '\n\nДанные: ' + webContext }
    ], 0.3, 1500, 'auto', false);
    res.json({ reply: result.reply, provider: result.provider });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ============ ПЕРЕВОД ДЛЯ КАРТИНОК ============ */
app.post('/api/translate', async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'Пустой промпт' });
    const result = await smartChat([
      { role: 'system', content: 'You translate requests into English prompts for AI image generators. Reply ONLY with the English prompt, up to 40 words. Add: highly detailed, cinematic lighting, 8k, masterpiece.' },
      { role: 'user', content: prompt }
    ], 0.5, 200, 'auto', false);
    res.json({ englishPrompt: result.reply.trim().replace(/^["']|["']$/g, '') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log('🚀 Сервер запущен на порту ' + PORT));
