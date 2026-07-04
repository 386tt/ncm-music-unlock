/**
 * NCM 解锁工具测试
 *
 * 通过创建一个模拟的 NCM 文件来验证解密流程的正确性。
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { NcmDecryptor, AES_KEY_FOR_KEY_DATA, AES_KEY_FOR_META, MAGIC_BYTES, detectAudioFormat } = require('./ncm-decrypt');
const { writeMP3Metadata, writeFLACMetadata, detectImageMime } = require('./meta-writer');

// ============ 辅助函数 ============

function aesEcbEncrypt(data, key) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function aesEcbDecrypt(data, key) {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/**
 * 创建一个模拟的 NCM 文件用于测试
 */
function createTestNcmFile(options = {}) {
  const {
    musicName = '测试歌曲',
    artist = [['测试歌手']],
    album = '测试专辑',
    format = 'mp3',
    albumPic = null,
  } = options;

  // 如果没有提供音频数据，生成一个最小的 MP3 帧
  const audioData = options.audioData || createMinimalMP3();

  // 构建元数据 JSON
  const metaObj = {
    musicId: 12345678,
    musicName: musicName,
    artist: artist,
    album: album,
    albumPic: albumPic || '',
    albumPicDocId: null,
    format: format,
    bitrate: 320000,
    duration: 240000,
    mp3DocId: null,
  };

  const metaJson = 'music:' + JSON.stringify(metaObj);
  const metaJsonBuf = Buffer.from(metaJson, 'utf8');

  // 加密元数据
  const encryptedMeta = aesEcbEncrypt(metaJsonBuf, AES_KEY_FOR_META);
  // Base64 编码（真实 NCM 文件使用 base64）
  const metaB64 = encryptedMeta.toString('base64');
  const metaB64Buf = Buffer.from(metaB64, 'utf8');

  // 添加头部 "163 key(Don't modify):"
  const metaHeader = Buffer.from('163 key(Don\'t modify):', 'utf8');
  const metaBody = Buffer.concat([metaHeader, metaB64Buf]);

  // XOR 0x63
  const metaXor = Buffer.alloc(metaBody.length);
  for (let i = 0; i < metaBody.length; i++) {
    metaXor[i] = metaBody[i] ^ 0x63;
  }

  // 构建密钥数据
  const keyData = crypto.randomBytes(32); // 随机RC4密钥
  const keyPrefix = Buffer.from('neteasecloudmusic', 'utf8');
  const keyBody = Buffer.concat([keyPrefix, keyData]);

  // AES 加密密钥数据
  const encryptedKey = aesEcbEncrypt(keyBody, AES_KEY_FOR_KEY_DATA);

  // XOR 0x64
  const keyXor = Buffer.alloc(encryptedKey.length);
  for (let i = 0; i < encryptedKey.length; i++) {
    keyXor[i] = encryptedKey[i] ^ 0x64;
  }

  // 使用生成的密钥加密音频数据
  const { createKeyBox } = require('./ncm-decrypt');
  const keyBox = createKeyBox(keyData);
  const encryptedAudio = Buffer.alloc(audioData.length);
  for (let i = 0; i < audioData.length; i++) {
    encryptedAudio[i] = audioData[i] ^ keyBox[i & 0xff];
  }

  // 组装 NCM 文件
  const parts = [];

  // 1. 魔数 CTENFDAM
  parts.push(Buffer.from(MAGIC_BYTES));
  // 2. 2 字节保留区
  parts.push(Buffer.from([0x00, 0x00]));

  // 3. 密钥数据（4字节长度 + 数据）
  const keyLenBuf = Buffer.alloc(4);
  keyLenBuf.writeUInt32LE(keyXor.length, 0);
  parts.push(keyLenBuf);
  parts.push(keyXor);

  // 4. 元数据（4字节长度 + 数据）
  const metaLenBuf = Buffer.alloc(4);
  metaLenBuf.writeUInt32LE(metaXor.length, 0);
  parts.push(metaLenBuf);
  parts.push(metaXor);

  // 5. CRC + 图片数据 (5字节CRC占位 + 4字节长度=0 + 4字节保留)
  //    总跳过 = getUint32(offset+5) + 13，其中 offset+5 读取的值决定跳过多少
  //    我们设 offset+5 处的 uint32 = 0，则跳过 0+13 = 13 字节
  const crcAndImageHeader = Buffer.alloc(13, 0);
  parts.push(crcAndImageHeader);

  // 6. 加密的音频数据
  parts.push(encryptedAudio);

  const ncmBuffer = Buffer.concat(parts);

  return {
    ncmBuffer,
    expectedTitle: musicName,
    expectedArtist: '测试歌手',
    expectedAlbum: album,
    expectedFormat: format,
    originalAudio: audioData,
    keyBox: keyBox,
  };
}

