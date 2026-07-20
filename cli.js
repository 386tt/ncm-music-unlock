#!/usr/bin/env node

/**
 * 音乐解锁命令行工具
 *
 * 支持格式：
 *   - NCM (网易云音乐): .ncm
 *   - QMC (QQ 音乐): .qmc0/.qmc1/.qmc3/.qmcogg/.qmcflac/.mgg/.mflac/.qmcmp3
 *
 * 用法：
 *   node cli.js <file> --search          # 解密后交互式搜索元信息
 *   node cli.js <file> --auto            # 解密后自动匹配元信息
 *   node cli.js <file> -o <out.mp3>      # 指定输出路径
 */

'use strict';

const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { unlock, isSupported } = require('./index');
const { writeMetadata, detectImageMime } = require('./meta-writer');

// 解析命令行参数
function parseArgs(args) {
  const options = {
    output: null,
    recursive: false,
    writeMeta: true,
    search: false,
    auto: false,
  };
  const inputs = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === '-o' || arg === '--output') {
      i++;
      options.output = args[i];
    } else if (arg === '-r' || arg === '--recursive') {
      options.recursive = true;
    } else if (arg === '--no-meta') {
      options.writeMeta = false;
    } else if (arg === '--search') {
      options.search = true;
    } else if (arg === '--auto') {
      options.auto = true;
    } else if (arg === '-h' || arg === '--help') {
      printHelp();
      process.exit(0);
    } else if (!arg.startsWith('-')) {
      inputs.push(arg);
    }
    i++;
  }

  return { inputs, options };
}

function printHelp() {
  console.log(`
音乐解锁工具 — 将加密音乐文件解锁为无加密的音频文件，保留所有元信息

支持格式:
  网易云音乐: .ncm
  QQ 音乐:    .qmc0 .qmc1 .qmc3 .qmcogg .qmcflac .mflac .mgg .qmcmp3

用法:
  node cli.js <输入> [选项]

输入可以是:
  加密文件          单个加密文件（自动识别 NCM/QMC）
  目录              目录中的所有加密文件（需配合 --auto）

元信息搜索:
  --search          解密后搜索外部音乐数据库，交互式选择元信息
  --auto            解密后自动匹配最佳结果，静默写入

其他选项:
  -o, --output      指定输出文件路径
  -r, --recursive   递归处理子目录
  --no-meta         不写入元数据到音频文件
  -h, --help        显示此帮助信息

示例:
  node cli.js song.ncm --search
  node cli.js song.mflac --auto
  node cli.js song.qmcflac -o output.flac --search
  node cli.js ./music/ --auto
`);
}

/**
 * 交互式搜索元信息
 * @param {object} meta - 当前元信息 { title, artist }
 * @returns {object|null} 选中的搜索结果，或 null（跳过）
 */
async function interactiveSearch(meta) {
  const { searchAll, flattenResults } = require('./metadata-search');

  const query = meta.artist
    ? `${meta.artist} ${meta.title}`
    : meta.title;

  console.log(`\n  🔍 正在搜索: "${query}" ...`);

  let allResults;
  try {
    const grouped = await searchAll(meta.title, meta.artist);
    allResults = flattenResults(grouped);

    // 按优先级排序: itunes > netease > musicbrainz > qqmusic
    const providerOrder = { itunes: 0, netease: 1, musicbrainz: 2, qqmusic: 3 };
    allResults.sort((a, b) =>
      (providerOrder[a.provider] || 99) - (providerOrder[b.provider] || 99)
    );
  } catch (e) {
    console.error(`  ✗ 搜索失败: ${e.message}`);
    return null;
  }

  if (allResults.length === 0) {
    console.log('  ✗ 未找到匹配的元信息');
    return null;
  }

  // 显示前 8 条结果
  const display = allResults.slice(0, 8);
  console.log(`\n  找到 ${allResults.length} 条结果，显示前 ${display.length} 条:\n`);

  for (let i = 0; i < display.length; i++) {
    const r = display[i];
    const tag = r.provider.toUpperCase().padEnd(12);
    const details = [
      r.year ? r.year : '',
      r.album ? `「${r.album}」` : '',
      r.genre || '',
      r.isrc ? `ISRC:${r.isrc}` : '',
    ].filter(Boolean).join(' · ');
    console.log(`  [${i + 1}] ${tag} ${r.title} — ${r.artist}`);
    if (details) console.log(`      ${details}`);
  }

  // 交互式选择
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(resolve => {
    rl.question('\n  选择结果 (1-8), A=全搜, 0=跳过: ', resolve);
  });
  rl.close();

  if (answer === '0' || answer === '') return null;
  if (answer.toLowerCase() === 'a') {
    // Rerun with all results shown
    console.log(`\n  全部 ${allResults.length} 条结果:`);
    for (let i = 0; i < allResults.length; i++) {
      const r = allResults[i];
      console.log(`  [${i + 1}] ${r.provider.padEnd(12)} ${r.title} — ${r.artist}`);
    }
    const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
    const a2 = await new Promise(resolve => {
      rl2.question('\n  选择结果: ', resolve);
    });
    rl2.close();
    const num = parseInt(a2, 10);
    if (num >= 1 && num <= allResults.length) return allResults[num - 1];
    return null;
  }

  const num = parseInt(answer, 10);
  if (num >= 1 && num <= display.length) return display[num - 1];

  return null;
}

