#!/usr/bin/env python3
"""
Gacvla scraper — fetches currency buy/sell rates from Georgian banks and
exchange offices and writes rates.json (per-1 GEL, buy/sell).

Rules (project standing rules):
- Only public, keyless, free endpoints. NO API keys, NO secrets, NO personal data.
- If a source fails, keep its last known rates (never delete, never invent).
- Credo Bank has no keyless feed — it is intentionally omitted.
- All rates are normalized to GEL per 1 unit of foreign currency.
"""
import json
import re
import sys
from datetime import datetime, timezone

import requests
from bs4 import BeautifulSoup

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"}
WANTED = ["USD", "EUR", "GBP", "RUB", "TRY"]
RATES_PATH = "rates.json"


def now_iso():
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def parse_num(text):
    """Parse a number written with ',' or '.' decimals and spaces/thin spaces."""
    if text is None:
        return None
    t = str(text).strip().replace("\u00a0", "").replace(" ", "").replace(",", ".")
    t = re.sub(r"[^0-9.\-]", "", t)
    try:
        return float(t) if t not in ("", "-", ".") else None
    except ValueError:
        return None


def sanity(code, value):
    """Plausibility guard for per-1 GEL rates. Returns value or None."""
    if value is None or value <= 0:
        return None
    ranges = {"USD": (1.0, 5.0), "EUR": (1.0, 6.0), "GBP": (1.0, 7.0),
              "RUB": (0.005, 0.2), "TRY": (0.01, 0.3)}
    lo, hi = ranges.get(code, (0.0001, 100.0))
    if lo <= value <= hi:
        return value
    # Common unit mistake: value quoted per 100 (or 1000) instead of per 1.
    for div in (100, 1000):
        if lo <= value / div <= hi:
            return value / div
    return None


def clean_rates(raw):
    """raw: {CODE: {'buy': x, 'sell': y}} -> sanity-checked, WANTED only."""
    out = {}
    for code, pair in (raw or {}).items():
        code = "RUR" if code == "RUR" else code
        if code not in WANTED:
            continue
        buy = sanity(code, parse_num(pair.get("buy")) if isinstance(pair, dict) else None)
        sell = sanity(code, parse_num(pair.get("sell")) if isinstance(pair, dict) else None)
        if buy is not None or sell is not None:
            out[code] = {"buy": round(buy, 4) if buy is not None else None,
                         "sell": round(sell, 4) if sell is not None else None}
    return out


def fetch_nbg():
    url = "https://nbg.gov.ge/gw/api/ct/monetarypolicy/currencies/en/json/"
    r = requests.get(url, timeout=20)
    r.raise_for_status()
    data = r.json()
    items = data[0]["currencies"] if isinstance(data, list) else data.get("currencies", [])
    rates, date = {}, None
    for c in items:
        if c.get("code") in WANTED and c.get("rate") and c.get("quantity"):
            rates[c["code"]] = c["rate"] / c["quantity"]
        date = c.get("date", date)
    return {"date": (data[0].get("date", "")[:10] if isinstance(data, list) else date),
            "rates": rates}


def fetch_kursi():
    """kursi.ge public API: Kursi's own rates + TBC + BoG bankRates in one call."""
    url = "https://api-core.kursi.ge/api/public/currencies"
    r = requests.get(url, headers=UA, timeout=20)
    r.raise_for_status()
    kursi, tbc, bog = {}, {}, {}
    for it in r.json():
        if it.get("baseCurrencyCode") != "GEL":
            continue
        code = it.get("secondaryCurrencyCode")
        if code not in WANTED:
            continue
        kursi[code] = {"buy": it.get("buyRate"), "sell": it.get("sellRate")}
        br = it.get("bankRates") or {}
        if isinstance(br.get("TBC"), dict):
            tbc[code] = {"buy": br["TBC"].get("buyRate"), "sell": br["TBC"].get("sellRate")}
        if isinstance(br.get("BOG"), dict):
            bog[code] = {"buy": br["BOG"].get("buyRate"), "sell": br["BOG"].get("sellRate")}
    return clean_rates(kursi), clean_rates(tbc), clean_rates(bog)


def fetch_bog_direct():
    """Bank of Georgia public API (no key, documented). One call per currency."""
    out = {}
    for code in WANTED:
        try:
            r = requests.get(f"https://api.businessonline.ge/api/rates/commercial/{code}",
                             headers=UA, timeout=20)
            if r.status_code == 200:
                d = r.json()
                out[code] = {"buy": d.get("Buy"), "sell": d.get("Sell")}
        except Exception as e:
            print(f"  BoG {code} failed: {e}", file=sys.stderr)
    return clean_rates(out)


