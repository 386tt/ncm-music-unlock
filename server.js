/**
 * 音乐解锁本地服务器
 *
 * 功能：
 * 1. 提供 HTML GUI 界面（支持 NCM + QMC/QQ音乐）
 * 2. 代理网易云 API 请求（解决浏览器 CORS 限制）
 * 3. 获取完整元数据（流派、年份、发行方、作曲者 等）
 *
 * 用法：
 *   node server.js
 *   然后浏览器打开 http://localhost:3456
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3456;

// ============ 网易云 API 代理 ============

/**
 * 获取歌曲详情（含 publishTime、artists、albumId 等）
 */
function fetchSongDetail(songId) {
  return neteaseRequest(
    '/api/v3/song/detail',
    'POST',
    `c=[{"id":"${songId}"}]`,
    { 'Content-Type': 'application/x-www-form-urlencoded' }
  );
}

/**
 * 获取专辑详情（含 genre/tags、company/发行方、subType 等）
 */
function fetchAlbumDetail(albumId) {
  return neteaseRequest('/api/album/' + albumId);
}

/**
 * 下载图片并返回 Buffer
 */
function downloadImage(imageUrl) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(imageUrl);
    const client = parsed.protocol === 'https:' ? https : http;

    client.get(imageUrl, { timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadImage(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function neteaseRequest(apiPath, method, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'music.163.com',
      port: 443,
      path: apiPath,
      method: method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://music.163.com/',
        'Accept': 'application/json, text/plain, */*',
        ...(extraHeaders || {}),
      },
    };

    if (body) {
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          resolve(data);
        } catch (e) {
          reject(new Error('JSON 解析失败'));
        }
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('请求超时')); });

    if (body) req.write(body);
    req.end();
  });
}

// ============ API 路由 ============

async function handleAPI(reqPath, res) {
  try {
    // GET /api/metadata?musicId=xxx
    if (reqPath.startsWith('/api/metadata')) {
      const parsed = url.parse(reqPath, true);
      const musicId = parsed.query.musicId;

      if (!musicId) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: '缺少 musicId 参数' }));
        return;
      }

      const result = { musicId, source: 'netease' };

      // 并行获取歌曲和专辑信息
      try {
        const songData = await fetchSongDetail(musicId);

        if (songData.code === 200 && songData.songs && songData.songs[0]) {
          const song = songData.songs[0];

          // 基础信息
          result.title = song.name;
          result.artists = (song.ar || []).map(a => a.name);

          // 年份
          if (song.publishTime) {
            result.publishTime = song.publishTime;
            result.year = new Date(song.publishTime).getFullYear().toString();
          }

          // 碟号 / 音轨号
          if (song.cd) result.disc = song.cd;
          if (song.no) result.track = song.no;

          // 封面
          if (song.al && song.al.picUrl) {
            result.coverUrl = song.al.picUrl + '?param=500y500';
          }

          // 专辑信息
          if (song.al) {
            result.album = song.al.name;
            const albumId = song.al.id;

            if (albumId) {
              try {
                const albumData = await fetchAlbumDetail(albumId);
                if (albumData.code === 200 && albumData.album) {
                  const album = albumData.album;

                  // 流派（从 tags 字段）
                  if (album.tags && album.tags.trim()) {
                    result.genre = album.tags.trim();
                  }

                  // 风格子类型
                  if (album.subType) {
                    result.subType = album.subType;
                    if (!result.genre) result.genre = album.subType;
                  }

                  // 发行方 / 唱片公司
                  if (album.company && album.company.trim()) {
                    result.publisher = album.company.trim();
                  }

                  // 发行年份（专辑的，更准确）
                  if (album.publishTime && !result.year) {
                    result.year = new Date(album.publishTime).getFullYear().toString();
                  }

                  // 专辑描述
                  if (album.description && album.description.trim()) {
                    result.description = album.description.trim();
                  }
                }
              } catch (e) {
                // 专辑 API 失败不影响整体
              }
            }
          }

          // 原曲信息（翻唱歌曲的作曲者信息）
          if (song.originSongSimpleData) {
            const orig = song.originSongSimpleData;
            const origInfo = {};
            if (orig.name) origInfo.name = orig.name;
            if (orig.artists && orig.artists.length > 0) {
              origInfo.artists = orig.artists.map(a => a.name);
            }
            if (orig.albumMeta && orig.albumMeta.name) {
              origInfo.album = orig.albumMeta.name;
            }
            if (Object.keys(origInfo).length > 0) {
              result.originSong = origInfo;
            }
          }
        }
      } catch (e) {
        result.error = 'API 请求失败: ' + e.message;
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result, null, 2));
      return;
    }

    // GET /api/search?q=关键词&provider=all|musicbrainz|itunes|netease|qqmusic
    if (reqPath.startsWith('/api/search')) {
      const parsed = url.parse(reqPath, true);
      const q = parsed.query.q || '';
      const provider = parsed.query.provider || 'all';

      if (!q.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '缺少 q 参数（搜索关键词）' }));
        return;
      }

      const { searchByProvider, searchAll } = require('./metadata-search');
      let results;

      if (provider === 'all') {
        results = await searchAll(q);
      } else {
        const items = await searchByProvider(provider, q);
        results = { [provider]: items };
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ provider, results }));
      return;
    }

    // GET /api/proxy/image?url=... — 代理下载封面图
    if (reqPath.startsWith('/api/proxy/image')) {
      const parsed = url.parse(reqPath, true);
      const imageUrl = parsed.query.url;

      if (!imageUrl) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: '缺少 url 参数' }));
        return;
      }

      try {
        const imgData = await downloadImage(imageUrl);
        // 检测 MIME 类型
        let contentType = 'image/jpeg';
        if (imgData[0] === 0x89 && imgData[1] === 0x50) contentType = 'image/png';
        else if (imgData[0] === 0x47 && imgData[1] === 0x49) contentType = 'image/gif';
        else if (imgData[0] === 0x52 && imgData[1] === 0x49) contentType = 'image/webp';

        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': imgData.length,
          'Cache-Control': 'public, max-age=86400',
        });
        res.end(imgData);
      } catch (e) {
        res.writeHead(502);
        res.end(JSON.stringify({ error: '图片下载失败: ' + e.message }));
      }
      return;
    }

    // 404
    res.writeHead(404);
    res.end('Not Found');
  } catch (e) {
    console.error('API error:', e);
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ============ 静态文件服务 ============

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.json': 'application/json',
};

