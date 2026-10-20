// RECOG experiment: score auto-recognition from the auction log (private repo pm-derek/cardcomp-data), no export needed.
// Each logged lot carries `recog` (what auto read and suggested) next to `card` (what Derek tapped or opened).
// Usage: node scripts/recog-score-log.js <cardcomp-data dir> [since YYYY-MM-DD]
const fs = require("fs"), path = require("path");
const dir = process.argv[2], since = process.argv[3] || "";
if (!dir) { console.log("usage: node scripts/recog-score-log.js <cardcomp-data dir> [since YYYY-MM-DD]"); process.exit(1); }
const rows = fs.readdirSync(dir).filter((f) => /^log-\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(4, 14) >= since).sort()
  .flatMap((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch (_) { return []; } });
const read = rows.filter((r) => r && r.recog), truth = read.filter((r) => r.card && r.card.id && !r.card.multi);
const pct = (a, b) => b ? Math.round(100 * a / b) + "%" : "-";
const v = (r) => { const g = r.recog; if (g.sug && g.sug.id === r.card.id) return "right"; if (g.sug) return (g.ids || []).includes(r.card.id) ? "wrong, listed" : "wrong";
  return (g.ids || []).includes(r.card.id) ? "no pick, listed" : "not listed"; };
const by = {}; truth.forEach((r) => { const k = v(r); by[k] = (by[k] || 0) + 1; });
const strong = truth.filter((r) => r.recog.strength === "strong"), strongWrong = strong.filter((r) => v(r) !== "right");
const pr = truth.filter((r) => v(r) === "right" && r.recog.printing && r.card.printing);
console.log(`${rows.length} lots logged, ${read.length} with an auto reading, ${truth.length} with a tapped / opened card to score against`);
console.log(`strong wrong: ${strongWrong.length} of ${strong.length}`);
console.log(Object.entries(by).map(([k, n]) => `${k} ${n} (${pct(n, truth.length)})`).join(" · "));
console.log(`printing read right: ${pr.filter((r) => r.recog.printing === r.card.printing).length} of ${pr.length}`);
// picture match (extension 0.7+): did the picture's top group hold the card, and was "sure" ever wrong
const pk = truth.filter((r) => r.recog.pic && r.recog.pic.top), inG = (r) => (r.recog.pic.group || [r.recog.pic.top]).includes(r.card.id);
const pkSure = pk.filter((r) => r.recog.pic.sure);
console.log(`picture: your card on top ${pk.filter(inG).length} of ${pk.length} (${pct(pk.filter(inG).length, pk.length)}) · sure ${pkSure.length}, wrong ${pkSure.filter((r) => !inG(r)).length} · ` +
  `lots where the text pick missed and the picture got it: ${pk.filter((r) => v(r) !== "right" && inG(r)).length}`);
const models = {}; read.forEach((r) => { models[r.recog.model] = (models[r.recog.model] || 0) + 1; }); console.log("models: " + JSON.stringify(models));
console.log("\nmisses:");
truth.filter((r) => v(r) !== "right").forEach((r) => { const g = r.recog, d = g.read;
  console.log(`- ${new Date(r.at).toISOString().slice(0, 16)} ${r.seller} · read "${d.name} ${d.number}${d.total ? "/" + d.total : ""}" ${d.rarity}${d.stamp ? " [" + d.stamp + "]" : ""}${d.finish ? " (" + d.finish + ")" : ""}` +
    ` → ${g.sug ? g.sug.n + " " + g.sug.s + " #" + g.sug.num + " " + g.sug.r : "no pick (" + g.kind + ")"} · you: ${r.card.n} ${r.card.s || ""} #${r.card.num || ""} ${r.card.r || ""} (${r.card.label}) · ${v(r)}`); });
