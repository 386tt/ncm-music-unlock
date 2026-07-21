# 音乐解锁

在浏览器或命令行中解锁加密音乐文件，支持网易云音乐 `.ncm` 和 QQ 音乐 `.qmc*`/`.mflac`/`.mgg` 格式，完整保留元信息。

## 功能

- **多平台支持** — 网易云音乐 (.ncm) + QQ 音乐 (.qmc0/.qmc1/.qmc3/.qmcogg/.qmcflac/.mflac/.mgg/.qmcmp3)
- **拖拽即用** — 打开 `unlock.html`，拖入加密文件即可解锁，纯前端运行，文件不上传
- **批量处理** — 支持多文件拖拽，一键全部下载
- **完整元信息** — 保留并写入 ID3v2.4（MP3）/ Vorbis Comment（FLAC）标签，包括封面图
- **在线增强** — 搭配 `server.js` 可自动获取流派、年份、发行方等网易云在线元数据
- **命令行支持** — Node.js CLI 批量解密，支持递归目录

## 浏览器使用

1. 下载项目，通过本地服务器打开：
   ```bash
   node server.js
   ```
   然后访问 **http://localhost:3456**

2. 拖拽 `.ncm` / `.qmc*` / `.mflac` / `.mgg` 文件到页面中
3. 点击"全部下载"保存解锁后的音频文件

> ⚠️ 直接双击打开 `unlock.html` 无法加载 QMC 解密引擎（QQ音乐），也无法获取在线元数据。**请务必通过 `node server.js` 使用。**

## 命令行使用

```bash
# 安装依赖
npm install

# 解密单个 NCM 文件
node cli.js music.ncm

# 解密单个 QMC 文件（QQ音乐）
node cli.js music.mflac
node cli.js music.mgg

# 解密目录下所有加密文件
node cli.js ./music/

# 递归解密子目录
node cli.js ./music/ -r
```

## 在线元数据

启动本地代理服务器，自动从网易云获取歌曲的流派、年份、发行方等信息：

```bash
node server.js
```

然后通过浏览器访问 **http://localhost:3456** 即可。

## 文件结构

| 文件 | 说明 |
|------|------|
| `unlock.html` | 纯前端拖拽解锁页面（NCM + QMC） |
| `ncm-decrypt.js` | NCM 解密核心（AES-128-ECB + RC4 KeyBox） |
| `qmc-decrypt.js` | QMC 解密核心（基于 @xhacker/qmcwasm） |
| `meta-writer.js` | ID3v2.4 / FLAC 元信息写入 |
| `cli.js` | Node.js 命令行工具 |
| `index.js` | 库主入口（自动识别格式） |
| `server.js` | 本地代理服务器（网易云 API + QMC 引擎服务） |
| `test.js` | 测试 |

## 技术细节

- **NCM 解密**: 纯 JS 实现 AES-128-ECB 解密 + RC4 变体密钥盒，浏览器零依赖
- **QMC 解密**: 使用 @xhacker/qmcwasm (WASM) / QmcLegacy.js (纯 JS) 引擎，支持 QMCv1/v2 所有变体
- 支持 MP3、FLAC、OGG、WAV 等格式
- FLAC 文件保留原始音频帧，仅替换/追加 Vorbis Comment 和 Picture block
- MP3 写入 ID3v2.4 标签头，兼容主流播放器
- 自动检测解密后音频的实际格式

## QQ 音乐支持格式详情

| 加密格式 | 解密后格式 | 说明 |
|----------|-----------|------|
| `.qmc0` `.qmc1` `.qmc3` `.qmcmp3` | MP3 | QMCv1 静态/密钥加密 |
| `.qmcflac` | FLAC | QMCv1 FLAC 加密 |
| `.qmcogg` | OGG | QMCv1 OGG 加密 |
| `.mflac` | FLAC | QMCv2 MapCipher FLAC |
| `.mgg` | OGG/M4A | QMCv2 MapCipher OGG |

## License

MIT

---

## 更新日志

### v2.4 (2026-07-21)

- 🔍 **QMC 在线元数据搜索** — QMC 解密后自动通过 iTunes/Netease/MusicBrainz 搜索补全专辑、发行商、流派、年份等信息
- 🏷️ **ID3v2 标签完整替换** — 解密后移除原始 ID3v2 标签，用新标签完整覆盖，避免残留旧标签干扰
- 🎵 **专辑艺术家支持** — Netease API 新增 `albumartist` 字段提取（区分于曲目艺术家，如合辑）
- 🖼️ **封面图在线传递** — 在线获取的封面图 URL 传递到下载结果，浏览器端可直接显示
- 🔎 **元信息重搜按钮** — 结果卡片新增「🔍 元信息」按钮，支持手动重新搜索在线元数据

### v2.3 (2026-07-20)

- 🎵 **QQ 音乐解密支持** — 新增 QMC 解密引擎，支持 .qmc0/.qmc1/.qmc3/.qmcogg/.qmcflac/.mflac/.mgg/.qmcmp3 格式
- 🔧 **统一 CLI** — `cli.js` 自动识别 NCM/QMC 格式，无需手动指定
- 🌐 **浏览器 QMC 支持** — `unlock.html` 通过本地服务器加载 QmqLegacy 引擎，支持 QQ 音乐拖拽解锁
- 📦 **模块化设计** — 新增 `qmc-decrypt.js` 核心模块，`index.js` 统一入口自动分发

### v2.2 (2026-07-20)

- 🎨 **Apple 风格 UI 全面美化** — unlock.html 采用毛玻璃效果、SF 字体、胶囊按钮、iOS Sheet 风格 Modal、层叠阴影
- 🌗 **浅色/暗色双模式** — 支持系统自动切换 + 手动切换，右上角一键切换主题
- ✨ **全新交互动画** — 卡片交错入场、拖拽呼吸光效、按钮弹性反馈、进度条光泽扫描
- 🎨 **Vue 版本同步美化** — Element UI 色系整体替换为 Apple Design 配色，毛玻璃上传区
- 🔧 **CSS 变量体系重构** — 统一设计 Token，浅色/暗色一键切换

### v2.1 (2026-07)

- 🎉 初始发布
- NCM 解密核心 (AES-128-ECB + RC4 KeyBox)
- MP3 ID3v2.4 / FLAC Vorbis Comment 元信息写入
- 浏览器拖拽解锁 + 命令行批量处理
- 在线元数据代理服务器

---

## 贡献者

| 姓名 | GitHub | 角色 |
|------|--------|------|
| **386tt** | [@386tt](https://github.com/386tt) | 作者 & 维护者 |

> 本项目 NCM 解密参考了 [unlock-music](https://git.unlock-music.dev/um/web)，QMC 解密使用 [QmcWasm](https://github.com/xhacker-zzz/QmcWasm)。
