// Terminarz — recurring/scheduled obligations register (task 1/6 of #2).
//
// A local register of cyclic commitments (insurance, leasing, taxes, domains,
// subscriptions) each with an OWNER. This is the foundation: the calendar,
// period statuses and reminders from later tasks build on this data.
//
// Single-file on purpose: hot reload (`addons_reload`) only re-imports the
// ENTRY, so keeping everything here means every edit reloads cleanly.

export default async function activate(cl) {
  const STYLE_ID = "terminarz-style";

  // ------------------------------------------------------------- constants
  const CATEGORIES = [
    { id: "car", label: "Ubezpieczenie auta" },
    { id: "home", label: "Ubezpieczenie domu" },
    { id: "firm", label: "Ubezpieczenie firmy" },
    { id: "leasing", label: "Leasing" },
    { id: "tax", label: "Podatek" },
    { id: "domain", label: "Domena / hosting" },
    { id: "subscription", label: "Abonament" },
    { id: "other", label: "Inne" },
  ];
  const CATEGORY_LABEL = Object.fromEntries(
    CATEGORIES.map((c) => [c.id, c.label]),
  );

  const MONTHS = [
    "styczeń", "luty", "marzec", "kwiecień", "maj", "czerwiec",
    "lipiec", "sierpień", "wrzesień", "październik", "listopad", "grudzień",
  ];
  const MONTHS_GEN = [
    "stycznia", "lutego", "marca", "kwietnia", "maja", "czerwca",
    "lipca", "sierpnia", "września", "października", "listopada", "grudnia",
  ];

  const DEFAULT_OWNERS = [
    { id: "ja", name: "Ja", color: "#89b4fa" },
    { id: "zona", name: "Żona", color: "#f5c2e7" },
    { id: "jdg", name: "JDG", color: "#a6e3a1" },
    { id: "spolka", name: "Spółka", color: "#fab387" },
  ];

  // ------------------------------------------------------------- helpers
  const esc = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const escAttr = (s) => esc(s).replace(/'/g, "&#39;");
  const utf8 = new TextEncoder();
  const byteLen = (v) => utf8.encode(JSON.stringify(v)).length;

  function formatAmount(n) {
    if (n == null || n === "") return "—";
    const num = Number(n);
    if (!isFinite(num)) return "—";
    return (
      num.toLocaleString("pl-PL", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }) + " zł"
    );
  }

  // Cycle → human-readable Polish (e.g. "co miesiąc, 15-go", "raty: luty, maj").
  function cycleWords(cycle) {
    if (!cycle || !cycle.type) return "—";
    switch (cycle.type) {
      case "monthly":
        return `co miesiąc, ${cycle.day}-go`;
      case "quarterly":
        return `co kwartał, ${cycle.day}-go`;
      case "yearly":
        return `rocznie: ${cycle.day} ${MONTHS_GEN[cycle.month] || ""}`.trim();
      case "installments": {
        const names = (cycle.months || [])
          .slice()
          .sort((a, b) => a - b)
          .map((m) => MONTHS[m])
          .filter(Boolean);
        return `raty: ${names.join(", ")}`;
      }
      case "onetime":
        return `jednorazowo: ${cycle.date || "—"}`;
      default:
        return "—";
    }
  }

  // ------------------------------------------------------------- store
  // Owners live in one small key; obligations are chunked under a byte cap so a
  // growing list never blows the host's 64KB/value limit (pattern from ksef).
  const MAX_CHUNK_BYTES = 52 * 1024;
  const K_OWNERS = "owners";
  const K_OBL = "obl"; // chunk prefix: obl, obl#2, obl#3, …
  let cache = null;

  async function initStore() {
    cache = await cl.storage.all();
    if (!Array.isArray(cache[K_OWNERS])) {
      await put(K_OWNERS, DEFAULT_OWNERS.slice());
    }
  }
  async function put(key, value) {
    await cl.storage.set(key, value);
    cache[key] = value;
  }
  async function drop(key) {
    await cl.storage.remove(key);
    delete cache[key];
  }
  function oblPartKeys() {
    return Object.keys(cache)
      .filter((k) => k === K_OBL || k.startsWith(`${K_OBL}#`))
      .sort();
  }
  function owners() {
    return Array.isArray(cache[K_OWNERS]) ? cache[K_OWNERS] : [];
  }
  function obligations() {
    return oblPartKeys().flatMap((k) => cache[k] || []);
  }
  async function saveObligations(list) {
    const parts = [];
    let current = [];
    let bytes = 2;
    for (const rec of list) {
      const rb = byteLen(rec);
      if (current.length && bytes + rb + 1 > MAX_CHUNK_BYTES) {
        parts.push(current);
        current = [];
        bytes = 2;
      }
      bytes += rb + (current.length ? 1 : 0);
      current.push(rec);
    }
    parts.push(current);
    for (let i = 0; i < parts.length; i++) {
      await put(i === 0 ? K_OBL : `${K_OBL}#${i + 1}`, parts[i]);
    }
    for (const stale of oblPartKeys()) {
      const idx = stale === K_OBL ? 0 : Number(stale.split("#")[1]) - 1;
      if (idx >= parts.length) await drop(stale);
    }
  }
  async function upsertObligation(rec) {
    const list = obligations();
    const i = list.findIndex((o) => o.id === rec.id);
    if (i >= 0) list[i] = rec;
    else list.push(rec);
    await saveObligations(list);
  }
  async function removeObligation(id) {
    await saveObligations(obligations().filter((o) => o.id !== id));
  }
  async function saveOwners(list) {
    await put(K_OWNERS, list);
  }
  function ownerById(id) {
    return owners().find((o) => o.id === id) || null;
  }
  function newId() {
    return "o" + Math.abs(hashStr(JSON.stringify(obligations()) + Math.random()));
  }
  // deterministic-ish id without Date.now/Math.random reliance issues
  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
  }

  // ------------------------------------------------------------- style
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement("style");
    s.id = STYLE_ID;
    s.textContent = `
      .tz-wrap{display:flex;flex-direction:column;height:100%;min-height:0;}
      .tz-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border-bottom:1px solid var(--border,#45475a);}
      .tz-bar h2{margin:0;font-size:var(--fs-lg,16px);}
      .tz-body{flex:1;min-height:0;overflow-y:auto;padding:12px 14px;}
      .tz-btn{background:var(--accent,#89b4fa);color:var(--bg-primary,#1e1e2e);border:none;border-radius:8px;padding:8px 14px;font-weight:600;cursor:pointer;font:inherit;}
      .tz-btn.ghost{background:var(--bg-tertiary,#313244);color:var(--text-primary,#cdd6f4);border:1px solid var(--border,#45475a);}
      .tz-btn.danger{background:var(--error,#f38ba8);color:var(--bg-primary,#1e1e2e);}
      .tz-btn:disabled{opacity:.5;cursor:not-allowed;}
      .tz-empty{margin:48px auto;text-align:center;color:var(--text-muted,#9399b2);max-width:32em;display:flex;flex-direction:column;gap:12px;align-items:center;}
      table.tz-tbl{width:100%;border-collapse:collapse;font-size:var(--fs-base,14px);}
      .tz-tbl th{text-align:left;color:var(--text-muted,#9399b2);font-weight:600;padding:8px 10px;border-bottom:1px solid var(--border,#45475a);white-space:nowrap;}
      .tz-tbl td{padding:9px 10px;border-bottom:1px solid var(--border,#45475a);vertical-align:top;}
      .tz-tbl tr:hover td{background:var(--bg-secondary,#181825);}
      .tz-chip{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;color:#11111b;white-space:nowrap;}
      .tz-cat{color:var(--text-secondary,#bac2de);font-size:12px;}
      .tz-amt{white-space:nowrap;font-variant-numeric:tabular-nums;}
      .tz-actions{display:flex;gap:6px;justify-content:flex-end;}
      .tz-iconbtn{background:none;border:1px solid var(--border,#45475a);border-radius:6px;color:var(--text-secondary,#bac2de);cursor:pointer;padding:4px 8px;font:inherit;font-size:12px;}
      .tz-iconbtn:hover{color:var(--text-primary,#cdd6f4);}
      .tz-iconbtn.danger:hover{color:var(--error,#f38ba8);border-color:var(--error,#f38ba8);}
      .tz-modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px;}
      .tz-modal{background:var(--bg-primary,#1e1e2e);border:1px solid var(--border,#45475a);border-radius:14px;max-width:560px;width:100%;max-height:88vh;overflow-y:auto;padding:18px 20px;}
      .tz-modal h3{margin:0 0 12px;}
      .tz-field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px;}
      .tz-field>span{font-size:12px;color:var(--text-secondary,#bac2de);}
      .tz-row2{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
      .tz-input,.tz-select,.tz-ta{background:var(--bg-secondary,#181825);color:var(--text-primary,#cdd6f4);border:1px solid var(--border,#45475a);border-radius:8px;padding:8px 10px;font:inherit;font-size:var(--fs-base,14px);width:100%;box-sizing:border-box;}
      .tz-ta{resize:vertical;min-height:52px;}
      .tz-months{display:grid;grid-template-columns:repeat(3,1fr);gap:4px 10px;margin-top:4px;}
      .tz-months label{display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;}
      .tz-err{color:var(--error,#f38ba8);font-size:12px;margin-top:2px;}
      .tz-modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px;}
      .tz-hint{color:var(--text-muted,#9399b2);font-size:12px;}
      .tz-owner-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border,#45475a);}
      .tz-swatch{width:16px;height:16px;border-radius:4px;flex-shrink:0;}
      .tz-soon{margin:60px auto;text-align:center;color:var(--text-muted,#9399b2);}
    `;
    document.head.appendChild(s);
  }

  // ------------------------------------------------------------- form modal
  function openForm(existing, afterSave) {
    injectStyle();
    const editing = !!existing;
    // working copy
    const f = existing
      ? JSON.parse(JSON.stringify(existing))
      : {
          id: "",
          name: "",
          category: "other",
          ownerId: owners()[0] ? owners()[0].id : "",
          amount: "",
          tolerancePct: 10,
          cycle: { type: "monthly", day: 1 },
          statementPattern: "",
          contractEnd: "",
          note: "",
        };

    const bg = document.createElement("div");
    bg.className = "tz-modal-bg";
    const modal = document.createElement("div");
    modal.className = "tz-modal";
    bg.appendChild(modal);

    function close() {
      bg.remove();
      document.removeEventListener("keydown", onEsc);
    }
    function onEsc(e) {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    }
    bg.addEventListener("click", (e) => {
      if (e.target === bg) close();
    });
    modal.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("keydown", onEsc);

    function cycleFields() {
      const c = f.cycle;
      const dayInput = (val) =>
        `<label class="tz-field"><span>Dzień miesiąca (1–31)</span><input class="tz-input" id="f-day" type="number" min="1" max="31" value="${escAttr(val ?? 1)}"></label>`;
      if (c.type === "monthly") return dayInput(c.day);
      if (c.type === "quarterly") return dayInput(c.day);
      if (c.type === "yearly")
        return `<div class="tz-row2">
            <label class="tz-field"><span>Miesiąc</span><select class="tz-select" id="f-month">${MONTHS.map((m, i) => `<option value="${i}" ${i === (c.month ?? 0) ? "selected" : ""}>${esc(m)}</option>`).join("")}</select></label>
            ${dayInput(c.day)}
          </div>`;
      if (c.type === "installments")
        return `<div class="tz-field"><span>Miesiące rat</span>
            <div class="tz-months">${MONTHS.map((m, i) => `<label><input type="checkbox" class="f-instm" value="${i}" ${(c.months || []).includes(i) ? "checked" : ""}> ${esc(m)}</label>`).join("")}</div>
            <div class="tz-err" id="err-months" style="display:none"></div>
          </div>
          ${dayInput(c.day)}`;
      if (c.type === "onetime")
        // type="text" (nie "date"): WebKit2GTK na Linuksie nie ma pickera dla
        // input[type=date]/[month] — klik nic nie robi. Tekst RRRR-MM-DD działa
        // na obu platformach.
        return `<label class="tz-field"><span>Data *</span><input class="tz-input" id="f-date" type="text" inputmode="numeric" placeholder="RRRR-MM-DD" value="${escAttr(c.date || "")}"><div class="tz-err" id="err-date" style="display:none"></div></label>`;
      return "";
    }

    function render() {
      modal.innerHTML = `
        <h3>${editing ? "Edytuj zobowiązanie" : "Nowe zobowiązanie"}</h3>
        <label class="tz-field"><span>Nazwa *</span>
          <input class="tz-input" id="f-name" type="text" value="${escAttr(f.name)}" placeholder="np. Leasing Stellantis">
          <div class="tz-err" id="err-name" style="display:none"></div>
        </label>
        <div class="tz-row2">
          <label class="tz-field"><span>Kategoria</span>
            <select class="tz-select" id="f-cat">${CATEGORIES.map((c) => `<option value="${c.id}" ${c.id === f.category ? "selected" : ""}>${esc(c.label)}</option>`).join("")}</select>
          </label>
          <label class="tz-field"><span>Właściciel</span>
            <select class="tz-select" id="f-owner">${owners().map((o) => `<option value="${escAttr(o.id)}" ${o.id === f.ownerId ? "selected" : ""}>${esc(o.name)}</option>`).join("")}</select>
          </label>
        </div>
        <div class="tz-row2">
          <label class="tz-field"><span>Kwota (zł) *</span>
            <input class="tz-input" id="f-amount" type="number" step="0.01" min="0" value="${escAttr(f.amount)}" placeholder="0.00">
            <div class="tz-err" id="err-amount" style="display:none"></div>
          </label>
          <label class="tz-field"><span>Tolerancja (%)</span>
            <input class="tz-input" id="f-tol" type="number" min="0" max="100" value="${escAttr(f.tolerancePct ?? 10)}">
          </label>
        </div>
        <label class="tz-field"><span>Cykl</span>
          <select class="tz-select" id="f-cycle">
            <option value="monthly" ${f.cycle.type === "monthly" ? "selected" : ""}>Miesięczny</option>
            <option value="quarterly" ${f.cycle.type === "quarterly" ? "selected" : ""}>Kwartalny</option>
            <option value="yearly" ${f.cycle.type === "yearly" ? "selected" : ""}>Roczny</option>
            <option value="installments" ${f.cycle.type === "installments" ? "selected" : ""}>Raty w wybranych miesiącach</option>
            <option value="onetime" ${f.cycle.type === "onetime" ? "selected" : ""}>Jednorazowy</option>
          </select>
        </label>
        <div id="cycle-fields">${cycleFields()}</div>
        <label class="tz-field"><span>Wzorzec z wyciągu (opcjonalnie)</span>
          <input class="tz-input" id="f-pattern" type="text" value="${escAttr(f.statementPattern || "")}" placeholder="fragment tytułu przelewu">
        </label>
        <div class="tz-row2">
          <label class="tz-field"><span>Koniec umowy (opcjonalnie)</span>
            <input class="tz-input" id="f-end" type="text" inputmode="numeric" placeholder="RRRR-MM (np. 2027-01)" value="${escAttr(f.contractEnd || "")}">
            <div class="tz-err" id="err-end" style="display:none"></div>
          </label>
        </div>
        <label class="tz-field"><span>Notatka (opcjonalnie)</span>
          <textarea class="tz-ta" id="f-note">${esc(f.note || "")}</textarea>
        </label>
        <div class="tz-modal-actions">
          <button class="tz-btn ghost" id="f-cancel">Anuluj</button>
          <button class="tz-btn" id="f-save">${editing ? "Zapisz zmiany" : "Dodaj"}</button>
        </div>`;

      // sync working copy on input so cycle switch keeps entered values
      const bind = (id, fn) => {
        const el = modal.querySelector(id);
        if (el) el.addEventListener("input", fn);
      };
      bind("#f-name", (e) => (f.name = e.target.value));
      bind("#f-cat", (e) => (f.category = e.target.value));
      bind("#f-owner", (e) => (f.ownerId = e.target.value));
      bind("#f-amount", (e) => (f.amount = e.target.value));
      bind("#f-tol", (e) => (f.tolerancePct = e.target.value));
      bind("#f-pattern", (e) => (f.statementPattern = e.target.value));
      bind("#f-end", (e) => (f.contractEnd = e.target.value));
      bind("#f-note", (e) => (f.note = e.target.value));

      modal.querySelector("#f-cycle").addEventListener("change", (e) => {
        captureCycle();
        const t = e.target.value;
        if (t === "monthly" || t === "quarterly")
          f.cycle = { type: t, day: f.cycle.day || 1 };
        else if (t === "yearly")
          f.cycle = { type: t, month: f.cycle.month || 0, day: f.cycle.day || 1 };
        else if (t === "installments")
          f.cycle = { type: t, months: f.cycle.months || [], day: f.cycle.day || 1 };
        else f.cycle = { type: "onetime", date: f.cycle.date || "" };
        modal.querySelector("#cycle-fields").innerHTML = cycleFields();
        wireCycleFields();
      });
      wireCycleFields();

      modal.querySelector("#f-cancel").addEventListener("click", close);
      modal.querySelector("#f-save").addEventListener("click", onSave);
      modal.querySelector("#f-name").focus();
    }

    function wireCycleFields() {
      const day = modal.querySelector("#f-day");
      if (day) day.addEventListener("input", (e) => (f.cycle.day = Number(e.target.value)));
      const month = modal.querySelector("#f-month");
      if (month) month.addEventListener("change", (e) => (f.cycle.month = Number(e.target.value)));
      const date = modal.querySelector("#f-date");
      if (date) date.addEventListener("input", (e) => (f.cycle.date = e.target.value));
      modal.querySelectorAll(".f-instm").forEach((cb) =>
        cb.addEventListener("change", captureCycle),
      );
    }
    function captureCycle() {
      const day = modal.querySelector("#f-day");
      if (day) f.cycle.day = Number(day.value);
      const month = modal.querySelector("#f-month");
      if (month) f.cycle.month = Number(month.value);
      const date = modal.querySelector("#f-date");
      if (date) f.cycle.date = date.value;
      const boxes = modal.querySelectorAll(".f-instm");
      if (boxes.length)
        f.cycle.months = Array.from(boxes)
          .filter((b) => b.checked)
          .map((b) => Number(b.value));
    }

    function showErr(id, msg) {
      const el = modal.querySelector(id);
      if (el) {
        el.textContent = msg;
        el.style.display = "";
      }
    }
    function clearErrs() {
      modal.querySelectorAll(".tz-err").forEach((e) => (e.style.display = "none"));
    }

    async function onSave() {
      captureCycle();
      clearErrs();
      let ok = true;
      if (!f.name || !f.name.trim()) {
        showErr("#err-name", "Podaj nazwę zobowiązania");
        ok = false;
      }
      const amt = Number(f.amount);
      if (!(amt > 0)) {
        showErr("#err-amount", "Kwota musi być większa od zera");
        ok = false;
      }
      if (
        f.cycle.type === "installments" &&
        (!f.cycle.months || f.cycle.months.length === 0)
      ) {
        showErr("#err-months", "Zaznacz co najmniej jeden miesiąc rat");
        ok = false;
      }
      const endVal = (f.contractEnd || "").trim();
      if (endVal && !/^\d{4}-(0[1-9]|1[0-2])$/.test(endVal)) {
        showErr("#err-end", "Format: RRRR-MM (np. 2027-01)");
        ok = false;
      }
      if (f.cycle.type === "onetime") {
        const dv = (f.cycle.date || "").trim();
        if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(dv)) {
          showErr("#err-date", "Podaj datę w formacie RRRR-MM-DD");
          ok = false;
        }
      }
      if (!ok) return;

      const rec = {
        id: f.id || newId(),
        name: f.name.trim(),
        category: f.category,
        ownerId: f.ownerId,
        amount: amt,
        tolerancePct: Number(f.tolerancePct) || 0,
        cycle: f.cycle,
        statementPattern: (f.statementPattern || "").trim(),
        contractEnd: (f.contractEnd || "").trim(),
        note: (f.note || "").trim(),
      };
      await upsertObligation(rec);
      close();
      if (afterSave) afterSave();
    }

    render();
    document.body.appendChild(bg);
  }

  // ------------------------------------------------------------- confirm
  function confirmDialog(message, onYes, { danger = true } = {}) {
    injectStyle();
    const bg = document.createElement("div");
    bg.className = "tz-modal-bg";
    bg.innerHTML = `
      <div class="tz-modal" style="max-width:420px">
        <p style="margin:0 0 16px">${esc(message)}</p>
        <div class="tz-modal-actions">
          <button class="tz-btn ghost" id="c-no">Anuluj</button>
          <button class="tz-btn ${danger ? "danger" : ""}" id="c-yes">Usuń</button>
        </div>
      </div>`;
    const modal = bg.querySelector(".tz-modal");
    modal.addEventListener("click", (e) => e.stopPropagation());
    const close = () => {
      bg.remove();
      document.removeEventListener("keydown", onEsc);
    };
    const onEsc = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    bg.addEventListener("click", (e) => {
      if (e.target === bg) close();
    });
    document.addEventListener("keydown", onEsc);
    bg.querySelector("#c-no").addEventListener("click", close);
    bg.querySelector("#c-yes").addEventListener("click", () => {
      close();
      onYes();
    });
    document.body.appendChild(bg);
  }

  // ------------------------------------------------------------- obligations page
  let oblEl = null;
  function renderObligations(el) {
    oblEl = el;
    injectStyle();
    const list = obligations()
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, "pl"));

    const rows = list
      .map((o) => {
        const owner = ownerById(o.ownerId);
        const chip = owner
          ? `<span class="tz-chip" style="background:${escAttr(owner.color)}">${esc(owner.name)}</span>`
          : `<span class="tz-hint">—</span>`;
        return `<tr data-id="${escAttr(o.id)}">
          <td>${esc(o.name)}<div class="tz-cat">${esc(CATEGORY_LABEL[o.category] || o.category)}</div></td>
          <td>${chip}</td>
          <td>${esc(cycleWords(o.cycle))}</td>
          <td class="tz-amt">${formatAmount(o.amount)}</td>
          <td>${o.contractEnd ? esc(o.contractEnd) : "<span class='tz-hint'>—</span>"}</td>
          <td><div class="tz-actions">
            <button class="tz-iconbtn tz-edit">Edytuj</button>
            <button class="tz-iconbtn danger tz-del">Usuń</button>
          </div></td>
        </tr>`;
      })
      .join("");

    el.innerHTML = `
      <div class="tz-wrap">
        <div class="tz-bar">
          <h2>📋 Zobowiązania</h2>
          <button class="tz-btn" id="tz-add">+ Dodaj</button>
        </div>
        <div class="tz-body">
          ${
            list.length === 0
              ? `<div class="tz-empty">
                   <div style="font-size:32px">📋</div>
                   <div>Brak zobowiązań — dodaj pierwsze.</div>
                   <button class="tz-btn" id="tz-add-empty">+ Dodaj zobowiązanie</button>
                 </div>`
              : `<table class="tz-tbl">
                   <thead><tr>
                     <th>Nazwa / kategoria</th><th>Właściciel</th><th>Cykl</th>
                     <th>Kwota</th><th>Koniec umowy</th><th></th>
                   </tr></thead>
                   <tbody>${rows}</tbody>
                 </table>`
          }
        </div>
      </div>`;

    const add = () => openForm(null, () => renderObligations(el));
    el.querySelector("#tz-add").addEventListener("click", add);
    const addEmpty = el.querySelector("#tz-add-empty");
    if (addEmpty) addEmpty.addEventListener("click", add);

    el.querySelectorAll("tr[data-id]").forEach((tr) => {
      const id = tr.getAttribute("data-id");
      tr.querySelector(".tz-edit").addEventListener("click", () => {
        const rec = obligations().find((o) => o.id === id);
        if (rec) openForm(rec, () => renderObligations(el));
      });
      tr.querySelector(".tz-del").addEventListener("click", () => {
        const rec = obligations().find((o) => o.id === id);
        confirmDialog(
          `Usunąć zobowiązanie „${rec ? rec.name : ""}"?`,
          async () => {
            await removeObligation(id);
            renderObligations(el);
          },
        );
      });
    });
  }

  // ------------------------------------------------------------- calendar (placeholder, task 3/6)
  function renderCalendar(el) {
    injectStyle();
    el.innerHTML = `
      <div class="tz-wrap">
        <div class="tz-bar"><h2>📆 Kalendarz</h2></div>
        <div class="tz-body">
          <div class="tz-soon">📆<br><br>Wkrótce — widoki Dzień / Miesiąc / Rok (zadanie 3/6).</div>
        </div>
      </div>`;
  }

  // ------------------------------------------------------------- module
  cl.registerModule({
    id: "main",
    label: "Terminarz",
    icon: "📅",
    pages: [
      {
        id: "obligations",
        label: "Zobowiązania",
        icon: "📋",
        render: renderObligations,
        onShow: () => oblEl && renderObligations(oblEl),
      },
      {
        id: "calendar",
        label: "Kalendarz",
        icon: "📆",
        render: renderCalendar,
      },
    ],
  });

  // ------------------------------------------------------------- settings (owners)
  cl.registerSettingsSection({
    id: "settings",
    label: "Terminarz",
    icon: "📅",
    render(el) {
      injectStyle();
      function draw() {
        const list = owners();
        el.innerHTML = `
          <h2 class="settings-section-title">📅 Terminarz — właściciele</h2>
          <p class="settings-section-desc">Właściciele przypisywani do zobowiązań. Właściciela, który ma przypisane zobowiązania, nie można usunąć.</p>
          <div id="tz-owners">
            ${list
              .map(
                (o) => `<div class="tz-owner-row" data-id="${escAttr(o.id)}">
                  <span class="tz-swatch" style="background:${escAttr(o.color)}"></span>
                  <span style="flex:1">${esc(o.name)}</span>
                  <button class="tz-iconbtn danger tz-owner-del">Usuń</button>
                </div>`,
              )
              .join("")}
          </div>
          <div class="tz-owner-row" style="border:none">
            <input class="tz-input" id="tz-new-name" type="text" placeholder="Nazwa właściciela" style="flex:1">
            <input id="tz-new-color" type="color" value="#89b4fa" style="width:40px;height:34px;border:none;background:none;cursor:pointer">
            <button class="tz-btn" id="tz-owner-add">Dodaj</button>
          </div>
          <div class="tz-err" id="tz-owner-err" style="display:none"></div>`;

        el.querySelector("#tz-owner-add").addEventListener("click", async () => {
          const name = el.querySelector("#tz-new-name").value.trim();
          const color = el.querySelector("#tz-new-color").value || "#89b4fa";
          const errEl = el.querySelector("#tz-owner-err");
          errEl.style.display = "none";
          if (!name) {
            errEl.textContent = "Podaj nazwę właściciela";
            errEl.style.display = "";
            return;
          }
          const id =
            name.toLowerCase().replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") ||
            "w" + hashStr(name + color);
          const list2 = owners().slice();
          if (list2.some((o) => o.id === id)) {
            errEl.textContent = "Właściciel o tej nazwie już istnieje";
            errEl.style.display = "";
            return;
          }
          list2.push({ id, name, color });
          await saveOwners(list2);
          draw();
        });

        el.querySelectorAll(".tz-owner-row[data-id]").forEach((row) => {
          const id = row.getAttribute("data-id");
          const del = row.querySelector(".tz-owner-del");
          if (del)
            del.addEventListener("click", async () => {
              const errEl = el.querySelector("#tz-owner-err");
              errEl.style.display = "none";
              if (obligations().some((o) => o.ownerId === id)) {
                errEl.textContent = "Właściciel ma przypisane zobowiązania";
                errEl.style.display = "";
                return;
              }
              await saveOwners(owners().filter((o) => o.id !== id));
              draw();
            });
        });
      }
      draw();
    },
  });

  await initStore();
  cl.log("Terminarz ready");

  return () => {
    oblEl = null;
  };
}
