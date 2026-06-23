#!/usr/bin/env node
/*
  CardComp ingest  ->  data.json        (Node 18+, NO dependencies)

  Builds ONE lean file the app loads: every Pokemon card worth bidding on
  (English + Japanese), each with its identity AND its TCGplayer prices baked in.

  Sources:
    - English identity (name/set/number/attacks/hp/image) : pokemon-tcg-data on GitHub
    - English prices                                       : TCGCSV  (category: Pokemon)
    - Japanese identity + prices                           : TCGCSV  (category: Pokemon Japan)

  Prune: a card is kept only if its best printing's market (or low) >= FLOOR.
  Set-agnostic and self-healing — a bulk card that spikes reappears next run.

  RUN:  node ingest.js     ->  writes ./data.json   (deploy beside index.html)
*/
const fs = require("fs");
const GH = "https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master";
const TC = "https://tcgcsv.com/tcgplayer";
const UA = "CardComp-Ingest/2.0 (East Bay Trader)";
const SLEEP = 120;
const FLOOR = 2.00;                 // keep only cards whose best printing >= this (USD)
const INCLUDE_JP = true;            // set false to skip Japanese

// Force an English set to a specific TCGCSV group if auto-match is wrong (see report):
const OVERRIDE = {
  "base1": "Base Set",
  "base4": "Base Set 2",
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => (s||"").toLowerCase().replace(/[^a-z0-9]/g,"");
const setTail = n => { const p = n.split(/:\s|\s-\s/); return p[p.length-1].trim(); };
const r2 = c => c == null ? null : Math.round(c * 100) / 100;

async function getJSON(url){
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error("HTTP " + res.status + " " + url);
  return res.json();
}
async function getText(url){
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  return (await res.text()).trim();
}

const GENERIC = new Set(["base","set","the","and","of","cards","series","pokemon","tcg"]);
const toks = s => (s.toLowerCase().match(/[a-z0-9]+/g)) || [];
function score(name, g){
  const Q = toks(name);
  const tailT = toks(setTail(g.name));
  // all of the set name's words appear in the group's set-name portion?
  if (Q.length && Q.every(t => tailT.includes(t))){
    const extra = tailT.filter(t => !Q.includes(t) && !GENERIC.has(t)); // distinctive extras = a DIFFERENT set
    if (extra.length === 0) return 100;   // the base/exact set
    if (extra.length === 1) return 70;
    return 50;
  }
  // fallbacks: whole-name substring, then token overlap
  if (norm(g.name).includes(norm(name))) return 45;
  const G = new Set(toks(g.name)); let i = 0; Q.forEach(t => { if (G.has(t)) i++; });
  return Q.length ? Math.round(i / Q.length * 40) : 0;
}

function priceMap(rows){            // productId -> {subTypeName: {m,l}}
  const pm = {};
  for (const row of rows){
    let m = row.marketPrice; if (m == null) m = row.midPrice;
    const l = row.lowPrice;
    if (m == null && l == null) continue;
    (pm[row.productId] || (pm[row.productId] = {}))[row.subTypeName] = { m: r2(m), l: r2(l) };
  }
  return pm;
}
function bestPrice(px){
  let best = 0;
  for (const k in px){ const v = px[k]; const p = (v.m != null ? v.m : v.l) || 0; if (p > best) best = p; }
  return best;
}
function num0(s){
  let n = String(s).split("/")[0].trim().replace(/^SVP/i, "");
  if (/^\d+$/.test(n)) n = String(parseInt(n, 10));     // 029 -> 29
  return n;
}
async function categoryId(want){
  const cats = (await getJSON(`${TC}/categories`)).results || [];
  const hit = cats.find(c => (c.name||"").toLowerCase() === want.toLowerCase())
           || cats.find(c => (c.name||"").toLowerCase().includes(want.toLowerCase()));
  return hit ? hit.categoryId : null;
}

async function englishCards(){
  const sets = await getJSON(`${GH}/sets/en.json`);
  const byId = {}; const cards = [];
  for (const sm of sets){
    let raw; try { raw = await getJSON(`${GH}/cards/en/${sm.id}.json`); } catch { continue; }
    const year = parseInt((sm.releaseDate||"0").split("/")[0]) || 0;
    for (const c of raw){
      const atk = [...(c.attacks||[]), ...(c.abilities||[])].map(a => a.name||"").join(" ");
      const card = { id:c.id, n:c.name, s:sm.name, c:sm.ptcgoCode||"", y:year, num:c.number,
        r:c.rarity||"", hp:c.hp||"", t:c.types||[], st:c.subtypes||[],
        atk, img:(c.images||{}).small||"", lang:"en" };
      cards.push(card); byId[c.id] = card;
    }
  }
  console.log(`EN identity: ${cards.length} cards / ${sets.length} sets`);

  const cat = 3;
  const groups = (await getJSON(`${TC}/${cat}/groups`)).results;
  console.log("\n  EN set -> group  (only low/med-confidence matches shown)");
  for (const sm of sets){
    let g, conf;
    if (OVERRIDE[sm.id]) { g = groups.find(x => x.name === OVERRIDE[sm.id]); conf = "OVR"; }
    if (!g){ let best=groups[0], sc=-1; for (const x of groups){ const s=score(sm.name,x); if(s>sc){sc=s;best=x;} }
      g = sc >= 35 ? best : null; conf = g ? (sc>=80?"high":sc>=50?"med":"low") : "none"; }
    if (!g) continue;
    if (conf==="low"||conf==="med") console.log(`  ${sm.id} (${sm.name}) -> ${g.name} [${conf}]`);
    let products, prices;
    try {
      products = (await getJSON(`${TC}/${cat}/${g.groupId}/products`)).results; await sleep(SLEEP);
      prices   = (await getJSON(`${TC}/${cat}/${g.groupId}/prices`)).results;   await sleep(SLEEP);
    } catch { continue; }
    const pm = priceMap(prices);
    for (const p of products){
      const ext = {}; (p.extendedData||[]).forEach(d => ext[d.name] = d.value);
      if (!("Number" in ext)) continue;
      const card = byId[`${sm.id}-${num0(ext.Number)}`]; const px = pm[p.productId];
      if (card && px){ card.pid = p.productId; card.px = px; }
    }
  }
  return cards;
}

async function japaneseCards(){
  const cat = await categoryId("Pokemon Japan");
  if (!cat){ console.log("JP: category not found, skipping"); return []; }
  const groups = (await getJSON(`${TC}/${cat}/groups`)).results;
  console.log(`\nJP: category ${cat}, ${groups.length} sets`);
  const cards = [];
  for (const g of groups){
    let products, prices;
    try {
      products = (await getJSON(`${TC}/${cat}/${g.groupId}/products`)).results; await sleep(SLEEP);
      prices   = (await getJSON(`${TC}/${cat}/${g.groupId}/prices`)).results;   await sleep(SLEEP);
    } catch { continue; }
    const pm = priceMap(prices);
    for (const p of products){
      const ext = {}; (p.extendedData||[]).forEach(d => ext[d.name] = d.value);
      if (!("Number" in ext)) continue;
      const px = pm[p.productId]; if (!px) continue;
      cards.push({ id:`jp:${p.productId}`, n:p.cleanName||p.name, s:g.name, c:g.abbreviation||"",
        y:parseInt((g.publishedOn||"0").slice(0,4))||0, num:num0(ext.Number), r:ext.Rarity||"",
        hp:ext.HP||"", t:[], st:[], atk:"", img:p.imageUrl||"", lang:"jp", pid:p.productId, px });
    }
  }
  return cards;
}

(async () => {
  let updated; try { updated = await getText("https://tcgcsv.com/last-updated.txt"); } catch { updated = new Date().toISOString(); }
  console.log("TCGCSV last updated:", updated);

  let all = await englishCards();
  if (INCLUDE_JP) all = all.concat(await japaneseCards());

  const kept = all.filter(c => c.px && bestPrice(c.px) >= FLOOR);
  const en = kept.filter(c => c.lang === "en").length, jp = kept.length - en;

  const out = { updated, floor: FLOOR, cards: kept };
  fs.writeFileSync("data.json", JSON.stringify(out));
  console.log(`\nWrote data.json — ${kept.length} cards >= $${FLOOR} (EN ${en} / JP ${jp}) · ${Math.round(JSON.stringify(out).length/1048576*10)/10} MB`);
})();
