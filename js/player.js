/* player.js —— 播放器：源/倍速/镜面/AB循环/节拍器/AI节拍/笔记/导出 */
(function () {
  const App = (window.App = window.App || {});
  const { el, uid, fmt, apiUrl, toast, openSheet, confirmSheet } = App.util;

  let video, curSource = null, objectUrl = null;
  let audioCtx = null;          // Web Audio 上下文（用于导出混音）
  let audioDest = null;         // 导出用的 MediaStreamDestination
  let videoSrcNode = null;      // video 元素的 MediaElementSource（MSE/普通源导出混音用）
  let aTime = null, bTime = null;
  let speed = 1, mirror = false;
  let notes = [], videoDuration = 0, videoKey = null;

  let metro = { ctx: null, on: false, bpm: 120, next: 0, timer: null, count: 0, voiceVol: 1 };
  let exportState = null;
  let exportDownloadUrl = null;
  let wasmRuntime = null;
  let wasmLoadingRuntime = null;
  let wasmExportActive = false;
  const wasmCoreBytes = 32232419;
  const maxWasmInputBytes = 120 * 1024 * 1024;
  const maxBeatAnalysisBytes = 24 * 1024 * 1024;
  const maxBeatAnalysisSeconds = 180;

  function init() {
    video = document.getElementById("mainVideo");

    document.getElementById("pickSourceBtn").onclick = openSourcePicker;
    document.getElementById("playBtn").onclick = togglePlay;

    // 倍速
    document.querySelectorAll("#speedGroup .chip").forEach((c) => {
      c.onclick = () => {
        speed = parseFloat(c.dataset.spd);
        video.playbackRate = speed;
        document.querySelectorAll("#speedGroup .chip").forEach((x) => x.classList.remove("active"));
        c.classList.add("active");
        document.getElementById("speedLabel").textContent = speed + "×";
        App.util.toast("已切换 " + speed + " 倍速");
      };
    });

    document.getElementById("mirrorBtn").onclick = () => {
      mirror = !mirror;
      video.classList.toggle("mirror", mirror);
      document.getElementById("mirrorBtn").classList.toggle("active", mirror);
    };

    // 节拍器人声音量（可独立调节；视频音量走系统/浏览器默认）
    document.getElementById("metroVol").oninput = (e) => {
      metro.voiceVol = parseFloat(e.target.value);
      try { window.speechSynthesis.cancel(); } catch (_) {}
    };

    // 清晰度自选（B 站源）：切换后重新加载，尽量保留播放位置
    document.getElementById("biliQn").onchange = async (e) => {
      if (!curSource || curSource.type !== "bili") return;
      const qn = parseInt(e.target.value, 10);
      const t = video.currentTime || 0;
      curSource.qn = qn;
      // EdgeOne 使用流式代理，不依赖服务端合并或磁盘缓存
      if (qn >= 64) {
        const hint = document.getElementById("qnHint");
        if (!getBiliCookie || !getBiliCookie()) {
          hint.textContent = "正在切换高清；未登录时 B 站可能限制到较低画质。";
        } else {
          hint.textContent = "正在切换高清流…";
        }
      } else {
        document.getElementById("qnHint").textContent = "";
      }
      // 记忆到收藏夹视频记录，下次打开沿用
      if (curSource.key) {
        try {
          const rec = await App.store.get("videos", curSource.key);
          if (rec) { rec.qn = qn; await App.store.put("videos", rec); }
        } catch (_) {}
      }
      video.src = sourceSrc(curSource);
      video.load();
      if (t > 1) {
        const seek = () => { try { video.currentTime = t; } catch (_) {} video.removeEventListener("loadedmetadata", seek); };
        video.addEventListener("loadedmetadata", seek);
      }
    };

    // 进度条：长按拖动 + 时间气泡
    const prog = document.getElementById("progress");
    const seekTip = document.getElementById("seekTip");
    let seeking = false;
    const progPct = (clientX) => {
      const r = prog.getBoundingClientRect();
      return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    };
    const showSeekTip = (pct) => {
      if (!video.duration) return;
      const r = prog.getBoundingClientRect();
      seekTip.style.left = pct * r.width + "px";
      seekTip.textContent = fmt(pct * video.duration);
      seekTip.style.display = "block";
    };
    prog.addEventListener("pointerdown", (e) => {
      if (!video.duration) return;
      seeking = true;
      try { prog.setPointerCapture(e.pointerId); } catch (_) {}
      const pct = progPct(e.clientX);
      video.currentTime = pct * video.duration;
      showSeekTip(pct);
      onTime();
      e.preventDefault();
    });
    prog.addEventListener("pointermove", (e) => {
      if (!seeking) return;
      const pct = progPct(e.clientX);
      video.currentTime = pct * video.duration;
      showSeekTip(pct);
    });
    const endSeek = (e) => {
      if (!seeking) return;
      seeking = false; // 松手即隐藏气泡
      seekTip.style.display = "none";
      try { prog.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    prog.addEventListener("pointerup", endSeek);
    prog.addEventListener("pointercancel", endSeek);
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("loadedmetadata", () => {
      videoDuration = video.duration || 0;
      document.getElementById("durTime").textContent = fmt(videoDuration);
      renderNotes();
    });
    video.addEventListener("ended", () => {
      document.getElementById("playBtn").textContent = "▶";
    });

    // 缓冲/等待计时提示
    video.addEventListener("waiting", () => showBuffer("缓冲中…"));
    video.addEventListener("loadstart", () => showBuffer("加载中…"));
    video.addEventListener("stalled", () => showBuffer("网络较慢，缓冲中…"));
    video.addEventListener("playing", hideBuffer);
    video.addEventListener("canplay", hideBuffer);
    video.addEventListener("seeked", hideBuffer);

    // AB
    document.getElementById("setA").onclick = () => {
      aTime = video.currentTime;
      toast("A 点：" + fmt(aTime));
      drawAB();
    };
    document.getElementById("setB").onclick = () => {
      bTime = video.currentTime;
      toast("B 点：" + fmt(bTime));
      drawAB();
    };
    document.getElementById("clearAB").onclick = () => {
      aTime = bTime = null;
      drawAB();
    };

    // 笔记
    document.getElementById("addNoteBtn").onclick = addNote;
    renderNotes();

    // 节拍器
    const bpmInput = document.getElementById("bpmInput");
    const bpmRange = document.getElementById("bpmRange");
    bpmInput.oninput = () => {
      metro.bpm = +bpmInput.value;
      bpmRange.value = metro.bpm;
    };
    bpmRange.oninput = () => {
      metro.bpm = +bpmRange.value;
      bpmInput.value = metro.bpm;
    };
    document.getElementById("metroBtn").onclick = toggleMetro;
    document.getElementById("aiBeatBtn").onclick = aiDetect;

    // 导出
    document.getElementById("exportBtn").onclick = openExportPicker;
    document.getElementById("exportStop").onclick = stopExport;

    // 全屏
    const fs = () => toggleFs();
    document.getElementById("fsBtn").onclick = fs;
    document.getElementById("fsBtn2").onclick = fs;
    document.addEventListener("fullscreenchange", () => {
      if (!document.fullscreenElement) {
        document.getElementById("videoWrap").classList.remove("pseudofs");
      }
    });

    // 弹幕循环
    startDanmaku();

    drawAB();

    // 校验已存 B 站登录态（失效则自动清除，可重新登录）
    validateLogin();
  }

  function toggleFs() {
    const wrap = document.getElementById("videoWrap");
    // 若当前已是原生全屏，退出
    if (document.fullscreenElement) {
      wrap.classList.remove("pseudofs");
      if (document.exitFullscreen) document.exitFullscreen();
      return;
    }
    // 若处于伪全屏（CSS 全屏），退出
    if (wrap.classList.contains("pseudofs")) {
      wrap.classList.remove("pseudofs");
      return;
    }
    // 1) 尝试原生全屏（iframe/WebView 可能因无 allowfullscreen 而失败）
    const req =
      wrap.requestFullscreen ||
      wrap.webkitRequestFullscreen ||
      wrap.mozRequestFullScreen ||
      wrap.msRequestFullscreen;
    if (req) {
      try {
        const p = req.call(wrap);
        if (p && typeof p.then === "function") {
          p.catch(() => enterPseudoFs(wrap));
          return;
        }
        return;
      } catch (e) {
        /* 落到伪全屏 */
      }
    }
    // 2) iOS Safari：直接让 video 进入全屏
    if (video.webkitEnterFullscreen) {
      try { video.webkitEnterFullscreen(); return; } catch (_) {}
    }
    // 3) 兜底：CSS 伪全屏，保证「按了一定有反应」
    enterPseudoFs(wrap);
  }
  function enterPseudoFs(wrap) {
    wrap.classList.add("pseudofs");
  }

  // ---------- 视频源 ----------
  function getBiliCookie() {
    try {
      localStorage.removeItem("biliCookie");
      return localStorage.getItem("biliLoggedIn") || "";
    } catch (_) { return ""; }
  }
  function sourceSrc(s) {
    if (s.type === "file") return objectUrlFor(s.blob);
    if (s.type === "bili") {
      const qn = s.qn || 32;
      // EdgeOne 不提供持久磁盘与 ffmpeg，所有画质都走可转发 Range 的单文件流
      return apiUrl(`/api/bili/stream?bvid=${encodeURIComponent(s.bvid)}&cid=${encodeURIComponent(s.cid)}&qn=${qn}`);
    }
    return s.url;
  }
  function objectUrlFor(blob) {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(blob);
    return objectUrl;
  }

  function loadSource(s) {
    hideBuffer();
    curSource = s;
    clearDanmaku();
    document.getElementById("curSource").textContent = s.name || "未命名视频";
    videoKey = s.key || s.name || uid();
    App.store.getNotes(videoKey).then((n) => {
      notes = n || [];
      renderNotes();
    });
    // 清晰度选择器：仅 B 站源显示
    const qnRow = document.getElementById("qnRow");
    const qnSel = document.getElementById("biliQn");
    if (s.type === "bili") {
      qnRow.hidden = false;
      qnSel.value = String(s.qn || 32);
    } else {
      qnRow.hidden = true;
    }
    video.src = sourceSrc(s);
    video.playbackRate = speed;
    video.classList.toggle("mirror", mirror);
    video.load();
  }

  // ---------- B 站登录 ----------
  function setBiliLoginState(loggedIn) {
    try {
      if (loggedIn) localStorage.setItem("biliLoggedIn", "1");
      else localStorage.removeItem("biliLoggedIn");
    } catch (_) {}
    App.util.closeSheet();
    toast(loggedIn ? "已登录 B 站（可访问更多视频）" : "已清除登录信息");
    const st = document.getElementById("biliLoginStatus");
    if (st) st.textContent = loggedIn ? "已登录 ✅ 可解锁高清画质" : "未登录（最高 480p）";
  }

  async function saveBiliCookie(v) {
    try {
      const response = await fetch(apiUrl("/api/bili/session"), {
        method: v ? "POST" : "DELETE",
        headers: v ? { "Content-Type": "application/json" } : undefined,
        body: v ? JSON.stringify({ cookie: v }) : undefined,
      });
      if (!response.ok) throw new Error("保存登录信息失败");
      setBiliLoginState(Boolean(v));
    } catch (e) {
      toast("登录信息保存失败：" + e.message);
    }
  }

  function openBiliLogin() {
    const ta = el("textarea", {
      placeholder: "在此粘贴 SESSDATA（或整段 Cookie）",
      value: "",
    });
    const help = el("div", { class: "bili-help", hidden: true }, [
      el("p", { class: "bili-help-t", text: "电脑浏览器获取（最方便）：" }),
      el("p", { text: "1. 打开 bilibili.com 并登录你的账号" }),
      el("p", { text: "2. 按 F12 → Application（应用）→ Cookies → bilibili.com" }),
      el("p", { text: "3. 找到 SESSDATA，双击复制它的值" }),
      el("p", { text: "4. 回到这里点「📋 粘贴」，再点「保存」即可" }),
      el("p", { class: "hint", text: "手机上也能拿：给 bilibili.com 存个书签，网址改成 javascript:alert(document.cookie)，登录后点书签复制 SESSDATA。登录信息会保存为本站专用的 HttpOnly Cookie，仅用于向 B 站请求高清地址。" }),
    ]);
    const pasteBtn = el("button", {
      class: "btn soft sm", text: "📋 粘贴", onclick: async () => {
        try {
          const t = await navigator.clipboard.readText();
          if (t && t.trim()) { ta.value = t.trim(); ta.focus(); toast("已粘贴，点「保存」即可"); }
          else toast("剪贴板是空的");
        } catch (e) { toast("自动粘贴被拦截，请手动长按粘贴"); }
      },
    });
    const helpBtn = el("button", {
      class: "btn soft sm", text: "❓ 怎么获取", onclick: () => { help.hidden = !help.hidden; },
    });
    const ok = el("button", {
      class: "btn sm", text: "保存", onclick: () => { saveBiliCookie(ta.value.trim()); },
    });
    const logoutBtn = el("button", {
      class: "btn soft sm", text: "🚪 退出登录", onclick: () => { saveBiliCookie(""); ta.value = ""; },
    });
    const qrBtn = el("button", { class: "btn sm", text: "📱 扫码登录", onclick: () => openBiliQR() });
    App.util.openSheet("B 站登录（解锁高清）", el("div", {}, [
      el("p", { class: "hint", text: "登录后部分需权限的视频也能提取，并可解锁 720p / 1080p 高清。" }),
      ta,
      el("div", { class: "controls" }, [pasteBtn, helpBtn, ok, logoutBtn]),
      help,
      el("hr", { class: "sheet-sep" }),
      el("p", { class: "hint", text: "推荐手机扫码登录（最省事）：" }),
      el("div", { class: "controls" }, [qrBtn]),
    ]));
  }

  // 启动/打开登录时校验已存 cookie：失效则清除，避免「一直显示已登录却用不了」
  async function validateLogin() {
    const cookie = getBiliCookie();
    const st = document.getElementById("biliLoginStatus");
    if (!cookie) {
      if (st) st.textContent = "未登录（最高 480p）";
      return;
    }
    try {
      const r = await fetch(apiUrl("/api/bili/check")).then((x) => x.json());
      if (r.loggedIn) {
        if (st) st.textContent = "已登录 ✅ 可解锁高清画质";
      } else {
        saveBiliCookie(""); // 失效，清除并提示重新登录
        toast("B 站登录已失效，请重新扫码登录");
        if (st) st.textContent = "未登录（最高 480p）";
      }
    } catch (e) {
      if (st) st.textContent = "已登录 ✅ 可解锁高清画质";
    }
  }

  function openBiliQR() {
    const qrContainer = el("div", { class: "qr-img", role: "img", "aria-label": "B站登录二维码" });
    const status = el("div", { class: "qr-status", text: "正在生成二维码…" });
    let timer = null, curKey = null;
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    async function startQR() {
      stop();
      status.textContent = "请用手机 B 站 App 扫码，并在手机上点「确认登录」";
      try {
        const info = await fetch(apiUrl("/api/bili/qr/gen")).then((r) => r.json());
        if (info.error) throw new Error(info.error);
        curKey = info.key;
        if (info.dataUrl) {
          qrContainer.replaceChildren(el("img", { alt: "B站登录二维码", src: info.dataUrl }));
        } else if (info.url && window.QRCode) {
          qrContainer.replaceChildren();
          new window.QRCode(qrContainer, {
            text: info.url,
            width: 196,
            height: 196,
            correctLevel: window.QRCode.CorrectLevel.M,
          });
        } else {
          throw new Error("二维码组件未加载，请稍后重试或手动粘贴 Cookie");
        }
        timer = setInterval(poll, 1500);
      } catch (e) {
        status.textContent = "生成失败：" + e.message;
      }
    }
    async function poll() {
      if (!curKey) return;
      if (document.getElementById("sheetMask").hidden) { stop(); return; }
      try {
        const r = await fetch(apiUrl("/api/bili/qr/poll?key=" + encodeURIComponent(curKey))).then((x) => x.json());
        if (r.status === "confirmed") { stop(); setBiliLoginState(true); }
        else if (r.status === "expired") { stop(); status.textContent = "二维码已过期，点「重新生成」"; }
        else if (r.status === "scanned") { status.textContent = "已扫码，请在手机上点「确认登录」"; }
      } catch (e) { /* 忽略瞬时错误，继续轮询 */ }
    }
    App.util.openSheet("📱 扫码登录 B 站", el("div", { class: "qr-box" }, [
      qrContainer, status,
      el("button", { class: "btn soft sm", text: "🔄 重新生成", onclick: () => startQR() }),
    ]));
    startQR();
  }

  // ---------- 弹幕 ----------
  let dmActive = {};
  function clearDanmaku() {
    Object.values(dmActive).forEach((e) => e.remove());
    dmActive = {};
  }
  function startDanmaku() {
    requestAnimationFrame(danmakuLoop);
  }
  function danmakuLoop() {
    const t = video.currentTime || 0;
    const layer = document.getElementById("danmaku");
    let lane = 0; // 多个笔记同时出现时从上往下叠放
    notes.forEach((n) => {
      const dur = n.dur || 3;
      const active = t >= n.t && t <= n.t + dur;
      if (active) {
        let node = dmActive[n.id];
        if (!node) {
          node = el("div", { class: "dm", text: n.text });
          layer.appendChild(node);
          dmActive[n.id] = node;
        }
        if (node.textContent !== n.text) node.textContent = n.text;
        node.style.top = 12 + lane * 52 + "px"; // 停在画面上方、不飘动
        lane++;
      } else if (dmActive[n.id]) {
        dmActive[n.id].remove();
        delete dmActive[n.id];
      }
    });
    requestAnimationFrame(danmakuLoop);
  }

  function openSourcePicker() {
    const fileInput = el("input", { type: "file", accept: "video/*" });
    fileInput.onchange = () => {
      const f = fileInput.files[0];
      if (!f) return;
      const rec = { id: uid(), name: f.name, type: "file", blob: f, createdAt: Date.now() };
      App.store.addVideo(rec);
      closeAndLoad({ type: "file", blob: f, name: f.name, key: rec.id });
    };

    const biliIn = el("input", { placeholder: "粘贴 B 站链接 / BV号 / b23.tv", type: "text" });
    const loginBtn = el("button", { class: "btn soft sm", text: "🔑 B站登录", onclick: openBiliLogin });
    const loginStatus = el("div", { class: "hint", id: "biliLoginStatus", text: getBiliCookie() ? "已登录 ✅ 可访问更多视频" : "未登录" });
    const biliBtn = el("button", {
      class: "btn sm",
      text: "从 B 站提取",
      onclick: async () => {
        const url = biliIn.value.trim();
        if (!url) return toast("请粘贴 B 站链接");
        toast("正在解析 B 站视频…");
        try {
          const meta = await fetch(apiUrl("/api/bili/meta?url=" + encodeURIComponent(url))).then((r) => r.json());
          if (meta.error) throw new Error(meta.error);
          const rec = {
            id: uid(),
            name: meta.title,
            type: "bili",
            bvid: meta.bvid,
            cid: meta.cid,
            qn: 32,
            author: meta.author,
            createdAt: Date.now(),
          };
          App.store.addVideo(rec);
          closeAndLoad({ type: "bili", bvid: meta.bvid, cid: meta.cid, qn: 32, name: meta.title, key: rec.id });
        } catch (e) {
          toast("提取失败：" + e.message);
        }
      },
    });

    const urlIn = el("input", { placeholder: "粘贴视频直链 https://…", type: "text" });
    const urlBtn = el("button", {
      class: "btn soft sm",
      text: "用直链",
      onclick: () => {
        const u = urlIn.value.trim();
        if (!u) return toast("请粘贴直链");
        closeAndLoad({ type: "url", url: u, name: u.split("/").pop() || "直链视频", key: u });
      },
    });

    const favSel = el("select", {});
    App.store.listVideos().then((vs) => {
      if (!vs.length) favSel.appendChild(el("option", { text: "（收藏夹暂无视频）", value: "" }));
      vs.forEach((v) => favSel.appendChild(el("option", { value: v.id, text: v.name })));
    });
    const favBtn = el("button", {
      class: "btn soft sm",
      text: "从收藏夹选",
      onclick: async () => {
        const id = favSel.value;
        if (!id) return toast("请先选择视频");
        const v = await App.store.get("videos", id);
        if (!v) return toast("未找到");
        closeAndLoad(videoRecordToSource(v));
      },
    });

    const wrap = el("div", {}, [
      el("p", { text: "上传本地视频", style: { fontWeight: "700", marginBottom: "4px" } }),
      fileInput,
      el("hr", { class: "sheet-sep" }),
      el("p", { text: "从 B 站提取", style: { fontWeight: "700", marginBottom: "4px" } }),
      biliIn,
      el("div", { class: "bili-row" }, [
        loginBtn,
      ]),
      loginStatus,
      biliBtn,
      el("hr", { class: "sheet-sep" }),
      el("p", { text: "视频直链", style: { fontWeight: "700", marginBottom: "4px" } }),
      urlIn,
      urlBtn,
      el("hr", { class: "sheet-sep" }),
      el("p", { text: "从收藏夹", style: { fontWeight: "700", marginBottom: "4px" } }),
      favSel,
      favBtn,
    ]);
    App.util.openSheet("选择视频源", wrap);
  }

  function closeAndLoad(src) {
    App.util.closeSheet();
    loadSource(src);
  }

  function videoRecordToSource(v) {
    if (v.type === "file") return { type: "file", blob: v.blob, name: v.name, key: v.id };
    if (v.type === "bili") {
      // 默认 480p 单文件流畅路径；若记录里存过清晰度则沿用（720p/1080p 走服务端合并）
      return { type: "bili", bvid: v.bvid, cid: v.cid, qn: v.qn || 32, name: v.name, key: v.id };
    }
    return { type: "url", url: v.url, name: v.name, key: v.id };
  }

  // 缓冲提示：实时显示「已加载百分之多少」，让用户直观看到进度
  let bufferTimer = null;
  function bufferedPct() {
    const d = video.duration || 0;
    if (!d || !video.buffered || video.buffered.length === 0) return 0;
    let end = 0;
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.end(i) > end) end = video.buffered.end(i);
    }
    return Math.min(100, Math.round((end / d) * 100));
  }
  function showBuffer(label) {
    const ov = document.getElementById("bufferOverlay");
    if (!ov) return;
    ov.hidden = false;
    const t = document.getElementById("bufferText");
    const upd = () => {
      if (t) t.textContent = label + " 已加载 " + bufferedPct() + "%";
    };
    upd();
    if (bufferTimer) clearInterval(bufferTimer);
    bufferTimer = setInterval(upd, 200);
  }
  function hideBuffer() {
    const ov = document.getElementById("bufferOverlay");
    if (ov) ov.hidden = true;
    if (bufferTimer) { clearInterval(bufferTimer); bufferTimer = null; }
  }

  function togglePlay() {
    if (!video.src) return toast("请先选择视频");
    if (video.paused) video.play(), (document.getElementById("playBtn").textContent = "⏸");
    else video.pause(), (document.getElementById("playBtn").textContent = "▶");
  }

  function onTime() {
    const d = video.duration || 0;
    const p = d ? (video.currentTime / d) * 100 : 0;
    document.getElementById("progressFill").style.width = p + "%";
    document.getElementById("playhead").style.left = p + "%";
    document.getElementById("curTime").textContent = fmt(video.currentTime);
    if (aTime != null && bTime != null && video.currentTime >= bTime - 0.05) {
      video.currentTime = aTime;
    }
    // 双元素音视频同步交由 startAudioSync 的 rAF 循环处理，这里不再离散校正
  }

  function drawAB() {
    const a = document.getElementById("abA");
    const b = document.getElementById("abB");
    const reg = document.getElementById("abRegion");
    if (aTime != null) {
      a.style.display = "flex";
      a.style.left = (aTime / (videoDuration || 1)) * 100 + "%";
    } else a.style.display = "none";
    if (bTime != null) {
      b.style.display = "flex";
      b.style.left = (bTime / (videoDuration || 1)) * 100 + "%";
    } else b.style.display = "none";
    if (aTime != null && bTime != null) {
      const lo = Math.min(aTime, bTime), hi = Math.max(aTime, bTime);
      reg.style.display = "block";
      reg.style.left = (lo / (videoDuration || 1)) * 100 + "%";
      reg.style.width = ((hi - lo) / (videoDuration || 1)) * 100 + "%";
    } else reg.style.display = "none";
  }

  // ---------- 笔记 ----------
  function addNote() {
    if (!videoKey) return toast("请先选择视频再记笔记");
    const t = video.currentTime || 0;
    const rec = { id: uid(), t, dur: 3, text: "要注意的点", lane: 8 };
    notes.push(rec);
    persistNotes();
    renderNotes();
    // 立即让用户输入文字
    editNoteText(rec);
  }

  function editNoteText(note) {
    const inp = el("textarea", { value: note.text });
    const ok = el("button", {
      class: "btn sm",
      text: "保存",
      onclick: () => {
        note.text = inp.value.trim() || "要注意的点";
        persistNotes();
        renderNotes();
        App.util.closeSheet();
      },
    });
    App.util.openSheet("编辑笔记", el("div", {}, [inp, el("div", { class: "controls" }, [ok])]));
  }

  function persistNotes() {
    if (videoKey) App.store.saveNotes(videoKey, notes);
  }

  function renderNotes() {
    const track = document.getElementById("notesTrack");
    track.innerHTML = "";
    const d = videoDuration || 1;
    notes.forEach((n) => {
      const node = el("div", {
        class: "note",
        style: { left: (n.t / d) * 100 + "%", top: (n.lane || 8) + "px" },
      }, [
        el("div", { class: "nt", text: fmt(n.t) + " · " + fmt(n.dur) + "s" }),
        el("div", { text: n.text }),
        el("div", { class: "nx", text: "✎", onclick: (e) => { e.stopPropagation(); editNoteText(n); } }),
        el("div", { class: "ne", text: "×", onclick: (e) => { e.stopPropagation(); delNote(n); } }),
      ]);
      makeDraggable(node, n);
      node.addEventListener("click", () => {
        if (!dragMoved) {
          video.currentTime = n.t;
          if (video.paused) togglePlay();
        }
      });
      track.appendChild(node);
    });
  }

  function delNote(n) {
    notes = notes.filter((x) => x.id !== n.id);
    persistNotes();
    renderNotes();
  }

  let dragMoved = false;
  function makeDraggable(node, n) {
    node.addEventListener("pointerdown", (e) => {
      if (e.target.classList.contains("nx") || e.target.classList.contains("ne")) return;
      e.preventDefault();
      dragMoved = false;
      const track = document.getElementById("notesTrack");
      const r = track.getBoundingClientRect();
      const move = (ev) => {
        dragMoved = true;
        let x = ev.clientX - r.left;
        x = Math.max(0, Math.min(r.width, x));
        let y = ev.clientY - r.top;
        y = Math.max(2, Math.min(r.height - 30, y));
        node.style.left = x + "px";
        node.style.top = y + "px";
        n.t = Math.max(0, (x / r.width) * (videoDuration || 1));
        n.lane = y;
        node.querySelector(".nt").textContent = fmt(n.t) + " · " + fmt(n.dur) + "s";
      };
      const up = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        if (dragMoved) persistNotes();
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
    });
  }

  // ---------- 节拍器 ----------
  function ensureCtx() {
    if (!metro.ctx) metro.ctx = new (window.AudioContext || window.webkitAudioContext)();
    return metro.ctx;
  }
  function toggleMetro() {
    if (metro.on) return stopMetro();
    const ctx = ensureCtx();
    if (ctx.state === "suspended") ctx.resume();
    // 预热语音引擎，减少 iOS 上首次报数的启动延迟（让人声更跟手）
    try { if (window.speechSynthesis) { window.speechSynthesis.cancel(); const w = new SpeechSynthesisUtterance(" "); w.volume = 0; window.speechSynthesis.speak(w); } } catch (e) {}
    metro.on = true;
    metro.next = ctx.currentTime + 0.1;
    metro.count = (parseInt(document.getElementById("beatStart").value, 10) || 1) - 1;
    document.getElementById("metroBtn").textContent = "⏹ 停止";
    scheduleMetro();
  }
  function stopMetro() {
    metro.on = false;
    clearTimeout(metro.timer);
    document.getElementById("metroBtn").textContent = "▶ 开始";
    document.getElementById("beatDot").classList.remove("on");
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }
  function scheduleMetro() {
    if (!metro.on) return;
    const ctx = metro.ctx;
    const interval = 60 / metro.bpm;
    while (metro.next < ctx.currentTime + 0.12) {
      const t = metro.next;
      metro.count = (metro.count % 8) + 1; // 1..8 循环
      const num = metro.count;
      const delay = (t - ctx.currentTime) * 1000;
      setTimeout(() => {
        speakBeat(num);
        const dot = document.getElementById("beatDot");
        dot.textContent = num;
        dot.classList.add("on");
        setTimeout(() => dot.classList.remove("on"), 90);
      }, Math.max(0, delay));
      metro.next += interval;
    }
    metro.timer = setTimeout(scheduleMetro, 25);
  }
  function speakBeat(n) {
    try {
      if (!window.speechSynthesis) return;
      const u = new SpeechSynthesisUtterance(String(n));
      u.lang = "zh-CN";
      u.rate = 1.5;   // 报数适中
      u.pitch = 1.0;
      u.volume = metro.voiceVol;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch (e) {}
  }

  async function aiDetect() {
    if (!curSource) return toast("请先选择视频");
    if (video.duration > maxBeatAnalysisSeconds) {
      return toast("节拍检测仅支持 " + Math.round(maxBeatAnalysisSeconds / 60) + " 分钟以内的视频，请手动设置 BPM");
    }
    const hint = document.getElementById("aiHint");
    hint.textContent = "正在分析音频…";
    try {
      let buf;
      if (curSource.type === "file") {
        if (curSource.blob.size > maxBeatAnalysisBytes) throw new Error("视频文件超过 " + formatBytes(maxBeatAnalysisBytes));
        buf = await curSource.blob.arrayBuffer();
      }
      else {
        const resp = await fetch(video.src);
        if (!resp.ok) throw new Error("视频读取失败（" + resp.status + "）");
        const length = Number(resp.headers.get("content-length"));
        if (Number.isFinite(length) && length > maxBeatAnalysisBytes) throw new Error("视频文件超过 " + formatBytes(maxBeatAnalysisBytes));
        buf = await readResponseBytes(resp, "正在读取节拍分析音频…", 0, maxBeatAnalysisBytes, false);
      }
      const ctx = ensureCtx();
      const audioBuf = await ctx.decodeAudioData(buf);
      const bpm = estimateBPM(audioBuf);
      if (!bpm) throw new Error("未检测到明显节拍");
      metro.bpm = bpm;
      document.getElementById("bpmInput").value = bpm;
      document.getElementById("bpmRange").value = bpm;
      hint.textContent = "估算 BPM：" + bpm + "（仅供参考，可手动微调）";
      toast("AI 检测节拍：" + bpm + " BPM");
    } catch (e) {
      hint.textContent = "无法自动检测（该格式可能不支持），请手动设置节拍。";
      toast("AI 检测失败：" + e.message);
    }
  }

  function estimateBPM(audioBuf) {
    const ch = audioBuf.getChannelData(0);
    const sr = audioBuf.sampleRate;
    const hop = 512,
      N = ch.length;
    const frames = Math.floor(N / hop);
    const energy = new Float32Array(frames);
    let maxE = 0;
    for (let i = 0; i < frames; i++) {
      let s = 0;
      for (let j = 0; j < hop; j++) {
        const v = ch[i * hop + j] || 0;
        s += v * v;
      }
      const e = Math.sqrt(s / hop);
      energy[i] = e;
      if (e > maxE) maxE = e;
    }
    if (maxE === 0) return 0;
    const flux = new Float32Array(frames);
    for (let i = 1; i < frames; i++) {
      const d = energy[i] - energy[i - 1];
      flux[i] = d > 0 ? d / maxE : 0;
    }
    const thresh = flux.reduce((a, b) => a + b, 0) / frames * 1.5;
    const peaks = [];
    for (let i = 2; i < frames - 2; i++) {
      if (flux[i] > thresh && flux[i] >= flux[i - 1] && flux[i] >= flux[i + 1]) {
        peaks.push(i * hop / sr);
      }
    }
    if (peaks.length < 4) return 0;
    const hist = {};
    for (let i = 1; i < peaks.length; i++) {
      let dt = peaks[i] - peaks[i - 1];
      if (dt <= 0) continue;
      let bpm = 60 / dt;
      // 折叠到 60-180
      while (bpm > 180) bpm /= 2;
      while (bpm < 60) bpm *= 2;
      const k = Math.round(bpm);
      hist[k] = (hist[k] || 0) + 1;
    }
    let best = 0,
      bestK = 0;
    for (const k in hist) {
      if (hist[k] > best) {
        best = hist[k];
        bestK = +k;
      }
    }
    return bestK || 0;
  }

  // ---------- 导出 ----------
  // 导出混音：把视频元素的音轨接入 Web Audio，输出到 MediaStreamDestination 后与画面合成。
  function getExportAudioStream() {
    // 视频元素自身带音轨；预解码检测不可靠，直接尝试建图，失败由调用方兜底静音。
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (!videoSrcNode) {
      videoSrcNode = audioCtx.createMediaElementSource(video);
      videoSrcNode.connect(audioCtx.destination);
      audioDest = audioCtx.createMediaStreamDestination();
      videoSrcNode.connect(audioDest);
    }
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioDest.stream;
  }

  function openExportPicker() {
    if (!video.src) return toast("请先选择视频");
    if (!video.videoWidth) return toast("视频尚未加载完成");

    const fastDownload = el("button", {
      class: "btn sm",
      text: "⚡ 原视频快速下载",
      onclick: () => {
        App.util.closeSheet();
        downloadOriginal();
      },
    });
    const realtimeExport = el("button", {
      class: "btn soft sm",
      text: "🎬 实时渲染导出",
      onclick: () => {
        App.util.closeSheet();
        startRealtimeExport();
      },
    });
    const wasmExport = el("button", {
      class: "btn soft sm",
      text: "🚀 FFmpeg 加速导出",
      onclick: () => chooseWasmExport(),
    });
    openSheet("选择导出方式", el("div", {}, [
      el("p", { class: "hint", text: "⚡ 原视频快速下载：不应用镜像、AB 截取或分辨率设置，几乎无需等待。" }),
      el("p", { class: "hint", text: "🎬 实时渲染导出：应用镜像、AB 截取与分辨率设置；录制时长约等于导出片段时长。" }),
      el("p", { class: "hint", text: "🚀 FFmpeg 加速导出：首次传输约 10 MB，浏览器自动解压并载入约 31 MB 的本地处理核心；处理不会上传视频。" }),
      el("div", { class: "controls" }, [fastDownload, realtimeExport, wasmExport]),
    ]));
  }

  async function chooseWasmExport() {
    App.util.closeSheet();
    const ok = await confirmSheet(
      "载入 FFmpeg 加速组件",
      "首次会传输约 10 MB 的组件，浏览器自动解压后载入约 31 MB 核心，并仅在当前浏览器处理视频。下载和读入视频时会显示实时进度。长视频或低内存手机可能较慢，建议优先导出短 AB 片段。",
      "下载并开始"
    );
    if (ok) startWasmExport();
  }

  function downloadOriginal() {
    let href = "";
    if (curSource && curSource.type === "file") href = video.currentSrc;
    else if (curSource && curSource.type === "bili") href = sourceSrc(curSource);
    else if (curSource && curSource.type === "url") href = curSource.url;
    if (!href) return toast("当前视频无法快速下载");

    const link = document.createElement("a");
    link.href = href;
    const originalName = curSource.name || "原视频";
    link.download = /\.[a-z0-9]{2,5}$/i.test(originalName)
      ? originalName
      : originalName + (curSource.type === "bili" ? ".mp4" : "");
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    toast("已开始原视频下载");
  }

  function getExportFileName(extension) {
    const name = (curSource && curSource.name) || "导出视频";
    const stem = name.replace(/\.[a-z0-9]{2,5}$/i, "");
    return stem + extension;
  }

  function setExportDownload(blob, fileName) {
    if (exportDownloadUrl) URL.revokeObjectURL(exportDownloadUrl);
    exportDownloadUrl = URL.createObjectURL(blob);
    const download = document.getElementById("exportDl");
    download.href = exportDownloadUrl;
    download.download = fileName;
    download.hidden = false;
  }

  function setExportBusy(message) {
    document.getElementById("exportBtn").disabled = true;
    document.getElementById("exportStop").hidden = false;
    document.getElementById("exportProgress").hidden = false;
    document.getElementById("exportPct").textContent = message;
    const fill = document.getElementById("exportFill");
    fill.classList.remove("is-indeterminate");
    fill.style.width = "0%";
    document.getElementById("exportDl").hidden = true;
  }

  function clearExportBusy() {
    document.getElementById("exportBtn").disabled = false;
    document.getElementById("exportStop").hidden = true;
    document.getElementById("exportProgress").hidden = true;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, index);
    return (value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)) + " " + units[index];
  }

  function setExportProgress(message, loaded, total) {
    const fill = document.getElementById("exportFill");
    const label = document.getElementById("exportPct");
    const hasTotal = Number.isFinite(total) && total > 0;
    if (hasTotal) {
      const ratio = Math.max(0, Math.min(1, loaded / total));
      fill.classList.remove("is-indeterminate");
      fill.style.width = (ratio * 100).toFixed(1) + "%";
      label.textContent = message + " " + formatBytes(loaded) + " / " + formatBytes(total) + "（" + Math.round(ratio * 100) + "%）";
      return;
    }
    fill.style.width = "35%";
    fill.classList.add("is-indeterminate");
    label.textContent = message + " 已读取 " + formatBytes(loaded) + "（文件总大小未知）";
  }

  function setExportRatio(message, ratio) {
    const fill = document.getElementById("exportFill");
    const percent = Math.max(0, Math.min(1, ratio));
    fill.classList.remove("is-indeterminate");
    fill.style.width = (percent * 100).toFixed(1) + "%";
    document.getElementById("exportPct").textContent = message + " " + Math.round(percent * 100) + "%";
  }

  async function readStreamBytes(stream, message, total, maxBytes, cancelWithExport) {
    const reader = stream.getReader();
    let capacity = Number.isSafeInteger(total) && total > 0 ? total : 1024 * 1024;
    if (maxBytes) capacity = Math.min(capacity, maxBytes);
    let data = new Uint8Array(capacity);
    let loaded = 0;
    while (true) {
      if (cancelWithExport && !wasmExportActive) {
        await reader.cancel();
        throw new Error("导出已取消");
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const nextLoaded = loaded + value.byteLength;
      if (maxBytes && nextLoaded > maxBytes) {
        await reader.cancel();
        throw new Error("视频超过 " + formatBytes(maxBytes) + "，为避免手机内存不足已停止读取");
      }
      if (nextLoaded > data.byteLength) {
        const nextCapacity = Math.max(nextLoaded, Math.min(maxBytes || Number.MAX_SAFE_INTEGER, data.byteLength * 2));
        const expanded = new Uint8Array(nextCapacity);
        expanded.set(data.subarray(0, loaded));
        data = expanded;
      }
      data.set(value, loaded);
      loaded = nextLoaded;
      setExportProgress(message, loaded, total);
    }
    setExportProgress(message, loaded, total || loaded);
    return loaded === data.byteLength ? data : data.slice(0, loaded);
  }

  async function readResponseBytes(response, message, fallbackTotal, maxBytes, cancelWithExport) {
    const contentLength = Number(response.headers.get("content-length"));
    const total = Number.isFinite(fallbackTotal) && fallbackTotal > 0
      ? fallbackTotal
      : (Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0);
    if (maxBytes && total > maxBytes) throw new Error("视频超过 " + formatBytes(maxBytes) + "，为避免手机内存不足已停止读取");
    if (!response.body) {
      const data = new Uint8Array(await response.arrayBuffer());
      if (maxBytes && data.byteLength > maxBytes) throw new Error("视频超过 " + formatBytes(maxBytes) + "，为避免手机内存不足已停止读取");
      setExportProgress(message, data.byteLength, total || data.byteLength);
      return data;
    }
    return readStreamBytes(response.body, message, total, maxBytes, cancelWithExport);
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) {
        if (window.FFmpegWASM) resolve();
        else existing.addEventListener("load", resolve, { once: true });
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(new Error("FFmpeg 组件加载失败"));
      document.head.appendChild(script);
    });
  }

  async function getWasmRuntime() {
    if (wasmRuntime && wasmRuntime.loaded) return wasmRuntime;
    const baseUrl = new URL("./js/vendor/ffmpeg/", window.location.href);
    setExportBusy("正在载入 FFmpeg 组件…");
    await loadScript(new URL("ffmpeg.js", baseUrl).href);
    const FFmpeg = window.FFmpegWASM && window.FFmpegWASM.FFmpeg;
    if (!FFmpeg) throw new Error("当前浏览器无法初始化 FFmpeg");
    const runtime = new FFmpeg();
    wasmLoadingRuntime = runtime;
    runtime.on("progress", ({ progress }) => {
      if (!wasmExportActive || !Number.isFinite(progress)) return;
      setExportRatio("正在快速导出…", progress);
    });
    const wasmResponse = await fetch(new URL("core/ffmpeg-core.wasm.gz", baseUrl).href);
    if (!wasmResponse.ok) throw new Error("FFmpeg 核心下载失败（" + wasmResponse.status + "）");
    const wasmData = await readResponseBytes(wasmResponse, "正在下载并解压 FFmpeg 核心…", wasmCoreBytes, 0, true);
    if (!wasmExportActive) return runtime;
    setExportProgress("正在载入 FFmpeg 核心到内存…", wasmCoreBytes, wasmCoreBytes);
    const wasmUrl = URL.createObjectURL(new Blob([wasmData], { type: "application/wasm" }));
    try {
      await runtime.load({
        coreURL: new URL("core/ffmpeg-core.js", baseUrl).href,
        wasmURL: wasmUrl,
      });
    } finally {
      URL.revokeObjectURL(wasmUrl);
    }
    wasmRuntime = runtime;
    wasmLoadingRuntime = null;
    return runtime;
  }

  async function getWasmInput() {
    const name = "input.mp4";
    if (curSource && curSource.type === "file") {
      const message = "正在读取本地视频到浏览器内存…";
      if (curSource.blob.size > maxWasmInputBytes) {
        throw new Error("视频超过 " + formatBytes(maxWasmInputBytes) + "，请改用实时渲染或原视频下载");
      }
      const data = typeof curSource.blob.stream === "function"
        ? await readStreamBytes(curSource.blob.stream(), message, curSource.blob.size, maxWasmInputBytes, true)
        : new Uint8Array(await curSource.blob.arrayBuffer());
      setExportProgress(message, data.byteLength, curSource.blob.size);
      return { name, data };
    }
    const sourceUrl = curSource && curSource.type === "bili" ? sourceSrc(curSource) : curSource && curSource.url;
    if (!sourceUrl) throw new Error("当前视频无法交给 FFmpeg 处理");
    const response = await fetch(sourceUrl);
    if (!response.ok) throw new Error("视频读取失败（" + response.status + "）");
    const data = await readResponseBytes(response, "正在读取视频到浏览器内存…", 0, maxWasmInputBytes, true);
    return { name, data };
  }

  async function startWasmExport() {
    if (!video.src || !video.videoWidth || wasmExportActive) return;
    wasmExportActive = true;
    setExportBusy("正在准备 FFmpeg 加速导出…");
    let runtime = null;
    let inputName = "";
    const outputName = "output.mp4";
    try {
      runtime = await getWasmRuntime();
      if (!wasmExportActive) return;
      const input = await getWasmInput();
      if (!wasmExportActive) return;
      inputName = input.name;
      await runtime.writeFile(inputName, input.data);

      const args = [];
      const useAB = document.getElementById("exportAB").checked && aTime != null && bTime != null;
      if (useAB) {
        const start = Math.min(aTime, bTime);
        const duration = Math.max(aTime, bTime) - start;
        args.push("-ss", start.toFixed(3), "-t", duration.toFixed(3));
      }
      args.push("-i", inputName);
      const filters = [];
      if (document.getElementById("exportMirror").checked) filters.push("hflip");
      const res = document.getElementById("exportRes").value;
      if (res !== "orig") filters.push("scale=-2:" + res);
      if (filters.length) {
        args.push("-vf", filters.join(","), "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-c:a", "aac");
      } else {
        args.push("-c", "copy");
      }
      args.push("-movflags", "+faststart", outputName);
      setExportRatio("FFmpeg 正在处理视频…", 0);
      await runtime.exec(args);
      if (!wasmExportActive) return;
      const output = await runtime.readFile(outputName);
      setExportDownload(new Blob([output], { type: "video/mp4" }), getExportFileName(".mp4"));
      toast("FFmpeg 导出完成，可下载");
    } catch (error) {
      if (wasmExportActive) toast("FFmpeg 导出失败：" + error.message);
    } finally {
      if (wasmLoadingRuntime) {
        wasmLoadingRuntime.terminate();
        wasmLoadingRuntime = null;
      }
      if (runtime && inputName) {
        try { await runtime.deleteFile(inputName); } catch (_) {}
        try { await runtime.deleteFile(outputName); } catch (_) {}
      }
      if (wasmExportActive) {
        wasmExportActive = false;
        clearExportBusy();
      }
    }
  }

  function startRealtimeExport() {
    if (!video.src) return toast("请先选择视频");
    if (!video.videoWidth) return toast("视频尚未加载完成");
    const canvas = document.createElement("canvas");
    const res = document.getElementById("exportRes").value;
    const aspect = video.videoWidth / video.videoHeight;
    let W, H;
    if (res === "orig") {
      W = video.videoWidth;
      H = video.videoHeight;
    } else {
      H = +res;
      W = Math.round(H * aspect);
    }
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    const fps = 30;
    const vstream = canvas.captureStream(fps);
    // 取音频流（无则静音导出），与画面合成
    let aStream = null;
    try { aStream = getExportAudioStream(); } catch (e) { console.warn("导出混音失败，仅画面：", e); }
    const stream = aStream
      ? new MediaStream([...vstream.getVideoTracks(), ...aStream.getAudioTracks()])
      : vstream;

    const types = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm"];
    let mime = "";
    for (const t of types) if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) { mime = t; break; }
    if (!mime) return toast("当前浏览器不支持视频导出");

    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4000000 });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: mime.split(";")[0] });
      setExportDownload(blob, getExportFileName(mime.includes("mp4") ? ".mp4" : ".webm"));
      document.getElementById("exportProgress").hidden = true;
      document.getElementById("exportBtn").disabled = false;
      document.getElementById("exportStop").hidden = true;
      toast("导出完成，可下载");
    };

    const useMirror = document.getElementById("exportMirror").checked;
    const onlyAB = document.getElementById("exportAB").checked;
    let lastDraw = 0;
    function draw() {
      if (rec.state !== "recording") return;
      ctx.save();
      if (useMirror) {
        ctx.translate(W, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(video, 0, 0, W, H);
      ctx.restore();
      // 进度
      const prog = document.getElementById("exportFill");
      const d = video.duration || 1;
      prog.style.width = (video.currentTime / d) * 100 + "%";
      // AB / 结束判断
      if (onlyAB && aTime != null && bTime != null) {
        const hi = Math.max(aTime, bTime);
        if (video.currentTime >= hi - 0.05) video.currentTime = Math.min(aTime, bTime);
      } else if (video.currentTime >= (video.duration || 1) - 0.05) {
        rec.stop();
        return;
      }
      requestAnimationFrame(draw);
    }

    // 起播点
    if (onlyAB && aTime != null) video.currentTime = aTime;
    video.playbackRate = speed;
    video.play();
    document.getElementById("playBtn").textContent = "⏸";
    rec.start();
    exportState = rec;
    document.getElementById("exportProgress").hidden = false;
    document.getElementById("exportBtn").disabled = true;
    document.getElementById("exportStop").hidden = false;
    requestAnimationFrame(draw);
  }

  function stopExport() {
    if (wasmExportActive) {
      wasmExportActive = false;
      const runtime = wasmRuntime || wasmLoadingRuntime;
      if (runtime) runtime.terminate();
      wasmRuntime = null;
      wasmLoadingRuntime = null;
      clearExportBusy();
      toast("已取消 FFmpeg 导出");
      return;
    }
    if (exportState && exportState.state === "recording") exportState.stop();
  }

  App.player = { init, loadSource, videoRecordToSource, get source() { return curSource; } };
})();
