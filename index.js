/**
 * 音乐解锁主模块
 *
 * 整合解密和元数据写入，支持多种加密格式：
 * - NCM (网易云音乐) : .ncm
 * - QMC (QQ 音乐)   : .qmc0/.qmc1/.qmc3/.qmcogg/.qmcflac/.mgg/.mflac/.qmcmp3
 *
 * 用法：
 *   const { unlock, unlockToFile } = require('./index');
 *
 *   // 解锁文件并保存
 *   await unlockToFile('song.ncm');
 *   await unlockToFile('song.mflac');
 *
 *   // 或获取解密后的数据
 *   const result = await unlock('song.ncm');
 *   // result.audio   → 解密后+写入元数据的音频 Buffer
 *   // result.title   → 歌曲标题
 *   // result.artist  → 歌手名
 *   // result.album   → 专辑名
 *   // result.format  → 音频格式
 *   // result.image   → 封面图 Buffer
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { NcmDecryptor, detectAudioFormat } = require('./ncm-decrypt');
const { QmcDecryptor, SUPPORTED_EXTENSIONS: QMC_EXTENSIONS } = require('./qmc-decrypt');
const { writeMetadata } = require('./meta-writer');


// ============ 格式检测 ============

/**
 * 根据文件扩展名判断加密类型
 * @param {string} filePath - 文件路径
 * @returns {'ncm'|'qmc'|null} 加密类型
 */
function detectType(filePath) {
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  if (ext === 'ncm') return 'ncm';
  if (QMC_EXTENSIONS.includes(ext)) return 'qmc';
  return null;
}

/**
 * 检查文件是否为支持的加密格式
 */
function isSupported(filePath) {
  return detectType(filePath) !== null;
}


// ============ 核心解锁 API ============

/**
 * 解锁加密音乐文件
 *
 * @param {string|Buffer} input - 加密文件路径或 Buffer
 * @param {object} [options] - 额外选项
 * @param {boolean} [options.writeMeta=true] - 是否写入元数据
 * @param {string} [options.type] - 强制指定加密类型（'ncm' 或 'qmc'）
 * @returns {Promise<object>} 解密结果
 */
async function unlock(input, options = {}) {
  const {
    writeMeta: doWriteMeta = true,
  } = options;

  // 读取文件
  let buffer, filename, fileType;
  if (typeof input === 'string') {
    buffer = fs.readFileSync(input);
    filename = path.basename(input);
    fileType = options.type || detectType(input);
    if (!fileType) {
      throw new Error(`不支持的加密格式: ${path.extname(input)}。支持: .ncm, .qmc0, .qmc1, .qmc3, .qmcflac, .qmcogg, .mflac, .mgg, .qmcmp3`);
    }
  } else if (Buffer.isBuffer(input)) {
    buffer = input;
    filename = options.filename || 'unknown';
    if (!options.type) {
      throw new TypeError('Buffer 输入时必须通过 options.type 指定加密类型 ("ncm" 或 "qmc")');
    }
    fileType = options.type;
  } else {
    throw new TypeError('input 必须是文件路径 (string) 或 Buffer');
  }

  // 执行解密
  let result;
  if (fileType === 'ncm') {
    const decryptor = new NcmDecryptor(buffer, filename);
    result = await decryptor.decrypt();
  } else if (fileType === 'qmc') {
    const decryptor = new QmcDecryptor(buffer, filename);
    result = await decryptor.decrypt();
  } else {
    throw new Error(`未知的加密类型: ${fileType}`);
  }

  // 检测/确认音频格式
  if (!result.format) {
    result.format = detectAudioFormat(result.audio);
  }

  // 写入元数据
  if (doWriteMeta && result.audio) {
    console.log('  写入元数据...');
    const audioWithMeta = writeMetadata(result.audio, {
      title: result.title,
      artist: result.artist,
      album: result.album,
      albumartist: result.albumartist,
      year: result.year,
      genre: result.genre,
      track: result.track,
      disk: result.disk,
      composer: result.composer,
      publisher: result.publisher,
      copyright: result.copyright,
      comment: result.comment,
      isrc: result.isrc,
      bpm: result.bpm,
      picture: result.image,
    }, result.format);
    result.audio = audioWithMeta;
  }

  return result;
}


/**
 * 解锁加密文件并保存
 *
 * @param {string} inputPath - 加密文件路径
 * @param {string} [outputPath] - 输出文件路径（可选，默认自动生成）
 * @param {object} [options] - 额外选项
 * @returns {Promise<string>} 输出文件路径
 */
