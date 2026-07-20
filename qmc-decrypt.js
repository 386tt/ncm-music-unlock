/**
 * QMC 文件解密核心模块
 *
 * 支持格式：
 *   - QMCv1 Static: .qmc0 .qmc1 .qmc3 .qmcmp3 .qmcflac .qmcogg
 *   - QMCv2 MapCipher/RC4: .mflac .mgg
 *   - QMCv2 musicex: 新版 .mflac/.mgg 内嵌 ekey 格式
 *
 * 优先使用 @xhacker/qmcwasm WASM 引擎，失败后回退到纯 JS 实现
 */

'use strict';

const fs = require('fs');
const path = require('path');

let QmcCryptoModule;
try {
  QmcCryptoModule = require('@xhacker/qmcwasm');
} catch (e) {
  try {
    QmcCryptoModule = require('@xhacker/qmcwasm/QmcLegacy.js');
  } catch (e2) {
    // 引擎不可用，将使用纯 JS 回退
  }
}

// ============ MapCipher 实现 ============

// 静态密码表 (QMCv1 Static Cipher)
const STATIC_CIPHER_BOX = new Uint8Array([
  0x77, 0x48, 0x32, 0x73, 0xDE, 0xF2, 0xC0, 0xC8,
  0x95, 0xEC, 0x30, 0xB2, 0x51, 0xC3, 0xE1, 0xA0,
  0x9E, 0xE6, 0x9D, 0xCF, 0xFA, 0x7F, 0x14, 0xD1,
  0xCE, 0xB8, 0xDC, 0xC3, 0x4A, 0x67, 0x93, 0xD6,
  0x28, 0xC2, 0x91, 0x70, 0xCA, 0x8D, 0xA2, 0xA4,
  0xF0, 0x08, 0x61, 0x90, 0x7E, 0x6F, 0xA2, 0xE0,
  0xEB, 0xAE, 0x3E, 0xB6, 0x67, 0xC7, 0x92, 0xF4,
  0x91, 0xB5, 0xF6, 0x6C, 0x5E, 0x84, 0x40, 0xF7,
  0xF3, 0x1B, 0x02, 0x7F, 0xD5, 0xAB, 0x41, 0x89,
  0x28, 0xF4, 0x25, 0xCC, 0x52, 0x11, 0xAD, 0x43,
  0x68, 0xA6, 0x41, 0x8B, 0x84, 0xB5, 0xFF, 0x2C,
  0x92, 0x4A, 0x26, 0xD8, 0x47, 0x6A, 0x7C, 0x95,
  0x61, 0xCC, 0xE6, 0xCB, 0xBB, 0x3F, 0x47, 0x58,
  0x89, 0x75, 0xC3, 0x75, 0xA1, 0xD9, 0xAF, 0xCC,
  0x08, 0x73, 0x17, 0xDC, 0xAA, 0x9A, 0xA2, 0x16,
  0x41, 0xD8, 0xA2, 0x06, 0xC6, 0x8B, 0xFC, 0x66,
  0x34, 0x9F, 0xCF, 0x18, 0x23, 0xA0, 0x0A, 0x74,
  0xE7, 0x2B, 0x27, 0x70, 0x92, 0xE9, 0xAF, 0x37,
  0xE6, 0x8C, 0xA7, 0xBC, 0x62, 0x65, 0x9C, 0xC2,
  0x08, 0xC9, 0x88, 0xB3, 0xF3, 0x43, 0xAC, 0x74,
  0x2C, 0x0F, 0xD4, 0xAF, 0xA1, 0xC3, 0x01, 0x64,
  0x95, 0x4E, 0x48, 0x9F, 0xF4, 0x35, 0x78, 0x95,
  0x7A, 0x39, 0xD6, 0x6A, 0xA0, 0x6D, 0x40, 0xE8,
  0x4F, 0xA8, 0xEF, 0x11, 0x1D, 0xF3, 0x1B, 0x3F,
  0x3F, 0x07, 0xDD, 0x6F, 0x5B, 0x19, 0x30, 0x19,
  0xFB, 0xEF, 0x0E, 0x37, 0xF0, 0x0E, 0xCD, 0x16,
  0x49, 0xFE, 0x53, 0x47, 0x13, 0x1A, 0xBD, 0xA4,
  0xF1, 0x40, 0x19, 0x60, 0x0E, 0xED, 0x68, 0x09,
  0x06, 0x5F, 0x4D, 0xCF, 0x3D, 0x1A, 0xFE, 0x20,
  0x77, 0xE4, 0xD9, 0xDA, 0xF9, 0xA4, 0x2B, 0x76,
  0x1C, 0x71, 0xDB, 0x00, 0xBC, 0xFD, 0x0C, 0x6C,
  0xA5, 0x47, 0xF7, 0xF6, 0x00, 0x79, 0x4A, 0x11
]);

