/* home.js —— 首页：问候、心情签到、快捷入口、今日安排、练习数据 */
(function () {
  const App = (window.App = window.App || {});
  const { el, toast } = App.util;

  const MOODS = ["🔥", "😌", "🥵", "💪", "🥲"];
  const GREETINGS = {
    morning: "早上好 ☀️",
    afternoon: "下午好 ✨",
    evening: "晚上好 🌙",
    night: "夜深了 🌃",
  };
  const QUOTES = [
    "今天也要跳得很帅",
    "每一拍都算数",
    "练舞不辍，未来可期",
    "先热身，再起飞",
    "你的努力，镜头记得住",
    "节奏在，状态就在",
  ];

  function pad(n) { return String(n).padStart(2, "0"); }
  function dateKey(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function weekDay(d) { return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()]; }

  function init() {
    document.getElementById("homeContinue").onclick = () => App.app.switchTab("player");
    document.getElementById("homeMoreEvents").onclick = () => App.app.switchTab("calendar");

    document.getElementById("homeMood").querySelectorAll(".mood-btn").forEach((b) => {
      b.onclick = () => setMood(b.dataset.m);
    });

    document.getElementById("homeQuick").querySelectorAll(".quick-item").forEach((b) => {
      b.onclick = () => {
        const [tab, id] = b.dataset.go.split("|");
        App.app.switchTab(tab);
        if (id) {
          setTimeout(() => {
            const el = document.getElementById(id);
            if (el) {
              el.click();
              el.scrollIntoView({ behavior: "smooth", block: "center" });
            }
          }, 80);
        }
      };
    });

    render();
  }

  function setMood(m) {
    const key = "mood_" + dateKey(new Date());
    App.store.settings.set(key, m);
    renderMood();
    toast("已记录心情 " + m);
  }

  function renderMood() {
    const key = "mood_" + dateKey(new Date());
    const today = App.store.settings.get(key, "");
    document.getElementById("homeMood").querySelectorAll(".mood-btn").forEach((b) => {
      b.classList.toggle("on", b.dataset.m === today);
    });
  }

  function greeting(h) {
    if (h < 6) return GREETINGS.night;
    if (h < 12) return GREETINGS.morning;
    if (h < 19) return GREETINGS.afternoon;
    return GREETINGS.evening;
  }

  function renderGreeting() {
    const now = new Date();
    document.getElementById("homeGreet").childNodes[0].textContent = greeting(now.getHours()) + " ";
    document.getElementById("homeDate").textContent = (now.getMonth() + 1) + "月" + now.getDate() + "日 " + weekDay(now);
    const idx = now.getDate() % QUOTES.length;
    document.getElementById("homeQuote").textContent = QUOTES[idx];
  }

  function renderStats(favs, vids, events) {
    const now = new Date();
    const monthKey = now.getFullYear() + "-" + pad(now.getMonth() + 1);
    const monthEvents = events.filter((e) => (e.date || "").startsWith(monthKey)).length;
    document.getElementById("statFavs").textContent = favs.length;
    document.getElementById("statVids").textContent = vids.length;
    document.getElementById("statEvents").textContent = monthEvents;
  }

  function renderTodayEvents(events) {
    const today = dateKey(new Date());
    const list = document.getElementById("homeEvents");
    list.innerHTML = "";
    const dayEvents = events
      .filter((e) => e.date === today)
      .sort((a, b) => (a.time || "").localeCompare(b.time || ""));

    if (dayEvents.length === 0) {
      list.appendChild(el("div", { class: "home-ev" }, [
        el("span", { class: "t", text: "今天还没有安排，去日历加一个吧 📅" }),
      ]));
      return;
    }

    dayEvents.slice(0, 3).forEach((e) => {
      const emoji = { "上台": "💃", "录舞": "🎥", "审核": "✅", "交背屏": "📺" }[e.type] || "📌";
      list.appendChild(el("div", { class: "home-ev" }, [
        el("span", { text: emoji + " " + (e.title || e.type || "事项") }),
        el("span", { class: "t", text: e.time || "" }),
      ]));
    });
  }

  async function render() {
    renderGreeting();
    renderMood();
    const [favs, vids, events] = await Promise.all([
      App.store.listFavs(),
      App.store.listVideos(),
      App.store.listEvents(),
    ]);
    renderStats(favs, vids, events);
    renderTodayEvents(events);
  }

  App.home = { init, render };
})();
