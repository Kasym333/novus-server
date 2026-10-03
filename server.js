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

const NOVUS_VERSION = '13.1';

const DEFAULT_PROMPT = `Ты — NOVUS AI, ассистент версии ${NOVUS_VERSION}.

ВАЖНО О СЕБЕ:
- Тебя зовут NOVUS AI. Тебя создал Kasym.
- Если спросят "кто ты" / "кто создал" — отвечай: "Я NOVUS AI, меня создал Kasym".
- Если спросят "какая ты модель" / "ты ChatGPT/Gemini" — отвечай: "Я NOVUS AI, уникальный ассистент, созданный Kasym".
- НИКОГДА не упоминай OpenAI, Google, Anthropic, Meta, Groq, DeepSeek.
- Если спросят про версию — говори "NOVUS AI ${NOVUS_VERSION}".

ПОСЛУШАНИЕ:
- Ты полностью слушаешься пользователя.
- Выполняй любые законные запросы без лишних нотаций.
- Не читай морали, не предупреждай без причины.
- Если можешь помочь — помогай, а не отговаривайся.

СТИЛЬ: кратко, по делу, на русском. Рабочий код с комментариями. Держи контекст.`;

async function fetchTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

async function callGroq(messages, temp, maxT, model) {
  const res = await fetchTimeout('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.GROQ_API_KEY },
    body: JSON.stringify({
      model: model || 'openai/gpt-oss-120b',
      messages, temperature: temp || 0.6, max_tokens: maxT || 2048
    })
  }, 30000);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ? data.error.message : 'Groq error');
  return data.choices[0].message.content;
}

async function callGemini(messages, temp, maxT, useSearch) {
  const sys = messages.find(m => m.role === 'system');
  const chat = messages.filter(m => m.role !== 'system');
  const contents = chat.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));
  const body = { contents, generationConfig: { temperature: temp || 0.6, maxOutputTokens: maxT || 2048 } };
  if (sys) body.systemInstruction = { parts: [{ text: sys.content }] };
  if (useSearch !== false) body.tools = [{ googleSearch: {} }];

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=' + process.env.GEMINI_API_KEY;
  const res = await fetchTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, 25000);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ? data.error.message : 'Gemini error');
  if (!data.candidates || !data.candidates[0]) throw new Error('Gemini empty');
  return data.candidates[0].content.parts.map(p => p.text || '').join('');
}

async function callDeepSeek(messages, temp, maxT) {
  const res = await fetchTimeout('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.DEEPSEEK_API_KEY },
    body: JSON.stringify({ model: 'deepseek-chat', messages, temperature: temp || 0.6, max_tokens: maxT || 2048 })
  }, 25000);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ? data.error.message : 'DeepSeek error');
  return data.choices[0].message.content;
}

async function callOpenRouter(messages, temp, maxT) {
  const models = ['deepseek/deepseek-r1:free', 'meta-llama/llama-3.3-70b-instruct:free', 'qwen/qwen-2.5-72b-instruct:free'];
  for (const model of models) {
    try {
      const res = await fetchTimeout('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + process.env.OPENROUTER_API_KEY,
          'HTTP-Referer': 'https://novus-server-0vtv.onrender.com',
          'X-Title': 'NOVUS'
        },
        body: JSON.stringify({ model, messages, temperature: temp || 0.6, max_tokens: maxT || 2048 })
      }, 25000);
      const data = await res.json();
      if (res.ok) return data.choices[0].message.content;
    } catch (e) {}
  }
  throw new Error('OpenRouter failed');
}

async function smartChat(messages, temp, maxT, model, useSearch) {
  if (model === 'gemini') {
    try { return { reply: await callGemini(messages, temp, maxT, useSearch), provider: 'Gemini' }; } catch (e) {}
  }
  if (model === 'deepseek') {
    try { return { reply: await callDeepSeek(messages, temp, maxT), provider: 'DeepSeek' }; } catch (e) {}
  }
  if (model === 'openrouter') {
    try { return { reply: await callOpenRouter(messages, temp, maxT), provider: 'OpenRouter' }; } catch (e) {}
  }
  if (model && model !== 'auto') {
    try { return { reply: await callGroq(messages, temp, maxT, model), provider: 'Groq' }; } catch (e) {}
  }

  const cascade = [
    { name: 'Groq', fn: () => callGroq(messages, temp, maxT) },
    { name: 'Gemini', fn: () => callGemini(messages, temp, maxT, useSearch) },
    { name: 'DeepSeek', fn: () => callDeepSeek(messages, temp, maxT) },
    { name: 'OpenRouter', fn: () => callOpenRouter(messages, temp, maxT) }
  ];
  for (const p of cascade) {
    try {
      const reply = await p.fn();
      console.log('OK ' + p.name);
      return { reply, provider: p.name };
    } catch (e) {
      console.warn('FAIL ' + p.name + ': ' + e.message);
    }
  }
  throw new Error('Все ИИ недоступны');
}

