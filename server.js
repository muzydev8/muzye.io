const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Locate yt-dlp binary (checks D:\Project\yt-dlp.exe first, then node_modules, then global)
function getYtDlpPath() {
  const localExe = path.join(__dirname, 'yt-dlp.exe');
  if (fs.existsSync(localExe)) return localExe;

  const moduleExe = path.join(__dirname, 'node_modules', 'yt-dlp-exec', 'bin', 'yt-dlp.exe');
  if (fs.existsSync(moduleExe)) return moduleExe;

  return 'yt-dlp';
}

const YTDLP_BIN = getYtDlpPath();

// Promise wrapper with 50MB buffer so 4K/60FPS metadata never crashes
function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    execFile(
      YTDLP_BIN,
      args,
      { maxBuffer: 1024 * 1024 * 50, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          return reject(new Error(stderr || error.message));
        }
        resolve(stdout);
      }
    );
  });
}

// Temporary downloads folder for merging 2K/4K 60FPS video + audio
const TEMP_DIR = path.join(os.tmpdir(), 'yoinks-downloads');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return 'Auto Size';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(1)} MB`;
}

// 1. Fetch Video Metadata & 480p - 4K 60FPS Tiers
app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'Please paste a valid video URL.' });
  }

  try {
    const stdout = await runYtDlp([
      url,
      '--dump-single-json',
      '--no-playlist',
      '--no-check-certificates',
      '--no-warnings',
      '--geo-bypass'
    ]);

    const info = JSON.parse(stdout);
    const rawFormats = info.formats || [];

    const findTierMeta = (maxHeight) => {
      const candidates = rawFormats.filter(
        (f) => f.height && f.height <= maxHeight && f.vcodec !== 'none'
      );
      if (candidates.length === 0) return { available: true, fps: 30, size: 'Ready' };

      candidates.sort((a, b) => {
        if ((b.height || 0) !== (a.height || 0)) return (b.height || 0) - (a.height || 0);
        if ((b.fps || 0) !== (a.fps || 0)) return (b.fps || 0) - (a.fps || 0);
        return (b.filesize || b.filesize_approx || 0) - (a.filesize || a.filesize_approx || 0);
      });

      const best = candidates[0];
      const estBytes = (best.filesize || best.filesize_approx || 0) * 1.12;

      return {
        available: true,
        actualHeight: best.height,
        fps: best.fps || 30,
        size: estBytes > 0 ? formatBytes(estBytes) : 'HD Stream'
      };
    };

    const tiers = [
      {
        id: '2160p60',
        label: '4K Ultra HD',
        resolution: '2160p',
        badge: '4K • 60FPS',
        ext: 'mp4',
        ...findTierMeta(2160)
      },
      {
        id: '1440p60',
        label: '2K Quad HD',
        resolution: '1440p',
        badge: '2K • 60FPS',
        ext: 'mp4',
        ...findTierMeta(1440)
      },
      {
        id: '1080p60',
        label: 'Full HD',
        resolution: '1080p',
        badge: '1080p • 60FPS',
        ext: 'mp4',
        ...findTierMeta(1080)
      },
      {
        id: '720p60',
        label: 'HD Ready',
        resolution: '720p',
        badge: '720p • 60FPS',
        ext: 'mp4',
        ...findTierMeta(720)
      },
      {
        id: '480p',
        label: 'Standard',
        resolution: '480p',
        badge: '480p • Fast',
        ext: 'mp4',
        ...findTierMeta(480)
      },
      {
        id: 'mp3',
        label: 'Audio Only (MP3)',
        resolution: '320kbps',
        badge: 'HQ AUDIO',
        ext: 'mp3',
        available: true,
        fps: null,
        size: 'Audio Track'
      }
    ];

    res.json({
      title: info.title || 'Untitled Media',
      thumbnail: info.thumbnail || '',
      duration:
        info.duration_string ||
        (info.duration
          ? `${Math.floor(info.duration / 60)}:${String(Math.floor(info.duration % 60)).padStart(2, '0')}`
          : 'Clip'),
      uploader: info.uploader || info.channel || 'Creator',
      platform: (info.extractor_key || info.extractor || 'WEB').toUpperCase(),
      webpage_url: info.webpage_url || url,
      tiers
    });
  } catch (err) {
    console.error('Extractor Error:', err.message);
    res.status(500).json({
      error: `Failed to fetch URL. Make sure yt-dlp.exe is in D:\\Project. Details: ${err.message.split('\n')[0]}`
    });
  }
});

// 2. Download & Merge High-Res 60FPS Video + Audio via yt-dlp & FFmpeg
app.get('/api/download', async (req, res) => {
  const { url, tier, title } = req.query;
  if (!url) return res.status(400).send('Missing video URL');

  const safeTitle =
    (title || 'yoinks_video')
      .replace(/[^a-zA-Z0-9_\-\s]/g, '')
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, 60) || 'yoinks_media';

  const uniqueId = crypto.randomBytes(4).toString('hex');
  const isAudio = tier === 'mp3';
  const ext = isAudio ? 'mp3' : 'mp4';
  const outputFileName = `${safeTitle}_${tier || '1080p60'}_${uniqueId}.${ext}`;
  const outputPath = path.join(TEMP_DIR, outputFileName);

  const formatMap = {
    '2160p60': 'bestvideo[height<=2160][fps<=60]+bestaudio/bestvideo[height<=2160]+bestaudio/best[height<=2160]/best',
    '1440p60': 'bestvideo[height<=1440][fps<=60]+bestaudio/bestvideo[height<=1440]+bestaudio/best[height<=1440]/best',
    '1080p60': 'bestvideo[height<=1080][fps<=60]+bestaudio/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best',
    '720p60': 'bestvideo[height<=720][fps<=60]+bestaudio/bestvideo[height<=720]+bestaudio/best[height<=720]/best',
    '480p': 'bestvideo[height<=480]+bestaudio/best[height<=480]/best'
  };

  try {
    const args = [
      url,
      '--no-playlist',
      '--no-check-certificates',
      '--no-warnings',
      '--ffmpeg-location',
      ffmpegPath,
      '-o',
      outputPath
    ];

    if (isAudio) {
      args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
    } else {
      args.push('-f', formatMap[tier] || formatMap['1080p60'], '--merge-output-format', 'mp4');
    }

    await runYtDlp(args);

    if (!fs.existsSync(outputPath)) {
      return res.status(500).send('File processing failed on server.');
    }

    res.download(outputPath, `${safeTitle}_${tier}.${ext}`, (err) => {
      fs.unlink(outputPath, () => {});
      if (err) console.error('Send error:', err.message);
    });
  } catch (error) {
    console.error('Download Error:', error.message);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    res.status(500).send('Failed to download and merge video stream.');
  }
});

// 3. Get 1800+ Supported Platforms Count & List
let cachedExtractors = null;
app.get('/api/extractors', async (req, res) => {
  try {
    if (!cachedExtractors) {
      const stdout = await runYtDlp(['--list-extractors']);
      cachedExtractors = stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s && !s.includes(' '));
    }
    res.json({
      count: cachedExtractors.length,
      sample: cachedExtractors.slice(0, 300)
    });
  } catch (e) {
    res.json({
      count: 1842,
      sample: [
        'YouTube', 'TikTok', 'Instagram', 'Twitter/X', 'Threads',
        'Facebook', 'Reddit', 'Twitch', 'Vimeo', 'SoundCloud',
        'Dailymotion', 'Bilibili', 'Pinterest', 'LinkedIn', 'Rumble'
      ]
    });
  }
});

app.listen(PORT, () => {
  console.log(`\n┌──────────────────────────────────────────────────────────┐`);
  console.log(`│  ⚡ YOINKS WEB SERVER RUNNING AT: http://localhost:${PORT}  │`);
  console.log(`│  🔧 Using Binary: ${path.basename(YTDLP_BIN)}                            │`);
  console.log(`└──────────────────────────────────────────────────────────┘\n`);
});