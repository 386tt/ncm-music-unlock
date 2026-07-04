/**
 * NCM 文件解密核心模块
 *
 * 实现网易云音乐 .ncm 加密文件的完整解密流程：
 * 1. 解析 NCM 文件结构（密钥区、元数据区、音频数据区）
 * 2. AES-128-ECB 解密密钥和元数据
 * 3. RC4 流密码解密音频数据
 * 4. 提取完整元信息（标题、歌手、专辑、封面图等）
 */

'use strict';

const crypto = require('crypto');
const https = require('https');
const http = require('http');

// ============ ID3v2 标签解析 ============

/**
 * 解析 MP3 文件中的 ID3v2 标签
 * 支持 v2.3 和 v2.4
 */
function parseID3v2(buffer) {
  if (buffer.length < 10) return null;
  if (buffer[0] !== 0x49 || buffer[1] !== 0x44 || buffer[2] !== 0x33) return null; // "ID3"

  const version = buffer[3];
  const flags = buffer[5];

  // 标签总大小（v2.4 使用 synchsafe 整数）
  let tagSize;
  if (version === 4) {
    tagSize = ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f);
  } else {
    tagSize = (buffer[6] << 21) | (buffer[7] << 14) | (buffer[8] << 7) | buffer[9];
  }

  let pos = 10;
  // 跳过扩展头部
  if (version === 4 && (flags & 0x40)) {
    const exSize = ((buffer[pos] & 0x7f) << 21) | ((buffer[pos+1] & 0x7f) << 14) | ((buffer[pos+2] & 0x7f) << 7) | (buffer[pos+3] & 0x7f);
    pos += 4 + exSize;
  } else if (version === 3 && (flags & 0x40)) {
    const exSize = (buffer[pos] << 24) | (buffer[pos+1] << 16) | (buffer[pos+2] << 8) | buffer[pos+3];
    pos += 4 + exSize;
  }

  const endPos = 10 + tagSize;
  const tags = {};

  while (pos + 10 <= endPos && pos + 10 <= buffer.length) {
    const frameId = String.fromCharCode(buffer[pos], buffer[pos+1], buffer[pos+2], buffer[pos+3]);
    if (frameId[0] === '\x00') break; // padding

    let frameSize;
    if (version === 4) {
      frameSize = ((buffer[pos+4] & 0x7f) << 21) | ((buffer[pos+5] & 0x7f) << 14) | ((buffer[pos+6] & 0x7f) << 7) | (buffer[pos+7] & 0x7f);
    } else {
      frameSize = (buffer[pos+4] << 24) | (buffer[pos+5] << 16) | (buffer[pos+6] << 8) | buffer[pos+7];
    }
    const frameFlags = (buffer[pos+8] << 8) | buffer[pos+9];
    pos += 10;

    if (frameSize <= 0 || pos + frameSize > buffer.length) break;

    let dataStart = pos;
    let dataLen = frameSize;
    // v2.4 的 data length indicator
    if (version === 4 && (frameFlags & 0x0001)) {
      const dli = ((buffer[pos] & 0x7f) << 21) | ((buffer[pos+1] & 0x7f) << 14) | ((buffer[pos+2] & 0x7f) << 7) | (buffer[pos+3] & 0x7f);
      dataStart = pos + 4;
      dataLen = Math.min(dli, frameSize - 4);
    }

    try {
      const enc = buffer[dataStart];
      const bodyStart = dataStart + 1;
      const bodyLen = dataLen - 1;

      // 文本帧 T***
      if (frameId[0] === 'T' && frameId !== 'TXXX') {
        let val;
        if (enc === 0x01 || enc === 0x02) {
          const bom = (buffer[bodyStart] === 0xff && buffer[bodyStart+1] === 0xfe) ? 2 : 0;
          val = buffer.slice(bodyStart + bom, bodyStart + bodyLen).toString('utf16le');
        } else if (enc === 0x03) {
          val = buffer.slice(bodyStart, bodyStart + bodyLen).toString('utf8');
        } else {
          val = buffer.slice(bodyStart, bodyStart + bodyLen).toString('latin1');
        }
        val = val.replace(/\x00/g, '').trim();
        if (val) tags[frameId] = val;
      }
      // 评论帧
      else if (frameId === 'COMM') {
        const lang = buffer.slice(bodyStart, bodyStart+3).toString();
        const descLen = Math.min(buffer[bodyStart+3] || 0, bodyLen-4);
        const commentStart = bodyStart + 4 + descLen;
        let commentText;
        if (enc === 0x03) commentText = buffer.slice(commentStart, bodyStart+bodyLen).toString('utf8');
        else commentText = buffer.slice(commentStart, bodyStart+bodyLen).toString('latin1');
        commentText = commentText.replace(/\x00/g, '').trim();
        if (commentText) tags.COMM = commentText;
      }
    } catch(e) {}

    pos += frameSize;
  }

  return {
    title: tags.TIT2 || '',
    artist: tags.TPE1 || '',
    album: tags.TALB || '',
    albumartist: tags.TPE2 || '',
    year: tags.TYER || tags.TDRC || '',
    genre: tags.TCON || '',
    track: tags.TRCK || '',
    disk: tags.TPOS || '',
    composer: tags.TCOM || '',
    publisher: tags.TPUB || '',
    copyright: tags.TCOP || '',
    comment: tags.COMM || '',
    encodedby: tags.TENC || '',
    lyricist: tags.TEXT || '',
    bpm: tags.TBPM || '',
    isrc: tags.TSRC || '',
    _raw: tags
  };
}