/**
 * QMCv2 MapCipher - 解密核心
 * 基于 QmcWasm C++ 源码实现
 */
class QmcMapCipher {
  constructor(key) {
    this.key = key;
    this.keyLen = key.length;
  }

  /**
   * combine(v, r) = ((v << r) | (v >> r)) & 0xFF
   */
  _combine(value, bits) {
    const r = (bits + 4) & 7;
    return ((value << r) | (value >> r)) & 0xFF;
  }

  /**
   * getMask(offset) — QmcMapCipher::getMask
   * idx = (offset² + 71214) % keyLen
   * return combine(key[idx], idx & 7)
   */
  _getMask(offset) {
    if (offset > 0x7fff) offset %= 0x7fff;
    const idx = (offset * offset + 71214) % this.keyLen;
    return this._combine(this.key[idx], idx & 0x7);
  }

  /**
   * 解密数据块
   */
  decrypt(buf, offset) {
    for (let i = 0; i < buf.length; i++) {
      buf[i] ^= this._getMask(offset + i);
    }
    return buf;
  }
}

/**
 * QMCv1 Static Cipher — 解密核心
 */
class QmcStaticCipher {
  _getMask(offset) {
    if (offset > 0x7fff) offset %= 0x7fff;
    return STATIC_CIPHER_BOX[(offset * offset + 27) & 0xFF];
  }

  decrypt(buf, offset) {
    for (let i = 0; i < buf.length; i++) {
      buf[i] ^= this._getMask(offset + i);
    }
    return buf;
  }
}


// ============ musicex footer 解析 ============

/**
 * 从新版 musicex 尾部提取 ekey
 */
