#!/usr/bin/env node
// Removes the auto-recognition experiment from the repo, leaving CardComp and the extension as they were.
//   node scripts/strip-recog.js          strip, then print what changed
//   node scripts/strip-recog.js --dry    only print what would change
// What it removes:
//   - folders recog/ (app side) and extension/recog/ (extension side)
//   - every line containing the tag RECOG, and every block between RECOG-BEGIN and RECOG-END lines,
//     in the repo's .js / .html / .md files (docs/ is kept as history)
//   - from extension/manifest.json: the recog-grab shortcut, the recog content script, and the permissions
//     the experiment added (MANIFEST_PERMS)
//   - the experiment's scripts, this one last
// Afterwards: commit, and reload the unpacked extension at chrome://extensions.
const fs = require("fs"), path = require("path");
const ROOT = path.resolve(__dirname, "..");
const DRY = process.argv.includes("--dry");
const DIRS = ["recog", "extension/recog"];
const FILES = ["scripts/recog-test.js", "scripts/recog-check.js", "scripts/recog-mock.html", "scripts/strip-recog.js"];
const MANIFEST_PERMS = ["activeTab"];                 // permissions added only for the experiment
const MANIFEST_HOSTS = ["https://api.anthropic.com/*"];
const SKIP = new Set([".git", "node_modules", "docs"]);
const log = [];
const rel = (p) => path.relative(ROOT, p);

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|html|md)$/.test(e.name)) out.push(p);
  }
  return out;
}

// 1. tagged lines and blocks
for (const f of walk(ROOT, [])) {
  if (DIRS.some((d) => rel(f).startsWith(d + "/")) || FILES.includes(rel(f))) continue;
  const lines = fs.readFileSync(f, "utf8").split("\n");
  const keep = []; let inBlock = false, cut = 0;
  for (const l of lines) {
    if (/RECOG-BEGIN/.test(l)) { inBlock = true; cut++; continue; }
    if (/RECOG-END/.test(l)) { inBlock = false; cut++; continue; }
    if (inBlock || /\bRECOG\b/.test(l)) { cut++; continue; }
    keep.push(l);
  }
  if (inBlock) { console.error("unclosed RECOG-BEGIN in " + rel(f) + ": nothing changed"); process.exit(1); }
  if (cut) { log.push(`${rel(f)}: removed ${cut} line(s)`); if (!DRY) fs.writeFileSync(f, keep.join("\n")); }
}

// 2. manifest
const mp = path.join(ROOT, "extension/manifest.json");
const m = JSON.parse(fs.readFileSync(mp, "utf8")), before = JSON.stringify(m);
if (m.commands) { delete m.commands["recog-grab"]; if (!Object.keys(m.commands).length) delete m.commands; }
m.content_scripts = (m.content_scripts || []).filter((c) => !(c.js || []).every((j) => j.startsWith("recog/")));
m.permissions = (m.permissions || []).filter((p) => !MANIFEST_PERMS.includes(p));
m.host_permissions = (m.host_permissions || []).filter((p) => !MANIFEST_HOSTS.includes(p));
if (JSON.stringify(m) !== before) { log.push("extension/manifest.json: removed the shortcut, content script and permissions"); if (!DRY) fs.writeFileSync(mp, JSON.stringify(m, null, 2) + "\n"); }

// 3. folders and scripts
for (const d of DIRS) { const p = path.join(ROOT, d); if (fs.existsSync(p)) { log.push(d + "/: deleted"); if (!DRY) fs.rmSync(p, { recursive: true }); } }
for (const f of FILES) { const p = path.join(ROOT, f); if (fs.existsSync(p)) { log.push(f + ": deleted"); if (!DRY) fs.rmSync(p); } }

// 4. anything left that still mentions the experiment
const left = walk(ROOT, []).filter((f) => fs.existsSync(f) && /\bRECOG\b|recog\//.test(fs.readFileSync(f, "utf8")));
console.log((DRY ? "Would change:\n  " : "Stripped:\n  ") + (log.join("\n  ") || "nothing (already stripped)"));
if (left.length && !DRY) console.log("Still mentions recog (check by hand): " + left.map(rel).join(", "));