// ============ 常量 ============

// NCM 文件魔数 "CTENFDAM"
const MAGIC_BYTES = [0x43, 0x54, 0x45, 0x4e, 0x46, 0x44, 0x41, 0x4d];

// AES-128 密钥（用于解密密钥数据）
// crypto-js Hex.parse("687a4852416d736f356b496e62617857")
const AES_KEY_FOR_KEY_DATA = Buffer.from([
  0x68, 0x7a, 0x48, 0x52, 0x41, 0x6d, 0x73, 0x6f,
  0x35, 0x6b, 0x49, 0x6e, 0x62, 0x61, 0x78, 0x57
]);

// AES-128 密钥（用于解密元数据）
// crypto-js Hex.parse("2331346C6A6B5F215C5D2630553C2728")
const AES_KEY_FOR_META = Buffer.from([
  0x23, 0x31, 0x34, 0x6c, 0x6a, 0x6b, 0x5f, 0x21,
  0x5c, 0x5d, 0x26, 0x30, 0x55, 0x3c, 0x27, 0x28
]);

// 元数据头部标识
const META_HEADER = '163 key(Don\'t modify):';
const KEY_DATA_PREFIX = 'neteasecloudmusic';

// MIME 类型映射
const MIME_MAP = {
  'mp3': 'audio/mpeg',
  'flac': 'audio/flac',
  'm4a': 'audio/mp4',
  'ogg': 'audio/ogg',
  'wav': 'audio/wav',
  'wma': 'audio/x-ms-wma',
  'ape': 'audio/ape'
};

// 常见音频格式的特征字节
const AUDIO_SIGNATURES = {
  mp3: [[0xff, 0xfb], [0xff, 0xf3], [0xff, 0xf2], [0xff, 0xfa], [0xff, 0xfd]],
  flac: [[0x66, 0x4c, 0x61, 0x43]], // "fLaC"
  m4a: [[0x00, 0x00, 0x00]],        // ftyp box
  ogg: [[0x4f, 0x67, 0x67, 0x53]],  // "OggS"
  wav: [[0x52, 0x49, 0x46, 0x46]],  // "RIFF"
};


// ============ AES 解密辅助函数 ============

/**
 * AES-128-ECB 解密（PKCS7 padding）
 */
function aesEcbDecrypt(data, key) {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/**
 * AES-128-ECB 加密（PKCS7 padding）
 */
function aesEcbEncrypt(data, key) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}


// ============ NCM 密钥盒（RC4 变体）============

/**
 * 生成 NCM 密钥盒
 *
 * 基于 RC4 的变体算法：
 * 1. 初始化 S-box [0..255]
 * 2. 使用密钥数据进行 KSA (Key-Scheduling Algorithm)
 * 3. 通过自定义映射生成最终的 256 字节密钥盒
 */
function createKeyBox(keyData) {
  // 初始化 S-box
  const sBox = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    sBox[i] = i;
  }

  // RC4 KSA（变量名保留了原始风格）
  const keyLen = keyData.length;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (sBox[i] + j + keyData[i % keyLen]) & 0xff;
    // swap sBox[i] and sBox[j]
    const tmp = sBox[i];
    sBox[i] = sBox[j];
    sBox[j] = tmp;
  }

  // 生成密钥盒映射
  const keyBox = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const idx = (i + 1) & 0xff;
    const n = sBox[idx];
    const m = sBox[(idx + n) & 0xff];
    keyBox[i] = sBox[(n + m) & 0xff];
  }

  return keyBox;
}


// ============ 音频格式检测 ============

/**
 * 检测音频数据的实际格式
 * 通过检查文件头特征字节来判断
 */
