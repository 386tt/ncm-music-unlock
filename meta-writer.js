/**
 * 元数据写入模块
 *
 * 将提取的元数据（标题、歌手、专辑、封面图等）写回音频文件。
 * 支持 MP3（ID3v2.4）和 FLAC（Vorbis Comment + Picture）格式。
 */

'use strict';

const NodeID3 = require('node-id3');


// ============ MP3 元数据写入 ============

/**
 * 将元数据写入 MP3 文件（使用 ID3v2.4 标签）
 *
 * @param {Buffer} audioData - 原始音频数据
 * @param {object} meta - 元数据对象
 * @param {string} meta.title - 歌曲标题
 * @param {string[]} meta.artist - 艺术家名列表
 * @param {string} meta.album - 专辑名
 * @param {Buffer} [meta.picture] - 封面图片数据
 * @returns {Buffer} 写入元数据后的 MP3 数据
 */
function writeMP3Metadata(audioData, meta) {
  // 先尝试移除已有的 ID3 标签以避免重复
  // node-id3 的 update 方法会自动处理

  const tags = {
    title: meta.title || '',
    artist: Array.isArray(meta.artist) ? meta.artist.join('; ') : (meta.artist || ''),
    album: meta.album || '',
  };

  // 添加封面图
  if (meta.picture && meta.picture.length > 0) {
    tags.image = {
      mime: detectImageMime(meta.picture),
      type: {
        id: 3, // 封面图（front cover）
        name: 'front cover',
      },
      description: 'Cover',
      imageBuffer: meta.picture,
    };
  }

  // 使用 node-id3 写入标签（会自动处理已有的标签）
  // write 方法返回写入后的完整 buffer
  const result = NodeID3.write(tags, audioData);

  return result;
}

/**
 * 将元数据更新到已有的 MP3 文件（更新模式）
 * 只更新标签，不重建整个文件
 */
function updateMP3Metadata(audioData, meta) {
  // node-id3 的 update 方法替换已有标签
  const tags = {};

  if (meta.title) tags.title = meta.title;
  if (meta.artist) {
    tags.artist = Array.isArray(meta.artist) ? meta.artist.join('; ') : meta.artist;
  }
  if (meta.album) tags.album = meta.album;

  if (meta.picture && meta.picture.length > 0) {
    tags.image = {
      mime: detectImageMime(meta.picture),
      type: { id: 3, name: 'front cover' },
      description: 'Cover',
      imageBuffer: meta.picture,
    };
  }

  return NodeID3.update(tags, audioData);
}


// ============ FLAC 元数据写入 ============

/**
 * FLAC 元数据块类型
 */
const FLAC_BLOCK_TYPE = {
  STREAMINFO: 0,
  PADDING: 1,
  APPLICATION: 2,
  SEEKTABLE: 3,
  VORBIS_COMMENT: 4,
  CUESHEET: 5,
  PICTURE: 6,
};

/**
 * 将元数据写入 FLAC 文件
 *
 * FLAC 文件结构：
 *   "fLaC" (4字节)
 *   METADATA_BLOCK* (每个块: 1bit last-flag + 7bit type + 3byte length + data)
 *   AUDIO_FRAMES...
 *
 * 此函数在 STREAMINFO 之后插入/替换 VORBIS_COMMENT 和 PICTURE 块。
 *
 * @param {Buffer} audioData - FLAC 音频数据
 * @param {object} meta - 元数据对象
 * @returns {Buffer} 写入元数据后的 FLAC 数据
 */
