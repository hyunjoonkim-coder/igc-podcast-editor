// Episode structure (matches the In Good Company reference edit):
//
//   [Intro / cold open]  a range of the raw recording, full-frame, music bed from 0:00
//   [Intro bumper]       InGoodCompany_Intro.mp4 (hard cut), music continues
//   [Main episode]       starts at "main start"; first 4.5 s the guest card covers the
//                        picture while the footage audio plays, then the host slides in.
//                        Music fades out as the host appears. Cuts ripple-delete,
//                        transition titles are inserted, split screen (unless layouts say otherwise).
//   [Outro]              InGoodCompany_EPOutro.mp4
//
// Every timecode in a project refers to the RAW host recording. Output is always 30 fps.

export const FPS = 30;

// Measured from the Episode 14 reference (1920x1080).
export const STYLE = {
  width: 1920, height: 1080,
  background: "#F2F1FF", purple: "#38177D", lavender: "#A79BFF", text: "#0E0D0C",
  tracking: "-0.03em",
  logo: { x: 89, y: 87, height: 110 },
  split: {
    panelW: 864, panelH: 468, panelY: 306, leftX: 88, rightX: 968, radius: 8,
    labelBaseline: 825, labelSize: 32, labelLine: 37, faceHeight: 0.33, faceY: 0.45,
  },
  solo: { faceHeight: 0.26, faceY: 0.42 },
  // Lower third: Inter 48 / leading 54 / tracking -10 / #FFFFFF. Each line rises 30 px and fades in
  // over 20 f (ease 100/0), holds 100 f, then drops 30 px and fades out over 20 f (ease 0/100).
  // Lines start 2 f apart.
  // drop shadow: black, 50% opacity, direction 135°, softness 50 (After Effects terms; distance 5 = AE default)
  // Matched to the After Effects comp: Inter Variable, weight 300 (Light), optical size 32, tracking 0.
  l3: { x: 103, baseline: 865, size: 48, weight: 300, line: 54, tracking: 0, rise: 30, inF: 20, holdF: 100, outF: 20, lineOffsetF: 2,
        shadow: { opacity: 0.5, direction: 135, distance: 5, softness: 50 },
        duration: (20 + 100 + 20 + 2 * 2) / 30 },
  guestCard: 4.5,
  // Guest card: all lines 140 / leading 126. If the job title or company would leave title safe
  // (the centre 80% of the frame), use the Episode 15 proportions instead: name 140, title + company
  // 80, baselines 110 then 91 apart. Anything still too wide shrinks just enough to fit.
  guestCardText: { size: 140, leading: 126, subSize: 80, subTracking: -0.015, nameToSub: 110, subLeading: 91, safeWidth: 1920 * 0.8, centerX: 956.5 },   // reference text centre sits at x≈957
  titleText: { size: 180 },
  slideIn: 0.8,
  // transition title: 2s20f on screen; letters fade in left to right over the first 33 frames
  titleReveal: 33 / 30,
  titleDuration: 80 / 30,          // for a ~12-letter title ("This or That")
  titleFeather: 9,                  // ~8 letters are visibly mid-fade at any moment (soft edge)
  // title-card music: -50 dB -> -10 dB over 1s20f, hold while the card is up, -> -50 dB over 1s10f
  titleMusic: { rampIn: 50 / 30, rampOut: 40 / 30, lowDb: -50, highDb: -10, trackAtCard: 202 / 30 },
  bumperFallback: 4,
  hostAudioIntoIntro: 1,            // the host's audio starts 1 s after the Intro clip starts
  outroFallback: 5,
  musicFade: 1.0,
  musicGainDb: -20,
  maxUpscale: 1.6,
};

/** Title length follows the text: "This or That" (12) = 2s20f, "Technology Adoption in Multifamily" (34) = 3s10f. */
/** The lines of a person's name block: name, the job title (may be 2+ lines), company. */
export function personLines(p = {}) {
  const title = String(p.title || "").split(/\n/).map((x) => x.trim()).filter(Boolean);
  return [p.name, ...title, p.company].map((x) => String(x || "").trim()).filter(Boolean);
}