function detectAudioFormat(buffer) {
  for (const [format, signatures] of Object.entries(AUDIO_SIGNATURES)) {
    for (const sig of signatures) {
      if (buffer.length >= sig.length) {
        let match = true;
        for (let i = 0; i < sig.length; i++) {
          if (buffer[i] !== sig[i]) {
            match = false;
            break;
          }
        }
        if (match) return format;
      }
    }
  }
  return 'mp3'; // 默认回退到 mp3
}


// ============ 图片下载 ============

/**
 * 从 URL 下载图片
 */
function downloadImage(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;

    client.get(url, { timeout: 15000 }, (res) => {
      // 处理重定向
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadImage(res.headers.location).then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        return reject(new Error(`下载图片失败，HTTP ${res.statusCode}`));
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}


// ============ NCM 解密器类 ============

class NcmDecryptor {
  /**
   * @param {Buffer} raw - NCM 文件的原始数据
   * @param {string} filename - 原始文件名（用于回退标题/歌手信息）
   */
  constructor(raw, filename) {
    this.raw = raw;
    this.filename = filename;
    this.offset = 0;

    // 解密过程中填充
    this.oriMeta = null;     // 原始元数据
    this.newMeta = null;     // 新元数据（处理后）
    this.audio = null;       // 解密后的音频数据
    this.format = '';         // 音频格式 (mp3/flac/m4a/...)
    this.mime = '';           // MIME 类型
    this.imageBuffer = null;  // 封面图片数据
    this.imageUrl = null;     // 封面图片 URL
  }

  // ---- 文件结构解析 ----

  /**
   * 验证文件魔数
   */
  _checkMagic() {
    const header = this.raw.slice(0, 8);
    for (let i = 0; i < MAGIC_BYTES.length; i++) {
      if (header[i] !== MAGIC_BYTES[i]) {
        throw new Error('此 NCM 文件已损坏（魔数不匹配）');
      }
    }
    this.offset = 10; // 跳过魔数(8) + 2字节保留区
  }

  /**
   * 读取并解密密钥数据
   * 结构：[4字节长度][XOR 0x64 后的 AES 密文]
   * 解密后跳过 "neteasecloudmusic" 前缀（17字节）
   */
  _getKeyData() {
    const keyLen = this.raw.readUInt32LE(this.offset);
    this.offset += 4;

    if (keyLen <= 0 || keyLen > 1024 || this.offset + keyLen > this.raw.length) {
      throw new Error(`密钥数据长度异常：${keyLen}（文件总长 ${this.raw.length}）`);
    }

    // XOR 解密（用 0x64）
    const xorData = Buffer.alloc(keyLen);
    for (let i = 0; i < keyLen; i++) {
      xorData[i] = this.raw[this.offset + i] ^ 0x64;
    }
    this.offset += keyLen;

    // AES-128-ECB 解密
    const decrypted = aesEcbDecrypt(xorData, AES_KEY_FOR_KEY_DATA);

    // 跳过前17字节 "neteasecloudmusic"
    return decrypted.slice(KEY_DATA_PREFIX.length);
  }

  /**
   * 生成密钥盒
   */
  _getKeyBox() {
    const keyData = this._getKeyData();
    return createKeyBox(keyData);
  }

  /**
   * 读取并解密元数据
   * 结构：[4字节长度][XOR 0x63 后的密文]
   * 密文前22字节为 "163 key(Don't modify):"，后续为 Base64 编码的 AES 密文
   */
  _getMetaData() {
    const metaLen = this.raw.readUInt32LE(this.offset);
    this.offset += 4;

    if (metaLen === 0) {
      return {};
    }

    if (metaLen < 0 || metaLen > 10 * 1024 * 1024 || this.offset + metaLen > this.raw.length) {
      console.warn(`元数据长度异常：${metaLen}，将尝试回退到空元数据`);
      return {};
    }

    // XOR 解密（用 0x63）
    const xorData = Buffer.alloc(metaLen);
    for (let i = 0; i < metaLen; i++) {
      xorData[i] = this.raw[this.offset + i] ^ 0x63;
    }
    this.offset += metaLen;

    // 跳过前 22 字节头部，剩余部分为 Base64（或 Hex）编码的 AES 密文
    const metaBody = xorData.slice(META_HEADER.length);
    let ciphertext = null;

    // 尝试 Base64 解码（大多数 NCM 文件使用此格式）
    try {
      const b64Str = metaBody.toString('utf8').trim();
      ciphertext = Buffer.from(b64Str, 'base64');
      // 验证：密文长度必须是 16 的倍数
      if (ciphertext.length < 16 || ciphertext.length % 16 !== 0) {
        ciphertext = null;
      }
    } catch (e) {
      ciphertext = null;
    }

    // 回退：尝试 Hex 解码
    if (!ciphertext) {
      try {
        const hexStr = metaBody.toString('utf8').replace(/[^0-9a-fA-F]/g, '');
        if (hexStr.length >= 32 && hexStr.length % 32 === 0) {
          ciphertext = Buffer.from(hexStr, 'hex');
        }
      } catch (e) {
        ciphertext = null;
      }
    }

    // 回退：直接当作原始二进制密文
    if (!ciphertext) {
      console.warn('无法解码元数据密文，将返回空元数据');
      return {};
    }

    try {
      // AES-128-ECB 解密
      const decrypted = aesEcbDecrypt(ciphertext, AES_KEY_FOR_META).toString('utf8');

      // 解析 JSON
      const colonIdx = decrypted.indexOf(':');
      if (colonIdx <= 0) {
        console.warn('元数据格式异常，将返回空元数据');
        return {};
      }
      const type = decrypted.slice(0, colonIdx);
      let rawMeta;

      if (type === 'dj') {
        // DJ 模式：外层是 DJ 信息，内层 mainMusic 才是实际音乐信息
        const outer = JSON.parse(decrypted.slice(colonIdx + 1));
        rawMeta = outer.mainMusic || {};
      } else {
        // 普通模式：music:... 或直接 JSON
        rawMeta = JSON.parse(decrypted.slice(colonIdx + 1));
      }

      // 修复封面图 URL：强制 HTTPS 并添加尺寸参数
      if (rawMeta.albumPic) {
        rawMeta.albumPic = rawMeta.albumPic.replace(/^http:\/\//, 'https://') + '?param=500y500';
      }

      return rawMeta;
    } catch (e) {
      console.warn('元数据解密/解析失败：', e.message);
      return {};
    }
  }

  /**
   * 解密音频数据
   * 跳过 CRC 校验区和专辑图片数据区，然后对剩余数据按字节异或解密
   */
  _getAudio(keyBox) {
    // 跳过 CRC 区（5字节）+ 图片数据区（长度在 offset+5 的 uint32 中）
    // 总跳过 = 13 + getUint32(offset+5)
    // 安全检查：确保 offset+5 在有效范围内
    if (this.offset + 9 <= this.raw.length) {
      const skipLen = this.raw.readUInt32LE(this.offset + 5);
      this.offset += skipLen + 13;
    }
    // 确保 offset 不越界
    if (this.offset >= this.raw.length) {
      throw new Error('无法定位音频数据：NCM 文件可能已损坏');
    }

    // 获取剩余数据作为加密的音频
    const encrypted = this.raw.slice(this.offset);

    // 使用密钥盒解密
    const decrypted = Buffer.alloc(encrypted.length);
    for (let i = 0; i < encrypted.length; i++) {
      decrypted[i] = encrypted[i] ^ keyBox[i & 0xff];
    }

    return decrypted;
  }

  // ---- 元数据处理 ----

  /**
   * 从文件名提取标题和艺术家信息（回退方案）
   * 常见文件名格式：歌手 - 歌名
   */
  _parseFilename() {
    // 移除扩展名
    let name = this.filename.replace(/\.(ncm|mp3|flac|m4a|ogg|wav|ape|wma)$/i, '');

    // 尝试 "歌手 - 歌名" 格式
    const separatorPatterns = [' - ', ' — ', '-', '—'];
    let artist = '';
    let title = name;

    for (const sep of separatorPatterns) {
      const idx = name.indexOf(sep);
      if (idx > 0 && idx < name.length - sep.length) {
        artist = name.slice(0, idx).trim();
        title = name.slice(idx + sep.length).trim();
        break;
      }
    }

    return { title, artist };
  }

  /**
   * 构建新的元数据
   * 从 NCM JSON 元数据 + 解密后音频的 ID3 标签中提取所有字段
   */
  async _buildMeta() {
    if (!this.oriMeta) {
      throw new Error('元数据未读取');
    }

    // 解析解密后音频中的 ID3v2 标签
    const id3Tags = parseID3v2(this.audio) || {};

    // 解析文件名
    const fallback = this._parseFilename();

    // 合并：ID3 标签 > NCM JSON > 文件名回退
    const title = id3Tags.title || this.oriMeta.musicName || fallback.title;

    // 歌手信息
    let artists = [];
    if (typeof this.oriMeta.artist === 'string') {
      artists = [[this.oriMeta.artist]];
    } else if (Array.isArray(this.oriMeta.artist)) {
      for (const item of this.oriMeta.artist) {
        if (typeof item === 'string') artists.push([item]);
        else if (Array.isArray(item) && item.length > 0) artists.push([item[0]]);
      }
    }
    if (artists.length === 0 && id3Tags.artist) {
      artists = id3Tags.artist.split(';').map(s => [s.trim()]).filter(s => s[0]);
    }
    if (artists.length === 0 && fallback.artist) {
      artists = fallback.artist.split(',').map(s => [s.trim()]).filter(s => s[0]);
    }
    const artistStr = artists.map(a => (Array.isArray(a) ? a[0] : a)).filter(Boolean).join('; ');

    // 下载封面图
    this.imageUrl = null;
    this.imageBuffer = null;
    if (this.oriMeta.albumPic) {
      try {
        this.imageBuffer = await downloadImage(this.oriMeta.albumPic);
        this.imageUrl = this.oriMeta.albumPic;
      } catch (err) {
        console.warn(`  ⚠ 封面图下载失败: ${err.message}`);
      }
    }

    // 检测实际音频格式
    if (this.audio) {
      this.format = this.oriMeta.format || detectAudioFormat(this.audio);
    }

    this.newMeta = {
      title: title,
      artists: artists,
      artist: artistStr,
      album: this.oriMeta.album || id3Tags.album || '',
      albumartist: id3Tags.albumartist || artistStr,
      year: id3Tags.year || '',
      genre: id3Tags.genre || '',
      track: id3Tags.track || '',
      disk: id3Tags.disk || '',
      composer: id3Tags.composer || '',
      publisher: id3Tags.publisher || '',
      copyright: id3Tags.copyright || '',
      comment: id3Tags.comment || '',
      isrc: id3Tags.isrc || '',
      bpm: id3Tags.bpm || '',
      picture: this.imageBuffer,
      id3Tags: id3Tags,
    };
  }

  // ---- 主解密流程 ----

  /**
   * 执行完整的解密流程
   *
   * @returns {Promise<object>} 解密结果对象
   */
  async decrypt() {
    // 1. 验证文件格式
    this._checkMagic();
    console.log('  1/5 验证文件魔数 ✓');

    // 2. 生成密钥盒
    const keyBox = this._getKeyBox();
    console.log('  2/5 生成解密密钥 ✓');

    // 3. 读取元数据
    this.oriMeta = this._getMetaData();
    console.log('  3/5 提取原始元数据 ✓');
    if (this.oriMeta.musicName) {
      console.log(`     - 标题: ${this.oriMeta.musicName}`);
    }
    if (this.oriMeta.artist) {
      const artist = Array.isArray(this.oriMeta.artist)
        ? this.oriMeta.artist.map(a => Array.isArray(a) ? a[0] : a).join(', ')
        : this.oriMeta.artist;
      console.log(`     - 歌手: ${artist}`);
    }
    if (this.oriMeta.album) {
      console.log(`     - 专辑: ${this.oriMeta.album}`);
    }

    // 4. 解密音频数据
    this.audio = this._getAudio(keyBox);
    console.log(`  4/5 解密音频数据 ✓ (${(this.audio.length / 1024 / 1024).toFixed(2)} MB)`);

    // 5. 构建元数据
    await this._buildMeta();
    console.log('  5/5 构建元数据 ✓');

    return this._gatherResult();
  }

  /**
   * 收集解密结果
   */
  _gatherResult() {
    if (!this.newMeta || !this.audio) {
      throw new Error('解密流程未完成');
    }

    return {
      title: this.newMeta.title,
      artist: this.newMeta.artist,
      artists: this.newMeta.artists,
      album: this.newMeta.album,
      albumartist: this.newMeta.albumartist,
      year: this.newMeta.year,
      genre: this.newMeta.genre,
      track: this.newMeta.track,
      disk: this.newMeta.disk,
      composer: this.newMeta.composer,
      publisher: this.newMeta.publisher,
      copyright: this.newMeta.copyright,
      comment: this.newMeta.comment,
      isrc: this.newMeta.isrc,
      bpm: this.newMeta.bpm,
      format: this.format,
      mime: MIME_MAP[this.format] || 'audio/mpeg',
      image: this.newMeta.picture,
      imageUrl: this.imageUrl,
      audio: this.audio,
      rawMeta: this.oriMeta,
      id3Tags: this.newMeta.id3Tags,
    };
  }
}


// ============ 导出 ============

module.exports = {
  NcmDecryptor,
  createKeyBox,
  detectAudioFormat,
  MIME_MAP,
  downloadImage,
  // 常量导出供外部使用
  MAGIC_BYTES,
  AES_KEY_FOR_KEY_DATA,
  AES_KEY_FOR_META,
};