function writeFLACMetadata(audioData, meta) {
  // 验证 FLAC 标志
  if (audioData.slice(0, 4).toString() !== 'fLaC') {
    console.warn('警告：数据不以 fLaC 开头，可能不是有效的 FLAC 文件');
    return audioData;
  }

  let pos = 4; // 跳过 "fLaC"
  let lastBlock = false;

  // 收集已有的元数据块
  const blocks = [];
  while (!lastBlock && pos + 4 <= audioData.length) {
    const header = audioData.readUInt32BE(pos);
    lastBlock = (header >> 31) & 1;
    const blockType = (header >> 24) & 0x7f;
    const blockSize = header & 0x00ffffff;

    pos += 4;

    // 防止零大小块导致的无限循环
    if (blockSize === 0) {
      lastBlock = true;
      break;
    }

    if (pos + blockSize > audioData.length) {
      console.warn('警告：FLAC 元数据块超出文件范围');
      break;
    }

    blocks.push({
      type: blockType,
      data: audioData.slice(pos, pos + blockSize),
      size: blockSize,
    });

    pos += blockSize;
  }

  // 音频帧数据
  const audioFrames = audioData.slice(pos);

  // 构建 Vorbis Comment 块
  const vorbisCommentBlock = buildVorbisCommentBlock(meta);

  // 构建 Picture 块（如果有封面图）
  const pictureBlock = meta.picture ? buildPictureBlock(meta.picture) : null;

  // 重新组织元数据块：STREAMINFO + VORBIS_COMMENT + PICTURE + 其他块(不含旧的VORBIS_COMMENT和PICTURE)
  const newBlocks = [];

  for (const block of blocks) {
    if (block.type === FLAC_BLOCK_TYPE.STREAMINFO) {
      // STREAMINFO 必须是第一个
      newBlocks.push(block);
    }
  }

  // 添加新的 Vorbis Comment
  newBlocks.push({ type: FLAC_BLOCK_TYPE.VORBIS_COMMENT, data: vorbisCommentBlock });

  // 添加新的 Picture 块
  if (pictureBlock) {
    newBlocks.push({ type: FLAC_BLOCK_TYPE.PICTURE, data: pictureBlock });
  }

  // 添加其余块（排除旧的 Vorbis Comment、Picture 和 Padding）
  for (const block of blocks) {
    if (block.type === FLAC_BLOCK_TYPE.VORBIS_COMMENT ||
        block.type === FLAC_BLOCK_TYPE.PICTURE ||
        block.type === FLAC_BLOCK_TYPE.PADDING) {
      continue; // 跳过这些块，用新的替换
    }
    if (block.type !== FLAC_BLOCK_TYPE.STREAMINFO) {
      newBlocks.push(block);
    }
  }

  // 序列化所有块
  const resultBuffers = [Buffer.from('fLaC')];

  for (let i = 0; i < newBlocks.length; i++) {
    const block = newBlocks[i];
    const isLast = (i === newBlocks.length - 1);
    // JavaScript 位运算产生带符号32位结果，>>> 0 转换为无符号
    const header = (((isLast ? 1 : 0) << 31) | (block.type << 24) | block.data.length) >>> 0;
    const headerBuf = Buffer.alloc(4);
    headerBuf.writeUInt32BE(header, 0);
    resultBuffers.push(headerBuf, block.data);
  }

  // 追加音频帧
  resultBuffers.push(audioFrames);

  return Buffer.concat(resultBuffers);
}

/**
 * 构建 Vorbis Comment 元数据块
 *
 * 格式：
 *   4 字节 LE: vendor 字符串长度
 *   vendor 字符串
 *   4 字节 LE: 注释数量
 *   每个注释:
 *     4 字节 LE: 注释长度
 *     注释内容 "KEY=VALUE"
 */
function buildVorbisCommentBlock(meta) {
  const vendor = 'reference libFLAC 1.3.2 20170101';
  const vendorBuf = Buffer.from(vendor, 'utf8');

  // 构建注释列表
  const comments = [];

  if (meta.title) {
    comments.push(Buffer.from(`TITLE=${meta.title}`, 'utf8'));
  }
  if (meta.artist) {
    const artistStr = Array.isArray(meta.artist)
      ? meta.artist.join('; ')
      : meta.artist;
    comments.push(Buffer.from(`ARTIST=${artistStr}`, 'utf8'));
  }
  if (meta.album) {
    comments.push(Buffer.from(`ALBUM=${meta.album}`, 'utf8'));
  }
  if (meta.date) {
    comments.push(Buffer.from(`DATE=${meta.date}`, 'utf8'));
  }
  if (meta.trackNumber) {
    comments.push(Buffer.from(`TRACKNUMBER=${meta.trackNumber}`, 'utf8'));
  }
  if (meta.genre) {
    comments.push(Buffer.from(`GENRE=${meta.genre}`, 'utf8'));
  }

  // 如果没有元数据，至少添加一个空注释
  if (comments.length === 0) {
    comments.push(Buffer.from('', 'utf8'));
  }

  // 构建块数据
  const parts = [];

  // Vendor 字符串
  const vendorLen = Buffer.alloc(4);
  vendorLen.writeUInt32LE(vendorBuf.length, 0);
  parts.push(vendorLen, vendorBuf);

  // 注释数量
  const countBuf = Buffer.alloc(4);
  countBuf.writeUInt32LE(comments.length, 0);
  parts.push(countBuf);

  // 每个注释
  for (const comment of comments) {
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(comment.length, 0);
    parts.push(lenBuf, comment);
  }

  return Buffer.concat(parts);
}