/**
 * 创建最小的有效 MP3 帧（用于测试）
 */
function createMinimalMP3() {
  // MPEG1 Layer3, 128kbps, 44100Hz, stereo
  // 一个完整的 MP3 帧头 + 一些空数据
  const frameHeader = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
  const frameData = Buffer.alloc(413, 0x55); // 最小帧填充
  return Buffer.concat([frameHeader, frameData]);
}

// ============ 单元测试 ============

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    // 支持同步和异步测试
    if (result && typeof result.then === 'function') {
      // 异步测试：将 promise 加入待处理列表
      pendingAsyncTests.push({ name, promise: result });
    } else {
      passed++;
      console.log(`  ✓ ${name}`);
    }
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
  }
}

const pendingAsyncTests = [];

function assert(condition, msg) {
  if (!condition) throw new Error(msg || '断言失败');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `期望 ${b}，实际 ${a}`);
}

function assertBufferEqual(a, b, msg) {
  if (!a.equals(b)) throw new Error(msg || 'Buffer 不匹配');
}

// ---- 运行测试 ----

console.log('=== NCM 解密核心测试 ===\n');

// 1. 测试魔数验证
test('验证有效的魔数', () => {
  const buf = Buffer.alloc(50);
  buf[0] = 0x43; // C
  buf[1] = 0x54; // T
  buf[2] = 0x45; // E
  buf[3] = 0x4e; // N
  buf[4] = 0x46; // F
  buf[5] = 0x44; // D
  buf[6] = 0x41; // A
  buf[7] = 0x4d; // M
  const decryptor = new NcmDecryptor(buf, 'test.ncm');
  decryptor._checkMagic();
  assertEqual(decryptor.offset, 10);
});

test('拒绝无效的魔数', () => {
  const buf = Buffer.alloc(50);
  const decryptor = new NcmDecryptor(buf, 'test.ncm');
  try {
    decryptor._checkMagic();
    throw new Error('应该抛出异常');
  } catch (err) {
    assert(err.message.includes('已损坏'), '错误消息应包含"已损坏"');
  }
});

// 2. 测试 AES 解密
test('AES-128-ECB 加密解密往返', () => {
  const key = crypto.randomBytes(16);
  const plaintext = Buffer.from('Hello, World! This is a test of AES-128-ECB encryption.', 'utf8');
  const encrypted = aesEcbEncrypt(plaintext, key);
  const decrypted = aesEcbDecrypt(encrypted, key);
  assertBufferEqual(decrypted, plaintext, 'AES 加密解密往返失败');
});

// 3. 测试音频格式检测
test('检测 MP3 格式', () => {
  const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x00, ...Array(100).fill(0)]);
  assertEqual(detectAudioFormat(mp3), 'mp3');
});

test('检测 FLAC 格式', () => {
  const flac = Buffer.from([0x66, 0x4c, 0x61, 0x43, ...Array(100).fill(0)]);
  assertEqual(detectAudioFormat(flac), 'flac');
});

test('检测 OGG 格式', () => {
  const ogg = Buffer.from([0x4f, 0x67, 0x67, 0x53, ...Array(100).fill(0)]);
  assertEqual(detectAudioFormat(ogg), 'ogg');
});

// 4. 测试图片 MIME 检测
test('检测 JPEG 图片', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  assertEqual(detectImageMime(jpeg), 'image/jpeg');
});

test('检测 PNG 图片', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  assertEqual(detectImageMime(png), 'image/png');
});

// 5. 测试完整的 NCM 解密流程
test('完整 NCM 解密流程', async () => {
  const testData = createTestNcmFile({
    musicName: '测试歌曲名',
    artist: [['测试艺术家']],
    album: '测试专辑名',
    format: 'mp3',
  });

  const decryptor = new NcmDecryptor(testData.ncmBuffer, '测试艺术家 - 测试歌曲名.ncm');
  const result = await decryptor.decrypt();

  assert(result.title === '测试歌曲名' || result.title === '测试歌曲名',
    `标题应为"测试歌曲名"，实际为"${result.title}"`);
  assert(result.format === 'mp3', `格式应为 mp3，实际为 ${result.format}`);
  assert(result.audio.length > 0, '音频数据不应为空');
  assert(result.audio.length === testData.originalAudio.length,
    `音频长度应为 ${testData.originalAudio.length}，实际为 ${result.audio.length}`);

  // 验证音频内容正确解密
  for (let i = 0; i < testData.originalAudio.length; i++) {
    if (result.audio[i] !== testData.originalAudio[i]) {
      throw new Error(`音频解密错误：位置 ${i} 处期望 ${testData.originalAudio[i]}，实际 ${result.audio[i]}`);
    }
  }
});

