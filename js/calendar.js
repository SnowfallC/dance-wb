/* calendar.js —— 日历待办 */
(function () {
  const App = (window.App = window.App || {});
  const { el, uid, toast, openSheet, confirmSheet } = App.util;

  const DEFAULT_TYPES = ["上台", "录舞", "审核", "交背屏"];
  const TYPE_EMOJI = { "上台": "💃", "录舞": "🎥", "审核": "✅", "交背屏": "📺" };
  function typeLabel(t) { return (TYPE_EMOJI[t] ? TYPE_EMOJI[t] + " " : "") + t; }
  let viewY, viewM, selKey; // selKey: 'YYYY-MM-DD'
  let types = DEFAULT_TYPES.slice();

  function init() {
    types = App.store.settings.get("eventTypes", DEFAULT_TYPES.slice());
    const now = new Date();
    viewY = now.getFullYear();
    viewM = now.getMonth();
    selKey = dateKey(now);
    document.getElementById("calPrev").onclick = () => { shift(-1); };
    document.getElementById("calNext").onclick = () => { shift(1); };
    document.getElementById("calToday").onclick = () => {
      const n = new Date();
      viewY = n.getFullYear(); viewM = n.getMonth(); selKey = dateKey(n); renderCal();
    };
    document.getElementById("addEventBtn").onclick = () => addEvent();
    renderCal();
  }

  function shift(d) {
    viewM += d;
    if (viewM < 0) { viewM = 11; viewY--; }
    if (viewM > 11) { viewM = 0; viewY++; }
    renderCal();
  }

  function pad(n) { return String(n).padStart(2, "0"); }
  function dateKey(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }

  async function renderCal() {
    const title = document.getElementById("calTitle");
    title.textContent = viewY + " 年 " + (viewM + 1) + " 月";
    const grid = document.getElementById("calGrid");
    grid.innerHTML = "";
    const first = new Date(viewY, viewM, 1);
    let start = (first.getDay() + 6) % 7; // 周一为起点
    const daysInMonth = new Date(viewY, viewM + 1, 0).getDate();
    const prevDays = new Date(viewY, viewM, 0).getDate();
    const today = dateKey(new Date());

    const events = await App.store.listEvents();
    const byDay = {};
    events.forEach((e) => { (byDay[e.date] = byDay[e.date] || []).push(e); });

    // 前置空格
    for (let i = 0; i < start; i++) {
      grid.appendChild(el("div", { class: "cal-cell dim", text: String(prevDays - start + 1 + i) }));
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const key = viewY + "-" + pad(viewM + 1) + "-" + pad(d);
      const cell = el("div", {
        class: "cal-cell" + (key === today ? " today" : "") + (key === selKey ? " sel" : ""),
        text: String(d),
        onclick: () => { selKey = key; renderCal(); },
      });
      if (byDay[key]) cell.appendChild(el("div", { class: "cal-dot" }));
      grid.appendChild(cell);
    }
    // 补齐末尾
    const total = start + daysInMonth;
    const tail = (7 - (total % 7)) % 7;
    for (let i = 1; i <= tail; i++) grid.appendChild(el("div", { class: "cal-cell dim", text: String(i) }));

    renderDay(events);
  }

  function renderDay(events) {
    const [y, m, d] = selKey.split("-").map(Number);
    document.getElementById("calDayTitle").textContent = "📅 " + selKey + " 的安排";
    const list = document.getElementById("eventList");
    list.innerHTML = "";
    const dayEvents = events.filter((e) => e.date === selKey).sort((a, b) => (a.time || "").localeCompare(b.time || ""));
    if (!dayEvents.length) {
      list.appendChild(el("p", { class: "hint", text: "📭 这一天还没有安排。点「➕ 添加事项」记录上台 / 录舞 / 审核 / 交背屏等。" }));
      return;
    }
    dayEvents.forEach((ev) => list.appendChild(eventNode(ev)));
  }

  function eventNode(ev) {
    const items = ev.items || [];
    const done = items.filter((i) => i.done).length;
    const list = el("ul", { class: "check-list" },
      items.map((it) =>
        el("li", { class: it.done ? "done" : "", onclick: () => toggleItem(ev, it.id) }, [
          el("span", { text: it.done ? "✅" : "⬜" }),
          el("span", { text: it.text }),
        ])
      )
    );
    const node = el("div", { class: "event-item", "data-type": ev.type }, [
      el("div", { class: "event-top" }, [
        el("div", { class: "event-title", text: ev.title }),
        el("div", { class: "event-type", text: typeLabel(ev.type) }),
      ]),
      el("div", { class: "event-meta", text: (ev.time || "时间未定") + (items.length ? ` · 准备 ${done}/${items.length}` : "") }),
      ev.note ? el("div", { class: "event-note", text: ev.note }) : null,
      items.length ? list : null,
      el("div", { class: "controls" }, [
        el("button", { class: "btn soft sm", text: "编辑", onclick: () => addEvent(ev) }),
        el("button", { class: "btn soft sm", text: "删除", onclick: () => delEvent(ev) }),
      ]),
    ]);
    return node;
  }

  async function toggleItem(ev, id) {
    const it = ev.items.find((x) => x.id === id);
    if (it) it.done = !it.done;
    await App.store.addEvent(ev);
    renderCal();
  }

  async function delEvent(ev) {
    if (!(await confirmSheet("删除事项", `确定删除「${ev.title}」？`, "删除"))) return;
    await App.store.del("events", ev.id);
    renderCal();
  }

  async function addEvent(edit) {
    const e = edit || { date: selKey, type: types[0] };
    let selType = e.type && types.includes(e.type) ? e.type : types[0];

    const title = el("input", { class: "ev-input", placeholder: "标题（如：周五团练上台）", value: e.title || "" });
    const date = el("input", { class: "ev-input", type: "date", value: e.date || selKey });
    const time = el("input", { class: "ev-input", type: "time", value: e.time || "" });
    const note = el("textarea", { class: "ev-input", placeholder: "备注（选填）", value: e.note || "" });
    const prep = el("textarea", {
      class: "ev-input",
      placeholder: "需提前准备的东西（每行一项）",
      value: (e.items || []).map((i) => i.text).join("\n"),
    });

    const typeWrap = el("div", { class: "ev-types" });
    const renderTypes = () => {
      typeWrap.innerHTML = "";
      types.forEach((t) => {
        const pill = el("button", {
          class: "ev-pill" + (t === selType ? " active" : ""),
          text: typeLabel(t),
          onclick: () => { selType = t; renderTypes(); },
        });
        typeWrap.appendChild(pill);
      });
      typeWrap.appendChild(el("button", {
        class: "ev-pill custom",
        text: "✨ 自定义",
        onclick: () => {
          const c = prompt("自定义类型名称：");
          if (c && c.trim()) {
            if (!types.includes(c.trim())) { types.push(c.trim()); App.store.settings.set("eventTypes", types); }
            selType = c.trim();
            renderTypes();
          }
        },
      }));
    };
    renderTypes();

    const ok = el("button", {
      class: "btn ev-save",
      text: "💾 保存安排",
      onclick: async () => {
        const tn = title.value.trim() || "未命名安排";
        const lines = prep.value.split("\n").map((s) => s.trim()).filter(Boolean);
        const oldItems = e.items || [];
        const items = lines.map((txt, i) => oldItems[i] && oldItems[i].text === txt ? oldItems[i] : { id: uid(), text: txt, done: false });
        const rec = {
          id: e.id || uid(),
          title: tn,
          type: selType,
          date: date.value || selKey,
          time: time.value || "",
          note: note.value.trim(),
          items,
          createdAt: e.createdAt || Date.now(),
        };
        await App.store.addEvent(rec);
        App.util.closeSheet();
        selKey = rec.date;
        renderCal();
        toast("已保存");
      },
    });

    openSheet(edit ? "编辑事项" : "添加安排", el("div", { class: "ev-form" }, [
      el("div", { class: "ev-field" }, [el("label", { text: "✏️ 标题" }), title]),
      el("div", { class: "ev-field" }, [el("label", { text: "🏷️ 类型" }), typeWrap]),
      el("div", { class: "ev-row" }, [
        el("div", { class: "ev-field" }, [el("label", { text: "📅 日期" }), date]),
        el("div", { class: "ev-field" }, [el("label", { text: "⏰ 时间" }), time]),
      ]),
      el("div", { class: "ev-field" }, [el("label", { text: "📝 备注" }), note]),
      el("div", { class: "ev-field" }, [el("label", { text: "📋 准备清单（每行一项）" }), prep]),
      ok,
    ]));
  }

  App.calendar = { init, render: renderCal };
})();