/** A lower third stays up until its top line has gone out: lines leave 2 frames apart. */
export function l3Duration(p) {
  const L = STYLE.l3, n = Math.max(1, personLines(p).length);
  return (L.inF + L.holdF + L.outF + (n - 1) * L.lineOffsetF) / 30;
}

export function titleLength(text) {
  const n = [...String(text || "")].length;
  const frames = Math.round(80 + (n - 12) * (20 / 22));
  return Math.min(150, Math.max(60, frames)) / FPS;
}

export function snap(t, fps = FPS) { return Math.round(t * fps) / fps; }

export function parseTc(v, fps = FPS) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return snap(v, fps);
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return snap(parseFloat(s), fps);
  const p = s.split(/[:;]/).map((x) => (/^\d+$/.test(x) ? parseInt(x, 10) : NaN));
  if (p.some(isNaN)) throw new Error(`Invalid timecode: ${v} (e.g. 00:01:23:15)`);
  let h = 0, m = 0, sec = 0, f = 0;
  if (p.length === 4) [h, m, sec, f] = p;
  else if (p.length === 3) [h, m, sec] = p;
  else if (p.length === 2) [m, sec] = p;
  else throw new Error(`Invalid timecode: ${v}`);
  if (f >= Math.round(fps)) throw new Error(`Frame ${f} is out of range for ${fps}fps: ${v}`);
  return snap(h * 3600 + m * 60 + sec + f / fps, fps);
}

