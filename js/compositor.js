// Draws every output frame on a canvas. All layout numbers are in 1920x1080 space.
import { STYLE, personLines } from "./timeline.js";

const clamp01 = (u) => Math.min(1, Math.max(0, u));
const easeOut = (u) => 1 - Math.pow(1 - clamp01(u), 3);
const easeInOut = (u) => { u = clamp01(u); return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; };
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
// In:  leaves the first key linearly, arrives with 100% influence (decelerates to rest).
const easeIn100 = bezier(0.333, 0.333, 0, 1);
// Out: leaves with 100% influence (starts slowly), reaches the last key linearly.
const easeOut100 = bezier(1, 0, 0.667, 0.667);

export const DEFAULT_FONTS = { title: "Barlow Condensed", bold: "Inter", regular: "Inter" };

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
    ]).catch(() => {});
    this.splitBg = null;
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
      if (main?.img) c.drawImage(main.img, ...main.crop, 0, 0, STYLE.width, STYLE.height);
    }
  }

  _panel(c, src, x, y, w, h, r) {
    c.save();
    c.beginPath();
    c.roundRect(x, y, w, h, r);
    c.clip();
    c.fillStyle = "#111";
    c.fillRect(x, y, w, h);
    if (src?.img) c.drawImage(src.img, ...src.crop, x, y, w, h);
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
    c.font = `${L.weight} ${L.size}px "${this.fonts.regular}"`;
    c.letterSpacing = `${L.tracking * L.size}px`;
    c.textBaseline = "alphabetic";
    c.fillStyle = "#FFFFFF";
    const sh = L.shadow, rad = (sh.direction * Math.PI) / 180;   // AE: 0° = up, clockwise
    c.shadowColor = `rgba(0,0,0,${sh.opacity})`;
    c.shadowOffsetX = Math.sin(rad) * sh.distance * this.scale;
    c.shadowOffsetY = -Math.cos(rad) * sh.distance * this.scale;
    c.shadowBlur = sh.softness * 0.6 * this.scale;
    const f = t * 30;                              // frames
    lines.forEach((text, j) => {
      // in: top line first (1, 2, 3, …) · out: bottom line first (…, 3, 2, 1) · 2 frames apart
      const inStart = j * L.lineOffsetF;
      const outStart = L.inF + L.holdF + (n - 1 - j) * L.lineOffsetF;
      let u;                                       // 0 = hidden/low, 1 = in place
      let dy;
      if (f < inStart) return;
      if (f < inStart + L.inF) { u = easeIn100((f - inStart) / L.inF); dy = L.rise * (1 - u); }
      else if (f < outStart) { u = 1; dy = 0; }
      else { const k = easeOut100((f - outStart) / L.outF); u = 1 - k; dy = L.rise * k; }
      if (u <= 0.002) return;
      c.globalAlpha = u;
      c.fillText(text, x, base + j * L.line + dy);
    });
    c.globalAlpha = 1;
    c.letterSpacing = "0px";
    c.shadowColor = "transparent";
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
      c.font = `400 ${size}px "${this.fonts.regular}"`;
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

  /** Guest intro card. The whole block fades in while rising. t = seconds since the card appeared. */
  drawGuestCard(t, person) {
    const c = this._begin();
    c.fillStyle = STYLE.background;
    c.fillRect(0, 0, STYLE.width, STYLE.height);
    const u = easeOut(t / 0.6);
    const dy = 34 * (1 - u);
    c.globalAlpha = u;
    const { lines, compact } = this.guestCardLayout(person);
    // the shorter compact block sits a little lower, as in the Episode 15 reference (quote top 311)
    // a 2-line job title adds a line: lift the block by half of each extra line so it stays centred
    const G = STYLE.guestCardText, extra = Math.max(0, lines.length - 3);
    const step = compact ? (lines[1] ? G.subLeading * (lines[1].size / G.subSize) : G.subLeading) : G.leading;
    const qTop = (compact ? 311 : 268) - (extra * step) / 2;
    if (this.quote) c.drawImage(this.quote, 960 - this.quote.width / 2, qTop + dy);
    else this._quoteIcon(c, 960, qTop + 51 + dy, 1);
    c.textAlign = "center";
    c.textBaseline = "alphabetic";
    c.fillStyle = STYLE.purple;
    const first = qTop + 105 + 48 + (lines[0]?.size ?? 140) * 0.727;
    for (const ln of lines) {
      c.font = `400 ${ln.size}px "${this.fonts.regular}"`;
      const ls = (ln.track ?? -0.03) * ln.size;
      c.letterSpacing = `${ls}px`;
      // the canvas also adds spacing after the last letter; shift by half of it to stay truly centred
      c.fillText(ln.text, STYLE.guestCardText.centerX + ls / 2, first + ln.dy + dy);
    }
    c.globalAlpha = 1;
    c.letterSpacing = "0px";
    c.textAlign = "left";
  }

  /** Rect of the host panel during the slide-in (u = 0..1). */
  slideRect(u) {
    const m = 30, W = STYLE.width, H = STYLE.height;
    const split = 0.62;
    if (u < split) {
      const k = easeInOut(u / split);
      return { x: lerp(W + 10, m, k), y: m, w: W - 2 * m, h: H - 2 * m, r: 28 };
    }
    const k = easeInOut((u - split) / (1 - split));
    return { x: lerp(m, 0, k), y: lerp(m, 0, k), w: lerp(W - 2 * m, W, k), h: lerp(H - 2 * m, H, k), r: lerp(28, 0, k) };
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
    if (src?.img) c.drawImage(src.img, ...src.crop, r.x, r.y, r.w, r.h);
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

function wrap(c, text, maxW) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const trial = cur ? cur + " " + w : w;
    if (cur && c.measureText(trial).width > maxW) { lines.push(cur); cur = w; } else cur = trial;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}
