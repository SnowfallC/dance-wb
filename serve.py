"""
serve.py —— 舞刀（Dance Workbench）应用服务器

- 静态文件服务（前端 PWA，端口 8000，由 supervisord 托管）
- B 站提取代理 API（浏览器跨域无法直接调 B 站接口，由本服务代取并流式回传）
  - GET /api/bili/meta?url=<BV/av/b23.tv 链接>   返回 {title,bvid,cid,duration,author,cover}
  - GET /api/bili/stream?bvid=&cid=&qn=          流式代理视频（支持 Range 转发，可拖动进度）
  - GET /api/video?url=<B站媒体直链>               B 站媒体流代理（支持 Range）

仅使用 Python 标准库（urllib），无第三方依赖。
"""

import os
import sys
import json
import re
import time
import hashlib
import threading
import urllib.parse
import urllib.request
import http.cookiejar
import http.cookies
import base64
import io
import subprocess
import tempfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

try:
    import qrcode
except ModuleNotFoundError:
    qrcode = None

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
ROOT = os.path.dirname(os.path.abspath(__file__))
# 合并后的高清视频缓存目录（运行时数据，不进部署包）
CACHE_DIR = os.path.join(ROOT, ".cache", "bili")
MAX_CACHE_BYTES = 8 * 1024 * 1024 * 1024  # 缓存上限 8GB，超出按最旧优先清理

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")
BILI_REFERER = "https://www.bilibili.com"
API_HOST = "https://api.bilibili.com"
MEDIA_HOST_SUFFIXES = (".bilivideo.com", ".bilivideo.cn", ".acgvideo.com")

# 线程安全的 WBI mixin key 缓存
_wbi_lock = threading.Lock()
_mixin_key_cache = {"key": None, "ts": 0}
MIXIN_TTL = 60 * 30  # 30 分钟

MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
    33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
    61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
    36, 20, 34, 44, 52,
]


