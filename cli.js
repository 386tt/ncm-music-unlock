#!/usr/bin/env node

/**
 * NCM 解锁命令行工具
 *
 * 用法：
 *   node cli.js <file.ncm>              # 解锁单个文件
 *   node cli.js <file1.ncm> <file2.ncm> # 解锁多个文件
 *   node cli.js <directory>              # 解锁目录中所有 .ncm 文件
 *   node cli.js <directory> --recursive  # 递归解锁子目录
 *   node cli.js <file.ncm> -o <out.mp3>  # 指定输出路径
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { unlockToFile, unlockDirectory } = require('./index');

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
NCM 音乐解锁工具 — 将 .ncm 文件解锁为无加密的音频文件，保留所有元信息

用法:
  node cli.js <输入> [选项]

输入可以是:
  .ncm 文件        单个 NCM 文件
  目录              目录中的所有 .ncm 文件（非递归）

选项:
  -o, --output     指定输出文件/目录路径
  -r, --recursive  递归处理子目录
  --no-meta        不写入元数据到音频文件
  -h, --help       显示此帮助信息

示例:
  node cli.js song.ncm
  node cli.js song.ncm -o output.mp3
  node cli.js ./music/
  node cli.js ./music/ --recursive
  node cli.js *.ncm
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
  console.log('║    NCM 音乐解锁工具 v1.0.0      ║');
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
        if (!absPath.toLowerCase().endsWith('.ncm')) {
          console.warn(`警告: ${path.basename(absPath)} 不是 .ncm 文件，将尝试解锁`);
        }
        await unlockToFile(absPath, options.output, {
          writeMeta: options.writeMeta,
        });
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.error(`错误: 路径不存在: ${absPath}`);
      } else {
        console.error(`错误: ${err.message}`);
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