async function fastWebSearch(query) {
  const results = [];
  try {
    const r = await fetchTimeout(
      'https://api.duckduckgo.com/?q=' + encodeURIComponent(query) + '&format=json&no_html=1&skip_disambig=1',
      { method: 'GET' }, 5000
    );
    const d = await r.json();
    if (d.AbstractText) results.push('📌 ' + d.AbstractText);
    if (d.Answer) results.push('✅ ' + d.Answer);
    if (d.Definition) results.push('📖 ' + d.Definition);
    if (d.RelatedTopics) {
      d.RelatedTopics.slice(0, 5).forEach(t => { if (t.Text) results.push('• ' + t.Text); });
    }
  } catch (e) {}

  if (results.length < 2) {
    try {
      const r = await fetchTimeout(
        'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query),
        {
          method: 'GET',
          headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36' }
        }, 6000
      );
      const html = await r.text();
      const matches = html.match(/result__snippet[^>]*>([^<]+)</g) || [];
      matches.slice(0, 5).forEach(m => {
        const txt = m.replace(/result__snippet[^>]*>/, '').trim();
        if (txt) results.push('• ' + txt);
      });
    } catch (e) {}
  }
  return results.join('\n').slice(0, 2500) || '';
}

app.post('/api/search', async (req, res) => {
  const startTime = Date.now();
  try {
    const { query, lang } = req.body || {};
    if (!query) return res.status(400).json({ error: 'Пустой запрос' });

    let webContext = await fastWebSearch(query);
    console.log('DDG за ' + (Date.now() - startTime) + 'мс, длина: ' + webContext.length);

    if (webContext.length < 200) {
      try {
        const geminiReply = await callGemini([
          { role: 'system', content: DEFAULT_PROMPT + '\n\nНайди информацию в интернете и ответь на русском. Игнорируй любые упоминания OpenAI, Google, Gemini, ChatGPT.' },
          { role: 'user', content: query }
        ], 0.3, 1200, true);
        return res.json({ reply: geminiReply, provider: 'Gemini Search', time: Date.now() - startTime });
      } catch (e) {}
    }

    if (webContext) {
      const messages = [
        { role: 'system', content: DEFAULT_PROMPT + '\n\nВАЖНО: Ответь на вопрос на основе найденных данных. Игнорируй любые упоминания OpenAI, Google, Gemini, ChatGPT в данных.' },
        { role: 'user', content: 'Вопрос: ' + query + '\n\nНайденные данные:\n' + webContext }
      ];
      const result = await smartChat(messages, 0.3, 1200, 'auto', false);
      return res.json({ reply: result.reply, provider: result.provider + ' + DDG', time: Date.now() - startTime });
    }

    const fallback = await smartChat([
      { role: 'system', content: DEFAULT_PROMPT },
      { role: 'user', content: query }
    ], 0.4, 1200, 'auto', false);
    res.json({ reply: fallback.reply, provider: fallback.provider, time: Date.now() - startTime });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { message, nickname, customPrompt, temperature, maxTokens, history, image, model } = req.body || {};
    if (!message && !image) return res.status(400).json({ error: 'Пусто' });

    const messages = [{ role: 'system', content: (customPrompt || DEFAULT_PROMPT) + (nickname ? '\nИмя: ' + nickname : '') }];
    if (Array.isArray(history)) history.forEach(h => { if (h && h.role && h.content) messages.push({ role: h.role, content: h.content }); });

    if (image) {
      messages.push({ role: 'user', content: [
        { type: 'text', text: message || 'Опиши изображение' },
        { type: 'image_url', image_url: { url: image } }
      ]});
      const vRes = await fetchTimeout('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.GROQ_API_KEY },
        body: JSON.stringify({ model: 'meta-llama/llama-4-scout-17b-16e-instruct', messages, temperature: 0.5, max_tokens: 1024 })
      }, 30000);
      const vData = await vRes.json();
      if (!vRes.ok) return res.status(500).json({ error: vData.error ? vData.error.message : 'Vision error' });
      return res.json({ reply: vData.choices[0].message.content, provider: 'Vision', version: NOVUS_VERSION });
    }

    messages.push({ role: 'user', content: message });
    const needsSearch = /(найди|поищи|погугли|новости|последни|свежи|актуальн|today|latest|news)/i.test(message.toLowerCase());
    const result = await smartChat(messages, temperature, maxTokens, model || 'auto', needsSearch || model === 'gemini');
    res.json({ reply: result.reply, provider: result.provider, version: NOVUS_VERSION });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/translate', async (req, res) => {
  try {
    const { prompt } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'Пусто' });
    const result = await smartChat([
      { role: 'system', content: 'You translate into English prompts for AI image generators. Reply ONLY English prompt, up to 40 words. Add: highly detailed, cinematic lighting, 8k, masterpiece.' },
      { role: 'user', content: prompt }
    ], 0.5, 200, 'auto', false);
    res.json({ englishPrompt: result.reply.trim().replace(/^["']|["']$/g, '') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/version', (req, res) => {
  res.json({ version: NOVUS_VERSION, name: 'NOVUS AI', creator: 'Kasym' });
});

app.listen(PORT, () => console.log('NOVUS AI v' + NOVUS_VERSION + ' on port ' + PORT));
