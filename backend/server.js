const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const Groq = require('groq-sdk');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== yt-dlp PATH (LOCAL + RENDER SAFE) =====
const YTDLP_PATH = path.join(__dirname, 'yt-dlp');

// ===== Groq setup =====
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY || 'put-your-local-test-key-here'
});

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ===== Rate Limiting =====
const limiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  message: { error: 'Too many requests, slow down 😅' }
});
app.use('/api/', limiter);

// ===== Downloads Directory =====
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');

(async () => {
  try {
    await fs.access(DOWNLOAD_DIR);
  } catch {
    await fs.mkdir(DOWNLOAD_DIR, { recursive: true });
    console.log('Downloads folder created');
  }
})();

// ===== Auto Cleanup =====
function delayedCleanup(filePath) {
  setTimeout(async () => {
    try {
      await fs.unlink(filePath);
      console.log('Deleted:', filePath);
    } catch {}
  }, 60_000);
}

// ===== Root =====
app.get('/', (req, res) => {
  res.send('RAMTECH AI Backend Running 🚀');
});

// ===== File Download =====
app.get('/api/file/:filename', async (req, res) => {
  const filePath = path.join(DOWNLOAD_DIR, req.params.filename);

  try {
    await fs.access(filePath);
  } catch {
    return res.status(404).json({ error: 'File not found' });
  }

  res.download(filePath, err => {
    if (!err) delayedCleanup(filePath);
  });
});

// ===== Main AI + Download Endpoint =====
app.post('/api/download', async (req, res) => {
  const { message } = req.body;
  if (!message || message.length > 300) {
    return res.status(400).json({ error: 'Invalid message' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  res.write(`data: ${JSON.stringify({ status: 'thinking', message: 'Thinking... 🤔' })}\n\n`);

  // ===== Ask Groq =====
  let aiResult;
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.7,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `
You are RAMTECH AI, a friendly music downloader.
Respond ONLY in JSON.

If user wants a song:
{ "action": "download", "songQuery": "song name or link" }

If chat:
{ "action": "reply", "message": "short friendly reply" }
`
        },
        { role: 'user', content: message }
      ]
    });

    aiResult = JSON.parse(completion.choices[0].message.content);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ status: 'error', message: 'AI error 😕' })}\n\n`);
    return res.end();
  }

  // ===== Chat Reply =====
  if (aiResult.action === 'reply') {
    res.write(`data: ${JSON.stringify({ status: 'reply', message: aiResult.message })}\n\n`);
    return res.end();
  }

  // ===== Download Flow =====
  if (aiResult.action === 'download') {
    const query = aiResult.songQuery.trim();
    const isUrl = /^https?:\/\//i.test(query);
    const search = isUrl ? query : `ytsearch1:${query}`;

    console.log('Using yt-dlp at:', YTDLP_PATH);

    const args = [
      '-x',
      '--audio-format', 'mp3',
      '--audio-quality', '5',
      '--no-playlist',
      '--restrict-filenames',
      '-o', `${DOWNLOAD_DIR}/%(title)s.%(ext)s`,
      search
    ];

    const yt = spawn(YTDLP_PATH, args);

    let output = '';

    yt.stdout.on('data', d => output += d.toString());
    yt.stderr.on('data', d => console.log(d.toString()));

    yt.on('close', async code => {
      if (code !== 0) {
        res.write(`data: ${JSON.stringify({ status: 'error', message: 'Download failed 😔' })}\n\n`);
        return res.end();
      }

      const match = output.match(/Destination: (.+\.mp3)/);
      if (!match) {
        res.write(`data: ${JSON.stringify({ status: 'error', message: 'File not found 😕' })}\n\n`);
        return res.end();
      }

      const filePath = match[1];
      const fileName = path.basename(filePath);
      const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

      res.write(`data: ${JSON.stringify({
        status: 'success',
        message: 'Song ready 🎧',
        downloadUrl: `${baseUrl}/api/file/${encodeURIComponent(fileName)}`
      })}\n\n`);

      res.end();
    });

    yt.on('error', err => {
      console.error(err);
      res.write(`data: ${JSON.stringify({ status: 'error', message: 'Download tool error 😅' })}\n\n`);
      res.end();
    });

  } else {
    res.write(`data: ${JSON.stringify({ status: 'reply', message: 'Say a song name 🎶' })}\n\n`);
    res.end();
  }
});

// ===== Cleanup Old Files =====
setInterval(async () => {
  try {
    const files = await fs.readdir(DOWNLOAD_DIR);
    for (const f of files) {
      const fp = path.join(DOWNLOAD_DIR, f);
      const stat = await fs.stat(fp);
      if (Date.now() - stat.mtimeMs > 15 * 60 * 1000) {
        await fs.unlink(fp);
      }
    }
  } catch {}
}, 5 * 60 * 1000);

// ===== Start Server =====
app.listen(PORT, () => {
  console.log(`RAMTECH AI running on port ${PORT}`);
});
