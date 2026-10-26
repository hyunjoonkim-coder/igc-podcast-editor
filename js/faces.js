// Face tracking + locked-off framing (port of igc/faces.py), running in the browser.
/* global faceapi */
import { VideoReader } from "./media.js";

const DEAD_ZONE = 0.035;
const SUSTAIN = 3.0;
const MOVE_DUR = 1.2;
const SAMPLE_GAP = 1.0;

let modelReady = null;
function loadModel() {
  if (!modelReady) {
    modelReady = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "vendor/face-api.js";
      s.onload = async () => {
        try {
          await faceapi.nets.tinyFaceDetector.loadFromUri("vendor/model");
          resolve();
        } catch (e) { reject(e); }
      };
      s.onerror = () => reject(new Error("Couldn't load the face detection model"));
      document.head.appendChild(s);
    });
  }
  return modelReady;
}

/** Returns [[t, cx, cy, fh] | [t, null, null, null], ...] normalised to the frame. */
export async function analyzeFaces(src, onProgress = () => {}, signal) {
  await loadModel();
  const tr = src.video;
  const W = 320, H = Math.round((320 * tr.height) / tr.width);
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.35 });
  const out = [];
  let prev = null;

  const detect = async (frame, t) => {
    ctx.drawImage(frame, 0, 0, W, H);
    const dets = await faceapi.detectAllFaces(canvas, opts);
    if (!dets.length) { out.push([t, null, null, null]); return; }
    const score = (d) => {
      const b = d.box;
      let s = b.width * b.height;
      if (prev) s *= 1 - Math.min(0.9, Math.abs((b.x + b.width / 2) / W - prev[0]) + Math.abs((b.y + b.height / 2) / H - prev[1]));
      return s;
    };
    const b = dets.reduce((a, d) => (score(d) > score(a) ? d : a)).box;
    const cx = (b.x + b.width / 2) / W, cy = (b.y + b.height / 2) / H;
    prev = [cx, cy];
    out.push([t, cx, cy, b.height / H]);
  };

  // Fast path: decode keyframes only (webcam files usually have one every 1-2 s).
  const keys = [];
  for (const k of tr.sync) if (!keys.length || k.cts - keys[keys.length - 1].cts >= SAMPLE_GAP) keys.push(k);
  const dur = tr.duration || src.duration;
  if (keys.length >= Math.min(20, dur / 5)) {
    let frame = null;
    const dec = new VideoDecoder({ output: (f) => { frame?.close(); frame = f; }, error: (e) => { throw e; } });
    dec.configure(tr.config);
    for (let n = 0; n < keys.length; n++) {
      if (signal?.aborted) break;
      const smp = tr.samples[keys[n].i];
      const [data] = await src.readSamples([smp]);
      dec.decode(new EncodedVideoChunk({ type: "key", timestamp: Math.round(keys[n].cts * 1e6), data }));
      await dec.flush();
      if (frame) { await detect(frame, keys[n].cts); frame.close(); frame = null; }
      if (n % 10 === 0) onProgress(n / keys.length);
    }
    dec.close();
  } else {
    // Sparse keyframes: decode straight through and sample once a second.
    const r = new VideoReader(src);
    for (let t = 0; t < dur; t += SAMPLE_GAP) {
      if (signal?.aborted) break;
      const f = await r.frameAt(t);
      if (f) await detect(f, t);
      onProgress(t / dur);
    }
    r.close();
  }
  onProgress(1);
  return out;
}

function medianFilter(v, k) {
  if (v.length < k) return v;
  const pad = k >> 1;
  return v.map((_, i) => {
    const w = [];
    for (let j = i - pad; j <= i + pad; j++) w.push(v[Math.max(0, Math.min(v.length - 1, j))]);
    return w.sort((a, b) => a - b)[pad];
  });
}

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : NaN;
}

export class CameraPath {
  constructor(samples) {
    const valid = (samples || []).filter((r) => r[1] !== null);
    this.found = valid.length > 0;
    this.moves = [];
    if (!this.found) { this.x0 = 0.5; this.y0 = 0.42; this.faceH = null; return; }
    const t = samples.map((r) => r[0]);
    const interp = (c) => samples.map((r, i) => {
      if (r[c] !== null) return r[c];
      let a = i - 1, b = i + 1;
      while (a >= 0 && samples[a][c] === null) a--;
      while (b < samples.length && samples[b][c] === null) b++;
      if (a < 0) return samples[b][c];
      if (b >= samples.length) return samples[a][c];
      const u = (t[i] - t[a]) / (t[b] - t[a]);
      return samples[a][c] * (1 - u) + samples[b][c] * u;
    });
    const cx = medianFilter(interp(1), 5), cy = medianFilter(interp(2), 5);
    this.faceH = median(valid.map((r) => r[3]));
    const gap = t.length > 1 ? (t[t.length - 1] - t[0]) / (t.length - 1) : 1;
    const need = Math.max(1, Math.round(SUSTAIN / gap));
    let cam = [median(cx.slice(0, 5)), median(cy.slice(0, 5))];
    this.x0 = cam[0]; this.y0 = cam[1];
    let run = 0;
    for (let i = 0; i < t.length; i++) {
      const off = [Math.abs(cx[i] - cam[0]), Math.abs(cy[i] - cam[1])];
      run = off[0] > DEAD_ZONE || off[1] > DEAD_ZONE ? run + 1 : 0;
      if (run >= need) {
        const from = i - need + 1, to = Math.min(t.length, i + 4);
        const target = [median(cx.slice(from, to)), median(cy.slice(from, to))];
        this.moves.push({ t: t[from], d: MOVE_DUR, fx: cam[0], fy: cam[1], tx: target[0], ty: target[1] });
        cam = target;
        run = 0;
        i += Math.ceil(MOVE_DUR / gap);
      }
    }
  }

  posAt(time) {
    let x = this.x0, y = this.y0;
    for (const m of this.moves) {
      if (time <= m.t) break;
      let u = Math.min(1, (time - m.t) / m.d);
      u = u * u * (3 - 2 * u);
      x = m.fx + (m.tx - m.fx) * u;
      y = m.fy + (m.ty - m.fy) * u;
    }
    return [x, y];
  }

  /** Constant crop size for a source in one layout. */
  cropSize(W, H, outW, outH, faceHeight, faceY, maxUpscale) {
    const aspect = outW / outH;
    const minH = outH / maxUpscale;
    let ch = this.faceH ? (this.faceH * H) / faceHeight : H;
    ch = Math.min(ch, H, W / aspect);
    const floor = Math.min(minH, H, W / aspect);
    ch = Math.max(ch, floor);
    const cx = this.x0 * W, cy = this.y0 * H;
    const roomW = 2 * Math.min(cx, W - cx);
    const roomH = Math.min(cy / faceY, (H - cy) / (1 - faceY));
    const fit = Math.min(roomW / aspect, roomH);
    if (fit < ch) ch = Math.max(fit, floor);
    return [ch * aspect, ch];
  }

  crop(time, W, H, outW, outH, faceHeight, faceY, maxUpscale) {
    const key = `${W}x${H}:${outW}x${outH}:${faceHeight}`;
    if (this._key !== key) { this._key = key; this._size = this.cropSize(W, H, outW, outH, faceHeight, faceY, maxUpscale); }
    const [cw, ch] = this._size;
    const [px, py] = this.posAt(time);
    const sx = Math.max(0, Math.min(W - cw, px * W - cw / 2));
    const sy = Math.max(0, Math.min(H - ch, py * H - ch * faceY));
    return [sx, sy, cw, ch];
  }
}
