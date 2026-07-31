/* store.js —— IndexedDB 数据层 */
(function () {
  const App = (window.App = window.App || {});

  const DB_NAME = "danceWorkbench";
  const DB_VER = 1;
  const STORES = ["videos", "favorites", "events", "bills", "notes"];
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        STORES.forEach((s) => {
          if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: "id" });
        });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  function tx(store, mode) {
    return open().then((db) => db.transaction(store, mode).objectStore(store));
  }

  function put(store, val) {
    return tx(store, "readwrite").then(
      (os) =>
        new Promise((res, rej) => {
          const r = os.put(val);
          r.onsuccess = () => res(val);
          r.onerror = () => rej(r.error);
        })
    );
  }
  function get(store, id) {
    return tx(store, "readonly").then(
      (os) =>
        new Promise((res, rej) => {
          const r = os.get(id);
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        })
    );
  }
  function del(store, id) {
    return tx(store, "readwrite").then(
      (os) =>
        new Promise((res, rej) => {
          const r = os.delete(id);
          r.onsuccess = () => res();
          r.onerror = () => rej(r.error);
        })
    );
  }
  function all(store) {
    return tx(store, "readonly").then(
      (os) =>
        new Promise((res, rej) => {
          const r = os.getAll();
          r.onsuccess = () => res(r.result || []);
          r.onerror = () => rej(r.error);
        })
    );
  }

  // 笔记按 key 存取
  function getNotes(key) {
    return get("notes", key).then((n) => (n && n.notes) || []);
  }
  function saveNotes(key, notes) {
    return put("notes", { id: key, key, notes });
  }

  // 设置（localStorage）
  const settings = {
    get(k, d) {
      const v = localStorage.getItem("dw_" + k);
      return v == null ? d : JSON.parse(v);
    },
    set(k, v) {
      localStorage.setItem("dw_" + k, JSON.stringify(v));
    },
  };

  App.store = {
    open,
    put,
    get,
    del,
    all,
    getNotes,
    saveNotes,
    settings,
    addVideo: (rec) => put("videos", rec),
    listVideos: () => all("videos"),
    addFav: (rec) => put("favorites", rec),
    listFavs: () => all("favorites"),
    addEvent: (rec) => put("events", rec),
    listEvents: () => all("events"),
    addBill: (rec) => put("bills", rec),
    listBills: () => all("bills"),
  };
})();