# ---------------------------------------------------------------------------
# B 站工具
# ---------------------------------------------------------------------------
def _http_json(url, params=None, headers=None, timeout=20):
    full = url
    if params:
        q = urllib.parse.urlencode(params)
        full = url + ("&" if "?" in url else "?") + q
    h = {"User-Agent": UA, "Referer": BILI_REFERER, "Accept": "application/json"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(full, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def get_mixin_key(orig):
    return "".join(orig[i] for i in MIXIN_KEY_ENC_TAB)[:32]


def fetch_mixin_key():
    now = time.time()
    with _wbi_lock:
        if _mixin_key_cache["key"] and now - _mixin_key_cache["ts"] < MIXIN_TTL:
            return _mixin_key_cache["key"]
    nav = _http_json(API_HOST + "/x/web-interface/nav")
    wbi = nav.get("data", {}).get("wbi_img", {})
    img = wbi.get("img_url", "").rsplit("/", 1)[-1].split(".")[0]
    sub = wbi.get("sub_url", "").rsplit("/", 1)[-1].split(".")[0]
    key = get_mixin_key(img + sub)
    with _wbi_lock:
        _mixin_key_cache["key"] = key
        _mixin_key_cache["ts"] = now
    return key


def wbi_sign(params):
    key = fetch_mixin_key()
    params = dict(params)
    params["wts"] = int(time.time())
    items = sorted(params.items(), key=lambda kv: kv[0])
    query = urllib.parse.urlencode(items)
    params["w_rid"] = hashlib.md5((query + key).encode("utf-8")).hexdigest()
    return params


def resolve_bvid(raw):
    """从 BV/av/b23.tv 链接解析出 bvid。"""
    raw = (raw or "").strip()
    if not raw:
        return None
    short_url = parse_bili_short_url(raw)
    if short_url:
        req = urllib.request.Request(short_url, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                raw = r.geturl()
        except Exception:
            return None
    if "BV" in raw:
        m = re.search(r"(BV[0-9A-Za-z]+)", raw)
        if m:
            return m.group(1)
    m = re.search(r"av(\d+)", raw, re.I)
    if m:
        return "av" + m.group(1)
    return None


def parse_bili_short_url(raw):
    """仅允许可信的 b23.tv 短链，避免服务端请求任意网址。"""
    candidate = "https://" + raw if re.match(r"^(?:www\.)?b23\.tv(?:/|$)", raw, re.I) else raw
    try:
        parsed = urllib.parse.urlparse(candidate)
    except ValueError:
        return None
    if parsed.scheme != "https" or parsed.hostname not in {"b23.tv", "www.b23.tv"}:
        return None
    return candidate


def is_allowed_media_url(raw):
    """只代理 B 站媒体域名，避免公开部署后成为通用代理。"""
    try:
        parsed = urllib.parse.urlparse(raw)
    except ValueError:
        return False
    host = (parsed.hostname or "").lower()
    return parsed.scheme == "https" and any(host.endswith(suffix) for suffix in MEDIA_HOST_SUFFIXES)


def parse_quality(qs, default):
    """读取并限制清晰度参数，避免非法输入中断请求处理。"""
    try:
        quality = int((qs.get("qn") or [str(default)])[0])
    except (TypeError, ValueError):
        return default
    return quality if 0 < quality <= 127 else default


def bili_meta(bvid):
    params = wbi_sign({"bvid": bvid})
    data = _http_json(API_HOST + "/x/web-interface/view", params)
    if data.get("code") != 0:
        raise RuntimeError(data.get("message") or "B站接口返回错误")
    d = data["data"]
    pages = d.get("pages") or []
    cid = pages[0]["cid"] if pages else d.get("cid")
    return {
        "title": d.get("title", ""),
        "bvid": d.get("bvid", bvid),
        "aid": d.get("aid"),
        "cid": cid,
        "duration": d.get("duration", 0),
        "author": (d.get("owner") or {}).get("name", ""),
        "cover": d.get("pic", ""),
        "desc": d.get("desc", ""),
    }


def bili_playurl(bvid, cid, qn=32, cookie=None, dash=False):
    params = wbi_sign({"bvid": bvid, "cid": cid, "qn": qn,
                       "fnval": (16 | 64) if dash else 0, "fourk": 1})
    headers = {}
    if cookie:
        headers["Cookie"] = cookie
    data = _http_json(API_HOST + "/x/player/playurl", params, headers=headers)
    if data.get("code") != 0:
        raise RuntimeError(data.get("message") or "无法获取播放地址")
    d = data["data"]
    if dash:
        dash_data = d.get("dash")
        if not dash_data:
            raise RuntimeError("该视频未提供 DASH 流（可能需登录或版权限制）")
        vlist = dash_data.get("video", [])
        if not vlist:
            raise RuntimeError("未找到视频流")
        # 在请求画质范围内挑选（优先 avc 兼容性更好）
        cand = [v for v in vlist if v.get("id", 0) <= qn] or vlist
        avc = [v for v in cand if "avc" in (v.get("codecs") or "")]
        pick = sorted(avc or cand, key=lambda v: v.get("id", 0), reverse=True)[0]
        alist = sorted(dash_data.get("audio", []),
                       key=lambda a: a.get("bandwidth", 0), reverse=True)
        a = alist[0] if alist else None
        return {
            "video": pick["baseUrl"],
            "audio": a["baseUrl"] if a else None,
            "vcodec": pick.get("codecs"),
            "acodec": a.get("codecs") if a else None,
            "width": pick.get("width"),
            "height": pick.get("height"),
        }
    # fnval=0 返回 durl（音视频合一）
    durl = d.get("durl")
    if durl:
        best = max(durl, key=lambda x: x.get("size", 0))
        return best["url"]
    raise RuntimeError("未找到可用播放地址")


# ---------- B 站登录（扫码 / 账号密码）----------
_PASSPORT = "https://passport.bilibili.com"
_bili_cj = http.cookiejar.CookieJar()
_bili_opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_bili_cj))


def _passport_call(path, params=None, data=None, method="GET"):
    url = _PASSPORT + path
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    h = {"User-Agent": UA, "Referer": _PASSPORT + "/", "Accept": "application/json"}
    body = None
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=h, method=method)
    try:
        with _bili_opener.open(req, timeout=20) as r:
            sc = r.headers.get_all("Set-Cookie") or []
            raw = r.read().decode("utf-8", "ignore")
    except urllib.error.HTTPError as e:
        sc = e.headers.get_all("Set-Cookie") or [] if e.headers else []
        raw = e.read().decode("utf-8", "ignore") if hasattr(e, "read") else "{}"
    except Exception:
        return {}, []
    try:
        return json.loads(raw), sc
    except Exception:
        return {}, sc


