const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const Groq = require('groq-sdk');

const app = express();
const PORT = 3000;

// Groq setup - key comes from environment variable (secure for deployment)
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY || 'put-your-local-test-key-here-if-needed'
});

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Rate limit increased for testing (change back to 5 when live)
const limiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 20,
  message: { error: 'Too many requests, please wait a minute 😅' }
});
app.use('/api/', limiter);

const DOWNLOAD_DIR = path.join(__dirname, 'downloads');

// Create downloads folder async at startup
(async () => {
  try {
    await fs.access(DOWNLOAD_DIR);
  } catch {
    await fs.mkdir(DOWNLOAD_DIR, { recursive: true });
    console.log(`Created downloads directory: ${DOWNLOAD_DIR}`);
  }
})();

// Delayed cleanup (60 seconds – safe)
function delayedCleanup(filePath) {
  setTimeout(async () => {
    try {
      await fs.unlink(filePath);
      console.log(`Delayed cleanup: ${filePath}`);
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`Cleanup failed: ${err}`);
    }
  }, 60000);
}

app.get('/', (req, res) => res.send('RAMTECH AI Backend running 🚀'));

app.get('/api/file/:filename', async (req, res) => {
  const fileName = req.params.filename;
  const filePath = path.join(DOWNLOAD_DIR, fileName);

  try {
    await fs.access(filePath);
  } catch {
    return res.status(404).json({ error: 'File not found' });
  }

  res.download(filePath, fileName, (err) => {
    if (err) {
      console.error('Send error:', err);
      res.status(500).json({ error: 'Failed to send file' });
    } else {
      delayedCleanup(filePath);
    }
  });
});

