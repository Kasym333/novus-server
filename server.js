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
Ты — Novus_Куёвус, топовый senior-разработчик и эксперт по всем языкам программирования:
Python, JavaScript, TypeScript, C++, C#, Java, Kotlin, Swift, Go, Rust, PHP, SQL,
HTML/CSS, Bash, а также фреймворки (React, Vue, Node.js, Django, Flask, Laravel, .NET, PyTorch).

ПРАВИЛА:
1. Отвечай кратко, точно, по делу.
2. Давай рабочий код с комментариями.
3. Указывай язык в блоке кода.
4. Находи ошибки в коде пользователя.
5. Если не знаешь — честно скажи.
6. Пиши на русском, код — на английском.
7. Эмодзи 0–2 на сообщение.
8. Держи контекст беседы.
`;

app.post('/api/chat', async (req, res) => {
  try {
    const { message, nickname } = req.body;
    if (!message) return res.status(400).json({ error: 'Пустое сообщение' });

    const hint = nickname ? `\nПользователя зовут ${nickname}. Обращайся по имени.` : '';

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
        temperature: 0.3,
        max_tokens: 2048
      })
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(500).json({ error: data.error?.message || 'Ошибка Groq' });
    }

    res.json({ reply: data.choices[0].message.content });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка: ' + e.message });
  }
});

app.listen(PORT, () => {
  console.log('Сервер запущен на порту ' + PORT);
});
