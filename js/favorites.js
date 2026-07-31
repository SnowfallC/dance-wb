/* favorites.js —— 收藏夹 + B 站提取 */
(function () {
  const App = (window.App = window.App || {});
  const { el, uid, toast, openSheet, confirmSheet } = App.util;

  let currentFavId = null;

  // 给收藏夹挑一个装饰 emoji：按关键词命中，否则取首字
  function pickIcon(name) {
    const n = String(name || "收藏夹").trim();
    const map = { 爵士:"💃", 韩舞:"🎤", 街舞:"🕺", 编舞:"✨", 练习:"🔥", 男团:"🕺", 女团:"💃", solo:"🌟", 直拍:"📹", 比赛:"🏆", 路演:"🎪" };
    const key = Object.keys(map).find((k) => n.toLowerCase().includes(k.toLowerCase()));
    if (key) return map[key];
    return n ? [...n][0] : "📁";
  }

  function init() {
    document.getElementById("newFavBtn").onclick = newFav;
    document.getElementById("addVidFile").onclick = () => document.getElementById("vidFile").click();
    document.getElementById("vidFile").onchange = (e) => {
      const f = e.target.files[0];
      if (!f) return;
      addVideo({ id: uid(), name: f.name, type: "file", blob: f, createdAt: Date.now() });
    };
    document.getElementById("addVidBili").onclick = addFromBili;
    document.getElementById("addVidUrl").onclick = addFromUrl;
    render();
  }

  async function render() {
    const autoOpenId = currentFavId; // await 前捕获，避免期间被手动 open 后再重复触发
    const favs = await App.store.listFavs();
    const list = document.getElementById("favList");
    list.innerHTML = "";
    if (!favs.length) {
      list.appendChild(el("p", { class: "hint", text: "📭 还没有收藏夹，点右上角「✨ 新建」按舞种创建。" }));
      document.getElementById("favDetailCard").hidden = true;
      return;
    }
    favs.sort((a, b) => a.createdAt - b.createdAt).forEach((f) => {
      const item = el("div", { class: "fav-item" }, [
        el("div", { class: "fi-icon", text: pickIcon(f.name) }),
        el("div", { class: "fi-main" }, [
          el("div", { class: "fi-name", text: f.name }),
          el("div", { class: "fi-plan", text: f.plan || "📝 未填写计划" }),
        ]),
        el("div", { class: "fi-count", text: "🎬 " + (f.videoIds || []).length + " 视频" }),
        el("div", { class: "fav-actions" }, [
          el("button", { class: "btn sm", text: "打开", onclick: () => openFav(f.id) }),
          el("button", { class: "btn soft sm", text: "编辑", onclick: () => editFav(f) }),
          el("button", { class: "btn soft sm", text: "删除", onclick: () => removeFav(f) }),
        ]),
      ]);
      list.appendChild(item);
    });
    if (autoOpenId) openFav(autoOpenId);
    else document.getElementById("favDetailCard").hidden = true;
  }

  function newFav() {
    const name = el("input", { placeholder: "📁 收藏夹名称（如：WAP 编舞）" });
    const plan = el("input", { placeholder: "💡 计划 / 舞种说明（选填）" });
    const ok = el("button", {
      class: "btn sm",
      text: "✨ 创建",
      onclick: async () => {
        const n = name.value.trim();
        if (!n) return toast("请填写名称");
        const rec = { id: uid(), name: n, plan: plan.value.trim(), videoIds: [], createdAt: Date.now() };
        await App.store.addFav(rec);
        App.util.closeSheet();
        currentFavId = rec.id;
        render();
        toast("已创建收藏夹");
      },
    });
    openSheet("新建收藏夹", el("div", {}, [name, plan, el("div", { class: "controls" }, [ok])]));
  }

  function editFav(f) {
    const name = el("input", { value: f.name });
    const plan = el("input", { value: f.plan || "" });
    const ok = el("button", {
      class: "btn sm",
      text: "💾 保存",
      onclick: async () => {
        f.name = name.value.trim() || f.name;
        f.plan = plan.value.trim();
        await App.store.addFav(f);
        App.util.closeSheet();
        render();
      },
    });
    openSheet("编辑收藏夹", el("div", {}, [name, plan, el("div", { class: "controls" }, [ok])]));
  }

  async function removeFav(f) {
    if (!(await confirmSheet("删除收藏夹", `确定删除「${f.name}」？视频本身不会删除。`, "删除"))) return;
    await App.store.del("favorites", f.id);
    if (currentFavId === f.id) currentFavId = null;
    render();
  }

  let openingFavId = null;
  async function openFav(id) {
    if (openingFavId === id) return; // 同一收藏夹正在打开中，避免并发重复渲染
    openingFavId = id;
    currentFavId = id;
    try {
      const f = await App.store.get("favorites", id);
    if (!f) return;
    document.getElementById("favDetailCard").hidden = false;
    document.getElementById("favDetailTitle").textContent = f.name;
    document.getElementById("favDetailPlan").textContent = f.plan || "📝 未填写计划";
    document.getElementById("favDetailPlan").className = "fav-plan";
    const list = document.getElementById("vidList");
    list.innerHTML = "";
    const ids = f.videoIds || [];
    if (!ids.length) list.appendChild(el("p", { class: "hint", text: "这个收藏夹还没有视频，用上方按钮添加。" }));
      for (const vid of ids) {
        const v = await App.store.get("videos", vid);
        if (!v) continue;
        list.appendChild(vidNode(v));
      }
    } finally {
      openingFavId = null;
    }
  }

  function vidNode(v) {
    const typeMap = { file: { label: "本地", cls: "file" }, bili: { label: "B站", cls: "bili" }, url: { label: "直链", cls: "url" } };
    const t = typeMap[v.type] || { label: "其它", cls: "url" };
    return el("div", { class: "vid-item" }, [
      el("span", { class: "vi-badge " + t.cls, text: t.label }),
      el("div", { class: "vi-name", text: v.name || "未命名" }),
      el("div", { class: "vid-actions" }, [
        el("button", { class: "btn soft sm", text: "观看", onclick: () => watch(v) }),
        el("button", { class: "btn soft sm", text: "做片段", onclick: () => makeClip(v) }),
        el("button", { class: "btn soft sm", text: "移除", onclick: () => removeVid(v) }),
      ]),
    ]);
  }

  async function addVideo(rec) {
    if (!currentFavId) {
      // 没有打开的收藏夹则自动建一个
      const f = { id: uid(), name: "我的收藏", plan: "", videoIds: [], createdAt: Date.now() };
      await App.store.addFav(f);
      currentFavId = f.id;
    }
    await App.store.addVideo(rec);
    const f = await App.store.get("favorites", currentFavId);
    f.videoIds = f.videoIds || [];
    if (!f.videoIds.includes(rec.id)) f.videoIds.push(rec.id);
    await App.store.addFav(f);
    openFav(currentFavId);
    toast("已添加到收藏夹");
  }

  async function addFromBili() {
    const inp = el("input", { placeholder: "🔗 粘贴 B 站链接 / BV号 / b23.tv" });
    const ok = el("button", {
      class: "btn sm",
      text: "🔍 提取",
      onclick: async () => {
        const url = inp.value.trim();
        if (!url) return toast("请粘贴链接");
        toast("正在解析 B 站视频…");
        try {
          const meta = await fetch("/api/bili/meta?url=" + encodeURIComponent(url)).then((r) => r.json());
          if (meta.error) throw new Error(meta.error);
          const rec = {
            id: uid(),
            name: meta.title,
            type: "bili",
            bvid: meta.bvid,
            cid: meta.cid,
            author: meta.author,
            createdAt: Date.now(),
          };
          App.util.closeSheet();
          addVideo(rec);
        } catch (e) {
          toast("提取失败：" + e.message);
        }
      },
    });
    openSheet("从 B 站提取", el("div", {}, [inp, el("div", { class: "controls" }, [ok])]));
  }

  function addFromUrl() {
    const inp = el("input", { placeholder: "🌐 视频直链 https://…" });
    const ok = el("button", {
      class: "btn sm",
      text: "➕ 添加",
      onclick: () => {
        const u = inp.value.trim();
        if (!u) return toast("请粘贴直链");
        App.util.closeSheet();
        addVideo({ id: uid(), name: u.split("/").pop() || "直链视频", type: "url", url: u, createdAt: Date.now() });
      },
    });
    openSheet("添加视频直链", el("div", {}, [inp, el("div", { class: "controls" }, [ok])]));
  }

  function watch(v) {
    App.app.switchTab("player");
    App.player.loadSource(App.player.videoRecordToSource(v));
  }
  function makeClip(v) {
    App.app.switchTab("player");
    App.player.loadSource(App.player.videoRecordToSource(v));
    toast("已载入播放器，在下方「导出视频」里设 AB 段即可剪片段");
  }
  async function removeVid(v) {
    const f = await App.store.get("favorites", currentFavId);
    if (f) {
      f.videoIds = (f.videoIds || []).filter((x) => x !== v.id);
      await App.store.addFav(f);
    }
    openFav(currentFavId);
  }

  App.favorites = { init, render, openFav };
})();