export function fmtTc(t, fps = FPS) {
  if (t === null || t === undefined || isNaN(t)) return "";
  const nf = Math.round(fps);
  const total = Math.round(t * fps);
  const f = total % nf, s = Math.floor(total / nf);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}:${pad(f)}`;
}

function subtract(range, cuts, fps) {
  let keep = [range];
  for (const [a, b] of cuts) {
    const nxt = [];
    for (const [s, e] of keep) {
      if (b <= s || a >= e) { nxt.push([s, e]); continue; }
      if (a > s) nxt.push([s, a]);
      if (b < e) nxt.push([b, e]);
    }
    keep = nxt;
  }
  return keep.filter(([s, e]) => e - s >= 1 / fps);
}

/**
 * Reorder the kept source ranges. Each move takes the source range [start, end] out of the play
 * order (closing the gap) and inserts it right before the moment source time `to` plays
 * (`to` empty = at the end of the episode). Ranges are split wherever needed.
 */
export function applyMoves(keep, moves, fps) {
  let order = keep.map(([s, e]) => [s, e]);
  const tiny = 1 / fps - 1e-6;
  for (const m of moves) {
    const a = m.a, b = m.b, to = m.to;
    if (!(b > a)) continue;
    if (to !== null && to > a + 1e-6 && to < b - 1e-6) continue;     // can't drop a range inside itself
    const rest = [], moved = [];
    for (const [s, e] of order) {
      if (e <= a || s >= b) { rest.push([s, e]); continue; }
      if (s < a) rest.push([s, a]);
      moved.push([Math.max(s, a), Math.min(e, b)]);
      if (e > b) rest.push([b, e]);
    }
    if (!moved.length) continue;
    let idx = rest.length;
    if (to !== null) {
      const hit = rest.findIndex(([s, e]) => to >= s - 1e-6 && to < e - 1e-6);
      if (hit >= 0) {
        const [s, e] = rest[hit];
        if (to > s + tiny) { rest.splice(hit, 1, [s, to], [to, e]); idx = hit + 1; }
        else idx = hit;
      } else {
        // `to` sits in a gap (cut away or moved): insert before the next range in source order
        let best = -1;
        rest.forEach(([s], i) => { if (s >= to && (best < 0 || s < rest[best][0])) best = i; });
        if (best >= 0) idx = best;
      }
    }
    rest.splice(idx, 0, ...moved);
    order = rest.filter(([s, e]) => e - s > tiny);
  }
  return order;
}

/**
 * @param project the editable project object
 * @param env     { sources: {host:{duration}, guest?:{duration}}, bumperDuration, outroDuration }
 */
export function buildTimeline(project, env) {
  const fps = FPS;
  const T = (v) => parseTc(v, fps);
  if (!env.sources.host) throw new Error("Choose the host video");
  const hasGuest = !!env.sources.guest;

  let srcEnd = Infinity;
  for (const [role, s] of Object.entries(env.sources)) {
    if (role === "hostintro") continue;          // separate file, own timeline
    const off = role === "guest" ? Number(project.sources?.guest?.offset || 0) : 0;
    srcEnd = Math.min(srcEnd, s.duration - Math.max(0, off));
  }
  srcEnd = Math.floor(srcEnd * fps) / fps;

  // A cut either removes its range, or (with a speed of 1–2×) keeps it and plays it faster.
  const ranges = (project.cuts || []).map((c) => {
    const a = T(c.start), b = T(c.end);
    if (a === null || b === null) throw new Error("Every cut needs both a start and an end");
    if (b <= a) throw new Error(`Cut ends before it starts: ${c.start} → ${c.end}`);
    const isSpeed = c.mode === "speed" || Number(c.speed) > 1;
    const sp = Math.min(2, Math.max(1, Number(c.speed) || 1));
    return { a, b, speed: isSpeed ? sp : null, id: c.id };
  });
  const cuts = ranges.filter((r) => !r.speed).map((r) => [r.a, r.b]).sort((x, y) => x[0] - y[0]);
  // Segment speeds set on the Edited bar: [{id, start, end, speed}] (source timecodes)
  const segSpeeds = (project.speeds || []).map((x) => ({ a: T(x.start), b: T(x.end), speed: Math.min(2, Math.max(1, Number(x.speed) || 1)), id: x.id }))
    .filter((x) => x.a !== null && x.b !== null && x.b > x.a);
  const speedRanges = [...ranges.filter((r) => r.speed), ...segSpeeds].sort((x, y) => x.a - y.a);
  const rangeAt = (a, b) => { const m = (a + b) / 2; return speedRanges.find((r) => m >= r.a && m < r.b) || null; };
  const speedAt = (a, b) => rangeAt(a, b)?.speed ?? 1;

  const items = [];
  let cursor = 0;
  let bumper = null, bumperTail = null;
  const push = (it) => { if (it.kind === "footage") { it.speed = it.speed || 1; it.srcDur = it.srcDur ?? it.duration * it.speed; } it.outStart = cursor; it.outEnd = cursor + it.duration; it.overlays = []; items.push(it); cursor += it.duration; return it; };

  // 1) intro / cold open
  const intro = project.intro || null;
  let introOut = null;
  if (intro) {
    const a = T(intro.start), b = T(intro.end);
    if (a === null || b === null) throw new Error("The intro needs a start and an end");
    if (b <= a) throw new Error("The intro ends before it starts");
    const camera = intro.camera === "host" || !hasGuest ? "host" : "guest";
    const start = cursor;
    for (const [s, e] of subtract([a, Math.min(b, srcEnd)], cuts, fps)) {
      push({ kind: "footage", part: "intro", srcStart: s, duration: Math.round((e - s) * fps) / fps, layout: "solo", camera });
    }
    introOut = { start, end: cursor, camera };
    // 2) Intro clip (InGoodCompany_Intro.mp4). Only its first second stands alone: after that the
    //    next footage (host intro / main) is already running underneath, so the host's voice starts
    //    1 s into the clip while the clip's picture plays to its end.
    const bDur = Math.round((env.bumperDuration || STYLE.bumperFallback) * fps) / fps;
    const lead = Math.min(bDur, STYLE.hostAudioIntoIntro);
    bumper = { start: cursor, end: cursor + bDur };
    push({ kind: "bumper", duration: lead });
    bumperTail = { kind: "bumper", outStart: cursor, outEnd: bumper.end, bumperStart: bumper.start };
  }

  // 2b) host intro: its own video file (timecodes are that file's own). Host full screen.
  //     The guest card covers its first 4.5 s (the host's voice already plays), then the host slides in.
  let cardStart = null, hiRange = null;
  const hi = project.host_intro;
  if (hi) {
    const file = env.sources.hostintro;
    if (!file) throw new Error("Choose the host intro video (or turn the host intro off)");
    const a = T(hi.start) ?? 0;
    const b = Math.min(T(hi.end) ?? file.duration, Math.floor(file.duration * fps) / fps);
    if (b <= a) throw new Error("The host intro ends before it starts");
    cardStart = cursor;
    hiRange = [a, b];
    push({ kind: "footage", part: "hostintro", src: "hostintro", srcStart: a, duration: Math.round((b - a) * fps) / fps, layout: "solo", camera: "hostintro" });
  }

  // 3) main episode
  // The main episode is the whole host recording; unwanted parts are removed with cuts.
  const inPoint = 0;
  const outPoint = srcEnd;
  if (outPoint <= inPoint) throw new Error("The end point is before the main start");
  const keep = subtract([inPoint, outPoint], cuts, fps);
  if (!keep.length) throw new Error("The cuts remove all of the main footage");
  // moves: play parts of the recording in a different order
  const moves = (project.moves || []).map((m) => ({ a: T(m.start), b: T(m.end), to: m.to ? T(m.to) : null, id: m.id }))
    .filter((m) => m.a !== null && m.b !== null && m.b > m.a);
  const order = applyMoves(keep, moves, fps);
  const movedAt = (t) => moves.find((m) => t >= m.a - 1e-6 && t < m.b - 1e-6)?.id ?? null;
  const snapIntoKeep = (t) => {
    for (const [s, e] of keep) {
      if (t < s) return s;
      if (t >= s && t <= e) return t;
    }
    return keep[keep.length - 1][1];
  };

  // Titles keep their place: a title stays right after the footage that came before it, counting
  // only footage that wasn't moved away. Moving parts around never drags a title along with them.
  const realMoves = moves.filter((m) => !(m.to !== null && m.to > m.a + 1e-6 && m.to < m.b - 1e-6));
  const stay = keep.flatMap((k) => subtract(k, realMoves.map((m) => [m.a, m.b]), fps));   // footage that wasn't moved
  const anchorOf = (at) => {
    let p = null;
    for (const [s0, e0] of stay) if (s0 < at - 1e-6) p = Math.max(p ?? -Infinity, Math.min(e0, at));
    return p;                                           // null = at the very start of the main episode
  };
  const titles = (project.titles || []).map((t) => {
    const at = T(t.at);
    if (at === null) throw new Error("Every title needs a timecode");
    return { at, anchor: anchorOf(at), text: t.text || "", duration: Number(t.duration || titleLength(t.text)), done: false };
  }).sort((a, b) => a.at - b.at);
  // Layout switches by timecode: [{at, layout: "split" | "host" | "guest"}]. With none set, the
  // main episode is split screen from its first frame (the host intro before it is host only).
  let switches = (project.layouts || []).map((l) => ({ at: T(l.at), layout: l.layout || "split" }))
    .filter((l) => l.at !== null).sort((a, b) => a.at - b.at);
  if (!switches.length) switches = [{ at: inPoint, layout: "split" }];
  if (!hasGuest) switches = [];
  const layoutAt = (t) => {
    let l = "host";
    for (const sw of switches) if (sw.at <= t + 1e-6) l = sw.layout;
    return l;
  };
  const splitT = switches.find((x) => x.layout === "split")?.at ?? Infinity;

  const mainStart = cursor;
  const bps = [...new Set([...titles.map((t) => t.anchor).filter((x) => x !== null), ...switches.map((x) => x.at), ...speedRanges.flatMap((r) => [r.a, r.b])])]
    .filter(isFinite).sort((a, b) => a - b);
  const isMoved = (t) => realMoves.some((m) => t >= m.a - 1e-6 && t < m.b - 1e-6);
  const emitTitles = (test) => {
    for (const t of titles) if (!t.done && test(t)) { t.done = true; push({ kind: "title", srcStart: t.at, duration: t.duration, text: t.text }); }
  };
  emitTitles((t) => t.anchor === null);                 // titles before any (unmoved) footage
  for (const [s, e] of order) {
    const pts = [s, ...bps.filter((b) => b > s && b < e), e];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const speed = speedAt(a, b);
      const dur = Math.round(((b - a) / speed) * fps) / fps;
      if (dur <= 0) continue;
      const l = layoutAt(a);
      push({ kind: "footage", part: "main", srcStart: a, srcDur: b - a, speed, speedId: rangeAt(a, b)?.id ?? null, moveId: movedAt(a), duration: dur, layout: l === "split" ? "split" : "solo", camera: l === "guest" ? "guest" : "host" });
      if (!isMoved(a)) emitTitles((t) => Math.abs(t.anchor - b) < 1e-6);   // titles that sit right after this footage
    }
  }
  for (const t of titles) if (!t.done) push({ kind: "title", srcStart: t.at, duration: t.duration, text: t.text });

  // 4) outro
  if (project.end_card !== false) push({ kind: "outro", duration: Math.round((env.outroDuration || STYLE.outroFallback) * fps) / fps });

  // source time (main) -> output time
  const toOut = (t) => {
    t = snapIntoKeep(t);
    let best = null;
    for (const it of items) {
      if (it.part === "main" && it.srcStart <= t && t <= it.srcStart + it.srcDur) {
        const c = it.outStart + (t - it.srcStart) / it.speed;
        best = best === null ? c : Math.max(best, c);
      }
    }
    return best ?? mainStart;
  };

  // overlays on the output timeline
  const overlays = [];
  const person = (role) => ({ ...(project.people?.[role] || {}) });
  // the guest card is pure graphics: it only needs the guest's name, not the guest video
  const guestCardOn = project.guest_card !== false && !!person("guest").name;
  // the guest card follows the Intro clip's picture
  const gcStart = bumper ? bumper.end : (cardStart ?? mainStart);
  const gcEnd = guestCardOn ? gcStart + STYLE.guestCard : gcStart;
  if (bumperTail && bumperTail.outEnd > bumperTail.outStart) overlays.push(bumperTail);
  if (guestCardOn) overlays.push({ kind: "guestcard", outStart: gcStart, outEnd: gcEnd + STYLE.slideIn, cardEnd: gcEnd, person: person("guest") });
  const autoL3 = project.auto_l3 === true;
  if (autoL3 && introOut) {
    const p = person(introOut.camera);
    if (p.name) overlays.push({ kind: "l3", outStart: introOut.start, outEnd: introOut.start + l3Duration(p), person: p, role: introOut.camera, part: "intro" });
  }
  if (autoL3 && person("host").name) {
    const at = gcEnd + (guestCardOn ? STYLE.slideIn + 0.2 : 0.5);
    overlays.push({ kind: "l3", outStart: at, outEnd: at + l3Duration(person("host")), person: person("host"), role: "host", part: "main" });
  }
  for (const l3 of project.lower_thirds || []) {
    const role = l3.person;
    const p = role === "custom" ? { name: l3.name, title: l3.title, company: l3.company } : person(role);
    if (!p.name) continue;
    // lower thirds are placed on the EDITED timeline (00:00:00:00 = first frame of the episode)
    const o = T(l3.at);
    if (o === null || o >= cursor) continue;
    overlays.push({ kind: "l3", outStart: o, outEnd: o + Number(l3.duration || l3Duration(p)), person: p, role, part: "edited" });
  }
  for (const it of items) {
    if (it.kind === "footage") it.overlays = overlays.filter((ov) => ov.outStart < it.outEnd && ov.outEnd > it.outStart);
  }
  const music = intro ? { start: 0, fadeStart: gcEnd, end: gcEnd + STYLE.musicFade } : null;
  // music clips: the intro bed, plus a swell around every title card
  const tm = STYLE.titleMusic;
  const musicClips = [];
  if (music) musicClips.push({ kind: "bed", start: 0, end: music.end, track: 0, fadeStart: music.fadeStart });
  for (const it of items.filter((i) => i.kind === "title")) {
    const start = Math.max(0, it.outStart - tm.rampIn);
    musicClips.push({ kind: "title", start, holdStart: it.outStart, holdEnd: it.outEnd, end: it.outEnd + tm.rampOut,
      track: tm.trackAtCard - (it.outStart - start) });
  }
  const chapters = [{ t: 0, name: "Intro" }, ...items.filter((i) => i.kind === "title").map((i) => ({ t: i.outStart, name: i.text }))];
  return { items, overlays, music, musicClips, switches, speedRanges, duration: cursor, keep, order, moves, cuts, chapters, toOut, splitT, inPoint, outPoint, intro: introOut,
    introRange: intro ? [T(intro.start), T(intro.end)] : null, mainStart,
    hostIntroRange: hiRange, hostIntroStart: cardStart, guestCardEnd: gcEnd };
}
