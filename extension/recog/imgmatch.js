// Picture match (RECOG experiment, docs/auto-recognition-handoff.md). Removed by scripts/strip-recog.js.
//
// Ranks candidate cards by how much their TCGplayer picture looks like the card in the stream frame. The model reads
// the name (it nearly always gets that right); the picture decides which printing of that name it is (art differs
// between the regular card, the full art, the SIR and other sets, and that is what moves the price). Runs locally,
// no API call. Same art (holo / reverse, 1st Ed / Unlimited, identical reprints) cannot be told apart: those come
// back as one group (sim to the top close to 1).
//
// Pure functions on {data, width, height} RGBA pixels, so the same file runs in the service worker, the results page
// and a Node test. Browser-only helper: IM.load(url or data URL).
(function (root) {
  const TW = 24, TH = 33;                 // a card (63 x 88 mm) compared at 24 x 33 cells
  const W = [1, 0.5, 0.5];                // channel weights: lightness, red-green, yellow-blue
  const N = TW * TH;

  // Average a rectangle of pixels into tw x th cells, as three opponent-color planes (0..1). Transparent pixels count
  // as mid gray (pokemontcg.io scans have clear rounded corners).
  function resample(img, x0, y0, x1, y1, tw, th) {
    const d = img.data, w = img.width, h = img.height, out = new Float32Array(tw * th * 3), n = tw * th;
    const sx = (x1 - x0) / tw, sy = (y1 - y0) / th;
    for (let ty = 0; ty < th; ty++) {
      const ya = y0 + ty * sy, iy0 = Math.max(0, Math.floor(ya)), iy1 = Math.min(h, Math.max(iy0 + 1, Math.round(ya + sy)));
      for (let tx = 0; tx < tw; tx++) {
        const xa = x0 + tx * sx, ix0 = Math.max(0, Math.floor(xa)), ix1 = Math.min(w, Math.max(ix0 + 1, Math.round(xa + sx)));
        let r = 0, g = 0, b = 0, c = 0;
        const step = Math.max(1, Math.floor((ix1 - ix0) / 6));   // big cells: sample a 6 x 6 grid, plenty for an average
        const ystep = Math.max(1, Math.floor((iy1 - iy0) / 6));
        for (let y = iy0; y < iy1; y += ystep) for (let x = ix0, p = (y * w + ix0) * 4; x < ix1; x += step, p += 4 * step) {
          if (d[p + 3] < 128) { r += 128; g += 128; b += 128; } else { r += d[p]; g += d[p + 1]; b += d[p + 2]; }
          c++;
        }
        if (!c) c = 1;
        r /= c * 255; g /= c * 255; b /= c * 255;
        const i = ty * tw + tx;
        out[i] = (r + g + b) / 3; out[n + i] = r - g; out[2 * n + i] = (r + g) / 2 - b;
      }
    }
    return out;
  }

  // Trim plain margins (white or clear) a product photo may carry, at most 8% a side.
  function trimBox(img) {
    const d = img.data, w = img.width, h = img.height;
    const plain = (x, y) => { const p = (y * w + x) * 4; return d[p + 3] < 128 || (d[p] > 240 && d[p + 1] > 240 && d[p + 2] > 240); };
    const rowPlain = (y) => { let k = 0; for (let x = 0; x < w; x += 2) k += plain(x, y) ? 1 : 0; return k > 0.9 * w / 2; };
    const colPlain = (x) => { let k = 0; for (let y = 0; y < h; y += 2) k += plain(x, y) ? 1 : 0; return k > 0.9 * h / 2; };
    let t = 0, b = h, l = 0, r = w;
    while (t < h * 0.08 && rowPlain(t)) t++;
    while (b > h * 0.92 && rowPlain(b - 1)) b--;
    while (l < w * 0.08 && colPlain(l)) l++;
    while (r > w * 0.92 && colPlain(r - 1)) r--;
    return [l, t, r, b];
  }

  // Zero mean, unit length per channel, so a dot product with a normalized window is a correlation.
  function normalize(v) {
    const o = new Float32Array(v.length);
    for (let c = 0; c < 3; c++) {
      let m = 0; for (let i = 0; i < N; i++) m += v[c * N + i]; m /= N;
      let s = 0; for (let i = 0; i < N; i++) { const x = v[c * N + i] - m; s += x * x; }
      s = Math.sqrt(s) || 1;
      for (let i = 0; i < N; i++) o[c * N + i] = (v[c * N + i] - m) / s;
    }
    return o;
  }
  // A candidate's picture -> its template (raw cells; normalize before matching).
  function cardCells(img) { const [l, t, r, b] = trimBox(img); return resample(img, l, t, r, b, TW, TH); }
  const wsum = W[0] + W[1] + W[2];
  // How alike two templates are (1 = same picture). Used to group printings that share the art.
  function sim(a, b) { let s = 0; for (let c = 0; c < 3; c++) { let d = 0; for (let i = 0; i < N; i++) d += a[c * N + i] * b[c * N + i]; s += W[c] * d; } return s / wsum; }

  // Score every template against the frame. box: [left, top, right, bottom] in thousandths (the model's), or null to
  // search the whole frame (slower, less sure). temps: [{id, t: normalized template}]. Returns [{id, s}] best first,
  // s = the best weighted correlation over position and scale (about 0.2 for unrelated cards, 0.6+ for the card).
  function match(frame, box, temps, opt) {
    opt = opt || {};
    const fw = frame.width, fh = frame.height;
    let rx0 = 0, ry0 = 0, rx1 = fw, ry1 = fh, heights;
    if (Array.isArray(box) && box.length === 4 && box[2] - box[0] > 20 && box[3] - box[1] > 20) {
      const l = box[0] / 1000 * fw, t = box[1] / 1000 * fh, r = box[2] / 1000 * fw, b = box[3] / 1000 * fh;
      let bh = b - t; const bw = r - l;
      if (bw / bh > 1.05) bh = bw / 0.716;   // a box wider than a card: the card is held sideways or the box is off; use its width
      const m = 0.18 * Math.max(bh, bw);
      rx0 = Math.max(0, l - m); ry0 = Math.max(0, t - m); rx1 = Math.min(fw, r + m); ry1 = Math.min(fh, b + m);
      heights = [0.8, 0.9, 1, 1.1].map((k) => bh * k);
    } else {
      heights = []; for (let k = 0.3; k <= 0.95; k *= 1.15) heights.push(fh * k);
    }
    const best = temps.map(() => -2), rw0 = rx1 - rx0, rh0 = ry1 - ry0;
    for (const ch of heights) {
      const k = TH / ch, RW = Math.round(rw0 * k), RH = Math.round(rh0 * k);
      if (RW < TW || RH < TH) continue;
      const reg = resample(frame, rx0, ry0, rx1, ry1, RW, RH), RN = RW * RH;
      // integral images of each channel and its square, for window mean / spread
      const I = [], Q = [];
      for (let c = 0; c < 3; c++) {
        const ii = new Float64Array((RW + 1) * (RH + 1)), qq = new Float64Array((RW + 1) * (RH + 1));
        for (let y = 0; y < RH; y++) {
          let rs = 0, rq = 0;
          for (let x = 0; x < RW; x++) {
            const v = reg[c * RN + y * RW + x]; rs += v; rq += v * v;
            ii[(y + 1) * (RW + 1) + x + 1] = ii[y * (RW + 1) + x + 1] + rs;
            qq[(y + 1) * (RW + 1) + x + 1] = qq[y * (RW + 1) + x + 1] + rq;
          }
        }
        I.push(ii); Q.push(qq);
      }
      const area = (a, x, y) => a[(y + TH) * (RW + 1) + x + TW] - a[y * (RW + 1) + x + TW] - a[(y + TH) * (RW + 1) + x] + a[y * (RW + 1) + x];
      const step = opt.step || (box ? 1 : 2);
      const sd = new Float64Array(3);
      for (let y = 0; y + TH <= RH; y += step) for (let x = 0; x + TW <= RW; x += step) {
        let flat = false;
        for (let c = 0; c < 3; c++) { const s = area(I[c], x, y), q = area(Q[c], x, y), v = q - s * s / N; sd[c] = v > 1e-9 ? Math.sqrt(v) : 0; if (c === 0 && sd[c] < 0.02 * Math.sqrt(N)) flat = true; }
        if (flat) continue;   // a blank wall: no card here
        for (let ti = 0; ti < temps.length; ti++) {
          const t = temps[ti].t; let s = 0;
          for (let c = 0; c < 3; c++) {
            if (!sd[c]) continue;
            let dot = 0; const to = c * N, ro = c * RN;
            for (let yy = 0; yy < TH; yy++) { const rr = ro + (y + yy) * RW + x, tt = to + yy * TW; for (let xx = 0; xx < TW; xx++) dot += t[tt + xx] * reg[rr + xx]; }
            s += W[c] * dot / sd[c];   // the template is zero-mean, so the window's mean drops out
          }
          s /= wsum;
          if (s > best[ti]) best[ti] = s;
        }
      }
    }
    return temps.map((t, i) => ({ id: t.id, s: +best[i].toFixed(4) })).sort((a, b) => b.s - a.s);
  }

  // The verdict on a ranking. Same-art printings fold into the top group; the next distinct picture decides how sure.
  //   sure: the top picture beats the next different picture clearly.
  function verdict(ranked, temps, opt) {
    opt = opt || {};
    const minS = opt.minS != null ? opt.minS : 0.45, gap = opt.gap != null ? opt.gap : 0.06, same = opt.same != null ? opt.same : 0.9;
    if (!ranked.length) return { top: null, group: [], next: null, sure: false };
    const T = new Map(temps.map((t) => [t.id, t.t]));
    const top = ranked[0], tt = T.get(top.id);
    const group = [], rest = [];
    for (const r of ranked) (tt && T.get(r.id) && sim(tt, T.get(r.id)) >= same ? group : rest).push(r);
    const next = rest[0] || null;
    return { top: top.id, s: top.s, group: group.map((r) => r.id), next: next ? next.id : null, ns: next ? next.s : null,
      sure: top.s >= minS && (!next || top.s - next.s >= gap) };
  }

  // Browser: pixels of an image URL or data URL (service worker or page). maxW scales big pictures down first.
  async function load(src, maxW) {
    const res = await fetch(src, src.startsWith("data:") ? undefined : { cache: "force-cache" });
    if (!res.ok) throw new Error("picture " + res.status);
    const bmp = await createImageBitmap(await res.blob());
    const s = maxW && bmp.width > maxW ? maxW / bmp.width : 1, w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
    const cv = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
    const g = cv.getContext("2d"); g.drawImage(bmp, 0, 0, w, h);
    return g.getImageData(0, 0, w, h);
  }
  // The picture of a catalog card: TCGplayer's product photo (small, every priced card has one), else pokemontcg.io.
  function picUrl(c) {
    if (c.pid) return `https://tcgplayer-cdn.tcgplayer.com/product/${c.pid}_200w.jpg`;
    const id = c.id || "", i = id.lastIndexOf("-");
    return !/:/.test(id) && i > 0 ? `https://images.pokemontcg.io/${id.slice(0, i)}/${id.slice(i + 1)}.png` : "";
  }

  const IM = { TW, TH, resample, cardCells, normalize, sim, match, verdict, load, picUrl, trimBox };
  if (typeof module !== "undefined" && module.exports) module.exports = IM; else root.IM = IM;
})(typeof self !== "undefined" ? self : this);