function extractMusicexEkey(raw) {
  const fileSize = raw.length;

  // 查找 musicex 特征码
  // 结构: [keydata][magic: 34 31 1a fd][len: c0 00 00 00 = 192][count: 01 00 00 00]["musicex\0"]
  const MUSICEX = new Uint8Array([0x6d, 0x75, 0x73, 0x69, 0x63, 0x65, 0x78, 0x00]);

  // 从文件尾部搜索 musicex — 它在文件最末尾
  let musicexPos = -1;
  for (let i = fileSize - 8; i > fileSize - 2000 && i > 0; i--) {
    let match = true;
    for (let j = 0; j < MUSICEX.length; j++) {
      if (raw[i + j] !== MUSICEX[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      musicexPos = i;
      break;
    }
  }

  if (musicexPos === -1) return null;

  // 前面的 12 字节: [magic 4B][len 4B][count 4B]
  // magic: 34 31 1a fd
  // len: little-endian uint32
  // count: little-endian uint32
  const keyBoxLen = raw[musicexPos - 8] | (raw[musicexPos - 7] << 8) |
                    (raw[musicexPos - 6] << 16) | (raw[musicexPos - 5] << 24);

  // 找 RSM1 标识
  let rsmPos = -1;
  // RSM1 在文件中的 UTF-16LE 编码: 52 00 53 00 4d 00 31 00
  for (let i = musicexPos - keyBoxLen - 30; i < musicexPos - 8; i++) {
    if (raw[i] === 0x52 && raw[i + 1] === 0x00 &&
        raw[i + 2] === 0x53 && raw[i + 3] === 0x00 &&
        raw[i + 4] === 0x4d && raw[i + 5] === 0x00) {
      rsmPos = i;
      break;
    }
  }
  if (rsmPos === -1) return null;

  // 从 RSM1 往前搜索 ekey 起始标记 (02 00 00 00 08 00 00 00)
  // 这个标记在 RSM1 之前 60-80 字节
  let marker = -1;
  for (let i = rsmPos - 100; i < rsmPos; i++) {
    if (raw[i] === 0x02 && raw[i + 1] === 0x00 &&
        raw[i + 2] === 0x00 && raw[i + 3] === 0x00 &&
        raw[i + 4] === 0x08 && raw[i + 5] === 0x00 &&
        raw[i + 6] === 0x00 && raw[i + 7] === 0x00) {
      marker = i;
      break;
    }
  }
  if (marker === -1 || rsmPos - marker < 10) {
    // 回退：直接尝试从 audioEnd 附近找 ekey
    // 跳过 marker，直接读 UTF-16LE 数据
    marker = rsmPos - 68; // 常见偏移
  }

  // ekey 从 marker+8 开始，直到遇到连续 \x00\x00
  const ekeyStart = marker + 8;
  let ekeyEnd = ekeyStart;
  while (ekeyEnd < raw.length - 2 && !(raw[ekeyEnd] === 0x00 && raw[ekeyEnd + 1] === 0x00)) {
    ekeyEnd += 2;
  }

  // 解码 UTF-16LE ekey
  const ekeyBytes = new Uint8Array(raw.slice(ekeyStart, ekeyEnd));
  const ekey = new TextDecoder('utf-16le').decode(ekeyBytes).trim();

  if (ekey.length === 0) return null;

  // 将 ekey 转换为 ASCII 字节数组（作为 MapCipher 的 key）
  const key = new Uint8Array(ekey.split('').map(c => c.charCodeAt(0)));

  // audio 结束于 marker 位置（footer 开始处）
  const audioEnd = marker;

  return {
    ekey: ekey,
    key: key,
    keyBoxLen: keyBoxLen,
    audioEnd: audioEnd,
    songId: 0,
  };
}


// ============ 音频格式检测 ============

const AUDIO_SIGNATURES = {
  mp3:  [[0xff, 0xfb], [0xff, 0xf3], [0xff, 0xf2], [0xff, 0xfa], [0xff, 0xfd]],
  flac: [[0x66, 0x4c, 0x61, 0x43]],
  m4a:  [[0x00, 0x00, 0x00]],
  ogg:  [[0x4f, 0x67, 0x67, 0x53]],
  wav:  [[0x52, 0x49, 0x46, 0x46]],
};

function detectAudioFormat(buffer) {
  for (const [format, signatures] of Object.entries(AUDIO_SIGNATURES)) {
    for (const sig of signatures) {
      if (buffer.length >= sig.length) {
        let match = true;
        for (let i = 0; i < sig.length; i++) {
          if (buffer[i] !== sig[i]) { match = false; break; }
        }
        if (match) return format;
      }
    }
  }
  return 'mp3';
}


// ============ 常量 ============

const EXT_MAP = {
  'qmc0':    'mp3',
  'qmc1':    'mp3',
  'qmc3':    'mp3',
  'qmcmp3':  'mp3',
  'qmcflac': 'flac',
  'qmcogg':  'ogg',
  'mflac':   'flac',
  'mgg':     'ogg',
  'mflac0':  'flac',
  'mgg1':    'ogg',
};

const MIME_MAP = {
  'mp3':  'audio/mpeg',
  'flac': 'audio/flac',
  'm4a':  'audio/mp4',
  'ogg':  'audio/ogg',
  'wav':  'audio/wav',
};

const SUPPORTED_EXTENSIONS = Object.keys(EXT_MAP);
const CHUNK_SIZE = 0x100000; // 1MB


// ============ ID3v2 标签解析 ============

function parseID3v2(buffer) {
  if (buffer.length < 10) return null;
  if (buffer[0] !== 0x49 || buffer[1] !== 0x44 || buffer[2] !== 0x33) return null;

  const version = buffer[3];
  const flags = buffer[5];

  let tagSize;
  if (version === 4) {
    tagSize = ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) |
              ((buffer[8] & 0x7f) << 7)  | (buffer[9] & 0x7f);
  } else {
    tagSize = (buffer[6] << 21) | (buffer[7] << 14) | (buffer[8] << 7) | buffer[9];
  }

  let pos = 10;
  if (version === 4 && (flags & 0x40)) {
    const exSize = ((buffer[pos] & 0x7f) << 21) | ((buffer[pos+1] & 0x7f) << 14) |
                   ((buffer[pos+2] & 0x7f) << 7) | (buffer[pos+3] & 0x7f);
    pos += 4 + exSize;
  } else if (version === 3 && (flags & 0x40)) {
    const exSize = (buffer[pos] << 24) | (buffer[pos+1] << 16) |
                   (buffer[pos+2] << 8) | buffer[pos+3];
    pos += 4 + exSize;
  }

  const endPos = 10 + tagSize;
  const tags = {};

  while (pos + 10 <= endPos && pos + 10 <= buffer.length) {
    const frameId = String.fromCharCode(buffer[pos], buffer[pos+1], buffer[pos+2], buffer[pos+3]);
    if (frameId[0] === '\x00') break;

    let frameSize;
    if (version === 4) {
      frameSize = ((buffer[pos+4] & 0x7f) << 21) | ((buffer[pos+5] & 0x7f) << 14) |
                  ((buffer[pos+6] & 0x7f) << 7)  | (buffer[pos+7] & 0x7f);
    } else {
      frameSize = (buffer[pos+4] << 24) | (buffer[pos+5] << 16) |
                  (buffer[pos+6] << 8)  | buffer[pos+7];
    }
    const frameFlags = (buffer[pos+8] << 8) | buffer[pos+9];
    pos += 10;

    if (frameSize <= 0 || pos + frameSize > buffer.length) break;

    let dataStart = pos;
    let dataLen = frameSize;
    if (version === 4 && (frameFlags & 0x0001)) {
      const dli = ((buffer[pos] & 0x7f) << 21) | ((buffer[pos+1] & 0x7f) << 14) |
                  ((buffer[pos+2] & 0x7f) << 7)  | (buffer[pos+3] & 0x7f);
      dataStart = pos + 4;
      dataLen = Math.min(dli, frameSize - 4);
    }

    try {
      const enc = buffer[dataStart];
      const bodyStart = dataStart + 1;
      const bodyLen = dataLen - 1;

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
      } else if (frameId === 'COMM') {
        const descLen = Math.min(buffer[bodyStart+3] || 0, bodyLen - 4);
        let commentText;
        if (enc === 0x03)
          commentText = buffer.slice(bodyStart + 4 + descLen, bodyStart + bodyLen).toString('utf8');
        else
          commentText = buffer.slice(bodyStart + 4 + descLen, bodyStart + bodyLen).toString('latin1');
        commentText = commentText.replace(/\x00/g, '').trim();
        if (commentText) tags.COMM = commentText;
      }
    } catch (e) {}

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


// ============ 文件名解析 ============

function parseFilename(filename) {
  let name = filename.replace(/\.(qmc[0-3]|qmcmp3|qmcflac|qmcogg|mflac|mgg|mflac0|mgg1|mp3|flac|m4a|ogg|wav|ape|wma)$/i, '');
  for (const sep of [' - ', ' — ', '-', '—']) {
    const idx = name.indexOf(sep);
    if (idx > 0 && idx < name.length - sep.length) {
      return {
        artist: name.slice(0, idx).trim(),
        title: name.slice(idx + sep.length).trim()
      };
    }
  }
  return { artist: '', title: name };
}


// ============ 主解密器 ============

class QmcDecryptor {
  constructor(raw, filename) {
    this.raw = raw;
    this.filename = filename;
    this.audioExt = '';
    this.audio = null;
    this.format = '';
    this.mime = '';
    this.songId = 0;
    this.footerSize = 0;
  }

  _detectExtension() {
    const ext = path.extname(this.filename).toLowerCase().replace('.', '');
    this.audioExt = EXT_MAP[ext] || 'mp3';
  }

  _detectActualFormat() {
    if (this.audio && this.audio.length > 4) {
      this.format = detectAudioFormat(this.audio);
    } else {
      this.format = this.audioExt;
    }
    this.mime = MIME_MAP[this.format] || MIME_MAP['mp3'];
  }

  /**
   * 执行解密（WASM 引擎 + 纯 JS 回退）
   */
  async decrypt() {
    this._detectExtension();
    console.log(`  1/3 识别文件格式: .${path.extname(this.filename).toLowerCase().replace('.', '')} → .${this.audioExt}`);

    const raw = new Uint8Array(this.raw);

    // 先尝试 WASM 引擎
    if (QmcCryptoModule) {
      try {
        return await this._decryptWithWasm(raw);
      } catch (e) {
        console.log(`     WASM 引擎失败: ${e.message}`);
        console.log('     尝试纯 JS 回退...');
      }
    }

    // 纯 JS 回退
    return await this._decryptPureJS(raw);
  }

  /**
   * WASM 引擎解密
   */
  async _decryptWithWasm(arr) {
    console.log('  2/3 使用 WASM 引擎解密...');

    const qmc = await QmcCryptoModule();
    const fileSize = arr.length;

    // 读取文件尾部用于密钥提取
    const tailSize = Math.min(CHUNK_SIZE, fileSize);
    const tailData = arr.slice(fileSize - tailSize);

    const tailPtr = qmc._malloc(tailSize);
    qmc.writeArrayToMemory(tailData, tailPtr);

    const extStr = '.' + this.audioExt;
    this.footerSize = qmc.preDec(tailPtr, tailSize, extStr);

    if (this.footerSize === -1) {
      qmc._free(tailPtr);
      throw new Error(qmc.getErr ? qmc.getErr() : '文件格式不支持');
    }

    const songIdStr = qmc.getSongId ? qmc.getSongId() : '0';
    this.songId = (songIdStr === '0' || songIdStr === '') ? 0 : parseInt(songIdStr, 10);

    console.log(`     密钥区: ${this.footerSize} 字节`);
    if (this.songId) console.log(`     歌曲ID: ${this.songId}`);

    // 解密音频
    const audioSize = fileSize - this.footerSize;
    console.log(`  3/3 解密 (${(audioSize / 1024 / 1024).toFixed(2)} MB)...`);

    const workPtr = qmc._malloc(CHUNK_SIZE);
    const chunks = [];
    let offset = 0;
    let remaining = audioSize;

    while (remaining > 0) {
      const chunkSize = Math.min(remaining, CHUNK_SIZE);
      const chunkData = arr.slice(offset, offset + chunkSize);

      qmc.writeArrayToMemory(chunkData, workPtr);
      const decryptedLen = qmc.decBlob(workPtr, chunkSize, offset);

      chunks.push(Buffer.from(qmc.HEAPU8.slice(workPtr, workPtr + decryptedLen)));

      offset += chunkSize;
      remaining -= chunkSize;
    }

    qmc._free(tailPtr);
    qmc._free(workPtr);

    this.audio = Buffer.concat(chunks);
    this._detectActualFormat();
    return this._gatherResult();
  }

  /**
   * 纯 JS 回退（处理 musicex 等新格式）
   */
  async _decryptPureJS(arr) {
    console.log('  2/3 解析文件尾部...');

    // 尝试提取 musicex ekey
    const ek = extractMusicexEkey(arr);

    if (!ek) {
      // 尝试用 QMCv1 流式解密（需要预计算密钥流文件）
      return await this._decryptWithStream(arr);
    }

    // musicex 格式：尝试用 MapCipher 解密
    this.songId = ek.songId;
    this.footerSize = arr.length - ek.audioEnd;

    console.log(`     ekey: ${ek.ekey}`);
    console.log(`     音频区: ${(ek.audioEnd / 1024 / 1024).toFixed(2)} MB`);

    // 尝试 MapCipher
    const cipher = new QmcMapCipher(ek.key);

    // 先测试前 8 字节
    const test = new Uint8Array(arr.slice(0, 8));
    cipher.decrypt(test, 0);
    const isFLAC = test[0] === 0x66 && test[1] === 0x4c && test[2] === 0x61 && test[3] === 0x43;

    if (!isFLAC) {
      throw new Error(
        '此文件使用了较新的 musicex 加密格式（eykey: ' + ek.ekey + '），' +
        '该格式尚不完全支持。\\n' +
        '建议方案：\\n' +
        '  1. 使用 QQ 音乐客户端内建的转码功能\\n' +
        '  2. 使用 Unlock Music 在线版: https://unlock-music.dev/\\n' +
        '  3. 等待本工具后续版本更新支持此格式'
      );
    }

    const audioSize = ek.audioEnd;
    console.log(`  3/3 解密 (${(audioSize / 1024 / 1024).toFixed(2)} MB)...`);

    const decrypted = new Uint8Array(audioSize);
    let lastPct = 0;

    for (let offset = 0; offset < audioSize; offset += CHUNK_SIZE) {
      const chunkSize = Math.min(CHUNK_SIZE, audioSize - offset);
      const chunk = new Uint8Array(arr.slice(offset, offset + chunkSize));
      cipher.decrypt(chunk, offset);
      decrypted.set(chunk, offset);

      const pct = Math.round((offset / audioSize) * 100);
      if (pct > lastPct && pct % 10 === 0) {
        console.log(`     - 已解密 ${pct}%...`);
        lastPct = pct;
      }
    }

    this.audio = Buffer.from(decrypted);
    this._detectActualFormat();
    return this._gatherResult();
  }

  /**
   * QMCv1 流式解密（使用预计算密钥流文件）
   * 需要 qmc.v1.stream 文件
   */
  async _decryptWithStream(arr) {
    let streamPath;
    try {
      streamPath = require('path').join(__dirname, 'qmc.v1.stream');
      require('fs').statSync(streamPath);
    } catch (e) {
      throw new Error(
        '无法识别文件加密格式。\\n' +
        '如果这是 QQ 音乐下载的文件，可能使用了较新的加密格式，暂不支持。'
      );
    }

    const streamFile = require('fs').readFileSync(streamPath);
    const firstSeg = new Uint8Array(streamFile.slice(0, 32768));
    const anotherSeg = new Uint8Array(streamFile.slice(32768));

    const fileSize = arr.length;
    // 读取最后4字节作为 keySize
    const keySize = arr[fileSize - 4] | (arr[fileSize - 3] << 8) |
                    (arr[fileSize - 2] << 16) | (arr[fileSize - 1] << 24);

    let audioSize;
    if (keySize > 0 && keySize < 0x400) {
      audioSize = fileSize - 4 - keySize;
    } else {
      audioSize = fileSize;
    }

    this.footerSize = fileSize - audioSize;
    console.log(`     密钥区: ${this.footerSize} 字节`);

    const decrypted = new Uint8Array(audioSize);
    const fsl = firstSeg.length;
    const asl = anotherSeg.length;

    for (let i = 0; i < audioSize; i++) {
      const pos = i;
      const mask = pos < fsl ? firstSeg[pos] : anotherSeg[(pos - fsl) % asl];
      decrypted[i] = arr[i] ^ mask;
    }

    this.audio = Buffer.from(decrypted);
    this._detectActualFormat();
    return this._gatherResult();
  }

  _gatherResult() {
    if (!this.audio) throw new Error('解密流程未完成');

    const id3Tags = parseID3v2(this.audio) || {};
    const fallback = parseFilename(this.filename);

    const title = id3Tags.title || fallback.title;
    const artist = id3Tags.artist || fallback.artist;
    const album = id3Tags.album || '';

    return {
      title, artist,
      artists: artist ? [[artist]] : [],
      album,
      albumartist: id3Tags.albumartist || artist,
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
      format: this.format,
      mime: this.mime,
      audio: this.audio,
      image: null,
      imageUrl: null,
      songId: this.songId,
      footerSize: this.footerSize,
      rawMeta: {},
      id3Tags,
    };
  }
}

module.exports = {
  QmcDecryptor,
  QmcMapCipher,
  QmcStaticCipher,
  detectAudioFormat,
  extractMusicexEkey,
  parseFilename,
  EXT_MAP,
  MIME_MAP,
  SUPPORTED_EXTENSIONS,
  CHUNK_SIZE,
};
