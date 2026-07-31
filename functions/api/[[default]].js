const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const biliReferer = "https://www.bilibili.com";
const biliApiHost = "https://api.bilibili.com";
const passportHost = "https://passport.bilibili.com";

const mediaHostSuffixes = [".bilivideo.com", ".bilivideo.cn", ".acgvideo.com"];

export async function onRequest(context) {
  const requestUrl = new URL(context.request.url);
  const path = requestUrl.pathname.replace(/^\/api\/?/, "/");

  try {
    if (path === "/health") return json({ ok: true });
    if (path === "/bili/meta") return biliMetaResponse(requestUrl);
    if (path === "/bili/stream") return biliStreamResponse(context.request, requestUrl);
    if (path === "/bili/dash") return biliDashResponse(context.request, requestUrl);
    if (path === "/bili/qr/gen") return biliQrGenerateResponse();
    if (path === "/bili/qr/poll") return biliQrPollResponse(requestUrl);
    if (path === "/bili/check") return biliCheckResponse(context.request);
    if (path === "/bili/session") return biliSessionResponse(context.request);
    if (path === "/video") return mediaProxyResponse(context.request, requestUrl);
    return json({ error: "not found" }, 404);
  } catch (error) {
    return json({ error: `请求失败：${error.message || "未知错误"}` }, 502);
  }
}

async function biliMetaResponse(requestUrl) {
  const bvid = await resolveBvid(requestUrl.searchParams.get("url"));
  if (!bvid) return json({ error: "无法识别 B 站视频链接" }, 400);

  const data = await biliApiJson("/x/web-interface/view", { bvid });
  if (data.code !== 0) return json({ error: data.message || "B 站接口返回错误" }, 502);
  const video = data.data || {};
  const pages = video.pages || [];
  return json({
    title: video.title || "",
    bvid: video.bvid || bvid,
    aid: video.aid,
    cid: pages[0]?.cid || video.cid,
    duration: video.duration || 0,
    author: video.owner?.name || "",
    cover: video.pic || "",
    desc: video.desc || "",
  });
}

async function biliStreamResponse(request, requestUrl) {
  const bvid = requestUrl.searchParams.get("bvid");
  const cid = requestUrl.searchParams.get("cid");
  const qn = normalizeQuality(requestUrl.searchParams.get("qn"));
  if (!bvid || !cid) return json({ error: "缺少 bvid/cid" }, 400);

  const playData = await biliPlayurl(bvid, cid, qn, getBiliSession(request), false);
  const durl = playData.durl || [];
  const media = durl.reduce((best, item) => (!best || (item.size || 0) > (best.size || 0) ? item : best), null);
  if (!media?.url) return json({ error: "未找到可用播放地址" }, 502);
  return proxyMedia(request, media.url, getBiliSession(request));
}

async function biliDashResponse(request, requestUrl) {
  const bvid = requestUrl.searchParams.get("bvid");
  const cid = requestUrl.searchParams.get("cid");
  const qn = normalizeQuality(requestUrl.searchParams.get("qn") || "80");
  if (!bvid || !cid) return json({ error: "缺少 bvid/cid" }, 400);

  const playData = await biliPlayurl(bvid, cid, qn, getBiliSession(request), true);
  const dash = playData.dash;
  if (!dash?.video?.length) return json({ error: "该视频未提供 DASH 流（可能需登录或版权限制）" }, 502);
  const candidates = dash.video.filter((item) => (item.id || 0) <= qn);
  const available = candidates.length ? candidates : dash.video;
  const avc = available.filter((item) => (item.codecs || "").includes("avc"));
  const video = (avc.length ? avc : available).sort((a, b) => (b.id || 0) - (a.id || 0))[0];
  const audio = [...(dash.audio || [])].sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];
  return json({
    video: video.baseUrl || video.base_url,
    audio: audio ? (audio.baseUrl || audio.base_url) : null,
    vcodec: video.codecs,
    acodec: audio?.codecs || null,
    width: video.width,
    height: video.height,
  });
}

async function biliQrGenerateResponse() {
  const response = await fetch(`${passportHost}/x/passport-login/web/qrcode/generate`, { headers: biliHeaders() });
  const payload = await response.json();
  const data = payload.data || {};
  if (!response.ok || !data.qrcode_key || !data.url) return json({ error: payload.message || "获取二维码失败" }, 502);
  return json({ key: data.qrcode_key, url: data.url });
}

async function biliQrPollResponse(requestUrl) {
  const key = requestUrl.searchParams.get("key");
  if (!key) return json({ error: "缺少 key" }, 400);
  const url = new URL(`${passportHost}/x/passport-login/web/qrcode/poll`);
  url.searchParams.set("qrcode_key", key);
  const response = await fetch(url, { headers: biliHeaders() });
  const payload = await response.json();
  if (payload.code === 0 && payload.data?.url) {
    return json({ status: "confirmed" }, 200, { "Set-Cookie": sessionCookie(extractCookie(response.headers)) });
  }
  if (payload.code === 86038) return json({ status: "expired" });
  if (payload.code === 86039) return json({ status: "scanned" });
  return json({ status: "waiting" });
}

