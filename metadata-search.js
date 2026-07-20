/**
 * 元信息搜索引擎
 *
 * 支持四个平台：
 *   - MusicBrainz: ISRC, composer, genre, label, release date
 *   - iTunes/Apple Music: 封面图, genre, releaseDate, track#, disc#
 *   - QQ音乐: 国内曲库补齐
 *   - 网易云音乐: genre, publisher, year（复用已有 API）
 *
 * 用法：
 *   const { searchAll, searchiTunes } = require('./metadata-search');
 *   const results = await searchAll('Blinding Lights', 'The Weeknd');
 *   // results = { musicbrainz: [...], itunes: [...], ... }
 */

'use strict';

const https = require('https');
const http = require('http');
const querystring = require('querystring');

// ============ HTTP 工具 ============

/**
 * HTTP GET with timeout & redirect support
 */
function httpGet(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const { timeout = 10000, headers = {}, followRedirect = true } = opts;
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;

    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'MusicUnlock/2.4 (metadata-enrichment; https://github.com/386tt/ncm-music-unlock)',
        'Accept': 'application/json',
        ...headers,
      },
      timeout,
    };

    const req = client.request(reqOpts, (res) => {
      // Follow redirects
      if (followRedirect && [301, 302, 303, 307, 308].includes(res.statusCode)) {
        const loc = res.headers.location;
        if (loc) return httpGet(loc, opts).then(resolve).catch(reject);
      }

      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        try {
          const json = JSON.parse(body);
          resolve({ statusCode: res.statusCode, data: json, headers: res.headers });
        } catch (e) {
          resolve({ statusCode: res.statusCode, data: body, headers: res.headers });
        }
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); });
    req.end();
  });
}

/**
 * HTTP POST with form body
 */
function httpPost(url, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const { timeout = 10000, headers = {} } = opts;
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const bodyStr = typeof body === 'string' ? body : querystring.stringify(body);

    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'User-Agent': 'MusicUnlock/2.4',
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(bodyStr),
        ...headers,
      },
      timeout,
    };

    const req = client.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const resp = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ statusCode: res.statusCode, data: JSON.parse(resp), headers: res.headers });
        } catch (e) {
          resolve({ statusCode: res.statusCode, data: resp, headers: res.headers });
        }
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); });
    req.write(bodyStr);
    req.end();
  });
}

// ============ 速率限制器 (MusicBrainz 1 req/s) ============

let lastRequestTime = 0;

async function rateLimitedRequest(fn) {
  const now = Date.now();
  const wait = Math.max(0, 1200 - (now - lastRequestTime)); // 1.2s between requests
  if (wait > 0) {
    await new Promise(r => setTimeout(r, wait));
  }
  lastRequestTime = Date.now();
  return fn();
}

// ============ 搜索结果归一化 ============

function normalizeResult(provider, data) {
  return {
    provider,
    title:       data.title       || '',
    artist:      data.artist      || '',
    album:       data.album       || '',
    albumartist: data.albumartist || '',
    year:        data.year        || '',
    genre:       data.genre       || '',
    track:       data.track       || '',
    disk:        data.disk        || '',
    composer:    data.composer    || '',
    publisher:   data.publisher   || '',
    isrc:        data.isrc        || '',
    coverUrl:    data.coverUrl    || '',
    comment:     data.comment     || '',
    providerId:  data.providerId  || '',
    providerUrl: data.providerUrl || '',
  };
}

// ============ MusicBrainz ============

/**
 * 搜索 MusicBrainz
 * API: GET https://musicbrainz.org/ws/2/recording/?query=...&fmt=json&limit=10
 * Rate limit: 1 req/sec
 */
