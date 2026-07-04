/**
 * NCM 解锁主模块
 *
 * 整合解密和元数据写入，提供简洁的 API 接口。
 *
 * 用法：
 *   const { unlock, unlockToFile } = require('./index');
 *
 *   // 解锁文件并保存
 *   await unlockToFile('song.ncm', 'song.mp3');
 *
 *   // 或获取解密后的数据
 *   const result = await unlock('song.ncm');
 *   // result.audio   → 解密后+写入元数据的音频 Buffer
 *   // result.title   → 歌曲标题
 *   // result.artist  → 歌手名
 *   // result.album   → 专辑名
 *   // result.format  → 音频格式
 *   // result.imageBuffer → 封面图 Buffer
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { NcmDecryptor, detectAudioFormat } = require('./ncm-decrypt');
const { writeMetadata } = require('./meta-writer');


/**
 * 解锁 NCM 文件
 *
 * @param {string|Buffer} input - NCM 文件路径或 Buffer
 * @param {object} [options] - 额外选项
 * @param {boolean} [options.writeMeta=true] - 是否写入元数据
 * @param {boolean} [options.downloadCover=true] - 是否下载封面图
 * @returns {Promise<object>} 解密结果
 */
async function unlock(input, options = {}) {
  const {
    writeMeta = true,
  } = options;

  // 读取文件
  let buffer, filename;
  if (typeof input === 'string') {
    buffer = fs.readFileSync(input);
    filename = path.basename(input, path.extname(input));
  } else if (Buffer.isBuffer(input)) {
    buffer = input;
    filename = 'unknown';
  } else {
    throw new TypeError('input 必须是文件路径 (string) 或 Buffer');
  }

  // 解密
  const decryptor = new NcmDecryptor(buffer, filename);
  const result = await decryptor.decrypt();

  // 检测/确认音频格式
  if (!result.format) {
    result.format = detectAudioFormat(result.audio);
  }

  // 写入元数据
  if (writeMeta && result.audio) {
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
 * 解锁 NCM 文件并保存到文件
 *
 * @param {string} inputPath - NCM 文件路径
 * @param {string} [outputPath] - 输出文件路径（可选，默认自动生成）
 * @param {object} [options] - 额外选项
 * @returns {Promise<string>} 输出文件路径
 */
async function unlockToFile(inputPath, outputPath, options = {}) {
  const absInput = path.resolve(inputPath);

  if (!fs.existsSync(absInput)) {
    throw new Error(`文件不存在: ${absInput}`);
  }

  console.log(`\n解锁: ${path.basename(absInput)}`);

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
  console.log(`  标题: ${result.title}`);
  if (result.artist) console.log(`  歌手: ${result.artist}`);
  if (result.album) console.log(`  专辑: ${result.album}`);
  if (result.image) console.log(`  封面: ${(result.image.length / 1024).toFixed(1)} KB`);
  console.log(`  大小: ${(result.audio.length / 1024 / 1024).toFixed(2)} MB`);

  return outPath;
}

/**
 * 批量解锁目录中的 NCM 文件
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

  // 查找 NCM 文件
  const ncmFiles = findNcmFiles(absDir, recursive);
  if (ncmFiles.length === 0) {
    console.log('未找到 .ncm 文件');
    return [];
  }

  console.log(`找到 ${ncmFiles.length} 个 .ncm 文件\n`);

  const results = [];
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < ncmFiles.length; i++) {
    const filePath = ncmFiles[i];
    console.log(`[${i + 1}/${ncmFiles.length}] ${path.basename(filePath)}`);

    try {
      const outPath = outputDir
        ? path.join(outputDir, path.basename(filePath, '.ncm') + '.mp3')
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
 * 递归查找目录中的 NCM 文件
 */
function findNcmFiles(dir, recursive) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && recursive) {
      results.push(...findNcmFiles(fullPath, recursive));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.ncm')) {
      results.push(fullPath);
    }
  }

  return results;
}


module.exports = {
  unlock,
  unlockToFile,
  unlockDirectory,
  NcmDecryptor,
};