async function unlockToFile(inputPath, outputPath, options = {}) {
  const absInput = path.resolve(inputPath);

  if (!fs.existsSync(absInput)) {
    throw new Error(`文件不存在: ${absInput}`);
  }

  const fileType = detectType(absInput);
  console.log(`\n解锁: ${path.basename(absInput)} [${fileType.toUpperCase()}]`);

  const result = await unlock(absInput, options);

  // 确定输出路径
  let outPath;
  if (outputPath) {
    outPath = path.resolve(outputPath);
  } else {
    const inputDir = path.dirname(absInput);
    const inputName = path.basename(absInput, path.extname(absInput));
    // 生成安全的文件名
    const artist = result.artist ? result.artist.replace(/[\\/:*?"<>|]/g, '_') : '';
    const title = result.title ? result.title.replace(/[\\/:*?"<>|]/g, '_') : inputName;
    let safeName;
    if (artist && title) {
      safeName = `${artist} - ${title}`;
    } else {
      safeName = title || inputName;
    }
    outPath = path.join(inputDir, `${safeName}.${result.format}`);
    // 避免重名
    if (fs.existsSync(outPath)) {
      outPath = path.join(inputDir, `${safeName}_unlocked.${result.format}`);
    }
  }

  // 写入文件
  fs.writeFileSync(outPath, result.audio);
  console.log(`✓ 已保存: ${path.basename(outPath)}`);

  // 打印元信息摘要
  console.log(`  格式: ${result.format.toUpperCase()}`);
  if (result.title) console.log(`  标题: ${result.title}`);
  if (result.artist) console.log(`  歌手: ${result.artist}`);
  if (result.album) console.log(`  专辑: ${result.album}`);
  if (result.image) console.log(`  封面: ${(result.image.length / 1024).toFixed(1)} KB`);
  console.log(`  大小: ${(result.audio.length / 1024 / 1024).toFixed(2)} MB`);

  return outPath;
}


/**
 * 批量解锁目录中的加密文件
 *
 * @param {string} dirPath - 目录路径
 * @param {object} [options] - 额外选项
 * @param {string} [options.outputDir] - 输出目录（默认同源目录）
 * @param {boolean} [options.recursive=false] - 是否递归子目录
 * @returns {Promise<object[]>} 解密结果数组
 */
async function unlockDirectory(dirPath, options = {}) {
  const {
    outputDir = null,
    recursive = false,
  } = options;

  const absDir = path.resolve(dirPath);
  if (!fs.existsSync(absDir)) {
    throw new Error(`目录不存在: ${absDir}`);
  }

  // 查找所有支持的加密文件
  const encryptedFiles = findEncryptedFiles(absDir, recursive);
  if (encryptedFiles.length === 0) {
    console.log('未找到加密文件（支持 .ncm, .qmc*, .mflac, .mgg 等）');
    return [];
  }

  console.log(`找到 ${encryptedFiles.length} 个加密文件\n`);

  const results = [];
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < encryptedFiles.length; i++) {
    const filePath = encryptedFiles[i];
    const fileType = detectType(filePath);
    console.log(`[${i + 1}/${encryptedFiles.length}] ${path.basename(filePath)} [${fileType.toUpperCase()}]`);

    try {
      const outPath = outputDir
        ? path.join(outputDir, path.basename(filePath, path.extname(filePath)) + '.mp3')
        : undefined;
      const out = await unlockToFile(filePath, outPath, options);
      results.push({ success: true, input: filePath, output: out });
      successCount++;
    } catch (err) {
      console.error(`✗ 失败: ${err.message}`);
      results.push({ success: false, input: filePath, error: err.message });
      failCount++;
    }
  }

  console.log(`\n===== 完成 =====`);
  console.log(`成功: ${successCount}, 失败: ${failCount}`);

  return results;
}


/**
 * 递归查找目录中所有支持的加密文件
 */
function findEncryptedFiles(dir, recursive) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && recursive) {
      results.push(...findEncryptedFiles(fullPath, recursive));
    } else if (entry.isFile() && isSupported(entry.name)) {
      results.push(fullPath);
    }
  }

  return results;
}


// ============ 兼容旧 API ============

// 保持向后兼容的别名
const findNcmFiles = (dir, recursive) =>
  findEncryptedFiles(dir, recursive).filter(f => path.extname(f).toLowerCase() === '.ncm');


// ============ 导出 ============

module.exports = {
  unlock,
  unlockToFile,
  unlockDirectory,
  detectType,
  isSupported,
  findEncryptedFiles,
  // 兼容旧 API
  findNcmFiles,
  NcmDecryptor,
  QmcDecryptor,
};