/**
 * 处理单个文件（支持搜索）
 */
async function processFile(absPath, options) {
  const ext = path.extname(absPath).toLowerCase();
  if (!isSupported(absPath)) {
    console.warn(`⚠ 警告: "${ext}" 不是已知的加密格式，将尝试解锁`);
  }

  console.log(`\n解锁: ${path.basename(absPath)}`);

  // 1. 解密
  const result = await unlock(absPath, { writeMeta: options.writeMeta });

  console.log(`  格式: ${result.format.toUpperCase()}`);
  if (result.title) console.log(`  标题: ${result.title}`);
  if (result.artist) console.log(`  歌手: ${result.artist}`);

  // 2. 元信息搜索
  let enrichedMeta = null;
  if (options.auto) {
    // 自动模式：取 iTunes 第一条
    try {
      const { searchiTunes } = require('./metadata-search');
      const query = result.artist
        ? `${result.artist} ${result.title}`
        : result.title;
      console.log(`  🔍 自动匹配: "${query}"...`);
      const itunesResults = await searchiTunes(result.title, result.artist);
      if (itunesResults.length > 0) {
        enrichedMeta = itunesResults[0];
        console.log(`  ✓ 匹配: ${enrichedMeta.title} — ${enrichedMeta.artist} [${enrichedMeta.year}]`);
      }
    } catch (e) {
      console.log(`  ✗ 自动匹配失败: ${e.message}`);
    }
  } else if (options.search) {
    // 交互式搜索
    enrichedMeta = await interactiveSearch(result);
  }

  // 3. 合并元信息
  let finalMeta = {
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
  };

  if (enrichedMeta) {
    const { mergeMetadata } = require('./metadata-search');

    // 下载封面图（如果有 URL 但没有 Buffer）
    if (enrichedMeta.coverUrl && !finalMeta.picture) {
      try {
        const { httpGet } = require('./metadata-search');
        const imgRes = await httpGet(enrichedMeta.coverUrl);
        finalMeta.picture = Buffer.from(imgRes.data, imgRes.data instanceof Buffer ? undefined : 'binary');
        console.log(`  🖼 下载封面图: ${(finalMeta.picture.length / 1024).toFixed(1)} KB`);
      } catch (e) {
        // 封面下载失败不碍事
      }
    }

    finalMeta = mergeMetadata(finalMeta, enrichedMeta);
  }

  // 4. 确定输出路径
  let outPath;
  if (options.output) {
    outPath = path.resolve(options.output);
  } else {
    const inputDir = path.dirname(absPath);
    const inputName = path.basename(absPath, path.extname(absPath));
    const artist = finalMeta.artist
      ? finalMeta.artist.replace(/[\\/:*?"<>|]/g, '_')
      : '';
    const title = finalMeta.title
      ? finalMeta.title.replace(/[\\/:*?"<>|]/g, '_')
      : inputName;
    let safeName = artist && title ? `${artist} - ${title}` : (title || inputName);
    outPath = path.join(inputDir, `${safeName}.${result.format}`);
    if (fs.existsSync(outPath)) {
      outPath = path.join(inputDir, `${safeName}_unlocked.${result.format}`);
    }
  }

  // 5. 写入文件（仅在保存时写入元信息）
  const audioWithMeta = writeMetadata(result.audio, finalMeta, result.format);
  fs.writeFileSync(outPath, audioWithMeta);

  console.log(`✓ 已保存: ${path.basename(outPath)}`);
  console.log(`  大小: ${(result.audio.length / 1024 / 1024).toFixed(2)} MB`);

  return outPath;
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const { inputs, options } = parseArgs(rawArgs);

  if (inputs.length === 0) {
    printHelp();
    process.exit(1);
  }

  console.log('╔══════════════════════════════════╗');
  console.log('║    音乐解锁工具 v2.4            ║');
  console.log('║    NCM · QMC + 元信息搜索       ║');
  console.log('╚══════════════════════════════════╝');

  const startTime = Date.now();

  for (const input of inputs) {
    const absPath = path.resolve(input);

    try {
      const stat = fs.statSync(absPath);

      if (stat.isDirectory()) {
        // 目录处理：递归查找加密文件
        const { findEncryptedFiles } = require('./index');
        const files = findEncryptedFiles(absPath, options.recursive);

        if (files.length === 0) {
          console.log('未找到加密文件');
          continue;
        }

        console.log(`找到 ${files.length} 个加密文件\n`);

        let successCount = 0, failCount = 0;

        for (let i = 0; i < files.length; i++) {
          console.log(`[${i + 1}/${files.length}]`);
          try {
            await processFile(files[i], options);
            successCount++;
          } catch (err) {
            console.error(`✗ 失败: ${err.message}`);
            failCount++;
          }
        }

        console.log(`\n===== 完成 =====`);
        console.log(`成功: ${successCount}, 失败: ${failCount}`);
      } else if (stat.isFile()) {
        await processFile(absPath, options);
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.error(`✗ 错误: 路径不存在: ${absPath}`);
      } else {
        console.error(`✗ 错误: ${err.message}`);
      }
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n总耗时: ${elapsed}s`);
}

main().catch(err => {
  console.error('发生未预期的错误:', err);
  process.exit(1);
});