async function searchMusicBrainz(title, artist) {
  const query = artist
    ? `artist:"${artist.replace(/"/g, '')}" AND recording:"${title.replace(/"/g, '')}"`
    : `recording:"${title.replace(/"/g, '')}"`;
  const url = `https://musicbrainz.org/ws/2/recording/?query=${encodeURIComponent(query)}&fmt=json&limit=10&inc=artist-rels+isrcs+genres+labels`;

  const res = await rateLimitedRequest(() => httpGet(url));

  if (res.statusCode !== 200 || !res.data.recordings) return [];

  return res.data.recordings.slice(0, 10).map(rec => {
    // Extract artist
    const artistName = rec['artist-credit']
      ? rec['artist-credit'].map(ac => ac.name + (ac.joinphrase || '')).join('')
      : '';

    // Extract release info from first release
    let album = '', date = '', trackNumber = '', country = '';
    const firstRel = rec.releases && rec.releases[0];
    if (firstRel) {
      album = firstRel.title || '';
      if (firstRel['release-events'] && firstRel['release-events'][0]) {
        date = firstRel['release-events'][0].date || '';
        country = firstRel['release-events'][0].area
          ? firstRel['release-events'][0].area.name : '';
      }
      if (firstRel.media && firstRel.media[0] && firstRel.media[0].tracks) {
        const t = firstRel.media[0].tracks[0];
        trackNumber = t ? (t.number || t.position || '') : '';
      }
    }

    // Extract ISRC
    const isrc = rec.isrcs && rec.isrcs[0] ? rec.isrcs[0].id : '';

    // Extract genres/tags
    const tags = rec.tags || [];
    const genre = tags.map(t => t.name).join(', ');

    // Extract label from release
    let publisher = '';
    if (firstRel && firstRel['label-info'] && firstRel['label-info'][0]) {
      publisher = firstRel['label-info'][0].label
        ? firstRel['label-info'][0].label.name : '';
    }

    // Extract composer from artist relations
    let composer = '';
    if (rec.relations) {
      composer = rec.relations
        .filter(r => r.type === 'composer' && r.artist)
        .map(r => r.artist.name)
        .join(', ');
    }

    const year = date ? date.substring(0, 4) : '';
    const coverUrl = firstRel && firstRel.id
      ? `https://coverartarchive.org/release/${firstRel.id}/front-500`
      : '';

    return normalizeResult('musicbrainz', {
      title: rec.title || '',
      artist: artistName,
      album,
      year,
      genre,
      track: trackNumber,
      composer,
      publisher,
      isrc,
      coverUrl,
      comment: country,
      providerId: rec.id || '',
      providerUrl: `https://musicbrainz.org/recording/${rec.id}`,
    });
  });
}

// ============ iTunes / Apple Music ============

/**
 * 搜索 iTunes Store
 * API: GET https://itunes.apple.com/search?term=...&media=music&entity=song&limit=15
 */
async function searchiTunes(title, artist) {
  const term = artist ? `${title} ${artist}` : title;
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=song&limit=15&country=cn`;

  let res;
  try {
    res = await httpGet(url);
  } catch (e) {
    return [];
  }

  if (res.statusCode !== 200 || !res.data.results) return [];

  // Also try with US storefront for more results
  let usResults = [];
  if (res.data.results.length < 3) {
    const usUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=song&limit=15&country=us`;
    try {
      const usRes = await httpGet(usUrl);
      if (usRes.data.results) usResults = usRes.data.results;
    } catch (e) {}
  }

  const allResults = [...res.data.results, ...usResults];
  const seen = new Set();

  return allResults.filter(r => r.kind === 'song').map(r => {
    const key = r.trackName + '|' + r.artistName;
    if (seen.has(key)) return null;
    seen.add(key);

    const coverUrl = r.artworkUrl100
      ? r.artworkUrl100.replace('100x100bb', '600x600bb')
      : '';

    const year = r.releaseDate ? r.releaseDate.substring(0, 4) : '';

    return normalizeResult('itunes', {
      title: r.trackName,
      artist: r.artistName,
      album: r.collectionName,
      albumartist: r.collectionArtistName || '',
      year,
      genre: r.primaryGenreName,
      track: r.trackNumber ? String(r.trackNumber) : '',
      disk: r.discNumber ? String(r.discNumber) : '',
      coverUrl,
      comment: r.country || '',
      providerId: String(r.trackId),
      providerUrl: r.trackViewUrl || '',
    });
  }).filter(Boolean);
}

// ============ 网易云音乐 ============

/**
 * 搜索网易云音乐
 * Step 1: POST /api/cloudsearch/pc — 搜索歌曲
 * Step 2: POST /api/v3/song/detail — 获取详情
 * Step 3: GET /api/album/{id} — 获取专辑信息（genre, publisher）
 */
