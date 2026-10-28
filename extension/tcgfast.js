// Fast TCGplayer read (Derek, 2026-10-23: "loading these on TCGplayer is slow"). Instead of loading the product page in
// a background tab and reading what it draws (several seconds; Chrome gives background tabs low priority), ask the same
// data services the page itself calls: the condition's market price (per SKU), the cheapest listing and how many are
// listed, and the recent sales of that condition and printing. Undocumented endpoints: every step is optional, and when
// no market price comes back CardComp falls back to the page read as before. Loaded by bg.js.
const TCG_FAST_COND = { NM: "Near Mint", LP: "Lightly Played", MP: "Moderately Played", HP: "Heavily Played", DMG: "Damaged" };
const tcgNorm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
async function tcgJson(url, body) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 5000);
  try {
    const r = await fetch(url, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal } : { signal: ctl.signal });
    if (!r.ok) throw new Error(new URL(url).host + " " + r.status);
    return await r.json();
  } catch (e) { throw new Error(e.name === "AbortError" ? new URL(url).host + " timed out" : e.message); }
  finally { clearTimeout(t); }
}
// Pull a list out of the shapes these services use ({data:[...]}, {results:[{results:[...]}]}, [...]).
const tcgList = (j) => Array.isArray(j) ? j : j && Array.isArray(j.data) ? j.data : j && Array.isArray(j.results) ? (j.results[0] && Array.isArray(j.results[0].results) ? j.results[0].results : j.results) : [];
const tcgPrintOK = (v, printing) => !printing || tcgNorm(v) === tcgNorm(printing);
const tcgEnglish = (l) => !l || /english/i.test(String(l)) || l === 1;

// One tap reads every condition of the printing (Derek, 2026-10-23: "1 tap to grab it all?"): the SKU list, the market
// price request and the sales request already cover all conditions, and one listings request (sorted cheapest first)
// is grouped by condition. Returns { conds: { NM: {market, low, listed, sales, salesN}, LP: {...}, ... } } plus the
// tapped condition's fields at the top level.
async function tcgFast(q) {
  const t0 = Date.now(), pid = String(q.pid || ""), printing = q.printing || "";
  const out = { pid, printing, cond: q.cond, fast: true, errs: [], conds: {} };
  if (!/^\d+$/.test(pid)) { out.errs.push("no product id"); return out; }
  const codeOf = (name) => Object.keys(TCG_FAST_COND).find((k) => tcgNorm(TCG_FAST_COND[k]) === tcgNorm(name));
  const slot = (c) => out.conds[c] = out.conds[c] || {};
  const step = async (name, fn) => { try { await fn(); } catch (e) { out.errs.push(name + ": " + e.message); } };
  await Promise.all([
    // 1. this printing's English SKUs (one per condition), then all their market prices in one request
    step("market", async () => {
      const d = await tcgJson(`https://mp-search-api.tcgplayer.com/v2/product/${pid}/details`);
      const skus = (d && (d.skus || (d.result && d.result.skus) || (d.results && d.results[0] && d.results[0].skus))) || [];
      const mine = skus.filter((x) => codeOf(x.condition) && tcgPrintOK(x.variant || x.printing, printing) && tcgEnglish(x.language))
        .map((x) => ({ sku: x.sku || x.skuId || x.id, cond: codeOf(x.condition) })).filter((x) => x.sku);
      if (!mine.length) throw new Error(`no SKUs for ${printing || "this printing"} (${skus.length} SKUs)`);
      const p = await tcgJson("https://mpgateway.tcgplayer.com/v1/pricepoints/marketprice/skus/search", { skuIds: mine.map((x) => +x.sku) });
      const rows = tcgList(p);
      for (const x of mine) { const r = rows.find((y) => String(y.skuId) === String(x.sku)); if (r && +r.marketPrice > 0) slot(x.cond).market = +r.marketPrice; }
      if (!Object.values(out.conds).some((c) => c.market > 0)) throw new Error("no market prices for " + mine.length + " SKUs");
    }),
    // 2. listings of this printing, cheapest first: the cheapest and a count per condition
    step("listings", async () => {
      const term = { sellerStatus: "Live", channelId: 0, language: ["English"] };
      if (printing) term.printing = [printing];
      const l = await tcgJson(`https://mp-search-api.tcgplayer.com/v1/product/${pid}/listings`, { filters: { term, range: { quantity: { gte: 1 } }, exclude: { channelExclusion: 0 } },
        from: 0, size: 50, sort: { field: "price+shipping", order: "asc" }, context: { shippingCountry: "US", cart: {} }, aggregations: ["listingType"] });
      const rows = tcgList(l).filter((x) => tcgPrintOK(x.printing || x.variant, printing));
      for (const x of rows) {
        const c = codeOf(x.condition), v = +x.price; if (!c || !(v > 0)) continue;
        const o = slot(c); o.listed = (o.listed || 0) + 1; if (!(o.low > 0) || v < o.low) o.low = v;
      }
      out.listMore = rows.length >= 50;   // counts are "50+" style when the page is full
    }),
    // 3. recent sales of this printing, newest first, per condition
    step("sales", async () => {
      const s = await tcgJson(`https://mpapi.tcgplayer.com/v2/product/${pid}/latestsales`, { conditions: [], languages: [1], variants: [], listingType: "All", limit: 25, offset: 0 });
      const all = tcgList(s), at = (x) => Date.parse(x.orderDate || x.date || "");
      out.salesSeen = all.length;
      for (const x of all) {
        const c = codeOf(x.condition), p = +x.purchasePrice, t = at(x);
        if (!c || !(p > 0) || !(t > 0) || !tcgPrintOK(x.variant || x.printing, printing) || !tcgEnglish(x.language)) continue;
        const o = slot(c); (o.sales = o.sales || []).push({ p, at: t });
      }
      for (const c in out.conds) { const o = out.conds[c]; if (o.sales) { o.sales.sort((a, b) => b.at - a.at); o.salesN = o.sales.length; o.sales = o.sales.slice(0, 5); } }
    }),
  ]);
  Object.assign(out, out.conds[q.cond] || {});   // the tapped condition, at the top level
  out.ms = Date.now() - t0;
  return out;
}
// Chinese card on stream (Derek, 2026-10-28: "detect that it's Chinese, then find the lowest listed that has Chinese in
// its title"). TCGplayer has no Chinese Pokemon catalog; sellers put Chinese copies on the English product as listings
// with photos, the title saying "Chinese". For each English printing the reading could be (q.cands: [{id, pid}], up to 8),
// read the cheapest listings in any language, and when the first page shows other languages or photo listings, ask for
// those too. A listing counts when its title / description / language says Chinese. Undocumented fields: the reply
// carries what each product returned (counts, languages, listing types, field names) so the first live run can be checked.
const ZH_RX = /chinese|中文|简体|簡體|繁体|繁體|\b[st]?-?chn\b|\bcn\b|\bs-?chinese|\bt-?chinese/i;
const tcgAggs = (j) => { const r = j && Array.isArray(j.results) && j.results[0]; const a = (r && r.aggregations) || (j && j.aggregations) || {};
  const vals = (k) => (Array.isArray(a[k]) ? a[k] : []).map((x) => ({ v: String(x.value != null ? x.value : x.key != null ? x.key : x.name || ""), n: +(x.count != null ? x.count : x.docCount) || 0 }));
  return { lang: vals("language"), type: vals("listingType") }; };