def fetch_valuto():
    url = "https://valuto.ge/wp-json/rest-currency-list/v3/currencies"
    r = requests.get(url, headers=UA, timeout=20)
    r.raise_for_status()
    out = {}
    for v in r.json()["data"]["currencies"].values():
        if v.get("CcTo") != "GEL":
            continue
        code = "RUB" if v.get("CcFrom") == "RUR" else v.get("CcFrom")
        out[code] = {"buy": v.get("buy"), "sell": v.get("sell")}
    return clean_rates(out)


def fetch_basisbank():
    url = "https://static.bb.ge/api/view/bb/websiteXrates"
    last_err = None
    for _ in range(2):  # one retry: the endpoint sometimes times out once
        try:
            r = requests.post(url, json={}, headers=UA, timeout=30)
            r.raise_for_status()
            break
        except Exception as e:
            last_err = e
    else:
        raise last_err
    arr = r.json()
    x = json.loads(arr[0]["xrates"])
    out = {}
    for code in ("USD", "EUR", "GBP", "RUR"):
        c = "RUB" if code == "RUR" else code
        out[c] = {"buy": x.get("kursBuy", {}).get(code),
                  "sell": x.get("kursSell", {}).get(code)}
    return clean_rates(out)


def fetch_liberty():
    """Static HTML homepage, Commercial column (first quote column)."""
    r = requests.get("https://www.libertybank.ge/ka/", headers=UA, timeout=20)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    block = soup.select_one(".currency-rates")
    if not block:
        raise ValueError("currency-rates block not found")
    out = {}
    for item in block.select(".js-homepage__currency-item"):
        name_el = item.select_one(".currency-rates__currency-name")
        desc_el = item.select_one(".currency-rates__currency-description")
        if not name_el:
            continue
        code = name_el.get_text(strip=True).upper()
        if code not in WANTED:
            continue
        unit = parse_num(desc_el.get_text()) if desc_el else 1
        unit = unit or 1
        vals = [parse_num(el.get_text()) for el in item.select(".currency-rates__currency")]
        # order: [official, commercial buy, commercial sell, internet buy, internet sell, ...]
        if len(vals) >= 3 and vals[1] is not None and vals[2] is not None:
            out[code] = {"buy": vals[1] / unit, "sell": vals[2] / unit}
    return clean_rates(out)


def fetch_procredit():
    """Static HTML; each currency is article.exchange-item with a flag img
    and a 'buy sell' number pair (order: USA, EU, UK, TUR, CHE)."""
    r = requests.get("https://www.procreditbank.ge/en/exchange", headers=UA, timeout=20)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    flags = {"USA.svg": "USD", "EU.svg": "EUR", "UK.svg": "GBP", "TUR.svg": "TRY"}
    out = {}
    for article in soup.select("article.exchange-item"):
        img = article.find("img")
        src = img.get("src", "") if img else ""
        code = next((c for f, c in flags.items() if f in src), None)
        if not code:
            continue
        nums = [parse_num(t) for t in re.findall(r"\d[\d\s]*[.,]\d{4}", article.get_text())]
        nums = [n for n in nums if n is not None and 0.001 < n < 10]
        if len(nums) >= 2:
            out[code] = {"buy": nums[0], "sell": nums[1]}
    return clean_rates(out)


def fetch_cartu():
    """Static HTML: div.currency-rates holds 'Currency Buy Sell Official'
    followed by rows like 'USD 2.5700 2.6200 2.5943' (card-transaction rates)."""
    r = requests.get("https://www.cartubank.ge/index.php?m=402&lng=eng", headers=UA, timeout=20)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    block = soup.select_one("div.currency-rates")
    if not block:
        raise ValueError("currency-rates block not found")
    out = {}
    text = block.get_text(" ", strip=True)
    for m in re.finditer(r"\b(USD|EUR|GBP|RUB|CHF)\s+([\d.,]+)\s+([\d.,]+)\s+([\d.,]+)", text):
        code = m.group(1)
        if code in WANTED:
            out[code] = {"buy": parse_num(m.group(2)), "sell": parse_num(m.group(3))}
    return clean_rates(out)


def fetch_halyk():
    r = requests.get("https://halykbank.ge/ka/individuals/currency", headers=UA, timeout=20)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    el = soup.find(id="currentexchangerate")
    if not el:
        raise ValueError("currentexchangerate element not found")
    out = {}
    for row in el.find_all("tr"):
        cells = [c.get_text(strip=True) for c in row.find_all(["td", "th"])]
        if len(cells) >= 3 and cells[0].upper() in WANTED:
            out[cells[0].upper()] = {"buy": parse_num(cells[1]), "sell": parse_num(cells[2])}
    return clean_rates(out)