async function searchNetEase(title, artist) {
  const keyword = artist ? `${artist} ${title}` : title;

  // Step 1: Search
  let searchRes;
  try {
    searchRes = await httpPost('https://music.163.com/api/cloudsearch/pc', `s=${encodeURIComponent(keyword)}&type=1&limit=10&offset=0`, {
      headers: { 'Referer': 'https://music.163.com/' },
    });
  } catch (e) {
    return [];
  }

  if (searchRes.statusCode !== 200 || !searchRes.data.result || !searchRes.data.result.songs) {
    return [];
  }

  const songs = searchRes.data.result.songs.slice(0, 8);

  // Step 2 & 3: Get detail for each song
  const results = [];
  for (const s of songs) {
    try {
      // Get song detail
      const detailRes = await httpPost('https://music.163.com/api/v3/song/detail',
        `c=${encodeURIComponent(JSON.stringify([{ id: String(s.id) }]))}`,
        { headers: { 'Referer': 'https://music.163.com/' } }
      );

      let year = '', track = '', disc = '', originComposers = '';
      if (detailRes.statusCode === 200 && detailRes.data.code === 200 &&
          detailRes.data.songs && detailRes.data.songs[0]) {
        const song = detailRes.data.songs[0];
        if (song.publishTime) year = new Date(song.publishTime).getFullYear().toString();
        if (song.no) track = String(song.no);
        if (song.cd) disc = String(song.cd);
        if (song.originSongSimpleData && song.originSongSimpleData.artists) {
          originComposers = song.originSongSimpleData.artists.map(a => a.name).join(', ');
        }
      }

      // Get album detail (genre, publisher)
      let genre = '', publisher = '', albumYear = '';
      if (s.al && s.al.id) {
        try {
          const albumRes = await httpGet(`https://music.163.com/api/album/${s.al.id}`, {
            headers: { 'Referer': 'https://music.163.com/' },
          });
          if (albumRes.statusCode === 200 && albumRes.data.code === 200 && albumRes.data.album) {
            const album = albumRes.data.album;
            if (album.tags) genre = album.tags.trim();
            if (album.company) publisher = album.company.trim();
            if (album.publishTime) albumYear = new Date(album.publishTime).getFullYear().toString();
          }
        } catch (e) {}
      }

      const coverUrl = s.al && s.al.picUrl
        ? s.al.picUrl.replace(/^http:\/\//, 'https://') + '?param=600y600'
        : '';

      results.push(normalizeResult('netease', {
        title: s.name || '',
        artist: (s.ar || []).map(a => a.name).join(', '),
        album: s.al ? s.al.name : '',
        year: albumYear || year,
        genre,
        track,
        disk: disc,
        composer: originComposers,
        publisher,
        coverUrl,
        providerId: String(s.id),
        providerUrl: `https://music.163.com/song?id=${s.id}`,
      }));
    } catch (e) {
      // skip failed song details
    }
  }

  return results;
}

// ============ QQ 音乐 ============

/**
 * 搜索 QQ 音乐（best-effort，API 可能不稳定）
 * API: GET https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=...&p=1&n=10&format=json
 */
async function searchQQMusic(title, artist) {
  const keyword = artist ? `${artist} ${title}` : title;

  let res;
  try {
    const params = querystring.stringify({
      w: keyword, p: '1', n: '10', format: 'json',
      ct: '24', cv: '0', inCharset: 'utf-8', outCharset: 'utf-8',
      aggr: '1', cr: '1', lossless: '1',
    });
    res = await httpGet(`https://c.y.qq.com/soso/fcgi-bin/client_search_cp?${params}`, {
      headers: { 'Referer': 'https://y.qq.com/' },
      timeout: 8000,
    });
  } catch (e) {
    return [];
  }

  if (res.statusCode !== 200 || !res.data.data || !res.data.data.song) return [];

  const songs = res.data.data.song.list.slice(0, 8);
  const results = [];

  for (const s of songs) {
    try {
      const artistName = (s.singer || []).map(sg => sg.name).join(', ');
      const albumName = s.album ? s.album.name : '';

      // Construct cover URL from album mid
      let coverUrl = '';
      if (s.album && s.album.mid) {
        coverUrl = `https://y.gtimg.cn/music/photo_new/T002R300x300M000${s.album.mid}.jpg?max_age=2592000`;
      }

      results.push(normalizeResult('qqmusic', {
        title: s.name || s.title || '',
        artist: artistName,
        album: albumName,
        year: '',
        genre: '',
        coverUrl,
        providerId: s.mid || String(s.id || ''),
        providerUrl: `https://y.qq.com/n/ryqq/songDetail/${s.mid}`,
      }));
    } catch (e) {}
  }

  return results;
}

// ============ 聚合搜索 ============

/**
 * 同时从所有平台搜索，聚合结果
 * @returns {Promise<{ musicbrainz: [], itunes: [], netease: [], qqmusic: [] }>}
 */
async function searchAll(title, artist, opts = {}) {
  const { providers = ['musicbrainz', 'itunes', 'netease', 'qqmusic'] } = opts;

  const tasks = {
    musicbrainz: providers.includes('musicbrainz') ? searchMusicBrainz(title, artist) : Promise.resolve([]),
    itunes:      providers.includes('itunes')      ? searchiTunes(title, artist)      : Promise.resolve([]),
    netease:     providers.includes('netease')     ? searchNetEase(title, artist)     : Promise.resolve([]),
    qqmusic:     providers.includes('qqmusic')     ? searchQQMusic(title, artist)     : Promise.resolve([]),
  };

  // Run all in parallel, collect results
  const keys = Object.keys(tasks);
  const results = await Promise.allSettled(keys.map(k => tasks[k]));

  const out = {};
  keys.forEach((k, i) => {
    out[k] = results[i].status === 'fulfilled' ? results[i].value : [];
  });

  return out;
}

/**
 * 单平台搜索（按名称）
 */
async function searchByProvider(provider, title, artist) {
  switch (provider) {
    case 'musicbrainz': return searchMusicBrainz(title, artist);
    case 'itunes':      return searchiTunes(title, artist);
    case 'netease':     return searchNetEase(title, artist);
    case 'qqmusic':     return searchQQMusic(title, artist);
    default: throw new Error(`Unknown provider: ${provider}`);
  }
}

// ============ 结果合并工具 ============

/**
 * 将所有平台的结果合并为一个平铺数组
 */
function flattenResults(results) {
  const all = [];
  for (const provider of ['musicbrainz', 'itunes', 'netease', 'qqmusic']) {
    if (results[provider]) {
      all.push(...results[provider]);
    }
  }
  return all;
}

/**
 * 将搜索结果合并到现有元信息中
 * @param {object} currentMeta - 当前元信息
 * @param {object} selected - 选中的 SearchResult
 * @returns {object} 合并后的元信息
 */
function mergeMetadata(currentMeta, selected) {
  const merged = { ...currentMeta };

  // 优先使用搜索结果的字段（如果当前为空或用户明确选择的话）
  if (selected.title && !currentMeta.title) merged.title = selected.title;
  if (selected.artist && !currentMeta.artist) merged.artist = selected.artist;
  if (selected.album) merged.album = selected.album || merged.album;
  if (selected.albumartist) merged.albumartist = selected.albumartist || merged.albumartist;
  if (selected.year) merged.year = selected.year || merged.year;
  if (selected.genre) merged.genre = selected.genre || merged.genre;
  if (selected.track) merged.track = selected.track || merged.track;
  if (selected.disk) merged.disk = selected.disk || merged.disk;
  if (selected.composer) merged.composer = selected.composer || merged.composer;
  if (selected.publisher) merged.publisher = selected.publisher || merged.publisher;
  if (selected.isrc) merged.isrc = selected.isrc || merged.isrc;
  if (selected.coverUrl) {
    merged.imageUrl = selected.coverUrl;
    merged.coverSource = selected.provider;
  }
  if (selected.comment && !currentMeta.comment) merged.comment = selected.comment;

  // 如果 artist 变了，重建 artists 数组
  if (selected.artist && selected.artist !== currentMeta.artist) {
    merged.artists = selected.artist.split(',').map(s => [s.trim()]).filter(s => s[0]);
  }

  merged.enrichSource = selected.provider;

  return merged;
}


// ============ 导出 ============

module.exports = {
  searchMusicBrainz,
  searchiTunes,
  searchNetEase,
  searchQQMusic,
  searchAll,
  searchByProvider,
  flattenResults,
  mergeMetadata,
  normalizeResult,
  // 底层 HTTP 工具（调试用）
  httpGet,
  httpPost,
};
