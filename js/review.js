// Review comments → edit instructions. For now only "Cut" comments with a start and an end are
// applied automatically; everything else is listed as excluded or as needing a manual check.
// All timecodes are times in the original review video (the host recording).

// HH:MM:SS(:FF|;FF|.mmm) or MM:SS
const TC = String.raw`(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[:;]\d{1,2}|\.\d{1,3})?`;
const RANGE_SEP = String.raw`\s*(?:-|–|—|~|to|→|->|until|till)\s*`;
// a line starts a new comment when it opens with a timecode, optionally after bullets, a comment
// number (#12, 12.) and an author name ("Jane Doe 00:01:23 ...")
const ENTRY = new RegExp(String.raw`^[\s>*•\-–#\d.)\]\[(]*?(?:(?:[A-Z][\w'’.-]*\s+){1,4}[-–:|·]?\s*)?[@(\[]?(${TC})(?:${RANGE_SEP}(${TC}))?[)\]]?\s*[-–—:|·]?\s*(.*)$`);

/** Timecode text → seconds. FF frames are counted at the video's frame rate. */
export function tcToSeconds(tc, fps) {
  const m = String(tc).trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:([:;])(\d{1,2})|\.(\d{1,3}))?$/);
  if (!m) return null;
  const h = Number(m[1] || 0), mi = Number(m[2]), s = Number(m[3]);
  if (mi > 59 || s > 59) return null;
  let t = h * 3600 + mi * 60 + s;
  if (m[5] !== undefined) {
    const f = Number(m[5]);
    if (f >= Math.ceil(fps)) return null;
    t += f / fps;
  }
  if (m[6] !== undefined) t += Number(m[6].padEnd(3, "0")) / 1000;
  return t;
}

/** Split pasted text into comments: [{n, line, startTc, endTc, start, end, text}] */
export function parseComments(text, fps) {
  const out = [];
  let cur = null;
  String(text || "").replace(/\r/g, "").split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const m = line.match(ENTRY);
    if (m) {
      cur = { n: out.length + 1, line: i + 1, startTc: m[1], endTc: m[2] || null, text: m[3].trim() };
      cur.start = tcToSeconds(m[1], fps);
      cur.end = m[2] ? tcToSeconds(m[2], fps) : null;
      out.push(cur);
    } else if (cur) {
      cur.text = (cur.text ? cur.text + " " : "") + line;       // comment continues on the next line
    }
  });
  return out;
}

const CUT = /\b(cut|cuts|cut out|remove|delete)\b/i;
const UNSURE = /\b(probably|maybe|might|perhaps|possibly|consider|not sure|optional|if (?:we|you|it)|could|or not|up to you)\b|\?/i;
const KEEP = /\b(don'?t|do not|no need to|never|shouldn'?t|keep)\b[^.]*\bcut/i;
const OTHER = [
  ["Cold open", /\bcold\s*-?\s*open\b/i],
  ["Move", /\b(move|moved|moving|reorder|swap)\b/i],
  ["Speed", /\b\d+(?:\.\d+)?\s*x\b|\bspeed\b|\bspeed up\b|\bfaster\b|\bslower\b/i],
];
const POINT_ONLY = [
  ["Title / slide", /\b(title|slide|transition|chapter|lower third|l3|card|graphic)\b/i],
  ["Audio", /\b(audio|music|sound|volume|levels?|mic|noise|loud|quiet|mute|sfx)\b/i],
];
// "Cut", "Cut this", "Cut this part." … anything beyond that is a note for the editor
const BARE_CUT = /^(?:please\s+)?(?:cut|remove|delete)(?:\s+(?:this|that|it|out|here|this part|this section|this bit|that part|everything|all of this))*[\s.!,:;-]*$/i;

/**
 * Sort each comment into: cut (applied automatically), manual (a person should look) or
 * excluded (not a cut: another kind of edit, a single-point note, …).
 */
