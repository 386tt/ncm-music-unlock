#!/usr/bin/env node

/**
 * 音乐解锁命令行工具
 *
 * 支持格式：
 *   - NCM (网易云音乐): .ncm
 *   - QMC (QQ 音乐): .qmc0/.qmc1/.qmc3/.qmcogg/.qmcflac/.mgg/.mflac/.qmcmp3
 *
 * 用法：
 *   node cli.js <file>                   # 解锁单个文件（自动识别格式）
 *   node cli.js <file1> <file2>          # 解锁多个文件
 *   node cli.js <directory>              # 解锁目录中所有加密文件
 *   node cli.js <directory> --recursive  # 递归解锁子目录
 *   node cli.js <file> -o <out.mp3>      # 指定输出路径
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { unlockToFile, unlockDirectory, isSupported } = require('./index');

// 解析命令行参数
function parseArgs(args) {
  const options = {
    output: null,
    recursive: false,
    writeMeta: true,
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
  目录              目录中的所有加密文件（非递归）

选项:
  -o, --output     指定输出文件/目录路径
  -r, --recursive  递归处理子目录
  --no-meta        不写入元数据到音频文件
  -h, --help       显示此帮助信息

示例:
  node cli.js song.ncm
  node cli.js song.mflac
  node cli.js song.qmcflac -o output.flac
  node cli.js ./music/
  node cli.js ./music/ --recursive
  node cli.js *.ncm *.mflac
`);
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const { inputs, options } = parseArgs(rawArgs);

  if (inputs.length === 0) {
    printHelp();
    process.exit(1);
  }

  console.log('╔══════════════════════════════════╗');
  console.log('║    音乐解锁工具 v2.3            ║');
  console.log('║    NCM · QMC / QQ音乐           ║');
  console.log('╚══════════════════════════════════╝');

  const startTime = Date.now();

  for (const input of inputs) {
    const absPath = path.resolve(input);

    try {
      const stat = fs.statSync(absPath);

      if (stat.isDirectory()) {
        // 处理目录
        await unlockDirectory(absPath, {
          outputDir: options.output,
          recursive: options.recursive,
          writeMeta: options.writeMeta,
        });
      } else if (stat.isFile()) {
        // 处理单个文件
        const ext = path.extname(absPath).toLowerCase();
        if (!isSupported(absPath)) {
          console.warn(`⚠ 警告: "${ext}" 不是已知的加密格式，将尝试解锁`);
        }
        await unlockToFile(absPath, options.output, {
          writeMeta: options.writeMeta,
        });
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