// Main chat endpoint
app.post('/api/download', async (req, res) => {
  const { message } = req.body;

  if (!message || message.trim().length < 1 || message.length > 300) {
    return res.status(400).json({ error: 'Invalid message' });
  }

  const userMessage = message.trim();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  res.write(`data: ${JSON.stringify({ status: 'processing', message: '⏳ Thinking...' })}\n\n`);

  // Groq with timeout
  let aiResult;
  try {
    const completionPromise = groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: `You are RAMTECH AI, a super friendly music downloader under ramtech company.
Respond ONLY with valid JSON, nothing else. Use this format:
If the user is asking for a song (name, artist, link, "download ...", "get me ...", "play ..."):
{ "action": "download", "songQuery": "the exact song name, artist, or link they want" }
For chit-chat (greetings, thanks, bye, questions about you, help):
{ "action": "reply", "message": "short, fun, friendly reply" }
If unclear: { "action": "reply", "message": "ask for clarification politely" }
Keep replies fun, short, and with emojis 😏`
        },
        { role: 'user', content: userMessage }
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.7,
      max_tokens: 150,
      response_format: { type: 'json_object' }
    });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Groq timeout')), 15000)
    );

    const completion = await Promise.race([completionPromise, timeoutPromise]);
    aiResult = JSON.parse(completion.choices[0].message.content);
  } catch (groqErr) {
    console.error('Groq API error:', groqErr);
    res.write(`data: ${JSON.stringify({ status: 'error', message: 'Hmm, my brain lagged 😅 Try again?' })}\n\n`);
    res.flushHeaders();
    res.end();
    return;
  }

  // Handle reply
  if (aiResult.action === 'reply' && aiResult.message) {
    res.write(`data: ${JSON.stringify({ status: 'reply', message: aiResult.message })}\n\n`);
    res.flushHeaders();
    res.end();
    return;
  }

  // Handle download
  if (aiResult.action === 'download' && aiResult.songQuery) {
    const queryToUse = aiResult.songQuery.trim();
    const isUrl = /^https?:\/\//i.test(queryToUse);
    const searchPrefix = isUrl ? '' : 'ytsearch1:';
    const safeQuery = queryToUse.replace(/"/g, '\\"');

    try {
      const cmdArgs = [
        '--force-overwrites',
        '--no-playlist',
        '-x', '--audio-format', 'mp3',
        '--audio-quality', '5',
        '--restrict-filenames',
        '--retries', '5',
        '--fragment-retries', '5',
        '--no-continue',
        '--abort-on-error',
        '--no-check-certificate',
        '--verbose',
        '-o', `${path.join(DOWNLOAD_DIR, '%(title)s.%(ext)s')}`,
        `${searchPrefix}${safeQuery}`
      ];

      console.log('Spawning yt-dlp with args:', cmdArgs);

      const ytProcess = spawn('/usr/local/bin/yt-dlp', cmdArgs);

      let stdoutData = '';
      ytProcess.stdout.on('data', (data) => {
        stdoutData += data.toString();
        console.log('yt-dlp stdout:', data.toString().trim());
      });

      ytProcess.stderr.on('data', (data) => {
        console.log('yt-dlp stderr:', data.toString().trim());
      });

      ytProcess.on('close', (code) => {
        console.log(`yt-dlp exited with code ${code}`);

        if (code !== 0) {
          res.write(`data: ${JSON.stringify({ status: 'error', message: 'Download failed 😔 Try again?' })}\n\n`);
          res.flushHeaders();
          res.end();
          return;
        }

        let filePath = null;

        const extractMatch = stdoutData.match(/\[ExtractAudio\] Destination: (.+)/i);
        if (extractMatch) {
          filePath = extractMatch[1].trim();
        } else {
          const allDestinations = [...stdoutData.matchAll(/Destination: (.+\.mp3)/gi)];
          if (allDestinations.length > 0) {
            filePath = allDestinations[allDestinations.length - 1][1].trim();
          }
        }

        if (!filePath && stdoutData.includes('has already been downloaded')) {
          const titleMatch = stdoutData.match(/Downloading item.*\n\[youtube\].*?: (.+)/i);
          if (titleMatch) {
            const title = titleMatch[1].trim().replace(/[^a-zA-Z0-9 -]/g, '_');
            filePath = path.join(DOWNLOAD_DIR, `${title}.mp3`);
            console.log('Reconstructed existing file:', filePath);
          }
        }

        if (!filePath) {
          console.log('Full yt-dlp output:\n', stdoutData);
          res.write(`data: ${JSON.stringify({ status: 'error', message: 'Could not find the file 😕' })}\n\n`);
          res.flushHeaders();
          res.end();
          return;
        }

        fs.access(filePath).then(() => {
          const fileName = path.basename(filePath);
          const downloadUrl = `http://localhost:${PORT}/api/file/${encodeURIComponent(fileName)}`;

          res.write(`data: ${JSON.stringify({
            status: 'success',
            message: `Song ready! Downloading "${fileName}"... 🎧`,
            downloadUrl,
            fileName
          })}\n\n`);

          // Final done signal + flush to close stream cleanly
          setTimeout(() => {
            res.write(`data: ${JSON.stringify({ status: 'done', message: 'All good! Enjoy the vibes 🔥' })}\n\n`);
            res.flushHeaders();
            res.end();
          }, 1000);

        }).catch(() => {
          res.write(`data: ${JSON.stringify({ status: 'error', message: 'File ready but not found on disk 😔' })}\n\n`);
          res.flushHeaders();
          res.end();
        });
      });

      ytProcess.on('error', (err) => {
        console.error('Spawn error:', err);
        res.write(`data: ${JSON.stringify({ status: 'error', message: 'Download tool error 😅' })}\n\n`);
        res.flushHeaders();
        res.end();
      });

    } catch (err) {
      console.error('Outer download error:', err);
      res.write(`data: ${JSON.stringify({ status: 'error', message: 'Something went wrong 😅' })}\n\n`);
      res.flushHeaders();
      res.end();
    }
  } else {
    res.write(`data: ${JSON.stringify({ status: 'error', message: 'Hmm, not sure what you mean. Want a song? 😏' })}\n\n`);
    res.flushHeaders();
    res.end();
  }
});

// Orphan cleanup every 5 minutes
setInterval(async () => {
  try {
    const files = await fs.readdir(DOWNLOAD_DIR);
    for (const file of files) {
      const fp = path.join(DOWNLOAD_DIR, file);
      const stat = await fs.stat(fp);
      if (Date.now() - stat.mtimeMs > 15 * 60 * 1000) {
        await fs.unlink(fp);
        console.log(`Orphan cleanup: ${fp}`);
      }
    }
  } catch (err) {
    console.error('Interval cleanup error:', err);
  }
}, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`RAMTECH AI Backend running on http://localhost:${PORT}`);
});