def _cookie_from(sc):
    out = {}
    for c in sc:
        first = c.split(";", 1)[0]
        if "=" in first:
            k, v = first.split("=", 1)
            out[k.strip()] = v.strip()
    return "; ".join(f"{k}={v}" for k, v in out.items())


def _seed_buvid():
    try:
        _bili_opener.open(
            urllib.request.Request(_PASSPORT + "/", headers={"User-Agent": UA, "Referer": _PASSPORT + "/"}),
            timeout=10,
        ).read()
    except Exception:
        pass


def bili_qr_generate():
    _seed_buvid()
    data, _ = _passport_call("/x/passport-login/web/qrcode/generate")
    d = data.get("data", {})
    key = d.get("qrcode_key")
    url = d.get("url")
    if not key or not url:
        raise RuntimeError("获取二维码失败")
    result = {"key": key, "url": url}
    if qrcode is None:
        return result
    img = qrcode.make(url, box_size=8, border=2)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    result["dataUrl"] = "data:image/png;base64," + b64
    return result


def bili_qr_poll(key):
    data, sc = _passport_call("/x/passport-login/web/qrcode/poll", params={"qrcode_key": key})
    code = data.get("code")
    if code == 0 and data.get("data", {}).get("url"):
        return {"status": "confirmed", "cookie": _cookie_from(sc)}
    if code == 86038:
        return {"status": "expired"}
    if code == 86039:
        return {"status": "scanned"}
    return {"status": "waiting"}


def bili_check_login(cookie):
    """校验 cookie 是否仍有效登录。"""
    data = _http_json(
        API_HOST + "/x/web-interface/nav",
        headers={"Cookie": cookie} if cookie else None,
    )
    return bool(data.get("data", {}).get("isLogin"))


