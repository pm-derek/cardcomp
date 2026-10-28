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
// Relay for CardComp's own TCGplayer requests (Chinese copy prices, index.html zhLookup): the page cannot call
// TCGplayer's data services itself (cross-site), the extension can. Only the listings search and the latest sales of one product.
const TCG_POST_OK = /^https:\/\/(mp-search-api\.tcgplayer\.com\/v1\/product\/\d+\/listings|mpapi\.tcgplayer\.com\/v2\/product\/\d+\/latestsales)$/;
async function tcgPostRelay(msg) {
  if (!TCG_POST_OK.test(String(msg.url || ""))) return { ok: false, err: "not a TCGplayer listings address" };
  try { return { ok: true, j: await tcgJson(msg.url, msg.body || {}) }; } catch (e) { return { ok: false, err: e.message }; }
}
if (typeof module !== "undefined" && module.exports) module.exports = { tcgFast, tcgPostRelay };
