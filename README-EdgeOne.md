# 舞刀 · EdgeOne Pages 部署说明

本仓库已经适配 EdgeOne Pages：网页静态文件由 Pages 托管，函数处理 `/api/*` 的 B 站解析、登录和媒体流代理。为兼容 Pages 旧版与 Makers 新版，仓库同时提供 `functions/api/[[default]].js` 和 `edge-functions/api/[[default]].js` 两种目录约定。

## 已支持的功能

- 本地文件练习、笔记、AB 循环、节拍器、日历、分账与 IndexedDB 数据保存。
- B 站链接解析、单文件播放、DASH 信息获取、扫码登录与登录状态校验。
- B 站媒体的 Range 流式转发，支持视频拖动进度。
- FFmpeg 加速导出由 EdgeOne 静态托管 WASM 核心，用户确认后才在浏览器本地载入；核心以 gzip 文件传输并由浏览器自动解压，不需要云端转码服务。

为保证手机稳定性，FFmpeg 加速导出最多读取 120 MB 的输入视频；节拍检测最多分析 3 分钟且文件不超过 24 MB。较长视频请使用实时渲染、原视频下载或手动设置 BPM。

登录后的 B 站 Cookie 只写入本站 `/api` 路径下的 `HttpOnly`、`Secure` Cookie，不再写入 LocalStorage 或拼接到视频 URL 中。二维码生成库已随仓库放入 `js/vendor/`，部署和扫码不依赖 Python、Pillow 或外部二维码 CDN。不要把包含 Cookie 的浏览器数据导出或分享给他人。

## EdgeOne 的限制与取舍

EdgeOne Pages 云函数的响应体上限为 6 MB，且最长执行 120 秒，因此原 `serve.py` 的 ffmpeg 合并、8 GB 本地缓存、预缓存与缓存清理功能不适用于 Serverless 环境。本次改造已让所有清晰度直接走流式代理；长视频、超高码率视频的连续播放仍受 EdgeOne 函数时限和 B 站策略影响。

`/api/video` 只允许代理 `bilivideo.com`、`bilivideo.cn` 与 `acgvideo.com` 的媒体地址，避免把公开站点变成任意地址的转发器。用户自行添加的普通 HTTPS 视频直链会由浏览器直接播放，不经过代理。

## 从 GitHub 部署到 EdgeOne Pages

1. 将此改造后的目录推送到你自己的 GitHub 仓库。
2. 打开 [EdgeOne Makers](https://edgeone.ai/pages/)，创建项目并关联该 GitHub 仓库。
3. 选择静态站点配置：根目录为 `./`，不填写构建命令，输出目录填 `./`。
4. 选择加速区域后开始部署。仓库中的 `edgeone.json` 默认将函数部署到广州与香港；如项目只面向单一地区，可在控制台或该文件中调整。
5. 打开预览域名，访问 `/api/health`。得到 `{"ok":true}` 后，再在网页中测试 B 站解析与播放。

后续推送到已关联的部署分支，EdgeOne 会自动重新构建并发布。

## 本地运行

```powershell
cd E:/AIuse/dance-wb
python serve.py 8000
```

本地服务已不强制安装 `qrcode`；浏览器会生成登录二维码。若网络策略阻止二维码 CDN，可使用页面中的手动 Cookie 登录方式。
