// Reference implementation of the Pull Sheet pricing engine (Pricing tab + era/Direct rules in column Q), for CardComp.
// Mirrors PricingEngine.gs (columns H..S) and eraQFormula_ in "Pull Sheet Sorter v4.gs". Pure function, no I/O.
//
// card: { market, cond, lang = "EN", era = "other", copies = 1, cheapest = null (cheapest listing, on your terms),
//         directLow = null, mine = false (the Direct Low is your own listing), current = null (your current price),
//         ceiling = null (remembered next Direct seller), daysUnsold = null, cost = null }
// S: settings in the shape of pricing-settings.snapshot.json
function upTo(table, v) {              // "market up to $X" tiers: smallest bound >= v
  const t = table.filter(r => r[0] !== "" && r[0] != null).sort((a, b) => a[0] - b[0]);
  for (const [b, x] of t) if (v <= b) return x;
  return t.length ? t[t.length - 1][1] : 1;
}
function from(table, v) {              // "copies from N" tiers: largest bound <= v
  let x = 1;
  for (const [b, y] of table.filter(r => r[0] !== "" && r[0] != null).sort((a, b) => a[0] - b[0])) if (v >= b) x = y;
  return x;
}
function snap(p, S) {
  const sp = Math.round(p * 100) / 100, sk = Math.floor(sp) - 0.01;
  let out = sp;
  if (sp >= 5 && sp <= S.setting.snap5_to) out = 4.99;
  else if (sp >= 50 && sp <= S.setting.snap50_to) out = 49.99;
  else if (sk < sp && sp - sk <= sp * S.setting.charm + 1e-9) out = sk;
  return Math.round(out * 100) / 100;
}
function listPrice(card, S) {
  const st = S.setting, m = card.market || 0, copies = card.copies || 1;
  const nmlp = /^(near mint|lightly played)/i.test(card.cond || "");
  const steps = [];
  // 1. route
  if (!(m > 0)) return { price: card.current, route: "no market", steps };
  if (m <= st.floor_at) { const p = snap(st.floor_price * from(S.floor_copies, copies), S); return { price: p, route: "floor", steps }; }
  // 2. base: market x markup x copies, at least the cheapest listing (your terms) x copies
  const mk = upTo(S.markup, m), cp = from(S.copies, copies);
  const cheap = card.cheapest || 0;
  const base = Math.max(m * mk * cp, cheap * (st.low_markup ? mk : 1) * cp);
  steps.push(["base", base]);
  // 3-4. language, era (NM/LP, market >= era_from) or the MP-and-below table
  const lang = 1 + ((S.lang[card.lang || "EN"] || {}).adjust || 0);
  const era = nmlp && m >= st.era_from ? (S.era[card.era || "other"] ?? 1) : 1;
  const nd = nmlp ? 1 : Math.max(m * upTo(S.nd_markup, m), cheap) * cp / base;
  let price = base * lang * era * nd;
  steps.push(["lang x era (or MP table)", price]);
  // 5. Direct: only ever raises
  if (nmlp) {
    const cap = m * st.dl_cap_x + st.dl_cap_add, dl = card.directLow || 0;
    if (dl > 0 && card.mine && m >= st.own_from) {
      let t = st.own_probe > 0 ? cap : card.current;
      if (card.ceiling > 0) t = card.ceiling - 0.01 <= card.current ? card.current : Math.min(t, card.ceiling - 0.01);
      price = Math.max(price, Math.min(t, cap));
    } else if (dl > 0 && !card.mine && m >= st.dl_from) {
      price = Math.max(price, Math.min(dl - 0.01, cap));
    }
    steps.push(["Direct", price]);
  }
  // 6. markdown (off while md_days is blank), then rounding
  const L = S.lang[card.lang || "EN"] || {};
  if (L.md_days != null && card.daysUnsold >= L.md_days && base >= st.md_min) {
    const md = Math.min((Math.floor((card.daysUnsold - L.md_days) / 7) + 1) * (L.md_week || 0), L.md_max || 0);
    const floor = Math.max(m * st.md_floor, (card.cost || 0) * st.cost_x);
    price = Math.max(price * (1 - md), Math.min(price, floor));
  }
  return { price: snap(price, S), route: "priced", steps };
}
if (typeof module !== "undefined") module.exports = { listPrice, snap, upTo, from };
