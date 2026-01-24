const chat = document.getElementById('chat');
const input = document.getElementById('userInput');
const sendBtn = document.getElementById('sendBtn');
const hero = document.getElementById('hero');
const themeToggle = document.getElementById('themeToggle');

// Load saved theme preference
if (localStorage.getItem('theme') === 'light') {
  document.body.classList.add('light');
  themeToggle.textContent = '☀️';
} else {
  document.body.classList.add('dark');
  themeToggle.textContent = '🌙';
}

function addMessage(content, type) {
  const msg = document.createElement('div');
  msg.className = `msg ${type}`;
  msg.innerHTML = content;
  chat.appendChild(msg);
  hero.style.display = 'none';
  chat.scrollTop = chat.scrollHeight;
}

function showTyping() {
  const typing = document.createElement('div');
  typing.className = 'msg ai typing';
  typing.innerHTML = '<span></span><span></span><span></span>';
  chat.appendChild(typing);
  chat.scrollTop = chat.scrollHeight;
  return typing;
}

function removeTyping(el) {
  if (el) el.remove();
}

// Send message
async function sendMessage() {
  const text = input.value.trim();
  if (!text) return;

  addMessage(text, 'user');
  input.value = '';

  const typingEl = showTyping();

  // Timeout if nothing happens (20 seconds)
  const timeoutId = setTimeout(() => {
    removeTyping(typingEl);
    addMessage('Hmm, taking too long... Try again? 😅', 'ai');
  }, 20000);

  let hadSuccess = false;

  try {
    const response = await fetch('https://ramtech-ai-backend.onrender.com/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text })
    });

    if (!response.body) throw new Error('No stream');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n\n').filter(Boolean);

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = JSON.parse(line.slice(6));
          removeTyping(typingEl);
          clearTimeout(timeoutId);

          // Track success to ignore temporary errors
          if (data.status === 'success' || data.downloadUrl) {
            hadSuccess = true;
          }

          // Show error only if no success followed
          if (data.status === 'error' && !hadSuccess) {
            addMessage(data.message || 'Hmm, something went wrong 😅 Try again?', 'ai');
          } else if (data.message && data.status !== 'error') {
            addMessage(data.message, 'ai');
          }

          if (data.downloadUrl) {
            const fullUrl = new URL(data.downloadUrl, 'https://ramtech-ai-backend.onrender.com').href;
            const songName = data.fileName || 'the song';

            // Auto-trigger download
            const link = document.createElement('a');
            link.href = fullUrl;
            link.download = songName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);

            // Success confirmation
            setTimeout(() => {
              addMessage(`Download successful! 🎉 "${songName}" saved to your Downloads folder 🔥`, 'ai');
            }, 1500);
          }
        }
      }
    }
  } catch (err) {
    clearTimeout(timeoutId);
    removeTyping(typingEl);
    // Only show error if no success was received
    if (!hadSuccess) {
      addMessage('Error connecting – check backend? 😔', 'ai');
    }
    console.error('Fetch error:', err);
  }
}

sendBtn.onclick = sendMessage;
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Theme toggle
themeToggle.onclick = () => {
  if (document.body.classList.contains('light')) {
    document.body.classList.remove('light');
    document.body.classList.add('dark');
    themeToggle.textContent = '🌙';
    localStorage.setItem('theme', 'dark');
  } else {
    document.body.classList.remove('dark');
    document.body.classList.add('light');
    themeToggle.textContent = '☀️';
    localStorage.setItem('theme', 'light');
  }
};