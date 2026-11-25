// Draws every output frame on a canvas. All layout numbers are in 1920x1080 space.
import { STYLE, personLines } from "./timeline.js";
import { Grader, gradeLut, gradeKey, isIdentity, imgSize } from "./grade.js";

const clamp01 = (u) => Math.min(1, Math.max(0, u));
const easeOut = (u) => 1 - Math.pow(1 - clamp01(u), 3);
const lerp = (a, b, u) => a + (b - a) * u;

/** Cubic-bezier easing (like CSS / After Effects keyframe influence). */
function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t;
  const sy = (t) => ((ay * t + by) * t + cy) * t;
  return (x) => {
    x = clamp01(x);
    let t = x;
    for (let i = 0; i < 8; i++) {           // Newton, then bisection fallback
      const dx = sx(t) - x, d = (3 * ax * t + 2 * bx) * t + cx;
      if (Math.abs(dx) < 1e-5) break;
      if (Math.abs(d) < 1e-6) break;
      t -= dx / d;
    }
    if (Math.abs(sx(t) - x) > 1e-4) { let lo = 0, hi = 1; t = x; for (let i = 0; i < 30; i++) { if (sx(t) < x) lo = t; else hi = t; t = (lo + hi) / 2; } }
    return sy(t);
  };
}
const ease7070 = bezier(0.7, 0, 0.3, 1);          // AE ease, 70% influence both sides
const easyEase = bezier(1 / 3, 0, 2 / 3, 1);       // AE Easy Ease (33.33%)

// Lower-third line in: each line moves up 30 px and fades in over frames 0-20 (lines 2 f apart).
// Eases fitted to the After Effects render (LowerThirds_Locked_1.mov, measured frame by frame).
// The out is the same curve played backwards.
const l3Pos = bezier(0.218, 0.155, 0.005, 1);
const l3Op = bezier(0.213, 0.044, 0.067, 1);
/** f = frames since this line started → [opacity, rise left (0..1)] */
function l3Curve(f) {
  if (f <= 0) return [0, 1];
  return [l3Op(f / 20), 1 - l3Pos(f / 20)];
}
const L3_SS = 6;
// Guest card (IntroL3.mp4): null scale 0-15 f, quote opacity 0-14 f, text rise over 20 f and
// text opacity over 18.2 f per line (starts staggered, see drawGuestCard)
const gcScale = bezier(0.11, 0.241, 0.171, 1);
const gcQuoteOp = bezier(0.112, 0, 0.295, 1);
const gcTextPos = bezier(0.191, 0.045, 0.3, 1);
const gcTextOp = bezier(0.298, 0.367, 0.371, 1);            // L3 lines are rendered 6x larger, then shrunk into 6 sub-pixel positions

export const DEFAULT_FONTS = { title: "Barlow Condensed", bold: "Inter", regular: "Inter", l3: null };   // l3: null = the regular font