/**
 * 构建 FLAC Picture 元数据块
 *
 * 格式：
 *   4 字节 BE: 图片类型 (3 = 封面)
 *   4 字节 BE: MIME 类型字符串长度
 *   MIME 类型字符串
 *   4 字节 BE: 描述字符串长度
 *   描述字符串
 *   4 字节 BE: 宽度
 *   4 字节 BE: 高度
 *   4 字节 BE: 色彩深度
 *   4 字节 BE: 使用的颜色数 (0 表示不适用)
 *   4 字节 BE: 图片数据长度
 *   图片数据
 */
function buildPictureBlock(imageBuffer) {
  const mime = detectImageMime(imageBuffer);

  const mimeBuf = Buffer.from(mime, 'ascii');
  const descBuf = Buffer.from('Cover', 'utf8');

  const parts = [];

  // 图片类型 (3 = front cover)
  const typeBuf = Buffer.alloc(4);
  typeBuf.writeUInt32BE(3, 0);
  parts.push(typeBuf);

  // MIME 类型
  const mimeLenBuf = Buffer.alloc(4);
  mimeLenBuf.writeUInt32BE(mimeBuf.length, 0);
  parts.push(mimeLenBuf, mimeBuf);

  // 描述
  const descLenBuf = Buffer.alloc(4);
  descLenBuf.writeUInt32BE(descBuf.length, 0);
  parts.push(descLenBuf, descBuf);

  // 宽度/高度/色彩深度/颜色数（默认为 0，表示未知）
  const zeros = Buffer.alloc(16, 0);
  parts.push(zeros);

  // 图片数据
  const imgLenBuf = Buffer.alloc(4);
  imgLenBuf.writeUInt32BE(imageBuffer.length, 0);
  parts.push(imgLenBuf, imageBuffer);

  return Buffer.concat(parts);
}


// ============ 工具函数 ============

/**
 * 检测图片的 MIME 类型
 * 通过文件头魔数判断
 */
function detectImageMime(buffer) {
  if (buffer.length < 4) return 'image/jpeg';

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  // GIF: 47 49 46
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return 'image/gif';
  }
  // WebP: 52 49 46 46 ... 57 45 42 50
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return 'image/webp';
  }
  // BMP: 42 4D
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return 'image/bmp';
  }

  return 'image/jpeg'; // 默认
}


// ============ 统一的元数据写入接口 ============

/**
 * 将元数据写入音频文件
 *
 * @param {Buffer} audioData - 音频数据
 * @param {object} meta - 元数据
 * @param {string} format - 音频格式 ('mp3', 'flac', 等)
 * @returns {Buffer} 写入元数据后的数据
 */
function writeMetadata(audioData, meta, format) {
  switch (format.toLowerCase()) {
    case 'mp3':
      return writeMP3Metadata(audioData, meta);
    case 'flac':
      return writeFLACMetadata(audioData, meta);
    case 'm4a':
    case 'mp4':
    case 'ogg':
    case 'wav':
    case 'ape':
    case 'wma':
    default:
      console.warn(`  注意: ${format.toUpperCase()} 格式的元数据写入暂不支持，将保留原始音频`);
      return audioData;
  }
}


module.exports = {
  writeMetadata,
  writeMP3Metadata,
  writeFLACMetadata,
  updateMP3Metadata,
  detectImageMime,
  buildVorbisCommentBlock,
  buildPictureBlock,
  FLAC_BLOCK_TYPE,
};