async function tcgChinese(q) {
  const t0 = Date.now(), out = { ok: true, hits: [], checked: 0, errs: [], dbg: [] };
  const cands = (q.cands || []).filter((c) => /^\d+$/.test(String(c.pid || ""))).slice(0, 8);
  const body = (term) => ({ filters: { term: Object.assign({ sellerStatus: "Live", channelId: 0 }, term), range: { quantity: { gte: 1 } }, exclude: { channelExclusion: 0 } },
    from: 0, size: 50, sort: { field: "price+shipping", order: "asc" }, context: { shippingCountry: "US", cart: {} }, aggregations: ["listingType", "language"] });
  await Promise.all(cands.map(async (c) => {
    const url = `https://mp-search-api.tcgplayer.com/v1/product/${c.pid}/listings`, rows = [], d = { pid: c.pid };
    try {
      const j = await tcgJson(url, body({})), ag = tcgAggs(j);
      rows.push(...tcgList(j));
      d.rows = rows.length; d.lang = ag.lang; d.type = ag.type; d.keys = rows[0] ? Object.keys(rows[0]).slice(0, 40) : [];
      const zhLang = ag.lang.filter((x) => ZH_RX.test(x.v) && x.n > 0).map((x) => x.v);
      const more = [];
      if (zhLang.length) more.push(tcgJson(url, body({ language: zhLang })));
      if (ag.type.some((x) => /custom/i.test(x.v) && x.n > 0)) more.push(tcgJson(url, body({ listingType: ["custom"] })));
      for (const r of await Promise.allSettled(more)) { if (r.status === "fulfilled") rows.push(...tcgList(r.value)); else out.errs.push(c.pid + ": " + r.reason.message); }
      out.checked++;
    } catch (e) { out.errs.push(c.pid + ": " + e.message); }
    const seen = new Set();
    for (const x of rows) {
      const k = x.listingId || x.customListingId || JSON.stringify([x.sellerKey, x.price, x.condition]); if (seen.has(k)) continue; seen.add(k);
      const cd = x.customData || {}, title = cd.title || x.title || x.listingTitle || "";
      const text = [title, cd.description, x.description, x.language, x.languageAbbreviation].filter(Boolean).join(" ");
      const p = +x.price; if (!(p > 0) || !ZH_RX.test(text)) continue;
      out.hits.push({ id: c.id, pid: String(c.pid), p, ship: +x.shippingPrice || 0, cond: x.condition || "", lang: x.language || "", title: String(title || x.language || "").slice(0, 140),
        seller: x.sellerName || "", photo: !!(cd.title || /custom/i.test(x.listingType || "")), key: cd.linkId || x.customListingKey || "" });
    }
    d.zh = out.hits.filter((h) => h.pid === String(c.pid)).length;
    out.dbg.push(d);
  }));
  out.hits.sort((a, b) => a.p - b.p);
  if (cands.length && !out.checked) out.ok = false;
  out.ms = Date.now() - t0;
  return out;
}
if (typeof module !== "undefined" && module.exports) module.exports = { tcgFast, tcgChinese };
