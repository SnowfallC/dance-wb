/* split.js —— AA 分账 */
(function () {
  const App = (window.App = window.App || {});
  const { el, uid, toast } = App.util;

  let people = [];
  let expenses = [];

  function init() {
    // 金额框只允许数字与一个小数点，去掉 e / + / - 等符号，避免「什么都能输入」
    const amtInput = document.getElementById("expAmount");
    amtInput.addEventListener("input", () => {
      let v = String(amtInput.value).replace(/[^\d.]/g, "");
      const parts = v.split(".");
      if (parts.length > 2) v = parts[0] + "." + parts.slice(1).join("");
      if (amtInput.value !== v) amtInput.value = v;
    });
    document.getElementById("addPeopleBtn").onclick = () => {
      const v = document.getElementById("peopleInput").value.trim();
      if (!v) return;
      v.split(/[,，\s]+/).filter(Boolean).forEach((n) => {
        if (!people.includes(n)) people.push(n);
      });
      document.getElementById("peopleInput").value = "";
      render();
    };
    document.getElementById("addExpBtn").onclick = () => {
      const amt = parseFloat(document.getElementById("expAmount").value);
      const content = document.getElementById("expContent").value.trim();
      if (!isFinite(amt) || amt <= 0) return toast("请输入有效金额");
      expenses.push({ id: uid(), amount: amt, content: content || "未注明" });
      document.getElementById("expAmount").value = "";
      document.getElementById("expContent").value = "";
      render();
    };
    render();
  }

  function render() {
    // 人数
    const pl = document.getElementById("peopleList");
    pl.innerHTML = "";
    if (!people.length) pl.appendChild(el("span", { class: "hint", text: "👥 还没有团员，先添加名字（可一次加多个，空格分隔）。" }));
    people.forEach((p, i) => {
      pl.appendChild(el("span", { class: "pchip" }, [
        p,
        el("b", { text: "×", onclick: () => { people.splice(i, 1); render(); } }),
      ]));
    });

    // 账目
    const el2 = document.getElementById("expList");
    el2.innerHTML = "";
    if (!expenses.length) el2.appendChild(el("p", { class: "hint", text: "📒 还没有记账。" }));
    expenses.forEach((x, i) => {
      el2.appendChild(el("div", { class: "exp-item" }, [
        el("span", { class: "ic-badge sm", text: "💸" }),
        el("span", { text: x.content }),
        el("span", {}, [
          el("span", { class: "ei-amt", text: "¥" + x.amount.toFixed(2) }),
          el("b", { class: "ei-del", text: "×", onclick: () => { expenses.splice(i, 1); render(); } }),
        ]),
      ]));
    });

    // 结果
    const total = expenses.reduce((a, x) => a + x.amount, 0);
    const n = Math.max(1, people.length);
    const per = total / n;
    document.getElementById("splitResult").innerHTML = "";
    document.getElementById("splitResult").appendChild(
      el("div", {}, [
        el("div", { text: "🧾 共 " + expenses.length + " 笔 · 合计 ¥" + total.toFixed(2) }),
        el("div", { text: (people.length ? "👥 " + people.length + " 人均摊" : "⚠️ 未设人数，按 1 人") }),
      ])
    );
    document.getElementById("splitResult").appendChild(
      el("div", { class: "per", text: "¥" + per.toFixed(2) + " /人" })
    );
  }

  App.split = { init, render };
})();
