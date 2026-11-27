// Gacvla — რეიტინგი: საუკეთესო კურსიდან ცუდისკენ
// მონაცემები: rates.json (სკრეპერი, ყოველ 30 წთ)

const CURRENCIES = [
  { code: "USD", symbol: "$", name: "აშშ დოლარი" },
  { code: "EUR", symbol: "€", name: "ევრო" },
  { code: "GBP", symbol: "£", name: "ბრიტანული ფუნტი" },
  { code: "RUB", symbol: "₽", name: "რუსული რუბლი" },
  { code: "TRY", symbol: "₺", name: "თურქული ლირა" },
];

let sources = [];
let cur = "USD";
let mode = "buy"; // buy = შენ ყიდი (ბანკის ყიდვის კურსი, კლებადობით); sell = შენ ყიდულობ (ბანკის გაყიდვის კურსი, ზრდადობით)

function fmt(n, digits = 4) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return Number(n).toFixed(digits).replace(".", ",");
}
function fmtMoney(n) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return Number(n).toLocaleString("ka-GE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " ₾";
}
function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("ka-GE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch (e) { return iso; }
}

function renderPicker() {
  const el = document.getElementById("cur-picker");
  el.innerHTML = CURRENCIES.map((c) =>
    `<button type="button" data-cur="${c.code}" class="${c.code === cur ? "active" : ""}">${c.code} ${c.symbol}</button>`
  ).join("");
  el.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      cur = b.dataset.cur;
      renderPicker();
      renderList();
    });
  });
}

function renderList() {
  const meta = CURRENCIES.find((c) => c.code === cur);
  const hint = document.getElementById("rank-hint");
  hint.textContent = mode === "buy"
    ? "შენ ყიდი — პირველ ადგილზეა ის, ვინც ყველაზე ძვირად ყიდულობს შენს ვალუტას."
    : "შენ ყიდულობ — პირველ ადგილზეა ის, ვინც ყველაზე იაფად გყიდის ვალუტას.";

  const rows = [];
  for (const s of sources) {
    const r = s.rates && s.rates[cur];
    if (!r || r[mode] === null || r[mode] === undefined) continue;
    const stale = s.updated_at && (Date.now() - new Date(s.updated_at).getTime() > 2 * 60 * 60 * 1000);
    rows.push({ name: s.name, type: s.type === "exchange" ? "პუნქტი" : "ბანკი", value: r[mode], stale: !!stale });
  }
  rows.sort((a, b) => mode === "buy" ? b.value - a.value : a.value - b.value);

  const list = document.getElementById("rank-list");
  const empty = document.getElementById("rank-empty");
  if (!rows.length) {
    list.innerHTML = "";
    empty.textContent = "ამ ვალუტაზე არცერთ წყაროს კურსი არ აქვს.";
    return;
  }
  empty.textContent = "";
  const best = rows[0].value;
  list.innerHTML = rows.map((row, i) => {
    const per100 = row.value * 100;
    const diff100 = Math.abs(row.value - best) * 100;
    const diffText = i === 0
      ? "საუკეთესო კურსი"
      : mode === "buy"
        ? `საუკეთესოზე ${fmtMoney(diff100)}-ით ნაკლები (100 ${cur}-ზე)`
        : `საუკეთესოზე ${fmtMoney(diff100)}-ით ძვირი (100 ${cur}-ზე)`;
    const amountText = mode === "buy"
      ? `100 ${cur} ${meta.symbol} → ${fmtMoney(per100)}`
      : `100 ${cur} ${meta.symbol} = ${fmtMoney(per100)}`;
    return `<li class="rank-row ${i === 0 ? "first" : ""}">
      <span class="rank-num">${i + 1}</span>
      <span class="rank-main">
        <span class="rank-name">${row.name}</span><span class="rank-type">${row.type}</span>
        <span class="rank-sub">${amountText}${row.stale ? " · ძველი მონაცემი" : ""}</span>
      </span>
      <span class="rank-rate">
        <span class="val">${fmt(row.value)}</span>
        <span class="rank-diff">${diffText}</span>
      </span>
    </li>`;
  }).join("");
}

function bindMode() {
  const buttons = document.querySelectorAll("#mode-toggle .mode-btn");
  buttons.forEach((b) => {
    b.addEventListener("click", () => {
      buttons.forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      mode = b.dataset.mode;
      renderList();
    });
  });
}

async function init() {
  try {
    const res = await fetch("rates.json", { cache: "no-store" });
    if (!res.ok) throw new Error("rates.json ვერ ჩაიტვირთა");
    const data = await res.json();
    sources = data.sources || [];
    document.getElementById("updated-at").textContent = fmtTime(data.updated_at);
    renderPicker();
    bindMode();
    renderList();
  } catch (e) {
    document.getElementById("rank-empty").textContent = "კურსების ჩატვირთვა ვერ მოხერხდა. სცადე გვერდის განახლება.";
  }
}

init();

// მუქი თემა: შენახული არჩევანი იმახსოვრება, ღილაკი გადართავს
(function initTheme() {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  function syncIcon() {
    btn.textContent = document.documentElement.classList.contains("dark") ? "☀️" : "🌙";
  }
  syncIcon();
  btn.addEventListener("click", () => {
    const dark = document.documentElement.classList.toggle("dark");
    try { localStorage.setItem("gacvla-theme", dark ? "dark" : "light"); } catch (e) {}
    syncIcon();
  });
})();
