const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const Groq = require('groq-sdk');

const app = express();
const PORT = process.env.PORT || 3000;

// Groq setup – key from env var (set in Render dashboard)
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

// CORS – allow Netlify + localhost
app.use(cors({
  origin: [
    'https://ram-tech-ai.netlify.app',
    'https://*.netlify.app',
    'http://localhost:3000',
    'http://127.0.0.1:3000'
  ],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json({ limit: '1mb' }));

const limiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  message: { error: 'Too many requests, slow down 😅' }
});
app.use('/api/', limiter);

const DOWNLOAD_DIR = path.join(__dirname, 'downloads');

(async () => {
  try {
    await fs.access(DOWNLOAD_DIR);
  } catch {
    await fs.mkdir(DOWNLOAD_DIR, { recursive: true });
    console.log('downloads folder created');
  }
})();

function delayedCleanup(filePath) {
  setTimeout(async () => {
    try {
      await fs.unlink(filePath);
    } catch {}
  }, 60000);
}

app.get('/', (req, res) => res.send('RAMTECH AI Backend Running 🚀'));

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

app.post('/api/download', async (req, res) => {
  const { message } = req.body;
  if (!message || message.trim().length < 1 || message.length > 300) {
    return res.status(400).json({ error: 'Invalid message' });
  }

  const userMessage = message.trim();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  res.write(`data: ${JSON.stringify({ status: 'thinking', message: 'Thinking... 🤔' })}\n\n`);

  let aiResult;
  try {
    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: `You are RAMTECH AI, a friendly music downloader.
Respond ONLY in JSON.
If user wants a song:
{ "action": "download", "songQuery": "song name or link" }
If chat:
{ "action": "reply", "message": "short friendly reply" }`
        },
        { role: 'user', content: userMessage }
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.7,
      max_tokens: 150,
      response_format: { type: 'json_object' }
    });
    aiResult = JSON.parse(completion.choices[0].message.content);
  } catch (err) {
    console.error('Groq error:', err);
    res.write(`data: ${JSON.stringify({ status: 'error', message: 'AI is slow or down 😅 Try again?' })}\n\n`);
    res.flushHeaders();
    res.end();
    return;
  }

  if (aiResult.action === 'reply') {
    res.write(`data: ${JSON.stringify({ status: 'reply', message: aiResult.message })}\n\n`);
    res.flushHeaders();
    res.end();
    return;
  }

  if (aiResult.action === 'download') {
    const query = aiResult.songQuery.trim();
    const isUrl = /^https?:\/\//i.test(query);
    const search = isUrl ? query : `ytsearch1:${query}`;

    const args = [
      '--cookies', 'cookies.txt',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
      '--referer', 'https://www.youtube.com/',
      '--add-header', 'Accept-Language: en-US,en;q=0.9',
      '--extractor-args', 'youtube:player_client=web_safari,ios',  // Safari/iOS client spoof — helped many bypass bot check
      '--sleep-requests', '1',  // random sleep between requests
      '--sleep-interval', '3',  // longer pause
      '--force-ipv6',  // try IPv6 if Render supports (some clouds have less flagged IPv6)
      '-x', '--audio-format', 'mp3',
      '--audio-quality', '5',
      '--no-playlist',
      '--restrict-filenames',
      '-o', `${DOWNLOAD_DIR}/%(title)s.%(ext)s`,
      search
    ];

    // Debug: check cookies.txt content
    try {
      const cookiesContent = await fs.readFile('cookies.txt', 'utf8');
      console.log('Cookies file exists and size:', (await fs.stat('cookies.txt')).size, 'bytes');
      console.log('Contains SID?', cookiesContent.includes('SID'));
      console.log('Contains LOGIN_INFO?', cookiesContent.includes('LOGIN_INFO'));
      console.log('Contains __Secure-3PSID?', cookiesContent.includes('__Secure-3PSID'));
      console.log('Cookies first 300 chars (for debug):', cookiesContent.substring(0, 300));
    } catch (err) {
      console.log('Error reading cookies.txt:', err.message);
    }

    // Debug: check yt-dlp
    console.log('Current working directory:', process.cwd());
    console.log('Trying to spawn ./yt-dlp from:', __dirname);
    try {
      await fs.access(path.join(__dirname, 'yt-dlp'));
      console.log('yt-dlp binary found in project root!');
      const stats = await fs.stat(path.join(__dirname, 'yt-dlp'));
      console.log('yt-dlp file mode:', stats.mode.toString(8));
    } catch (err) {
      console.log('yt-dlp binary NOT found or not accessible:', err.message);
    }

    const yt = spawn('./yt-dlp', args);

    let output = '';
    let errorOutput = '';

    yt.stdout.on('data', d => output += d.toString());
    yt.stderr.on('data', d => errorOutput += d.toString());

    yt.on('close', code => {
      console.log('yt-dlp exit code:', code);
      console.log('Output:', output);
      console.log('Errors:', errorOutput);

      if (code !== 0) {
        res.write(`data: ${JSON.stringify({ status: 'error', message: 'Download failed – tool error 😔 (exit code ' + code + ')' })}\n\n`);
        res.flushHeaders();
        res.end();
        return;
      }

      const match = output.match(/Destination: (.+\.mp3)/);
      if (!match) {
        res.write(`data: ${JSON.stringify({ status: 'error', message: 'Could not find downloaded file 😕' })}\n\n`);
        res.flushHeaders();
        res.end();
        return;
      }

      const filePath = match[1];
      const fileName = path.basename(filePath);
      const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
      res.write(`data: ${JSON.stringify({
        status: 'success',
        message: 'Song ready! 🎧',
        downloadUrl: `${baseUrl}/api/file/${encodeURIComponent(fileName)}`
      })}\n\n`);
      res.flushHeaders();
      res.end();
    });

    yt.on('error', err => {
      console.error('Spawn error:', err.message);
      res.write(`data: ${JSON.stringify({ status: 'error', message: 'Download tool not available 😅 (' + err.message + ')' })}\n\n`);
      res.flushHeaders();
      res.end();
    });
  } else {
    res.write(`data: ${JSON.stringify({ status: 'reply', message: 'Say a song name 🎶' })}\n\n`);
    res.flushHeaders();
    res.end();
  }
});

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

app.listen(PORT, () => {
  console.log(`🚀 RAMTECH AI running on port ${PORT}`);
});