#!/bin/bash

echo "🔧 Installing system dependencies..."

apt-get update
apt-get install -y ffmpeg curl

echo "⬇️ Downloading yt-dlp..."

curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o yt-dlp

chmod +x yt-dlp

echo "✅ yt-dlp installed successfully"
