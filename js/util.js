/* util.js —— 通用工具 */
(function () {
  const App = (window.App = window.App || {});

  function el(tag, props, children) {
    const e = document.createElement(tag);
    if (props) {
      for (const k in props) {
        if (k === "class") e.className = props[k];
        else if (k === "html") e.innerHTML = props[k];
        else if (k === "text") e.textContent = props[k];
        else if (k.startsWith("on") && typeof props[k] === "function")
          e.addEventListener(k.slice(2), props[k]);
        else if (k === "style" && typeof props[k] === "object")
          Object.assign(e.style, props[k]);
        else if (props[k] !== null && props[k] !== undefined)
          e.setAttribute(k, props[k]);
      }
    }
    if (children != null) {
      (Array.isArray(children) ? children : [children]).forEach((c) => {
        if (c == null) return;
        e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      });
    }
    return e;
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }

  let toastTimer = null;
  function toast(msg, ms) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), ms || 2200);
  }

  // 底部弹层
  function openSheet(title, bodyNode, onClose) {
    const mask = document.getElementById("sheetMask");
    document.getElementById("sheetTitle").textContent = title;
    const body = document.getElementById("sheetBody");
    body.innerHTML = "";
    if (bodyNode) body.appendChild(bodyNode);
    mask.hidden = false;
    document.getElementById("sheetClose").onclick = () => closeSheet(onClose);
    mask.onclick = (e) => {
      if (e.target === mask) closeSheet(onClose);
    };
  }
  function closeSheet(onClose) {
    document.getElementById("sheetMask").hidden = true;
    if (onClose) onClose();
  }

  async function confirmSheet(title, message, okText) {
    return new Promise((resolve) => {
      const wrap = el("div", {}, [
        el("p", { text: message, style: { marginBottom: "12px" } }),
        el("div", { class: "controls" }, [
          el("button", {
            class: "btn sm",
            text: okText || "确定",
            onclick: () => {
              closeSheet();
              resolve(true);
            },
          }),
          el("button", {
            class: "btn soft sm",
            text: "取消",
            onclick: () => {
              closeSheet();
              resolve(false);
            },
          }),
        ]),
      ]);
      openSheet(title, wrap);
    });
  }

  App.util = { el, uid, fmt, toast, openSheet, closeSheet, confirmSheet };
})();