def fetch_rico():
    r = requests.get("https://www.rico.ge/ka/", headers=UA, timeout=20)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    out = {}
    for row in soup.select(".currencies-table-body .currency-row"):
        code_el = row.select_one(".currency-info strong")
        unit_el = row.select_one(".currency-unit strong")
        if not code_el:
            continue
        code = code_el.get_text(strip=True).upper()
        if code == "RUR":
            code = "RUB"
        if code not in WANTED:
            continue
        unit = parse_num(unit_el.get_text()) if unit_el else 1
        unit = unit or 1
        rate_cells = row.select(".currency-rate")
        vals = []
        for cell in rate_cells:
            strong = cell.select_one("strong")
            vals.append(parse_num(strong.get_text()) if strong else parse_num(cell.get_text()))
        if len(vals) >= 2 and vals[0] is not None and vals[1] is not None:
            out[code] = {"buy": vals[0] / unit, "sell": vals[1] / unit}
    return clean_rates(out)


SOURCES = [
    # (id, name, type, url, fetcher, note)
    ("tbc", "თიბისი", "bank", "https://tbcbank.ge/ka/valutis-kursi",
     lambda ctx: ctx["tbc"], None),
    ("bog", "საქართველოს ბანკი", "bank", "https://bankofgeorgia.ge/ka/retail",
     lambda ctx: ctx["bog"], None),
    ("liberty", "ლიბერთი", "bank", "https://www.libertybank.ge/ka/",
     lambda ctx: fetch_liberty(), None),
    ("basisbank", "ბაზისბანკი", "bank", "https://basisbank.ge/",
     lambda ctx: fetch_basisbank(), None),
    ("procredit", "პროკრედიტი", "bank", "https://www.procreditbank.ge/en/exchange",
     lambda ctx: fetch_procredit(), None),
    ("cartu", "ქართუ", "bank", "https://www.cartubank.ge/index.php?m=402&lng=eng",
     lambda ctx: fetch_cartu(), "საბარათე კურსი — ფილიალის ნაღდი კურსისგან შეიძლება განსხვავდებოდეს."),
    ("halyk", "ჰალიკი", "bank", "https://halykbank.ge/ka/individuals/currency",
     lambda ctx: fetch_halyk(), None),
    ("rico", "რიკო კრედიტი", "exchange", "https://www.rico.ge/ka/",
     lambda ctx: fetch_rico(), None),
    ("valuto", "ვალუტო", "exchange", "https://valuto.ge/",
     lambda ctx: fetch_valuto(), None),
    ("kursi", "kursi.ge", "exchange", "https://kursi.ge/",
     lambda ctx: ctx["kursi"], None),
]


def main():
    try:
        with open(RATES_PATH, encoding="utf-8") as f:
            old = json.load(f)
    except Exception:
        old = {"nbg": {"date": None, "rates": {}}, "sources": [], "updated_at": None}
    old_sources = {s["id"]: s for s in old.get("sources", [])}

    ctx = {"tbc": {}, "bog": {}, "kursi": {}}
    nbg = old.get("nbg", {"date": None, "rates": {}})

    # NBG official (live API)
    try:
        nbg = fetch_nbg()
        print(f"NBG ok: {nbg['rates']}")
    except Exception as e:
        print(f"NBG failed: {e}", file=sys.stderr)

    # kursi.ge API gives Kursi + TBC + BoG in one call
    try:
        kursi, tbc, bog = fetch_kursi()
        ctx["kursi"], ctx["tbc"] = kursi, tbc
        if bog:
            ctx["bog"] = bog
        print(f"kursi.ge ok: kursi={kursi} tbc={tbc} bog={bog}")
    except Exception as e:
        print(f"kursi.ge failed: {e}", file=sys.stderr)

    # BoG direct API (primary for BoG; kursi's bankRates is fallback)
    try:
        direct = fetch_bog_direct()
        if direct:
            ctx["bog"] = direct
        print(f"BoG direct ok: {direct}")
    except Exception as e:
        print(f"BoG direct failed: {e}", file=sys.stderr)

    ts = now_iso()
    new_sources = []
    for sid, name, stype, url, fetcher, note in SOURCES:
        prev = old_sources.get(sid, {})
        try:
            rates = fetcher(ctx)
        except Exception as e:
            print(f"{sid} failed: {e}", file=sys.stderr)
            rates = {}
        if rates:
            entry = {"id": sid, "name": name, "type": stype, "url": url,
                     "updated_at": ts, "rates": rates}
            if note:
                entry["note"] = note
            new_sources.append(entry)
            print(f"{sid} ok: {rates}")
        elif prev.get("rates"):
            # keep last known rates, keep old timestamp (site marks it stale)
            new_sources.append(prev)
            print(f"{sid} kept old rates")
        else:
            print(f"{sid} has no rates at all — skipped", file=sys.stderr)

    out = {"nbg": nbg, "sources": new_sources, "updated_at": ts}
    with open(RATES_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"Wrote {RATES_PATH}: {len(new_sources)} sources")


if __name__ == "__main__":
    main()
