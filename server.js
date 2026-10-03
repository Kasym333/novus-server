app.post('/api/chat', async (req, res) => {
  try {
    const { message, nickname, summary, history, image } = req.body;
    if (!message && !image) return res.status(400).json({ error: 'Пустое сообщение' });

    const hint = nickname ? `\nПользователя зовут ${nickname}.` : '';
    const summaryBlock = summary
      ? `\n\n[КРАТКАЯ СВОДКА ПРОШЛОЙ БЕСЕДЫ]\n${summary}\n[КОНЕЦ СВОДКИ]`
      : '';

    const msgs = [
      { role: 'system', content: PROMPT + hint + summaryBlock }
    ];

    if (Array.isArray(history)) {
      history.forEach(h => {
        if (h.role && h.content) msgs.push({ role: h.role, content: h.content });
      });
    }

    // 🖼 Если есть фото — используем vision-модель
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

      // Llama 4 Scout поддерживает картинки на Groq
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