function serveStatic(reqPath, res) {
  let filePath;

  if (reqPath === '/' || reqPath === '/index.html') {
    filePath = path.join(__dirname, 'unlock.html');
  } else {
    filePath = path.join(__dirname, reqPath);
  }

  // 安全检查：防止目录遍历
  const normalized = path.normalize(filePath);
  if (!normalized.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const stat = fs.statSync(normalized);
    if (!stat.isFile()) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const ext = path.extname(normalized).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });

    fs.createReadStream(normalized).pipe(res);
  } catch (e) {
    res.writeHead(404);
    res.end('Not Found');
  }
}

/**
 * 提供 node_modules 中的文件（用于 QMC WASM 等资源）
 */
function serveNodeModules(res, relPath) {
  const filePath = path.join(__dirname, 'node_modules', relPath);
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    let contentType = 'application/octet-stream';
    if (relPath.endsWith('.wasm')) contentType = 'application/wasm';
    else if (relPath.endsWith('.js')) contentType = 'application/javascript';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=3600',
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    res.writeHead(404);
    res.end('Not Found');
  }
}

// ============ 启动服务器 ============

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url);
  const reqPath = parsed.pathname;

  // 为浏览器提供 QMC WASM 和 Legacy JS 文件
  if (reqPath.endsWith('/QmcWasm.wasm') || reqPath.endsWith('/QmcLegacy.js') || reqPath.endsWith('/QmcWasmBundle.js')) {
    const wasmFile = reqPath.split('/').pop();
    serveNodeModules(res, `@xhacker/qmcwasm/${wasmFile}`);
    return;
  }

  if (reqPath.startsWith('/api/')) {
    handleAPI(reqPath + (parsed.search || ''), res);
  } else {
    serveStatic(reqPath, res);
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ╔═══════════════════════════════════╗');
  console.log('  ║   音乐解锁 v2.3                  ║');
  console.log('  ║   本地服务器已启动                ║');
  console.log('  ╚═══════════════════════════════════╝');
  console.log('');
  console.log(`  打开浏览器访问:  http://localhost:${PORT}`);
  console.log('');
  console.log('  支持功能：');
  console.log('  - 拖拽 .ncm 文件解锁（网易云音乐）');
  console.log('  - 拖拽 .qmc* / .mflac / .mgg 文件解锁（QQ 音乐）');
  console.log('  - 自动获取网易云完整元数据');
  console.log('    （流派、年份、发行方、作曲者 等）');
  console.log('  - 元数据写回 MP3/FLAC 文件');
  console.log('');
  console.log('  按 Ctrl+C 停止服务器');
  console.log('');
});
