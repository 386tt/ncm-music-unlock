# **.ncm文件转换器**

由DeepSeek V4pro+Claude+我共同完成

#### **基础版**使用教程:

html版：直接点开unlock.html文件，将.ncm文件拖入文件框中(或点击文件框选择文件)

解析成功后点击下载或全部下载，即可获得.mp3或.flac文件

#### **进阶版**使用教程:

**ps:需要下载并配置Node.js运行环境**

点击文件框下方的***"点击了解如何解决 →"*，**根据提示在.html文件目录打开**终端**，输入<code>node server.js</code>

访问 \[此链接](http://localhost:3456)
即可调用网易云API获得元信息(如流派、年份、发行方等信息)

#### 命令行版：

&#x20; <code>git clone https://github.com/386tt/ncm-music-unlock.git<code>

&#x20; <code>cd ncm-music-unlock<code>

&#x20; <code>npm install<code>

&#x20; <code>node server.js<code>

&#x20; 浏览器打开 http://localhost:3456后使用

## **为什么会信息不全？**

网易云没有给所有音乐添加信息，特别是老音乐或是小众音乐，若实在需要元信息，需手动用MP3tag添加信息