# ---------------------------------------------------------------------------
# 请求处理
# ---------------------------------------------------------------------------
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        pass  # 静默日志，避免刷屏

    def _send_json(self, obj, code=200, extra_headers=None):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _session_cookie(self):
        raw = self.headers.get("Cookie", "")
        parsed = http.cookies.SimpleCookie()
        try:
            parsed.load(raw)
            value = parsed.get("danceBiliCookie")
            return value.value if value else ""
        except (http.cookies.CookieError, ValueError):
            return ""

    def _session_header(self, cookie, clear=False):
        max_age = 0 if clear else 2592000
        value = "" if clear else urllib.parse.quote(cookie, safe="")
        return f"danceBiliCookie={value}; Path=/api; Max-Age={max_age}; HttpOnly; SameSite=Strict"

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if path == "/api/bili/meta":
            return self._api_bili_meta(qs)
        if path == "/api/bili/stream":
            return self._api_bili_stream(qs)
        if path == "/api/bili/dash":
            return self._api_bili_dash(qs)
        if path == "/api/bili/mux":
            return self._api_bili_mux(qs)
        if path == "/api/bili/precache":
            return self._api_bili_precache(qs)
        if path == "/api/bili/cacheclear":
            return self._api_bili_cacheclear(qs)
        if path == "/api/bili/qr/gen":
            return self._api_bili_qr_gen()
        if path == "/api/bili/qr/poll":
            return self._api_bili_qr_poll(qs)
        if path == "/api/bili/check":
            return self._api_bili_check(qs)
        if path == "/api/video":
            return self._api_video_proxy(qs)
        if path == "/api/health":
            return self._send_json({"ok": True})

        # 静态文件兜底
        return super().do_GET()

    def _api_bili_meta(self, qs):
        url = (qs.get("url") or [""])[0]
        bvid = resolve_bvid(url)
        if not bvid:
            return self._send_json({"error": "无法识别 B 站视频链接"}, 400)
        try:
            meta = bili_meta(bvid)
            return self._send_json(meta)
        except Exception as e:
            return self._send_json({"error": f"获取失败：{e}"}, 502)

    def _api_bili_stream(self, qs):
        bvid = (qs.get("bvid") or [""])[0]
        cid = (qs.get("cid") or [""])[0]
        qn = parse_quality(qs, 32)
        cookie = self._session_cookie() or None
        if not bvid or not cid:
            return self._send_json({"error": "缺少 bvid/cid"}, 400)
        try:
            play_url = bili_playurl(bvid, cid, qn, cookie)
        except Exception as e:
            return self._send_json({"error": f"获取播放地址失败：{e}"}, 502)
        return self._proxy_url(play_url, cookie=cookie)

    def _api_bili_dash(self, qs):
        bvid = (qs.get("bvid") or [""])[0]
        cid = (qs.get("cid") or [""])[0]
        qn = parse_quality(qs, 80)
        cookie = self._session_cookie() or None
        if not bvid or not cid:
            return self._send_json({"error": "缺少 bvid/cid"}, 400)
        try:
            dash = bili_playurl(bvid, cid, qn, cookie, dash=True)
        except Exception as e:
            return self._send_json({"error": f"获取 DASH 失败：{e}"}, 502)
        self._send_json(dash)

    # ---------- 高清视频缓存（合并一次，之后秒开）----------
    def _bili_cache_path(self, bvid, cid, qn, cookie):
        login = hashlib.md5((cookie or "").encode("utf-8")).hexdigest()[:8] if cookie else "anon"
        return os.path.join(CACHE_DIR, f"{bvid}_{cid}_{qn}_{login}.mp4")

    def _trim_cache(self):
        """缓存超过上限时，按修改时间从最旧开始删除，直到低于上限。"""
        try:
            if not os.path.isdir(CACHE_DIR):
                return
            files = [os.path.join(CACHE_DIR, f) for f in os.listdir(CACHE_DIR)
                     if f.endswith(".mp4")]
            total = sum(os.path.getsize(f) for f in files)
            if total <= MAX_CACHE_BYTES:
                return
            files.sort(key=lambda f: os.path.getmtime(f))
            for f in files:
                try:
                    os.remove(f)
                except OSError:
                    pass
                total -= os.path.getsize(f) if os.path.exists(f) else 0
                if total <= MAX_CACHE_BYTES:
                    break
        except Exception:
            pass

    def _merge_to(self, video_url, audio_url, out_path, headers):
        """把 DASH 音视频合并为单文件 MP4 到 out_path，成功返回 True。"""
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-headers", headers, "-i", video_url]
        if audio_url:
            cmd += ["-headers", headers, "-i", audio_url]
        cmd += ["-c", "copy", "-movflags", "+faststart", "-f", "mp4", out_path]
        try:
            proc = subprocess.run(cmd, timeout=1200,
                                  stdout=subprocess.DEVNULL,
                                  stderr=subprocess.PIPE)
        except subprocess.TimeoutExpired:
            return "合并超时（视频过大或服务器网络较慢）"
        if proc.returncode != 0 or not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
            err = (proc.stderr or b"").decode("utf-8", "ignore")[:300]
            try:
                os.remove(out_path)
            except OSError:
                pass
            return f"合并失败：{err}"
        return None

    def _api_bili_mux(self, qs):
        """服务端合并 DASH 音视频为单一 MP4（供无 MSE 的手机浏览器看 720p/1080p）。
        合并结果按 视频+清晰度+登录态 缓存到磁盘：首次/主动缓存时合并一次，
        之后直接以「支持 Range」的方式回传缓存文件，手机秒开且可拖动进度。
        """
        bvid = (qs.get("bvid") or [""])[0]
        cid = (qs.get("cid") or [""])[0]
        qn = parse_quality(qs, 80)
        cookie = self._session_cookie() or None
        if not bvid or not cid:
            return self._send_json({"error": "缺少 bvid/cid"}, 400)
        try:
            info = bili_playurl(bvid, cid, qn, cookie, dash=True)
        except Exception as e:
            return self._send_json({"error": f"获取 DASH 失败：{e}"}, 502)
        video_url = info.get("video")
        if not video_url:
            return self._send_json({"error": "没有视频流（高清通常需先扫码登录）"}, 502)
        audio_url = info.get("audio")
        headers = f"Referer: {BILI_REFERER}\r\nUser-Agent: {UA}\r\n"
        cache_path = self._bili_cache_path(bvid, cid, qn, cookie)
        # 命中缓存：直接以 Range 方式回传（秒开）
        if os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
            return self._send_file_range(cache_path, "video/mp4")
        # 未命中：先合并到临时文件，成功后再落盘缓存，避免写入半成品
        os.makedirs(CACHE_DIR, exist_ok=True)
        fd, tmppath = tempfile.mkstemp(suffix=".mp4")
        os.close(fd)
        err = self._merge_to(video_url, audio_url, tmppath, headers)
        if err:
            return self._send_json({"error": err}, 502)
        try:
            os.replace(tmppath, cache_path)  # 原子落盘，保证缓存完整
        except OSError as e:
            # 落盘失败则退回直接发送临时文件
            return self._send_file_range(tmppath, "video/mp4")
        finally:
            if os.path.exists(tmppath):
                try:
                    os.remove(tmppath)
                except OSError:
                    pass
        self._trim_cache()
        return self._send_file_range(cache_path, "video/mp4")

    def _api_bili_precache(self, qs):
        """主动把某视频某清晰度合并并缓存（不播放，供「缓存好了再看」）。"""
        bvid = (qs.get("bvid") or [""])[0]
        cid = (qs.get("cid") or [""])[0]
        qn = parse_quality(qs, 80)
        cookie = self._session_cookie() or None
        if not bvid or not cid:
            return self._send_json({"error": "缺少 bvid/cid"}, 400)
        cache_path = self._bili_cache_path(bvid, cid, qn, cookie)
        if os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
            return self._send_json({"status": "cached", "size": os.path.getsize(cache_path)})
        try:
            info = bili_playurl(bvid, cid, qn, cookie, dash=True)
        except Exception as e:
            return self._send_json({"error": f"获取 DASH 失败：{e}"}, 502)
        video_url = info.get("video")
        if not video_url:
            return self._send_json({"error": "没有视频流（高清通常需先扫码登录）"}, 502)
        audio_url = info.get("audio")
        headers = f"Referer: {BILI_REFERER}\r\nUser-Agent: {UA}\r\n"
        os.makedirs(CACHE_DIR, exist_ok=True)
        fd, tmppath = tempfile.mkstemp(suffix=".mp4")
        os.close(fd)
        t0 = time.time()
        err = self._merge_to(video_url, audio_url, tmppath, headers)
        if err:
            return self._send_json({"error": err}, 502)
        try:
            os.replace(tmppath, cache_path)
        except OSError as e:
            return self._send_json({"error": f"落盘失败：{e}"}, 502)
        finally:
            if os.path.exists(tmppath):
                try:
                    os.remove(tmppath)
                except OSError:
                    pass
        self._trim_cache()
        return self._send_json({"status": "ok", "size": os.path.getsize(cache_path),
                                "seconds": round(time.time() - t0, 1)})

    def _api_bili_cacheclear(self, qs):
        """清理缓存：带 bvid+cid+qn 清理单个，否则清空全部。返回释放字节数。"""
        bvid = (qs.get("bvid") or [""])[0]
        cid = (qs.get("cid") or [""])[0]
        qn = (qs.get("qn") or [""])[0]
        cookie = self._session_cookie() or None
        try:
            if bvid and cid and qn:
                p = self._bili_cache_path(bvid, cid, parse_quality(qs, 80), cookie)
                freed = os.path.getsize(p) if os.path.exists(p) else 0
                try:
                    os.remove(p)
                except OSError:
                    pass
            elif os.path.isdir(CACHE_DIR):
                freed = 0
                for f in os.listdir(CACHE_DIR):
                    fp = os.path.join(CACHE_DIR, f)
                    if f.endswith(".mp4"):
                        freed += os.path.getsize(fp)
                        try:
                            os.remove(fp)
                        except OSError:
                            pass
            else:
                freed = 0
            return self._send_json({"status": "ok", "freed": freed})
        except Exception as e:
            return self._send_json({"error": f"清理失败：{e}"}, 500)

    def _send_file_range(self, path, content_type):
        """以支持 Range 的方式发送本地文件（手机 <video> 必须，可拖动进度）。"""
        size = os.path.getsize(path)
        rng = self.headers.get("Range")
        m = re.match(r"bytes=(\d*)-(\d*)", rng or "") if rng else None
        if m and (m.group(1) or m.group(2)):
            start = int(m.group(1)) if m.group(1) else 0
            end = int(m.group(2)) if m.group(2) else size - 1
            end = min(end, size - 1)
            if start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            length = end - start + 1
            self.send_response(206)
            self.send_header("Content-Type", content_type)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(length))
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            with open(path, "rb") as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(64 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        else:
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(size))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            with open(path, "rb") as f:
                while True:
                    chunk = f.read(64 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
    def _api_video_proxy(self, qs):
        target = (qs.get("url") or [""])[0]
        if not target:
            return self._send_json({"error": "缺少 url"}, 400)
        if not is_allowed_media_url(target):
            return self._send_json({"error": "仅允许代理 B 站媒体地址"}, 400)
        cookie = self._session_cookie() or None
        return self._proxy_url(target, cookie=cookie)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/api/bili/session":
            return self._send_json({"error": "not found"}, 404)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            cookie = str(payload.get("cookie", "")).strip()
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
            return self._send_json({"error": "登录信息无效"}, 400)
        if not cookie or len(cookie) > 3000:
            return self._send_json({"error": "登录信息无效"}, 400)
        return self._send_json({"ok": True}, extra_headers={"Set-Cookie": self._session_header(cookie)})

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/api/bili/session":
            return self._send_json({"error": "not found"}, 404)
        return self._send_json({"ok": True}, extra_headers={"Set-Cookie": self._session_header("", clear=True)})

    def _api_bili_qr_gen(self):
        try:
            self._send_json(bili_qr_generate())
        except Exception as e:
            self._send_json({"error": f"生成二维码失败：{e}"}, 502)

    def _api_bili_qr_poll(self, qs):
        key = (qs.get("key") or [""])[0]
        if not key:
            return self._send_json({"error": "缺少 key"}, 400)
        try:
            result = bili_qr_poll(key)
            cookie = result.pop("cookie", "")
            headers = {"Set-Cookie": self._session_header(cookie)} if cookie else None
            self._send_json(result, extra_headers=headers)
        except Exception as e:
            self._send_json({"error": f"轮询失败：{e}"}, 502)

    def _api_bili_check(self, qs):
        cookie = self._session_cookie() or None
        if not cookie:
            return self._send_json({"loggedIn": False, "reason": "no_cookie"})
        try:
            ok = bili_check_login(cookie)
            return self._send_json({"loggedIn": bool(ok)})
        except Exception as e:
            return self._send_json({"loggedIn": False, "reason": str(e)})

    def _proxy_url(self, target, cookie=None):
        """流式代理媒体，支持 Range 转发（可拖动进度）。"""
        if not is_allowed_media_url(target):
            return self._send_json({"error": "仅允许代理 B 站媒体地址"}, 400)
        hdr = {
            "User-Agent": UA,
            "Referer": BILI_REFERER,
            "Origin": BILI_REFERER,
        }
        if cookie:
            hdr["Cookie"] = cookie
        rng = self.headers.get("Range")
        if rng:
            hdr["Range"] = rng
        req = urllib.request.Request(target, headers=hdr)
        try:
            resp = urllib.request.urlopen(req, timeout=30)
        except urllib.error.HTTPError as e:
            resp = e
        except Exception as e:
            self.send_response(502)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(f"代理失败：{e}".encode("utf-8"))
            return

        code = resp.getcode()
        self.send_response(code)
        for k in ("Content-Type", "Content-Length", "Content-Range",
                  "Accept-Ranges", "Transfer-Encoding"):
            v = resp.headers.get(k)
            if v:
                self.send_header(k, v)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

        try:
            while True:
                chunk = resp.read(64 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)
        except Exception:
            pass
        finally:
            try:
                resp.close()
            except Exception:
                pass


def main():
    os.chdir(ROOT)
    ThreadingHTTPServer.allow_reuse_address = True
    with ThreadingHTTPServer(("", PORT), Handler) as httpd:
        print(f"Dance Workbench 已启动，端口 {PORT}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("已退出。")


if __name__ == "__main__":
    main()
