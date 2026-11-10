// Gacvla — ვალუტის კურსები
// მონაცემები: rates.json (სკრეპერი, ყოველ 30 წთ) + ეროვნული ბანკის API (ლაივ, ბრაუზერიდან)

const CURRENCIES = [
  { code: "USD", symbol: "$", name: "აშშ დოლარი" },
  { code: "EUR", symbol: "€", name: "ევრო" },
  { code: "GBP", symbol: "£", name: "ბრიტანული ფუნტი" },
  { code: "RUB", symbol: "₽", name: "რუსული რუბლი" },
  { code: "TRY", symbol: "₺", name: "თურქული ლირა" },
];

const NBG_API = "https://nbg.gov.ge/gw/api/ct/monetarypolicy/currencies/en/json/";

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

async function loadRates() {
  const res = await fetch("rates.json", { cache: "no-store" });
  if (!res.ok) throw new Error("rates.json ვერ ჩაიტვირთა");
  return res.json();
}

async function loadNbgLive() {
  // ეროვნული ბანკის API პირდაპირ ბრაუზერიდან (CORS ჩართულია, გასაღები არ სჭირდება)
  try {
    const res = await fetch(NBG_API);
    if (!res.ok) return null;
    const data = await res.json();
    // რეალური სტრუქტურა: [{"date": "...", "currencies": [{code, quantity, rate, ...}]}]
    const list = Array.isArray(data) ? (data[0] && data[0].currencies ? data[0].currencies : data) : (data.currencies || []);
    const out = {};
    let date = null;
    for (const item of list) {
      if (!item.code || !item.rate || !item.quantity) continue;
      out[item.code] = item.rate / item.quantity;
      date = item.date;
    }
    return { rates: out, date, live: true };
  } catch (e) {
    return null;
  }
}

function bestAcross(sources, code, side) {
  // side: "buy" -> ყველაზე მაღალი ყიდვა (შენ რომ ყიდი); "sell" -> ყველაზე დაბალი გაყიდვა (შენ რომ ყიდულობ)
  let best = null;
  for (const s of sources) {
    const r = s.rates && s.rates[code];
    if (!r || r[side] === null || r[side] === undefined) continue;
    if (best === null) { best = { value: r[side], name: s.name }; continue; }
    if (side === "buy" && r[side] > best.value) best = { value: r[side], name: s.name };
    if (side === "sell" && r[side] < best.value) best = { value: r[side], name: s.name };
  }
  return best;
}

function renderBest(sources) {
  const el = document.getElementById("best-rates");
  el.innerHTML = CURRENCIES.map((c) => {
    const buy = bestAcross(sources, c.code, "buy");
    const sell = bestAcross(sources, c.code, "sell");
    return `<div class="best-cell">
      <div class="cur">${c.code} ${c.symbol}</div>
      <div class="row"><span>შენ ყიდი 👉</span><span class="val">${buy ? fmt(buy.value) : "—"}</span></div>
      <div class="who">${buy ? buy.name : ""}</div>
      <div class="row"><span>შენ ყიდულობ 👉</span><span class="val">${sell ? fmt(sell.value) : "—"}</span></div>
      <div class="who">${sell ? sell.name : ""}</div>
    </div>`;
  }).join("");
}

function renderNbg(nbg, live) {
  const el = document.getElementById("nbg-rates");
  el.innerHTML = CURRENCIES.map((c) => {
    const v = nbg && nbg[c.code];
    return `<div class="nbg-cell"><div class="cur">${c.code}</div><div class="val">${v ? fmt(v) : "—"}</div><div class="sym">1 ${c.symbol} = ${v ? fmt(v) + " ₾" : "—"}</div></div>`;
  }).join("");
  const status = document.getElementById("nbg-status");
  if (status) status.textContent = live ? "ლაივ — ეროვნული ბანკის API-დან." : "ლაივ ჩატვირთვა ვერ მოხერხდა — ნაჩვენებია ბოლო შენახული კურსი.";
  const dateEl = document.getElementById("nbg-date");
  if (dateEl && nbg && nbg.date) dateEl.textContent = "— " + nbg.date;
}

function rateCell(value, isBest) {
  return `<td class="${isBest ? "best" : ""}">${value === null || value === undefined ? "—" : fmt(value)}</td>`;
}

