# NCM 音乐解锁

在浏览器或命令行中解锁网易云音乐 `.ncm` 加密文件，完整保留元信息（标题、歌手、专辑、封面图、流派、年份、发行方等）。

## 功能

- **拖拽即用** — 打开 `unlock.html`，拖入 `.ncm` 文件即可解锁，纯前端运行，文件不上传
- **批量处理** — 支持多文件拖拽，一键全部下载
- **完整元信息** — 保留并写入 ID3v2.4（MP3）/ Vorbis Comment（FLAC）标签，包括封面图
- **在线增强** — 搭配 `server.js` 可自动获取流派、年份、发行方等网易云在线元数据
- **命令行支持** — Node.js CLI 批量解密，支持递归目录

## 浏览器使用

1. 下载项目，用浏览器打开 `unlock.html`
2. 拖拽 `.ncm` 文件到页面中
3. 点击"全部下载"保存解锁后的音频文件

> 直接双击打开 HTML 无法获取在线元数据。如需完整信息，请参考下方 **在线元数据** 部分。

## 命令行使用

```bash
# 安装依赖
npm install

# 解密单个文件
node cli.js music.ncm

# 解密目录下所有 .ncm 文件
node cli.js ./music/

# 递归解密子目录
node cli.js ./music/ -r
```

## 在线元数据

启动本地代理服务器，自动从网易云获取歌曲的流派、年份、发行方等信息：

```bash
node server.js
```

然后通过浏览器访问 **http://localhost:3456** 打开 `unlock.html` 即可。

## 文件结构

| 文件 | 说明 |
|------|------|
| `unlock.html` | 纯前端拖拽解锁页面 |
| `ncm-decrypt.js` | NCM 解密核心（AES-128-ECB + RC4 KeyBox） |
| `meta-writer.js` | ID3v2.4 / FLAC 元信息写入 |
| `cli.js` | Node.js 命令行工具 |
| `index.js` | 库主入口 |
| `server.js` | 本地代理服务器（网易云 API） |
| `test.js` | 测试 |

## 技术细节

- 纯 JS 实现 AES-128-ECB 解密，浏览器零依赖
- 支持 MP3、FLAC、OGG、WAV 等格式
- FLAC 文件保留原始音频帧，仅替换/追加 Vorbis Comment 和 Picture block
- MP3 写入 ID3v2.4 标签头，兼容主流播放器

## License

MIT