export class Compositor {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.scale = canvas.width / STYLE.width;
    this.logo = null;
    this.fonts = { ...DEFAULT_FONTS };
    this.people = {};
    this.splitBg = null;
  }

  async setBrand({ logo = null, quote = null, fonts = {} } = {}) {
    this.logo = logo;
    this.quote = quote;
    this.fonts = { ...DEFAULT_FONTS, ...Object.fromEntries(Object.entries(fonts).filter(([, v]) => v)) };
    await Promise.all([
      document.fonts.load(`700 120px "${this.fonts.title}"`),
      document.fonts.load(`700 44px "${this.fonts.bold}"`),
      document.fonts.load(`400 48px "${this.fonts.regular}"`),
      document.fonts.load(`300 48px "${this.fonts.regular}"`),
      document.fonts.load(`400 140px "${this.fonts.regular}"`),
      this.fonts.l3 ? document.fonts.load(`400 48px "${this.fonts.l3}"`) : null,
      this.fonts.l3 ? document.fonts.load(`400 140px "${this.fonts.l3}"`) : null,
    ]).catch(() => {});
    this.splitBg = null;
    this.l3Sprites = new Map();
  }

  /** Colour curves per camera: { host: grade, guest: grade } (see grade.js). */
  setGrades(grades, bypass = false) {
    const key = bypass ? "" : JSON.stringify(grades || {});
    if (key === this.gradeKey) return;
    this.gradeKey = key;
    this.luts = {};
    if (bypass) return;
    for (const [role, g] of Object.entries(grades || {})) if (!isIdentity(g)) this.luts[role] = gradeLut(g);
  }

  /** Draw a camera source (src = {img, crop, role}) into x, y, w, h with that camera's curves. */
  _drawSrc(c, src, x, y, w, h) {
    const lut = src.role && this.luts?.[gradeKey(src.role)];
    if (lut) {
      this.grader ??= new Grader();
      if (this.grader.ok) {
        try {
          const [iw, ih] = imgSize(src.img);
          const g = this.grader.apply(src.img, src.crop, lut, iw, ih);
          c.drawImage(g.canvas, 0, 0, g.w, g.h, x, y, w, h);
          return;
        } catch (e) { console.warn("curves:", e); }
      }
    }
    c.drawImage(src.img, ...src.crop, x, y, w, h);
  }

  setPeople(people) {
    const key = JSON.stringify(people);
    if (key !== this._peopleKey) { this._peopleKey = key; this.people = people || {}; this.splitBg = null; }
  }

  _begin() {
    const c = this.ctx;
    c.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    c.globalAlpha = 1;
    c.shadowColor = "transparent";
    c.textAlign = "left";
    c.letterSpacing = "0px";
    return c;
  }

  _layerCtx() {
    if (!this._layer) this._layer = new OffscreenCanvas(STYLE.width, STYLE.height);
    const l = this._layer.getContext("2d");
    l.setTransform(1, 0, 0, 1, 0, 0);
    l.globalCompositeOperation = "source-over";
    l.globalAlpha = 1;
    l.clearRect(0, 0, STYLE.width, STYLE.height);
    return l;
  }

  // -- static pieces -----------------------------------------------------------
  _wordmark(c, x, y, height, align = "left", color = STYLE.purple) {
    if (this.logo) {
      const w = (this.logo.width * height) / this.logo.height;
      c.drawImage(this.logo, align === "center" ? x - w / 2 : x, y, w, height);
      return;
    }
    const lineH = height * 0.46, gap = height - 2 * lineH;
    let size = lineH / 0.7;
    c.font = `700 ${size}px "${this.fonts.title}"`;
    const cap = c.measureText("I").actualBoundingBoxAscent || size * 0.7;
    size *= lineH / cap;
    c.font = `700 ${size}px "${this.fonts.title}"`;
    c.fillStyle = color;
    c.textBaseline = "alphabetic";
    c.textAlign = align;
    ["IN GOOD", "COMPANY"].forEach((w, i) => c.fillText(w, x, y + lineH + i * (lineH + gap)));
    c.textAlign = "left";
  }

  _splitBackground() {
    if (this.splitBg) return this.splitBg;
    const cv = new OffscreenCanvas(STYLE.width, STYLE.height);
    const c = cv.getContext("2d");
    c.fillStyle = STYLE.background;
    c.fillRect(0, 0, STYLE.width, STYLE.height);
    this._wordmark(c, STYLE.logo.x, STYLE.logo.y, STYLE.logo.height);
    const sp = STYLE.split;
    // Inter 32 / leading 37 / tracking -30 / #0E0D0C
    c.font = `400 ${sp.labelSize}px "${this.fonts.regular}"`;
    c.letterSpacing = `${-0.03 * sp.labelSize}px`;
    c.fillStyle = STYLE.text;
    c.textBaseline = "alphabetic";
    for (const [role, x] of [["host", sp.leftX], ["guest", sp.rightX]]) {
      const p = this.people[role] || {};
      personLines(p).forEach((line, i) => c.fillText(line, x, sp.labelBaseline + i * sp.labelLine));
    }
    this.splitBg = cv;
    return cv;
  }

  // -- footage ----------------------------------------------------------------
  /** solo: `main` fills the frame. split: host left, guest right. */
  drawFootage(layout, main, guest) {
    const c = this._begin();
    if (layout === "split") {
      c.drawImage(this._splitBackground(), 0, 0);
      const sp = STYLE.split;
      this._panel(c, main, sp.leftX, sp.panelY, sp.panelW, sp.panelH, sp.radius);
      this._panel(c, guest, sp.rightX, sp.panelY, sp.panelW, sp.panelH, sp.radius);
    } else {
      c.fillStyle = "#000";
      c.fillRect(0, 0, STYLE.width, STYLE.height);
      if (main?.img) this._drawSrc(c, main, 0, 0, STYLE.width, STYLE.height);
    }
  }

  _panel(c, src, x, y, w, h, r) {
    c.save();
    c.beginPath();
    c.roundRect(x, y, w, h, r);
    c.clip();
    c.fillStyle = "#111";
    c.fillRect(x, y, w, h);
    if (src?.img) this._drawSrc(c, src, x, y, w, h);
    c.restore();
  }

  /** Lower third. t = seconds since the L3 started (see STYLE.l3 for the spec). */
  drawL3(t, dur, person, layout, role) {
    const c = this._begin();
    const L = STYLE.l3;
    const lines = personLines(person);                // a 2-line job title makes it 4 lines, same spacing
    const n = lines.length;
    let x = L.x, base = L.baseline + (3 - n) * L.line;
    if (layout === "split") {                      // same size, inside that person's panel
      const sp = STYLE.split;
      x = (role === "guest" ? sp.rightX : sp.leftX) + 24;
      base = sp.panelY + sp.panelH - 28 - (n - 1) * L.line;
    }
    const f = t * 30;                              // frames
    const end = L.inF + L.holdF + L.outF + (n - 1) * L.lineOffsetF;   // 144 f for 3 lines
    lines.forEach((text, j) => {
      // in: top line first (1, 2, 3, …) · out: bottom line first (…, 3, 2, 1) · 2 frames apart.
      // The out mirrors the in exactly (the whole L3 is symmetric in time).
      const fromIn = f - j * L.lineOffsetF;
      const fromOut = end - f - j * L.lineOffsetF;
      if (fromIn <= 0 || fromOut <= 0) return;
      const [u, rise] = l3Curve(Math.min(fromIn, fromOut));
      if (u <= 0.002) return;
      // Drawn from pre-rendered images at 1/6-pixel steps, so the slow end of the landing glides
      // instead of snapping to whole pixels or going soft/sharp between them.
      const sp = this._l3Sprite(text), k = this.scale;
      const dy = (base + j * L.line + L.rise * rise - sp.oy) * k;
      let iy = Math.floor(dy), ph = Math.round((dy - iy) * L3_SS);
      if (ph === L3_SS) { iy += 1; ph = 0; }
      c.save();
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalAlpha = u;
      c.drawImage(sp.phases[ph], Math.round((x - sp.ox) * k), iy);
      c.restore();
    });
    c.globalAlpha = 1;
  }

  /** One L3 line with its drop shadow, rendered once at 6x and box-filtered down into 6 images,
   *  each shifted down by a further 1/6 pixel (output pixels). */
  _l3Sprite(text) {
    const L = STYLE.l3, k = this.scale, S = L3_SS;
    const font = this.fonts.l3 ? `400 ${L.size}px "${this.fonts.l3}"` : `${L.weight} ${L.size}px "${this.fonts.regular}"`;
    const key = font + "|" + k + "|" + text;
    this.l3Sprites ??= new Map();
    let sp = this.l3Sprites.get(key);
    if (sp) return sp;
    const pad = 60, ox = pad, oy = L.size + pad;                    // baseline sits oy below the top
    const m = this.ctx;
    m.save();
    m.font = font;
    m.letterSpacing = `${L.tracking * L.size}px`;
    const tw = m.measureText(text).width;
    m.restore();
    const W = Math.ceil((tw + 2 * pad) * k), H = Math.ceil((L.size * 1.4 + 2 * pad) * k);   // output pixels
    const big = new OffscreenCanvas(W * S, H * S), c = big.getContext("2d", { willReadFrequently: true });
    const ks = k * S;
    c.scale(ks, ks);
    c.font = font;
    c.letterSpacing = `${L.tracking * L.size}px`;
    c.textBaseline = "alphabetic";
    c.fillStyle = "#FFFFFF";
    const sh = L.shadow, rad = (sh.direction * Math.PI) / 180;   // AE: 0° = up, clockwise
    c.shadowColor = `rgba(0,0,0,${sh.opacity})`;
    c.shadowOffsetX = Math.sin(rad) * sh.distance * ks;
    c.shadowOffsetY = -Math.cos(rad) * sh.distance * ks;
    c.shadowBlur = sh.softness * 0.6 * ks;
    c.fillText(text, ox, oy);
    // sum each S-wide column block (premultiplied), row by row of the big image
    const src = c.getImageData(0, 0, W * S, H * S).data, R = H * S;
    const sumA = new Float32Array(R * W), sumC = new Float32Array(R * W);   // colour is grey: one channel
    for (let r = 0; r < R; r++) {
      for (let x = 0; x < W; x++) {
        let a = 0, cc = 0;
        for (let i = 0, o = (r * W * S + x * S) * 4; i < S; i++, o += 4) { const al = src[o + 3]; a += al; cc += src[o] * al; }
        sumA[r * W + x] = a; sumC[r * W + x] = cc;
      }
    }
    const phases = [];
    for (let p = 0; p < S; p++) {
      const out = new ImageData(W, H + 1), d = out.data, n = S * S;
      for (let y = 0; y <= H; y++) {
        for (let x = 0; x < W; x++) {
          let a = 0, cc = 0;
          for (let i = 0; i < S; i++) {
            const r = y * S - p + i;                  // shifted down by p/S of an output pixel
            if (r < 0 || r >= R) continue;
            a += sumA[r * W + x]; cc += sumC[r * W + x];
          }
          const o = (y * W + x) * 4, v = a ? cc / a : 0;
          d[o] = d[o + 1] = d[o + 2] = v; d[o + 3] = a / n;
        }
      }
      const pc = new OffscreenCanvas(W, H + 1);
      pc.getContext("2d").putImageData(out, 0, 0);
      phases.push(pc);
    }
    sp = { phases, ox, oy };
    if (this.l3Sprites.size > 40) this.l3Sprites.clear();
    if (document.fonts.check(font, text)) this.l3Sprites.set(key, sp);   // don't keep a fallback-font copy
    return sp;
  }

  // -- guest card + host slide-in ------------------------------------------------
  _quoteIcon(c, cx, cy, s) {
    c.save();
    c.translate(cx, cy);
    c.scale(s, s);
    c.translate(-960, -284);
    c.strokeStyle = STYLE.lavender;
    c.lineWidth = 30;
    c.lineCap = "butt";
    c.lineJoin = "round";
    c.beginPath();
    c.moveTo(915, 335); c.lineTo(915, 278); c.quadraticCurveTo(915, 248, 945, 248); c.lineTo(950, 248);
    c.moveTo(968, 248); c.lineTo(992, 248); c.quadraticCurveTo(1005, 248, 1005, 262); c.lineTo(1005, 284);
    c.quadraticCurveTo(1005, 320, 970, 320);
    c.stroke();
    c.restore();
  }

  /** Guest card layout: font sizes and baselines for each line (see STYLE.guestCardText). */
  guestCardLayout(person) {
    const G = STYLE.guestCardText, c = this.ctx;
    const width = (text, size, track = -0.03) => {
      c.font = `400 ${size}px "${this.fonts.l3 || this.fonts.regular}"`;
      c.letterSpacing = `${track * size}px`;
      return c.measureText(text).width;
    };
    const fit = (text, size, track) => (text && width(text, size, track) > G.safeWidth ? size * G.safeWidth / width(text, size, track) : size);
    const name = String(person.name || "").trim(), subs = personLines({ ...person, name: "" });
    const compact = subs.some((t) => width(t, G.size) > G.safeWidth);
    const nameSize = fit(name, G.size);
    const lines = [];
    if (!compact) {
      [name, ...subs].filter(Boolean).forEach((text, j) => lines.push({ text, size: j === 0 ? nameSize : G.size, dy: j * G.leading }));
    } else {
      if (name) lines.push({ text: name, size: nameSize, dy: 0 });
      // title and company share one size so they stay a pair; shrink both if either still overflows
      const subSize = Math.min(...subs.map((t) => fit(t, G.subSize, G.subTracking)));
      const k = subSize / G.subSize;
      // first sub-line sits 110 below the name; lines below it keep the 91 leading (scaled if shrunk)
      subs.forEach((text, j) => lines.push({ text, size: subSize, track: G.subTracking, dy: (name ? G.nameToSub : 0) + j * G.subLeading * k }));
    }
    c.letterSpacing = "0px";
    return { lines, compact };
  }

  /** Guest intro card. t = seconds since the card appeared.
   *  Matched to the After Effects comp (IntroL3.mp4), all eases fitted to it frame by frame:
   *  • everything hangs on a null that scales 50% -> 100% over frames 0-15 around the frame centre
   *  • the quote mark fades in over frames 0-14
   *  • each text line rises 60 px (inside the null) over 20 frames and fades in, top line first */
  drawGuestCard(t, person) {
    const c = this._begin();
    c.fillStyle = STYLE.background;
    c.fillRect(0, 0, STYLE.width, STYLE.height);
    const f = t * 30;
    const { lines, compact } = this.guestCardLayout(person);
    // the shorter compact block sits a little lower, as in the Episode 15 reference (quote top 311)
    // a 2-line job title adds a line: lift the block by half of each extra line so it stays centred
    const G = STYLE.guestCardText, extra = Math.max(0, lines.length - 3);
    const step = compact ? (lines[1] ? G.subLeading * (lines[1].size / G.subSize) : G.subLeading) : G.leading;
    const qTop = (compact ? 311 : 268) - (extra * step) / 2;
    const sc = f >= 15 ? 1 : 0.5 + 0.5 * Math.min(1, gcScale(f / 15));
    c.imageSmoothingQuality = "high";
    c.translate(960, 540);
    c.scale(sc, sc);
    c.translate(-960, -540);
    c.globalAlpha = gcQuoteOp(f / 14);
    if (c.globalAlpha > 0.002) {
      if (this.quote) c.drawImage(this.quote, 960 - this.quote.width / 2, qTop);
      else this._quoteIcon(c, 960, qTop + 51, 1);
    }
    const first = qTop + 105 + 48 + (lines[0]?.size ?? 140) * 0.727;
    lines.forEach((ln, j) => {
      const op = gcTextOp((f - (1.62 + 1.43 * j)) / 18.2);
      if (op <= 0.002) return;
      const dy = 60 * (1 - gcTextPos((f - (-0.72 + 1.86 * j)) / 20));
      const sp = this._gcSprite(ln);
      c.globalAlpha = op;
      c.drawImage(sp.canvas, sp.x, first + ln.dy + dy - sp.oy, sp.w, sp.h);
    });
    c.globalAlpha = 1;
  }

  /** A guest card line rendered once at 3x, so it scales and glides smoothly. */
  _gcSprite(ln) {
    const S = 3, track = (ln.track ?? -0.03) * ln.size;
    const font = `400 ${ln.size}px "${this.fonts.l3 || this.fonts.regular}"`;
    const key = font + "|" + track + "|" + ln.text;
    this.gcSprites ??= new Map();
    let sp = this.gcSprites.get(key);
    if (sp) return sp;
    const m = this.ctx;
    m.save();
    m.font = font;
    m.letterSpacing = `${track}px`;
    const tw = m.measureText(ln.text).width;
    m.restore();
    const pad = 20, w = Math.ceil(tw + 2 * pad), h = Math.ceil(ln.size * 1.5 + 2 * pad), oy = Math.ceil(ln.size * 1.1 + pad);
    const cv = new OffscreenCanvas(w * S, h * S), c = cv.getContext("2d");
    c.scale(S, S);
    c.font = font;
    c.letterSpacing = `${track}px`;
    c.textBaseline = "alphabetic";
    c.textAlign = "center";
    c.fillStyle = STYLE.purple;
    // the canvas also adds spacing after the last letter; shift by half of it to stay truly centred
    c.fillText(ln.text, w / 2 + track / 2, oy);
    sp = { canvas: cv, x: STYLE.guestCardText.centerX - w / 2, oy, w, h };
    if (this.gcSprites.size > 20) this.gcSprites.clear();
    if (document.fonts.check(font, ln.text)) this.gcSprites.set(key, sp);
    return sp;
  }

  /** Rect of the host panel during the slide-in (u = 0..1 over STYLE.slideIn = 40 frames).
   *  After Effects matte keys (30 fps):
   *    Position x  0f 2963.1404 -> 30f 1000, ease 70/70 (the rectangle sits 40 px left of the
   *                layer position, so 1000 is the frame centre)
   *    Size        20f 1870x1030 -> 40f 1920x1080, easy ease
   *    Roundness   20f 24 -> 40f 0, easy ease */
  slideRect(u) {
    const f = clamp01(u) * 40;
    const x = lerp(2963.1404, 1000, ease7070(f / 30)) - 40;
    const k = easyEase((f - 20) / 20);
    const w = lerp(1870, 1920, k), h = lerp(1030, 1080, k);
    return { x: x - w / 2, y: 540 - h / 2, w, h, r: lerp(24, 0, k) };
  }

  /** Draw the host video into the sliding panel (on top of the guest card). */
  drawSlidePanel(u, src) {
    const c = this._begin();
    const r = this.slideRect(u);
    c.save();
    c.beginPath();
    c.roundRect(r.x, r.y, r.w, r.h, r.r);
    c.clip();
    c.fillStyle = "#000";
    c.fillRect(r.x, r.y, r.w, r.h);
    if (src?.img) this._drawSrc(c, src, r.x, r.y, r.w, r.h);
    c.restore();
  }

  // -- full-frame clips ------------------------------------------------------------
  _fill(c, img, w, h, bg = STYLE.background) {
    c.fillStyle = bg;
    c.fillRect(0, 0, STYLE.width, STYLE.height);
    if (!img) return;
    const s = Math.min(STYLE.width / w, STYLE.height / h);
    c.drawImage(img, (STYLE.width - w * s) / 2, (STYLE.height - h * s) / 2, w * s, h * s);
  }

  /** Intro bumper. src=null draws a built-in stand-in. */
  drawBumper(src, t) {
    const c = this._begin();
    if (src?.img) { this._fill(c, src.img, src.w, src.h, "#000"); return; }
    c.fillStyle = "#1E0A4E";
    c.fillRect(0, 0, STYLE.width, STYLE.height);
    const u = easeOut(t / 0.8);
    c.save();
    c.globalAlpha = u;
    c.translate(STYLE.width / 2, STYLE.height / 2);
    c.scale(0.94 + 0.06 * u, 0.94 + 0.06 * u);
    this._wordmark(c, 0, -170, 340, "center", "#FFFFFF");
    c.restore();
  }

  /** Transition title: hard cut in, letters fade in one by one from left to right
   *  (all visible after 33 frames), then hold, then hard cut out. */
  /** How many lines a transition title wraps to on screen (same font and width as drawTitle). */
  titleLines(text) {
    if (!this._measure) this._measure = new OffscreenCanvas(8, 8).getContext("2d");
    const c = this._measure, size = STYLE.titleText.size;
    c.font = `400 ${size}px "${this.fonts.regular}"`;
    c.letterSpacing = `${-0.03 * size}px`;
    return wrap(c, text, STYLE.width - 240).length;
  }

  drawTitle(t, dur, text, bg) {
    const c = this._begin();
    if (bg?.img) this._fill(c, bg.img, bg.w, bg.h);
    else { c.fillStyle = STYLE.background; c.fillRect(0, 0, STYLE.width, STYLE.height); }
    const size = STYLE.titleText.size;
    c.font = `400 ${size}px "${this.fonts.regular}"`;
    c.letterSpacing = `${-0.03 * size}px`;
    c.textAlign = "left";
    c.textBaseline = "alphabetic";
    c.fillStyle = STYLE.purple;
    const lines = wrap(c, text, STYLE.width - 240);
    const cap = size * 0.727, lineH = size * 1.1;
    const top = (STYLE.height - (cap + (lines.length - 1) * lineH)) / 2 - 18;
    const total = lines.reduce((n, l) => n + [...l].length, 0);
    // Soft wipe: each letter's fade spans ~7 letters' worth of stagger, so the opacity edge is
    // feathered across several letters; the last letter is fully in at 33 frames.
    // reveal takes the same share of the card as in the 2s20f reference (33 of 80 frames)
    const reveal = STYLE.titleReveal * (dur / STYLE.titleDuration);
    const F = STYLE.titleFeather;
    const stagger = reveal / (total - 1 + F);
    const fade = stagger * F;
    let k = 0;
    lines.forEach((line, j) => {
      const chars = [...line];
      const x0 = (STYLE.width - c.measureText(line).width) / 2;
      const y = top + cap + j * lineH;
      chars.forEach((ch, i) => {
        // where this letter sits in the full, kerned line: the prefix up to and including it, minus
        // its own advance (so pairs like "To" keep their kerning and don't collide with the next letter)
        const x = x0 + c.measureText(chars.slice(0, i + 1).join("")).width - c.measureText(ch).width;
        const a = clamp01((t - k * stagger) / fade);
        if (a > 0) { c.globalAlpha = a; c.fillText(ch, x, y); }
        k++;
      });
    });
    c.globalAlpha = 1;
    c.letterSpacing = "0px";
  }

  /** Outro. src=null draws a built-in stand-in. */
  drawOutro(src, t) {
    const c = this._begin();
    if (src?.img) { this._fill(c, src.img, src.w, src.h, "#000"); return; }
    c.fillStyle = STYLE.background;
    c.fillRect(0, 0, STYLE.width, STYLE.height);
    c.globalAlpha = easeOut(t / 0.8);
    this._wordmark(c, STYLE.width / 2, STYLE.height / 2 - 170, 260, "center");
    c.font = `400 40px "${this.fonts.regular}"`;
    c.fillStyle = STYLE.text;
    c.textAlign = "center";
    c.fillText("Thanks for listening", STYLE.width / 2, STYLE.height / 2 + 190);
    c.textAlign = "left";
    c.globalAlpha = 1;
  }
}

// "/" in the text forces a line break ("From Leasing Agent /to VP" → two lines); each part
// still wraps on its own when it's too wide.
function wrap(c, text, maxW) {
  const lines = [];
  for (const part of String(text || "").split("/")) {
    const words = part.split(/\s+/).filter(Boolean);
    let cur = "";
    for (const w of words) {
      const trial = cur ? cur + " " + w : w;
      if (cur && c.measureText(trial).width > maxW) { lines.push(cur); cur = w; } else cur = trial;
    }
    if (cur) lines.push(cur);
  }
  return lines.length ? lines : [""];
}
