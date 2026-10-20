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
  const MECH = new Set(["ex", "v", "vmax", "vstar", "gx", "break", "lvx", "prime", "star", "legend", "tag"]);
  const QUAL = /\b(prime|lvx|legend|star|break|holo|full art|alt art)\b/g;
  const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, " ").trim().replace(/\blv x\b/g, "lvx");   // LV.X / LVX / Lv. X are one token
  const depad = s => String(s == null ? "" : s).toLowerCase().trim().replace(/^0+(?=\d)/, "");
  const price = c => (typeof bestMarket === "function" ? bestMarket(c) : 0) || 0;
  // A stamp on the card names its product line. Tests in order: the first one that matches a candidate wins.
  //   anniversary logos: 30th -> 30th Celebration (+ Classic Collection), 25th -> Celebrations; either one falls back to
  //     any anniversary reprint (the model has called the 30th logo "25th": Shining Celebi, live session 2)
  //   a set-logo stamp ("Prismatic Evolutions", "Journey Together", "Mega Evolution"): TCGplayer lists those stamped
  //     promos as their own products, "Flareon ex 014 131 Prismatic Evolutions Stamp" (154 in the catalog)
  //   Prerelease / Staff / Pokemon Center / Black Star promo marks
  const ANNIV = (c) => /celebration|30th|25th|classic collection/i.test(c.s);
  const STAMP_STOP = new Set(["logo", "stamp", "stamped", "mark", "set", "symbol", "the", "a", "an", "on", "card", "small", "pikachu", "pokemon", "promo", "anniversary", "edition"]);
  function stampTests(stamp) {
    const t = String(stamp || ""), out = [];
    if (!t.trim()) return out;
    if (/30th/i.test(t)) out.push((c) => /30th/i.test(c.s));
    if (/25th|celebrations/i.test(t)) out.push((c) => /celebrations|25th/i.test(c.s));
    if (/anniversary|30th|25th|celebration/i.test(t)) out.push(ANNIV);
    const words = norm(t).split(" ").filter((w) => w.length > 2 && !STAMP_STOP.has(w) && !/^\d+(st|th)?$/.test(w));
    if (words.length) out.push((c) => /\bstamp(ed)?\b/i.test(c.n) && words.some((w) => norm(c.n).split(" ").includes(w)));
    if (/prerelease/i.test(t)) out.push((c) => /prerelease/i.test(c.n));
    if (/\bstaff\b/i.test(t)) out.push((c) => /\bstaff\b/i.test(c.n));
    if (/pok[eé]mon center/i.test(t)) out.push((c) => /pok[eé]mon center/i.test(c.n + " " + c.s));
    if (/black star|\bpromo\b/i.test(t)) out.push((c) => /promo/i.test(c.s + " " + c.r));
    if (/stamp/i.test(t)) out.push((c) => /\bstamp(ed)?\b/i.test(c.n));   // "a stamp" of some kind: any stamped product
    return out;
  }
  const stampTest = (stamp) => { const ts = stampTests(stamp); return ts.length ? (c) => ts.some((f) => f(c)) : null; };

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

  // ctx (optional): { short: the frame's short edge in pixels, model: the model id that read it }. Small streams (720p) make numbers unreadable,
  // and Haiku then invents plausible ones (live test: 7 of 7 numbers on a 720p stream were wrong).
  function autoMatch(read, ctx) {
    read = read || {}; ctx = ctx || {};
    const rl = String(read.language || "").toLowerCase();
    // Chinese / Korean / other: the catalog is English and Japanese only (TCGplayer lists neither Chinese nor Korean).
    // Show the English printings for reference, never as the card: no suggestion, a loud note.
    const foreign = /^(zh|ko|other|chinese|korean)/.test(rl) ? (/^(zh|chinese)/.test(rl) ? "Chinese" : /^(ko|korean)/.test(rl) ? "Korean" : "Non-English") : "";
    if (foreign) {
      const en = autoMatch(Object.assign({}, read, { language: "en" }), ctx);
      return Object.assign(en, { kind: "foreign", foreign, strength: null, suggestion: null,
        note: foreign + " card: no " + foreign + " prices in CardComp. English printings below are for reference only, " + foreign + " usually sells for much less" });
    }
    const lang = rl === "jp" ? "jp" : "en";
    const why = [];
    const nm = byName(read.name, lang);
    if (nm.level > 1) why.push("name matched loosely (level " + nm.level + ")");
    if (!nm.cards.length) return { kind: "none", strength: null, suggestion: null, cards: [], note: "no " + (read.name || "card") + " in the catalog (likely under $1.50)", why, lang };

    let num = depad(read.number);
    const total = parseInt(read.total, 10) || 0, lowRes = ctx.short > 0 && ctx.short < 1000;
    // total fits: the set's printed size, or a standalone product that carries it in its name ("Flareon ex 014 131 ...")
    const totalOK = c => total && ((SET_SIZE[c.s] || []).includes(total) || new RegExp("\\b0*\\d+ 0*" + total + "\\b").test(norm(c.n)));
    // Off a small stream, a number whose total contradicts the catalog is a guess: ignore it. Either no set this
    // card is in has that many cards, or the card(s) with that number sit in a set of another size (Mew ex 232/191
    // read on a 720p stream: Paldean Fates #232 exists, but Paldean Fates has 91 cards).
    if (num && total && lowRes) {
      const sized = (c) => (SET_SIZE[c.s] || []).length > 0, withNum = nm.cards.filter(c => depad(c.num) === num);
      const noSet = nm.cards.some(sized) && !nm.cards.some(totalOK);
      const clashes = withNum.length && withNum.every(c => sized(c) && !totalOK(c));
      if (noSet || clashes) { why.push("number " + read.number + "/" + read.total + " ignored: the catalog has no such " + nm.cards[0].n.replace(/\s+\d.*$/, "")); num = ""; }
    }
    // Set guesses: Sonnet / Opus name the set well; Haiku's guesses were wrong often enough to pick a $1,300 Lugia.
    const trustSet = !/haiku/i.test(ctx.model || "");
    const rt = readTier(read.rarity), setQ = trustSet ? norm(read.set) : "", stampTs = stampTests(read.stamp), stampF = stampTs.length ? (c) => stampTs.some((f) => f(c)) : null;
    const rq = norm(read.rarity);
    const isNum = c => num && depad(c.num) === num;
    const isNear = c => num && /^\d+$/.test(num) && /^\d+$/.test(depad(c.num)) && Math.abs(+depad(c.num) - +num) === 1;
    const tierOK = c => rt && cardTier(c.r) === rt;
    // Exact rarity, or a longer rarity name inside the read of the same tier ("double rare" in "Double Rare holo").
    // Not a bare word: "illustration rare" contains "rare", which once picked a plain Rare Ninjask over its Art Rare (2026-10-20).
    const rarityOK = c => { const r = norm(c.r); return !!(rq && r && (r === rq || (r.length > 4 && rq.includes(r) && cardTier(c.r) === rt))); };
    const setExact = c => setQ.length > 2 && norm(c.s) === setQ;
    const setNear = c => setQ.length > 2 && (norm(c.s).includes(setQ) || setQ.includes(norm(c.s)));
    const stampOK = c => !!(stampF && stampF(c));
    const stampRank = c => { for (let i = 0; i < stampTs.length; i++) if (stampTs[i](c)) return stampTs.length - i; return 0; };
    const score = c => (isNum(c) ? 100 : 0) + (isNear(c) ? 50 : 0) + (stampOK(c) ? 30 + stampRank(c) : 0) + (setExact(c) ? 20 : setNear(c) ? 8 : 0) +
      (rarityOK(c) ? 12 : 0) + (tierOK(c) ? 10 : 0) + (totalOK(c) ? 4 : 0);
    const sorted = nm.cards.slice().sort((a, b) => (score(b) - score(a)) || ((b.y || 0) - (a.y || 0)) || ((b.o || 0) - (a.o || 0)));
    const cards = sorted.slice(0, 16), pool = sorted.slice(0, 80);   // pool: every printing of the name, for the picture match
    const out = (kind, strength, sug, note) => ({ kind, strength, suggestion: sug ? sug.id : null, cards, pool, note: note || "", why, lang });
    const nameSure = nm.level <= 2;
    // Narrow a pool by the clues in order (stamp, set, exact rarity, rarity tier); each step only if it keeps someone.
    const narrow = (pool) => {
      const pool0 = pool;
      for (const f of stampTs) {   // the most specific stamp test that keeps someone
        if (pool.length <= 1) break;
        const p = pool.filter(f);
        if (p.length) { if (p.length < pool.length) { pool = p; } break; }
      }
      const steps = [["set", setQ.length > 2 ? setExact : null], ["set", setQ.length > 2 ? setNear : null], ["rarity", rq ? rarityOK : null], ["tier", rt ? tierOK : null]];
      let by = ""; const used = new Set();
      if (stampTs.length && pool.length < pool0.length) { by = "stamp"; used.add("stamp"); }
      for (const [label, f] of steps) {
        if (!f || pool.length <= 1) continue;
        const p = pool.filter(f);
        if (p.length && p.length < pool.length) { pool = p; by = label; used.add(label); }
      }
      return { pool, by, used };
    };

    if (num) {
      let ex = nm.cards.filter(isNum);
      if (ex.length > 1 && total) { const t = ex.filter(totalOK); if (t.length) ex = t; }
      if (ex.length > 1) { const n = narrow(ex); if (n.pool.length === 1) { why.push("tie on number broken by " + n.by); return out("exact", "weak", n.pool[0]); } }
      if (ex.length === 1) {
        const sz = SET_SIZE[ex[0].s] || [];
        const clash = total && sz.length && !sz.includes(total);   // "063/090" but that set has 76 cards: a misread
        if (clash) why.push("set total " + total + " does not fit " + ex[0].s + " (" + sz.join("/") + ")");
        if (lowRes) why.push("small stream (" + ctx.short + "p): number not trusted for a strong pick");
        return out("exact", nameSure && !clash && !lowRes ? "strong" : "weak", ex[0]);
      }
      if (ex.length > 1) return out("ambiguous", null, null, ex.length + " printings with #" + read.number + ": pick one");
      const near = nm.cards.filter(isNear);
      if (near.length === 1 && !lowRes) { why.push("number off by one: read " + read.number + ", catalog " + near[0].num); return out("near", "weak", near[0]); }
      if (!lowRes) return out("number-miss", null, null, "no #" + read.number + " for " + nm.cards[0].n.replace(/\s+\d.*$/, "") + " in the catalog (likely under $1.50, or misread)");
      why.push("number " + read.number + " not in the catalog, read off a small stream: matched on the other clues");
    }
    if (nm.cards.length === 1) return out("unique", "weak", nm.cards[0], "no number read");
    const n = narrow(nm.cards);
    if (n.pool.length === 1) {
      const pick = n.pool[0];
      // Without a stamp backing it, a rarity or set read must not pick a printing 5x the cheapest one
      // (a premium rarity read, or any set guess).
      if (!n.used.has("stamp")) {
        const others = nm.cards.filter(c => c !== pick).map(price).filter(p => p > 0);
        const cheapest = others.length ? Math.min(...others) : 0;
        if ((rt === "premium" || n.used.has("set")) && cheapest > 0 && price(pick) >= 5 * cheapest) {
          why.push((n.used.has("set") ? "set" : "premium") + " read would pick a printing " + Math.round(price(pick) / cheapest) + "x the cheapest: no suggestion");
          return out("ambiguous", null, null, "several printings, no number read: pick one");
        }
      }
      why.push(n.by + " leaves one printing");
      return out("unique", "weak", pick, "no number read");
    }
    return out("ambiguous", null, null, (n.pool.length < nm.cards.length ? n.pool.length + " of " : "") + nm.cards.length + " printings, no number read: pick one");
  }

  // Printing from the finish read (Prismatic Sylveon 040: Holofoil $0.38, Reverse $0.49, Poké Ball $2.78, Master Ball
  // $30.51; the collapsed bid is priced from the top printing). Only for a card with several printings, only a key it has.
  function finishKey(card, finish) {
    const keys = Object.keys((card && card.px) || {}); if (keys.length < 2) return "";
    const f = String(finish || "").toLowerCase(), plain = (k) => !/ball|reverse|1st|shadowless/i.test(k);
    const pick = (re, ok) => keys.find((k) => re.test(k) && (!ok || ok(k))) || "";
    if (/master/.test(f)) return pick(/master ball/i);
    if (/pok/.test(f)) return pick(/pok[eé] ball/i);
    if (/reverse/.test(f)) return pick(/^reverse holofoil$/i) || pick(/reverse/i, (k) => !/ball/i.test(k));
    if (/^holo/.test(f)) return pick(/^holofoil$/i) || pick(/^unlimited holofoil$/i) || pick(/holofoil/i, plain);
    if (/non/.test(f)) return pick(/^normal$/i) || pick(/^unlimited$/i);
    return "";
  }
  const autoMatch0 = autoMatch;
  autoMatch = function (read, ctx) {
    const m = autoMatch0(read, ctx);
    const c = m.suggestion && typeof CARDS !== "undefined" ? CARDS.find((x) => x.id === m.suggestion) : null;
    m.printing = c && read ? finishKey(c, read.finish) : "";
    return m;
  };
  window.autoMatch = autoMatch;
  window.__recog = { finishKey, norm, cardTier, readTier, byName, stampTest };
})();