function sourceCard(s, allSources) {
  const stale = s.updated_at && (Date.now() - new Date(s.updated_at).getTime() > 2 * 60 * 60 * 1000);
  const rows = CURRENCIES.map((c) => {
    const r = (s.rates && s.rates[c.code]) || {};
    const bestBuy = bestAcross(allSources, c.code, "buy");
    const bestSell = bestAcross(allSources, c.code, "sell");
    const isBestBuy = bestBuy && r.buy === bestBuy.value;
    const isBestSell = bestSell && r.sell === bestSell.value;
    return `<tr><td>${c.code} ${c.symbol}</td>${rateCell(r.buy, isBestBuy)}${rateCell(r.sell, isBestSell)}</tr>`;
  }).join("");

  const opts = CURRENCIES.map((c) => `<option value="${c.code}">${c.code} ${c.symbol}</option>`).join("");

  return `<article class="source" data-source="${s.id}">
    <header>
      <h3>${s.name}</h3>
      <span class="src-updated ${stale ? "stale" : ""}">${stale ? "ძველი მონაცემი · " : ""}განახლდა: ${fmtTime(s.updated_at)}</span>
    </header>
    ${s.note ? `<p class="hint">${s.note}</p>` : ""}
    <table class="rates">
      <thead><tr><th>ვალუტა</th><th>ყიდვა</th><th>გაყიდვა</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="calc">
      <div class="calc-title">კალკულატორი — ${s.name}</div>
      <div class="calc-row">
        <input type="number" min="0" step="any" inputmode="decimal" placeholder="თანხა" class="calc-amount" aria-label="თანხა">
        <select class="calc-cur" aria-label="ვალუტა">${opts}</select>
      </div>
      <div class="mode-toggle">
        <button type="button" class="mode-btn active" data-mode="sell">ვალუტას ვყიდულობ</button>
        <button type="button" class="mode-btn" data-mode="buy">ვალუტას ვყიდი</button>
      </div>
      <div class="calc-result"></div>
      <div class="calc-rate"></div>
    </div>
  </article>`;
}

function bindCalculators() {
  document.querySelectorAll(".source").forEach((card) => {
    const id = card.dataset.source;
    const amountEl = card.querySelector(".calc-amount");
    const curEl = card.querySelector(".calc-cur");
    const resultEl = card.querySelector(".calc-result");
    const rateEl = card.querySelector(".calc-rate");
    const buttons = card.querySelectorAll(".mode-btn");
    let mode = "sell"; // default: მომხმარებელი ვალუტას ყიდულობს (ბანკის გაყიდვის კურსით)

    function calc() {
      const s = window.__gacvla.sourcesById[id];
      const amount = parseFloat((amountEl.value || "").replace(",", "."));
      const cur = curEl.value;
      const r = s && s.rates && s.rates[cur];
      if (!r || !amount || amount <= 0) { resultEl.textContent = ""; rateEl.textContent = ""; return; }
      const curMeta = CURRENCIES.find((c) => c.code === cur);
      if (mode === "sell") {
        // ვალუტის ყიდვა: ვიხდი ლარს, ვიღებ ვალუტას — ბანკის გაყიდვის კურსით
        if (r.sell === null || r.sell === undefined) { resultEl.textContent = "ამ ვალუტაზე კურსი არ არის."; rateEl.textContent = ""; return; }
        const got = amount / r.sell;
        resultEl.textContent = `${fmtMoney(amount)} → ${got.toLocaleString("ka-GE", { maximumFractionDigits: 2 })} ${cur} ${curMeta.symbol}`;
        rateEl.textContent = `კურსი: 1 ${cur} = ${fmt(r.sell)} ₾`;
      } else {
        // ვალუტის გაყიდვა: ვაძლევ ვალუტას, ვიღებ ლარს — ბანკის ყიდვის კურსით
        if (r.buy === null || r.buy === undefined) { resultEl.textContent = "ამ ვალუტაზე კურსი არ არის."; rateEl.textContent = ""; return; }
        const got = amount * r.buy;
        resultEl.textContent = `${amount.toLocaleString("ka-GE")} ${cur} ${curMeta.symbol} → ${fmtMoney(got)}`;
        rateEl.textContent = `კურსი: 1 ${cur} = ${fmt(r.buy)} ₾`;
      }
    }

    amountEl.addEventListener("input", calc);
    curEl.addEventListener("change", calc);
    buttons.forEach((b) => b.addEventListener("click", () => {
      buttons.forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      mode = b.dataset.mode;
      calc();
    }));
  });
}

async function init() {
  try {
    const data = await loadRates();
    window.__gacvla = { sourcesById: {} };
    const sources = data.sources || [];
    sources.forEach((s) => { window.__gacvla.sourcesById[s.id] = s; });

    document.getElementById("updated-at").textContent = fmtTime(data.updated_at);

    renderBest(sources);

    // ეროვნული ბანკი: ჯერ ლაივ API, თუ ვერ მოხერხდა — rates.json-დან
    const live = await loadNbgLive();
    if (live) {
      renderNbg({ ...live.rates, date: live.date }, true);
    } else {
      renderNbg({ ...(data.nbg ? data.nbg.rates : {}), date: data.nbg ? data.nbg.date : null }, false);
    }

    const banks = sources.filter((s) => s.type === "bank");
    const exchanges = sources.filter((s) => s.type === "exchange");
    document.getElementById("banks").innerHTML = banks.length ? banks.map((s) => sourceCard(s, sources)).join("") : '<p class="empty">ჯერ მონაცემები არ არის — მალე განახლდება.</p>';
    document.getElementById("exchanges").innerHTML = exchanges.length ? exchanges.map((s) => sourceCard(s, sources)).join("") : '<p class="empty">ჯერ მონაცემები არ არის — მალე განახლდება.</p>';

    bindCalculators();
  } catch (e) {
    document.getElementById("banks").innerHTML = '<p class="empty">კურსების ჩატვირთვა ვერ მოხერხდა. სცადე გვერდის განახლება.</p>';
  }
}

init();