// 6. 测试 MP3 元数据写入
test('MP3 元数据写入', () => {
  const audioData = createMinimalMP3();
  const result = writeMP3Metadata(audioData, {
    title: '测试歌名',
    artist: '测试歌手',
    album: '测试专辑',
    picture: null,
  });

  // 应该有 ID3 标签头 "ID3"
  const header = result.slice(0, 3).toString();
  assertEqual(header, 'ID3', `ID3 标签头应为"ID3"，实际为"${header}"`);
  assert(result.length > audioData.length, '添加元数据后长度应增加');
});

// 7. 测试带封面的 MP3
test('MP3 元数据写入（含封面）', () => {
  const audioData = createMinimalMP3();
  // 创建最小 JPEG
  const coverImage = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
    0x49, 0x46, 0x00, 0x01, // ... minimal JPEG header
  ]);

  const result = writeMP3Metadata(audioData, {
    title: '带封面歌曲',
    artist: '歌手名',
    album: '专辑名',
    picture: coverImage,
  });

  const header = result.slice(0, 3).toString();
  assertEqual(header, 'ID3', 'ID3 标签头应为"ID3"');
});

// 8. 测试 FLAC 元数据写入
test('FLAC 元数据写入', () => {
  const flac = Buffer.alloc(2000);
  flac.write('fLaC', 0);
  // 写入一个最小的 STREAMINFO 块 (34 bytes data + 4 byte header)
  // last=1 (是最后一个元数据块, 第31位=1), type=0 STREAMINFO, size=34
  const header = ((1 << 31) | (0 << 24) | 34) >>> 0; // >>> 0 转换为无符号整数
  flac.writeUInt32BE(header, 4);
  // STREAMINFO 最小需要有 34 字节数据
  // 在 offset 8-41 处填充 34 字节的 STREAMINFO 数据 (全零即可，用于测试)

  const result = writeFLACMetadata(flac, {
    title: 'FLAC测试',
    artist: 'FLAC艺术家',
    album: 'FLAC专辑',
  });

  assert(result.length > 0, '结果不应为空');
  assert(result.slice(0, 4).toString() === 'fLaC', '应保留 fLaC 标识');
});

// ============ 额外的异步测试 ============

// 测试: 完整 NCM 解密流程（含音频逐字节验证）
test('异步完整 NCM 解密流程（逐字节验证）', async () => {
  const testData = createTestNcmFile({
    musicName: '深度验证歌曲',
    artist: [['深度验证歌手']],
    album: '深度验证专辑',
    format: 'mp3',
  });

  const decryptor = new NcmDecryptor(testData.ncmBuffer, '深度验证歌手 - 深度验证歌曲.ncm');
  const result = await decryptor.decrypt();

  if (result.title !== '深度验证歌曲') {
    throw new Error(`标题应为"深度验证歌曲"，实际为"${result.title}"`);
  }
  if (result.format !== 'mp3') {
    throw new Error(`格式应为 mp3，实际为 ${result.format}`);
  }
  if (result.audio.length !== testData.originalAudio.length) {
    throw new Error(`音频长度不匹配: 期望 ${testData.originalAudio.length}, 实际 ${result.audio.length}`);
  }

  // 验证音频数据逐字节匹配
  for (let i = 0; i < testData.originalAudio.length; i++) {
    if (result.audio[i] !== testData.originalAudio[i]) {
      throw new Error(`位置 ${i} 解密错误: 期望 ${testData.originalAudio[i]}, 实际 ${result.audio[i]}`);
    }
  }
});

// ============ 等待异步测试并输出结果 ============

(async () => {
  // 等待所有异步测试完成
  for (const { name, promise } of pendingAsyncTests) {
    try {
      await promise;
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed++;
      console.log(`  ✗ ${name}`);
      console.log(`    ${err.message}`);
    }
  }

  // 打印结果
  console.log(`\n===== 测试结果 =====`);
  console.log(`通过: ${passed}`);
  console.log(`失败: ${failed}`);

  if (failed > 0) {
    console.log('\n❌ 部分测试失败！');
    process.exit(1);
  } else {
    console.log('\n✅ 所有测试通过！');
  }
})();