async function biliCheckResponse(request) {
  const cookie = getBiliSession(request);
  if (!cookie) return json({ loggedIn: false, reason: "no_cookie" });
  const data = await biliApiJson("/x/web-interface/nav", {}, cookie);
  return json({ loggedIn: Boolean(data.data?.isLogin) });
}

async function biliSessionResponse(request) {
  if (request.method === "DELETE") return json({ ok: true }, 200, { "Set-Cookie": "danceBiliCookie=; Path=/api; Max-Age=0; HttpOnly; Secure; SameSite=Strict" });
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405, { Allow: "POST, DELETE" });
  const payload = await request.json();
  const cookie = typeof payload.cookie === "string" ? payload.cookie.trim() : "";
  if (!cookie || cookie.length > 3000) return json({ error: "登录信息无效" }, 400);
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(cookie) });
}

async function mediaProxyResponse(request, requestUrl) {
  const target = requestUrl.searchParams.get("url");
  if (!isAllowedMediaUrl(target)) return json({ error: "仅允许代理 B 站媒体地址" }, 400);
  return proxyMedia(request, target, getBiliSession(request));
}

async function biliPlayurl(bvid, cid, qn, cookie, dash) {
  const payload = await biliApiJson("/x/player/playurl", {
    bvid,
    cid,
    qn: String(qn),
    fnval: dash ? "80" : "0",
    fourk: "1",
  }, cookie);
  if (payload.code !== 0) throw new Error(payload.message || "无法获取播放地址");
  return payload.data || {};
}

async function biliApiJson(path, params, cookie) {
  const url = new URL(path, biliApiHost);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, { headers: biliHeaders(cookie) });
  if (!response.ok) throw new Error(`B 站接口响应 ${response.status}`);
  return response.json();
}

async function proxyMedia(request, target, cookie) {
  const headers = biliHeaders(cookie);
  const range = request.headers.get("range");
  if (range) headers.set("Range", range);
  const upstream = await fetch(target, { headers });
  const responseHeaders = new Headers();
  for (const name of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  responseHeaders.set("Cache-Control", "private, no-store");
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

function biliHeaders(cookie) {
  const headers = new Headers({
    "User-Agent": userAgent,
    Referer: biliReferer,
    Origin: biliReferer,
    Accept: "application/json, text/plain, */*",
  });
  if (cookie) headers.set("Cookie", cookie);
  return headers;
}

function normalizeQuality(value) {
  const quality = Number.parseInt(value, 10);
  return Number.isFinite(quality) && quality > 0 && quality <= 127 ? quality : 32;
}

async function resolveBvid(raw) {
  const value = (raw || "").trim();
  if (!value) return null;
  const shortUrl = parseBiliShortUrl(value);
  if (shortUrl) {
    try {
      const response = await fetch(shortUrl, { headers: { "User-Agent": userAgent }, redirect: "follow" });
      return extractBvid(response.url) || extractAid(response.url);
    } catch (_) {
      return null;
    }
  }
  return extractBvid(value) || extractAid(value);
}

function parseBiliShortUrl(value) {
  const normalized = /^(?:www\.)?b23\.tv(?:\/|$)/i.test(value) ? "https://" + value : value;
  try {
    const url = new URL(normalized);
    if (url.protocol !== "https:" || !["b23.tv", "www.b23.tv"].includes(url.hostname.toLowerCase())) return null;
    return url.href;
  } catch (_) {
    return null;
  }
}

function extractBvid(value) {
  return value.match(/(BV[0-9A-Za-z]+)/)?.[1] || null;
}

function extractAid(value) {
  const aid = value.match(/av(\d+)/i)?.[1];
  return aid ? `av${aid}` : null;
}

function isAllowedMediaUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && mediaHostSuffixes.some((suffix) => url.hostname.endsWith(suffix));
  } catch (_) {
    return false;
  }
}

function extractCookie(headers) {
  const values = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie") || ""];
  const cookies = new Map();
  for (const value of values) {
    const first = value.split(";", 1)[0];
    const separator = first.indexOf("=");
    if (separator > 0) cookies.set(first.slice(0, separator).trim(), first.slice(separator + 1).trim());
  }
  return [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
}

function getBiliSession(request) {
  const encoded = request.headers.get("cookie")?.match(/(?:^|;\s*)danceBiliCookie=([^;]+)/)?.[1];
  if (!encoded) return "";
  try {
    return decodeURIComponent(encoded);
  } catch (_) {
    return "";
  }
}

function sessionCookie(value) {
  return `danceBiliCookie=${encodeURIComponent(value)}; Path=/api; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict`;
}

function json(value, status = 200, additionalHeaders = {}) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  Object.entries(additionalHeaders).forEach(([key, headerValue]) => headers.set(key, headerValue));
  return new Response(JSON.stringify(value), {
    status,
    headers,
  });
}
