#!/usr/bin/env node
/*
  CardComp price ingest  —  TCGCSV  ->  prices.json      (Node 18+, NO dependencies)

  WHY: the browser can't fetch TCGCSV (CORS). So this pulls it once, builds a
       tiny static index, and you deploy that file next to cardcomp_poc.html.
       Same-origin = no CORS, no API, instant prices.

  RUN:
     1.  node ingest.js                 -> writes ./prices.json
     2.  put prices.json in the SAME folder as cardcomp_poc.html
     3.  deploy that folder to Netlify (drag-drop or your usual way)
     Re-run whenever you want fresh prices (prices move slowly; a refresh
     every few days, or before a big stream, is plenty).

  It prints a set -> TCGCSV group report. If any row says CHECK/NONE, copy the
  correct group name from the printed list into OVERRIDE below and re-run.
*/
const fs = require("fs");
const BASE = "https://tcgcsv.com/tcgplayer";
const CATEGORY = 3;                                  // 3 = Pokemon
const UA = "CardComp-Ingest/1.0 (East Bay Trader)";  // TCGCSV asks for a custom UA
const SLEEP = 120;                                   // be a good neighbor (~100ms)

// (pokemontcg set id, set name). The set id prefixes every card id (swsh12-139),
// so keying the index "{set id}-{number}" lines up with the app's card.id.
const SETS = [
  ["base1","Base"],["base2","Jungle"],["base3","Fossil"],["base4","Base Set 2"],
  ["base5","Team Rocket"],["base6","Legendary Collection"],["gym1","Gym Heroes"],
  ["gym2","Gym Challenge"],["neo1","Neo Genesis"],["neo4","Neo Destiny"],
  ["ex7","Team Rocket Returns"],["ex11","Delta Species"],["ex13","Holon Phantoms"],
  ["xy3","Furious Fists"],["g1","Generations"],["xy12","Evolutions"],
  ["sv3pt5","151"],["sv6","Twilight Masquerade"],["sv6pt5","Shrouded Fable"],
  ["sv8","Surging Sparks"],["sv8pt5","Prismatic Evolutions"],["sv9","Journey Together"],
  ["sv10","Destined Rivals"],["swsh12","Silver Tempest"],
  ["svp","Scarlet & Violet Black Star Promos"],["me4","Chaos Rising"],
  ["me2pt5","Ascended Heroes"],
];

// Force a set to a specific TCGCSV group name if the auto-match is wrong:
//   "ptcg_set_id": "EXACT TCGCSV group name"   (copy from the printed report)
const OVERRIDE = {
  "base1": "Base Set",
  "base4": "Base Set 2",
  "svp": "SV: Scarlet & Violet Promo Cards",   // <- example; fill in after first run
};

const norm = s => (s||"").toLowerCase().replace(/[^a-z0-9]/g,"");
const setTail = n => { const p = n.split(/:\s|\s-\s/); return p[p.length-1].trim(); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function score(our, g){
  const a = norm(our), tail = norm(setTail(g.name)), full = norm(g.name);
  if (a === tail) return 100;
  if (tail.endsWith(a) || full.endsWith(a)) return 80;
  if (a && (tail.includes(a) || full.includes(a))) return 60;
  if (tail && a.includes(tail)) return 50;
  const at = new Set((our.toLowerCase().match(/[a-z0-9]+/g)) || []);
  const gt = new Set((g.name.toLowerCase().match(/[a-z0-9]+/g)) || []);
  if (at.size && gt.size){
    let inter = 0; at.forEach(x => { if (gt.has(x)) inter++; });
    const uni = new Set([...at, ...gt]).size;
    return Math.round(inter / uni * 40);
  }
  return 0;
}

async function getJSON(url){
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

function resolveGroups(groups){
  const byName = {}; groups.forEach(g => byName[g.name] = g);
  const map = {};
  console.log("\n  set id    our name                          -> TCGCSV group (id)                  conf");
  console.log("  " + "-".repeat(94));
  for (const [sid, name] of SETS){
    let g, conf;
    if (OVERRIDE[sid] && byName[OVERRIDE[sid]]) { g = byName[OVERRIDE[sid]]; conf = "OVERRIDE"; }
    else {
      let best = groups[0], sc = -1;
      for (const cand of groups){ const s = score(name, cand); if (s > sc){ sc = s; best = cand; } }
      g = sc >= 35 ? best : null;                          // refuse weak matches, don't mis-map
      conf = g ? (sc >= 80 ? "high" : sc >= 50 ? "MED" : "LOW") : "NONE";
    }
    map[sid] = g;
    const gtxt = g ? `${g.name} (${g.groupId})` : "— no match —";
    const flag = (conf === "high" || conf === "OVERRIDE") ? "" : "   <-- CHECK / add to OVERRIDE";
    console.log(`  ${sid.padEnd(9)} ${name.padEnd(33)} -> ${gtxt.padEnd(36)} ${conf}${flag}`);
  }
  return map;
}

(async () => {
  let updated;
  try { updated = (await (await fetch("https://tcgcsv.com/last-updated.txt", { headers: { "User-Agent": UA } })).text()).trim(); }
  catch { updated = new Date().toISOString(); }
  console.log("TCGCSV last updated:", updated);

  const groups = (await getJSON(`${BASE}/${CATEGORY}/groups`)).results;
  console.log(`Fetched ${groups.length} Pokemon groups.`);
  const map = resolveGroups(groups);

  const prices = {};
  let matched = 0, unmatchedSets = 0;
  for (const [sid, g] of Object.entries(map)){
    if (!g) { unmatchedSets++; continue; }
    const gid = g.groupId;
    let products, priceRows;
    try {
      products  = (await getJSON(`${BASE}/${CATEGORY}/${gid}/products`)).results; await sleep(SLEEP);
      priceRows = (await getJSON(`${BASE}/${CATEGORY}/${gid}/prices`)).results;   await sleep(SLEEP);
    } catch (e) { console.log(`  ! ${sid} group ${gid}: ${e.message}`); continue; }

    const pmap = {};                                   // productId -> {subTypeName: market}
    for (const row of priceRows){
      let m = row.marketPrice; if (m == null) m = row.midPrice; if (m == null) continue;
      (pmap[row.productId] || (pmap[row.productId] = {}))[row.subTypeName] = Math.round(m * 100) / 100;
    }
    for (const p of products){
      const ext = {}; (p.extendedData || []).forEach(d => ext[d.name] = d.value);
      if (!("Number" in ext)) continue;                // sealed product, not a card
      const num = String(ext.Number).split("/")[0].trim(); if (!num) continue;
      const pr = pmap[p.productId]; if (!pr) continue;
      prices[`${sid}-${num}`] = pr; matched++;
    }
  }

  const out = { updated, source: "tcgcsv.com", prices };
  fs.writeFileSync("prices.json", JSON.stringify(out));
  console.log(`\nWrote prices.json — ${matched} priced cards across ${SETS.length - unmatchedSets}/${SETS.length} sets (${Math.round(JSON.stringify(out).length / 1024)} KB).`);
  if (unmatchedSets) console.log(`  ${unmatchedSets} set(s) unmatched — see report above, add to OVERRIDE, re-run.`);
})();
