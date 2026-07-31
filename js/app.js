/* app.js —— 装配与路由 */
(function () {
  const App = (window.App = window.App || {});

  const refreshHooks = {};

  const AppObj = {
    switchTab(name) {
      document.querySelectorAll(".tab").forEach((t) => t.classList.add("hidden"));
      document.getElementById("tab-" + name).classList.remove("hidden");
      document.querySelectorAll(".tabbtn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
      const sub = { home: () => App.home && App.home.render(), favorites: () => App.favorites && App.favorites.render(), calendar: () => App.calendar && App.calendar.render() }[name];
      if (sub) sub();
    },
    onShow(name, fn) { refreshHooks[name] = fn; },
  };
  App.app = AppObj;

  function boot() {
    App.player.init();
    App.favorites.init();
    App.calendar.init();
    App.split.init();
    App.home && App.home.init();

    document.querySelectorAll(".tabbtn").forEach((b) => {
      b.onclick = () => AppObj.switchTab(b.dataset.tab);
    });

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    }
    AppObj.switchTab("home");
    App.util.toast("舞刀已就绪");
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
