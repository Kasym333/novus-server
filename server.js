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

const DEFAULT_PROMPT = `Ты — Novus, умный ассистент. Отвечай грамотно, по делу, без воды.
Понимаешь сленг, опечатки, разговорную речь. Если не знаешь — честно скажи.
Если просят код — давай рабочий код с краткими пояснениями.`;

// ============ GROQ ============
async function callGroq(messages, temperature, maxTokens) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + process.env.GROQ_API_KEY
    },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b',
      messages,
      temperature: temperature ?? 0.5,
      max_tokens: maxTokens ?? 2048
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Groq error');
  return data.choices[0].message.content;
}

// ============ GEMINI ============
async function callGemini(messages, temperature, maxTokens) {
  // Достаём system + превращаем историю в формат Gemini
  const systemMsg = messages.find(m => m.role === 'system');
  const chatMsgs = messages.filter(m => m.role !== 'system');

  const contents = chatMsgs.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  const body = {
    contents,
    generationConfig: {
      temperature: temperature ?? 0.5,
      maxOutputTokens: maxTokens ?? 2048
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
  if (!res.ok) throw new Error(data.error?.message || 'Gemini error');
  return data.candidates[0].content.parts[0].text;
}

// ============ DEEPSEEK ============
async function callDeepSeek(messages, temperature, maxTokens) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + process.env.DEEPSEEK_API_KEY
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages,
      temperature: temperature ?? 0.5,
      max_tokens: maxTokens ?? 2048
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'DeepSeek error');
  return data.choices[0].message.content;
}

// ============ КАСКАД: Groq → Gemini → DeepSeek ============
async function smartChat(messages, temperature, maxTokens) {
  const providers = [
    { name: 'Groq', fn: () => callGroq(messages, temperature, maxTokens) },
    { name: 'Gemini', fn: () => callGemini(messages, temperature, maxTokens) },
    { name: 'DeepSeek', fn: () => callDeepSeek(messages, temperature, maxTokens) }
  ];

  let lastError = null;
  for (const p of providers) {
    try {
      const reply = await p.fn();
      console.log('✅ Ответ от: ' + p.name);
      return { reply, provider: p.name };
    } catch (e) {
      console.warn('❌ ' + p.name + ' упал:', e.message);
      lastError = e;
    }
  }
  throw lastError || new Error('Все ИИ недоступны');
}

// ============ ЧАТ ============
app.post('/api/chat', async (req, res) => {
  try {
    const body = req.body || {};
    const message = body.message;
    const nickname = body.nickname;
    const customPrompt = body.customPrompt;
    const temperature = body.temperature;
    const maxTokens = body.maxTokens;

    if (!message) return res.status(400).json({ error: 'Пустое сообщение' });

    const prompt = customPrompt || DEFAULT_PROMPT;
    const hint = nickname ? ('\nПользователя зовут ' + nickname + '.') : '';
    const messages = [
      { role: 'system', content: prompt + hint },
      { role: 'user', content: message }
    ];

    const result = await smartChat(messages, temperature, maxTokens);
    res.json({ reply: result.reply, provider: result.provider });
  } catch (e) {
    res.status(500).json({ error: 'Все ИИ недоступны: ' + e.message });
  }
});

// ============ ПОИСК ============
app.post('/api/search', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'Пустой запрос' });

    let webContext = '';
    try {
      const ddgRes = await fetch('https://api.duckduckgo.com/?q=' + encodeURIComponent(query) + '&format=json&no_html=1&skip_disambig=1');
      const ddgData = await ddgRes.json();
      const parts = [];
      if (ddgData.AbstractText) parts.push(ddgData.AbstractText);
      if (ddgData.RelatedTopics) {
        ddgData.RelatedTopics.slice(0, 5).forEach(t => { if (t.Text) parts.push(t.Text); });
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

// ============ ПЕРЕВОД ПРОМПТА ДЛЯ КАРТИНОК ============
app.post('/api/translate', async (req, res) => {
  try {
    const { prompt } = req.body;
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

app.listen(PORT, () => {
  console.log('Сервер запущен на порту ' + PORT);
});
