# 舞刀 · 自托管部署指南

这份软件本来跑在临时的 Cloud Studio 沙箱里，沙箱休眠后外部浏览器就打不开了。
把整个 `/workspace` 目录（也就是本项目）拷到你**自己长期开着的电脑或服务器**上运行，就能 7×24 随时用，不再受沙箱休眠影响。

前端调用的是相对路径 `/api/...`，**没有任何写死的地址**，搬到哪里都能跑。

> **关于数据留存**：你的收藏夹、视频、笔记、日历、分账等所有个人数据都存储在**浏览器本地 IndexedDB** 中；服务端 `serve.py` 只负责代理 B 站请求，**不保存任何用户数据**。无论你部署到自己的电脑还是服务器，数据都只会留在每个使用者的设备本地。

---

## 一、准备环境（电脑 / 服务器都要）

需要：

- **Python 3.8+**（macOS/Linux 一般自带；Windows 去 python.org 下载安装，记得勾选 “Add to PATH”）
- **一个 Python 包**（扫码登录 B 站用到）：
  ```bash
  pip3 install -r requirements.txt
  # 或单独： pip3 install qrcode
  ```
- **ffmpeg（可选）**：只有在你想用「1080p 合并」那条路径时才需要。
  默认的 480p 单文件播放**不需要 ffmpeg**。
  - macOS：`brew install ffmpeg`
  - Ubuntu：`sudo apt install ffmpeg`
  - Windows：去 gyan.dev/ffmpeg 下载，解压并把 `bin` 目录加进 PATH

---

## 二、方案 A：在自己电脑上跑（家里同 WiFi 用手机看）

适合「电脑平时不关机 / 回家练舞用」的场景。

1. 把本项目目录放到电脑上，比如 `D:\dance-wb` 或 `~/dance-wb`。
2. 打开终端（Windows 是 PowerShell / 命令提示符），进入目录：
   ```bash
   cd 路径/dance-wb
   ./start.sh            # macOS / Linux
   python3 serve.py 8000   # Windows 或不想用脚本时
   ```
   看到「Dance Workbench 已启动，端口 8000」就成功了。
3. **电脑本地访问**：浏览器开 `http://localhost:8000`
4. **手机访问**：手机和电脑连同一个 WiFi，查电脑内网 IP：
   - Windows：`ipconfig` → 看「IPv4 地址」（一般是 192.168.x.x）
   - macOS：`ifconfig | grep 192`
   - Linux：`hostname -I`
   然后手机浏览器开 `http://192.168.x.x:8000`（换成你查到的 IP）。

> 注意：局域网 http 下 App 能正常播放，但**离线缓存（PWA 安装）需要 https 才生效**，不影响在线使用。

---

## 三、方案 B：部署到 VPS（手机随时随地上网就能用）

适合「想要一个固定网址、随时打开」的情况。需要一台 VPS（阿里云/腾讯云/AWS 等都行）和一个域名（没有域名也可以，见文末「没域名方案」）。

### 1. 上传代码
```bash
# 在 VPS 上
sudo mkdir -p /opt/dance-wb
# 用 scp / git 把项目文件拷到 /opt/dance-wb
cd /opt/dance-wb
pip3 install -r requirements.txt
python3 serve.py 8000   # 先手动跑一次，确认能启动
```

### 2. 设为开机自启（systemd）
```bash
sudo cp deploy/dance-wb.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now dance-wb
```
之后进程崩溃会自动重启，重启服务器也会自动拉起。

### 3. 用 Caddy 反代 + 自动 HTTPS
装好 [Caddy](https://caddyserver.com/) 后，把 `deploy/Caddyfile` 里的 `dance.example.com` 改成你的域名，然后：
```bash
caddy run --config /opt/dance-wb/deploy/Caddyfile
```
Caddy 会自动申请并续期 HTTPS 证书。之后手机直接访问 `https://你的域名` 即可，
且 PWA 离线缓存、扫码登录全部正常。

> 不想用 Caddy 也可用 Nginx，核心就是「把 80/443 反代到本机 8000」，网上搜 “nginx 反向代理” 一堆教程。

---

## 四、方案 C：一键平台（Render / Railway，最省事，推荐分享给朋友）

不想买服务器、不想配域名，又想发给朋友随时用 —— 用这类平台最合适。
它们会给你一个 `https://xxx.onrender.com` 的固定网址，**有人访问时自动唤醒**，比沙箱更适合分享。

> 前提：需要一个 GitHub 账号（没有就去 github.com 免费注册，全中文界面）。

### 步骤（以 Render 为例，Railway 几乎一样）

1. **把代码传上 GitHub**
   - 在 GitHub 新建一个仓库（如 `dance-wb`）。
   - 把本项目所有文件（含 `serve.py` / `Procfile` / `requirements.txt` / `runtime.txt` / `js/` 等）上传进去。
     （不会用 git 也没事：在 GitHub 仓库页点「Add file → Upload files」直接拖进去。）

2. **在 Render 一键部署**
   - 打开 [render.com](https://render.com)，用 GitHub 登录。
   - 点 **New → Web Service** → 授权并选中你的 `dance-wb` 仓库。
   - Render 会自动识别 `Python` + `Procfile`，基本不用改：
     - Build Command：`pip install -r requirements.txt`
     - Start Command：`python3 serve.py $PORT`（Procfile 已写好，可不动）
   - 点 **Create Web Service**，等一两分钟构建完成。

3. **拿到网址分享**
   - 构建完成后，Render 会显示一个 `https://dance-wb-xxx.onrender.com` 的地址。
   - 把这个地址发给你朋友，谁打开谁就能用；首次打开若慢（冷启动）等几十秒即可。

> Railway 用法类似：连 GitHub → 选仓库 → 它会自动按 `Procfile` 启动，给一个 `*.up.railway.app` 地址。
> 免费额度足够个人练舞用；两家免费版在长时间无人访问后会「休眠」，但**有人访问会自动醒来**，无需手动干预。

---

## 五、没域名也想随时用？（内网穿透）

如果不想买域名/VPS，可以用 **Cloudflare Tunnel** 或 **ngrok** 把本机 8000 临时暴露成一个公网 https 地址：

```bash
# 装好 cloudflared 后
cloudflared tunnel --url http://localhost:8000
# 终端会打印一个 https://xxxx.trycloudflare.com 的地址，手机直接开
```
优点：免费、有 https、不用域名；缺点：每次重启地址会变（付费版可固定）。

---

## 六、常见问题

- **手机打不开 / 一直转圈**：确认电脑和手机在同一 WiFi；检查电脑防火墙是否放行了 8000 端口；`start.sh` 是否还在运行。
- **B 站提取失败 / 需要登录**：点「从 B 站提取」旁的登录按钮扫码；cookie 存在浏览器本地，失效后再扫一次即可。
- **想换端口**：`python3 serve.py 9000`，访问时也用 9000。
- **导出视频没声音**：导出用的是浏览器自带录制，部分手机浏览器不支持混音，属已知限制。

---

## 七、目录说明

```
/workspace
├── index.html          前端入口
├── style.css           样式
├── js/                 各模块（player / favorites / calendar / split / store / app）
├── serve.py            后端（静态服务 + B 站代理 + 扫码登录）
├── requirements.txt    后端依赖（qrcode）
├── runtime.txt         Python 版本锁定（一键平台用）
├── Procfile            启动命令（Render / Railway 识别）
├── start.sh            一键启动脚本（本地用）
├── deploy/             VPS 用：systemd 服务 + Caddy 配置
├── icon.svg / cover.svg / manifest.webmanifest   PWA 图标与清单
└── README-部署.md      本文件
```
