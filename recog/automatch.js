// CardComp auto-recognition, step 2: turn a model's reading of the card on stream into search candidates.
// EXPERIMENT (docs/auto-recognition-handoff.md). Manual search never calls this. To remove the whole
// feature: node scripts/strip-recog.js (deletes this folder and every line tagged RECOG).
//
// autoMatch({name, number, total, language, rarity, set}) ->
//   { kind, strength, suggestion, cards, note, why }
//   kind:      "exact"   name + number found (one printing)
//              "near"    name found, number off by one digit (a misread 161 for 162)
//              "unique"  no number, but name (+ rarity) leaves one printing
//              "ambiguous" several printings fit: Derek picks (Mew ex, Time-Space Distortion packs)
//              "number-miss" name found, but no printing has that number: likely under the $1.50 floor
//              "none"    no printing of that name in the catalog
//   strength:  "strong" (exact name + exact number, set total fits if read), "weak" (best guess), or null
//   cards:     the candidates, best first, like a normal search would list them (max 16)
// Rules (from the 20-frame test, 2026-10-16):
//   - never the "closest by name" fallback: a different Pokemon with the same number is never a candidate
//   - a number that matches nothing removes the suggestion (Kyurem ex 157 is under the floor; SIR #165 is not it)
//   - rarity is a tie-break, never a filter, and a premium read (SIR / UR / full art) cannot pick a printing
//     that costs 5x+ the cheapest other candidate (Garchomp UR $4 vs SIR $185; Jellicent UR vs SIR)
(function () {
  const MECH = new Set(["ex", "v", "vmax", "vstar", "gx", "break", "lv", "prime", "star", "legend", "tag"]);
  const QUAL = /\b(prime|lv x|lvx|legend|star|break|holo|full art|alt art)\b/g;
  const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const depad = s => String(s == null ? "" : s).toLowerCase().trim().replace(/^0+(?=\d)/, "");
  const price = c => (typeof bestMarket === "function" ? bestMarket(c) : 0) || 0;

  function cardTier(r) {
    r = String(r || "").toLowerCase();
    if (/special (illustration|art)|ultra|secret|rainbow|hyper|super rare$|character super|character rare|futuristic|trainer gallery|mega.?attack|black white rare/.test(r)) return "premium";
    if (/^(illustration rare|art rare)$/.test(r)) return "ir";
    if (/^(common|uncommon|rare|double rare|triple rare|holo rare|rare holo|ace spec|shiny rare|rare shiny|classic collection|common holo)/.test(r)) return "plain";
    return null;   // Promo, None, Radiant, Shining, Prime, Amazing...: the rarity says nothing about the treatment
  }
  function readTier(s) {
    s = String(s || "").toLowerCase();
    if (!s || /prime|radiant|shining|amazing|promo/.test(s)) return null;
    if (/special|\bsir\b|\bsar\b|hyper|secret|gold|rainbow|full ?art|alt(ernate)? art|ultra|\bur\b|\bsr\b|futuristic/.test(s)) return "premium";
    if (/illustration|art rare|\bir\b|\bar\b/.test(s)) return "ir";
    if (/common|uncommon|rare|holo|double|trainer/.test(s)) return "plain";
    return null;
  }
  function editDist(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 9;
    const d = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = d[0]; d[0] = i;
      for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
    }
    return d[b.length];
  }

  // Cards of that name. level 1 = name as read, 2 = without a qualifier (Ursaring Prime -> Ursaring),
  // 3 = every word read is in the name (Time Distortion -> Time Space Distortion), 4 = one or two letters off.
  function byName(name, lang) {
    const pool = CARDS.filter(c => (c.game || "pkmn") === "pkmn" && (c.lang || "en") === lang && !c.sealed);
    const starts = q => pool.filter(c => {
      const n = norm(c.n);
      if (n === q) return true;
      if (!n.startsWith(q + " ")) return false;
      return !MECH.has(n.slice(q.length + 1).split(" ")[0]);   // "mew" must not take "mew ex"
    });
    const q = norm(name);
    if (!q) return { level: 0, cards: [] };
    let cards = starts(q);
    if (cards.length) return { level: 1, cards };
    const q2 = q.replace(QUAL, " ").replace(/\s+/g, " ").trim();
    if (q2 && q2 !== q) { cards = starts(q2); if (cards.length) return { level: 2, cards }; }
    const toks = q.split(" ").filter(t => t.length > 1);
    if (toks.length > 1) {
      cards = pool.filter(c => { const ct = norm(c.n).split(" "); return ct[0] === toks[0] && toks.every(t => ct.includes(t)); });
      if (cards.length) return { level: 3, cards };
    }
    if (q.length >= 6) {
      const k = q.split(" ").length;
      cards = pool.filter(c => editDist(q, norm(c.n).split(" ").slice(0, k).join(" ")) <= 2);
      if (cards.length) return { level: 4, cards };
    }
    return { level: 0, cards: [] };
  }

  function autoMatch(read) {
    read = read || {};
    const lang = String(read.language || "").toLowerCase() === "jp" ? "jp" : "en";
    const why = [];
    const nm = byName(read.name, lang);
    if (nm.level > 1) why.push("name matched loosely (level " + nm.level + ")");
    if (!nm.cards.length) return { kind: "none", strength: null, suggestion: null, cards: [], note: "no " + (read.name || "card") + " in the catalog (likely under $1.50)", why, lang };

    const num = depad(read.number), total = parseInt(read.total, 10) || 0;
    const rt = readTier(read.rarity), setQ = norm(read.set);
    const isNum = c => num && depad(c.num) === num;
    const isNear = c => num && /^\d+$/.test(num) && /^\d+$/.test(depad(c.num)) && Math.abs(+depad(c.num) - +num) === 1;
    const totalOK = c => total && (SET_SIZE[c.s] || []).includes(total);
    const tierOK = c => rt && cardTier(c.r) === rt;
    const setOK = c => setQ && setQ.length > 2 && (norm(c.s).includes(setQ) || setQ.includes(norm(c.s)));
    const score = c => (isNum(c) ? 100 : 0) + (isNear(c) ? 50 : 0) + (tierOK(c) ? 10 : 0) + (totalOK(c) ? 4 : 0) + (setOK(c) ? 2 : 0);
    const cards = nm.cards.slice().sort((a, b) => (score(b) - score(a)) || ((b.y || 0) - (a.y || 0)) || ((b.o || 0) - (a.o || 0))).slice(0, 16);
    const out = (kind, strength, sug, note) => ({ kind, strength, suggestion: sug ? sug.id : null, cards, note: note || "", why, lang });
    const nameSure = nm.level <= 2;

    if (num) {
      let ex = nm.cards.filter(isNum);
      if (ex.length > 1 && total) { const t = ex.filter(totalOK); if (t.length) ex = t; }
      if (ex.length === 1) {
        const sz = SET_SIZE[ex[0].s] || [];
        const clash = total && sz.length && !sz.includes(total);   // "063/090" but that set has 76 cards: a misread
        if (clash) why.push("set total " + total + " does not fit " + ex[0].s + " (" + sz.join("/") + ")");
        return out("exact", nameSure && !clash ? "strong" : "weak", ex[0]);
      }
      if (ex.length > 1) {
        const t = rt ? ex.filter(tierOK) : [];
        if (t.length === 1) { why.push("tie on number broken by rarity"); return out("exact", "weak", t[0]); }
        return out("ambiguous", null, null, ex.length + " printings with #" + read.number + ": pick one");
      }
      const near = nm.cards.filter(isNear);
      if (near.length === 1) { why.push("number off by one: read " + read.number + ", catalog " + near[0].num); return out("near", "weak", near[0]); }
      return out("number-miss", null, null, "no #" + read.number + " for " + nm.cards[0].n.replace(/\s+\d.*$/, "") + " in the catalog (likely under $1.50, or misread)");
    }
    if (nm.cards.length === 1) return out("unique", "weak", nm.cards[0], "no number read");
    if (rt) {
      const t = nm.cards.filter(tierOK);
      if (t.length === 1) {
        const others = nm.cards.filter(c => c !== t[0]).map(price).filter(p => p > 0);
        const cheapest = others.length ? Math.min(...others) : 0;
        if (rt === "premium" && cheapest > 0 && price(t[0]) >= 5 * cheapest) {
          why.push("premium read would pick a printing " + Math.round(price(t[0]) / cheapest) + "x the cheapest: no suggestion");
          return out("ambiguous", null, null, "several printings, no number read: pick one");
        }
        why.push("rarity '" + read.rarity + "' leaves one printing");
        return out("unique", "weak", t[0], "no number read");
      }
    }
    return out("ambiguous", null, null, nm.cards.length + " printings, no number read: pick one");
  }

  window.autoMatch = autoMatch;
  window.__recog = { norm, cardTier, readTier, byName };
})();