export function classify(c, duration = Infinity) {
  const t = c.text || "";
  const types = OTHER.filter(([, re]) => re.test(t)).map(([k]) => k);
  const pointTypes = POINT_ONLY.filter(([, re]) => re.test(t)).map(([k]) => k);
  const hasCut = CUT.test(t);
  const range = c.end !== null && c.end !== undefined;
  if (c.start === null || (range && c.end === null)) return { ...c, kind: "manual", reason: "Timecode couldn't be read" };
  if (!hasCut) {
    if (types.length) return { ...c, kind: "excluded", type: types.join(" + "), reason: "Separate edit instruction" };
    if (pointTypes.length) return { ...c, kind: "excluded", type: pointTypes.join(" + "), reason: range ? "Not a cut" : "Single-point note" };
    return { ...c, kind: "excluded", type: "Note", reason: range ? "No cut instruction" : "Single-point note" };
  }
  if (KEEP.test(t)) return { ...c, kind: "manual", reason: "Says not to cut / keep" };
  if (types.length) return { ...c, kind: "manual", reason: `Cut mixed with another instruction (${types.join(", ")})` };
  if (UNSURE.test(t)) return { ...c, kind: "manual", reason: "Not a definite request" };
  if (!range) return { ...c, kind: "manual", reason: "No exact range (only one timecode)" };
  if (c.end <= c.start) return { ...c, kind: "manual", reason: "End is before the start" };
  if (c.start >= duration) return { ...c, kind: "manual", reason: "Starts after the end of the video" };
  const memo = BARE_CUT.test(t.trim()) ? "" : t.trim();
  return { ...c, kind: "cut", memo };
}

/** union of [a, b] ranges */
function union(list, gap) {
  const s = list.filter((r) => r.b > r.a).sort((x, y) => x.a - y.a);
  const out = [];
  for (const r of s) {
    const last = out[out.length - 1];
    if (last && r.a <= last.b + gap) { last.b = Math.max(last.b, r.b); last.refs.push(...r.refs); last.memos.push(...r.memos); }
    else out.push({ a: r.a, b: r.b, refs: [...r.refs], memos: [...r.memos] });
  }
  return out;
}

/**
 * Turn cut comments into the cuts to add: snapped to whole frames of the video, overlapping
 * ranges merged, and anything already removed by an existing cut left out.
 * existing: [[a, b]] removal cuts already in the episode (seconds).
 */
export function planCuts(items, { fps, duration = Infinity, existing = [] }) {
  const snap = (t) => Math.round(t * fps) / fps;
  const frame = 1 / fps;
  const wanted = items.filter((c) => c.kind === "cut").map((c) => ({
    a: Math.max(0, snap(c.start)), b: snap(Math.min(c.end, duration)),
    refs: [c.n], memos: c.memo ? [{ n: c.n, text: c.memo }] : [],
  }));
  const merged = union(wanted, frame / 2);
  const have = union(existing.map(([a, b]) => ({ a, b, refs: [], memos: [] })), frame / 2);
  const cuts = [];
  let already = 0;
  for (const m of merged) {
    // subtract what's already cut
    let parts = [[m.a, m.b]];
    for (const h of have) {
      const nx = [];
      for (const [a, b] of parts) {
        if (h.b <= a || h.a >= b) { nx.push([a, b]); continue; }
        already += Math.min(b, h.b) - Math.max(a, h.a);
        if (h.a > a) nx.push([a, h.a]);
        if (h.b < b) nx.push([h.b, b]);
      }
      parts = nx;
    }
    for (const [a, b] of parts) if (b - a >= frame - 1e-9) cuts.push({ a, b, refs: m.refs, memos: m.memos, merged: m.refs.length > 1 });
    if (!parts.length) cuts.push({ a: m.a, b: m.b, refs: m.refs, memos: m.memos, skip: true });
  }
  const removed = cuts.filter((c) => !c.skip).reduce((n, c) => n + (c.b - c.a), 0);
  return { cuts, removed, already, mergedCount: wanted.length - merged.length };
}
