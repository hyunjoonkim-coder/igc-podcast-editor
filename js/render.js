// Renders the whole episode in the browser: audio mix -> AAC, frames -> H.264 (30 fps), muxed to MP4.
/* global Mp4Muxer */
import { buildTimeline, STYLE, FPS } from "./timeline.js";
import { AudioStream, VideoReader, AUDIO_RATE } from "./media.js";
import { Compositor } from "./compositor.js";
import { timeStretch } from "./stretch.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function episodeEnv(project, sources, assets) {
  const env = { fps: FPS, sources: {} };
  if (sources.host) env.sources.host = { duration: sources.host.duration };
  if (sources.guest) env.sources.guest = { duration: sources.guest.duration };
  if (sources.hostintro) env.sources.hostintro = { duration: sources.hostintro.duration };
  env.bumperDuration = assets.bumper?.duration || STYLE.bumperFallback;
  env.outroDuration = assets.outro?.duration || STYLE.outroFallback;
  return env;
}

export function timelineFor(project, sources, assets) {
  return buildTimeline(project, episodeEnv(project, sources, assets));
}

const db2amp = (db) => Math.pow(10, db / 20);

/** Music playing at output time t: [{track: seconds into the music file, gain: linear}] */
export function musicAt(tl, project, t) {
  const out = [];
  for (const c of tl.musicClips || []) {
    if (t < c.start || t >= c.end) continue;
    let g;
    if (c.kind === "bed") {
      g = db2amp(Number(project.music_db ?? STYLE.musicGainDb));
      if (t > c.fadeStart) g *= 1 - (t - c.fadeStart) / (c.end - c.fadeStart);
    } else {
      const m = STYLE.titleMusic;
      let dbv = m.highDb;
      if (t < c.holdStart) dbv = m.lowDb + (m.highDb - m.lowDb) * ((t - c.start) / (c.holdStart - c.start || 1));
      else if (t > c.holdEnd) dbv = m.highDb + (m.lowDb - m.highDb) * ((t - c.holdEnd) / (c.end - c.holdEnd || 1));
      g = db2amp(dbv);
    }
    out.push({ track: c.track + (t - c.start), gain: g });
  }
  return out;
}

async function pickVideoConfig(W, H, draft) {
  const base = { width: W, height: H, framerate: FPS, bitrate: draft ? 3_000_000 : 12_000_000, avc: { format: "avc" } };
  for (const codec of ["avc1.640028", "avc1.4d0028", "avc1.42003e"]) {
    for (const hw of ["prefer-hardware", "no-preference"]) {
      const cfg = { ...base, codec, hardwareAcceleration: hw };
      const r = await VideoEncoder.isConfigSupported(cfg).catch(() => ({ supported: false }));
      if (r.supported) return cfg;
    }
  }
  throw new Error("This browser can't encode H.264. Please use the latest Chrome or Edge.");
}

async function pickAudioConfig() {
  for (const codec of ["mp4a.40.2", "opus"]) {
    const cfg = { codec, sampleRate: AUDIO_RATE, numberOfChannels: 2, bitrate: 192_000 };
    const r = await AudioEncoder.isConfigSupported(cfg).catch(() => ({ supported: false }));
    if (r.supported) return cfg;
  }
  throw new Error("This browser can't encode audio");
}

/**
 * sources: { host: Mp4Source, guest?: Mp4Source }
 * assets:  { bumper?, titleBg?, outro? } each {kind:'video', src, duration} | {kind:'image', bitmap, w, h}
 *          music?: { buffer: AudioBuffer (48 kHz) }
 * paths:   { host: CameraPath, guest?: CameraPath }
 */
export async function renderEpisode({ project, sources, assets, paths, brand, draft, writable, onProgress, signal }) {
  const tl = timelineFor(project, sources, assets);
  const W = draft ? 960 : STYLE.width, H = draft ? 540 : STYLE.height;
  const canvas = new OffscreenCanvas(W, H);
  const comp = new Compositor(canvas);
  await comp.setBrand(brand);
  comp.setPeople(project.people);

  const vcfg = await pickVideoConfig(W, H, draft);
  const acfg = await pickAudioConfig();
  const target = writable ? new Mp4Muxer.FileSystemWritableFileStreamTarget(writable) : new Mp4Muxer.ArrayBufferTarget();
  const muxer = new Mp4Muxer.Muxer({
    target,
    video: { codec: "avc", width: W, height: H, frameRate: FPS },
    audio: { codec: acfg.codec === "opus" ? "opus" : "aac", numberOfChannels: 2, sampleRate: AUDIO_RATE },
    fastStart: writable ? false : "in-memory",
    firstTimestampBehavior: "offset",
  });

  const check = () => { if (signal?.aborted) throw new DOMException("Cancelled", "AbortError"); };
  const report = (phase, frac, extra = {}) => onProgress?.({ phase, frac, ...extra });

  // ---------------------------------------------------------------- audio pass
  const audioChunks = [];
  let encErr = null;
  const aenc = new AudioEncoder({ output: (chunk, meta) => audioChunks.push({ chunk, meta }), error: (e) => { encErr = e; } });
  aenc.configure(acfg);
  const totalSamples = Math.round(tl.duration * AUDIO_RATE);
  // per-mic level in dB (0 = as recorded, ±20)
  const vol = (role) => Math.pow(10, Number(project.sources?.[role]?.volume_db ?? 0) / 20);
  const off = Number(project.sources?.guest?.offset || 0);
  const music = assets.music?.buffer || null;
  const mL = music?.getChannelData(0), mR = music ? music.getChannelData(Math.min(1, music.numberOfChannels - 1)) : null;
  const CH = 4800;
  // AAC encoders put 2112 samples of priming in front of the audio, and the muxer doesn't write an
  // edit list to hide it, so players would hear everything ~44 ms late. Skip that much of the mix
  // up front (and pad the end) so the audio lines up with the picture.
  let skip = acfg.codec.startsWith("mp4a") ? 2112 : 0;
  let encPos = 0;
  const encode = (L, R) => {
    let a = 0;
    if (skip > 0) { a = Math.min(skip, L.length); skip -= a; }
    const n = L.length - a;
    if (n <= 0) return;
    const data = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { data[i] = Math.max(-1, Math.min(1, L[a + i])); data[n + i] = Math.max(-1, Math.min(1, R[a + i])); }
    const ad = new AudioData({ format: "f32-planar", sampleRate: AUDIO_RATE, numberOfFrames: n, numberOfChannels: 2,
      timestamp: Math.round((encPos / AUDIO_RATE) * 1e6), data });
    encPos += n;
    aenc.encode(ad);
    ad.close();
  };

  for (const it of tl.items) {
    check();
    const s0 = Math.round(it.outStart * AUDIO_RATE), s1 = Math.round(it.outEnd * AUDIO_RATE);
    const streams = [];
    if (it.kind === "footage" && it.src === "hostintro") {
      streams.push([new AudioStream(sources.hostintro, it.srcStart), vol("hostintro")]);
    } else if (it.kind === "footage") {
      streams.push([new AudioStream(sources.host, it.srcStart), vol("host")]);
      if (sources.guest) streams.push([new AudioStream(sources.guest, it.srcStart + off), vol("guest")]);
    } else {
      const a = { bumper: assets.bumper, title: assets.titleBg, outro: assets.outro }[it.kind];
      if (a?.kind === "video") streams.push([new AudioStream(a.src, 0), 1]);
    }
    // sped-up range: read the whole source span, mix, then time-stretch it (pitch preserved)
    let pre = null;
    if (it.kind === "footage" && it.speed > 1) {
      const outLen = s1 - s0, srcLen = Math.round(outLen * it.speed) + 2048;
      const ML = new Float32Array(srcLen), MR = new Float32Array(srcLen);
      for (const [st, g] of streams) {
        const [l, r] = await st.read(srcLen);
        for (let i = 0; i < srcLen; i++) { ML[i] += l[i] * g; MR[i] += r[i] * g; }
      }
      pre = timeStretch(ML, MR, it.speed, outLen);
    }
    for (let p = s0; p < s1; p += CH) {
      const n = Math.min(CH, s1 - p);
      const L = new Float32Array(n), R = new Float32Array(n);
      if (pre) { L.set(pre[0].subarray(p - s0, p - s0 + n)); R.set(pre[1].subarray(p - s0, p - s0 + n)); }
      else for (const [st, g] of streams) {
        const [l, r] = await st.read(n);
        for (let i = 0; i < n; i++) { L[i] += l[i] * g; R[i] += r[i] * g; }
      }
      const c0 = p / AUDIO_RATE, c1 = (p + n) / AUDIO_RATE;
      if (music && (tl.musicClips || []).some((c) => c.start < c1 && c.end > c0)) {
        for (let i = 0; i < n; i++) {
          const t = (p + i) / AUDIO_RATE;
          for (const m of musicAt(tl, project, t)) {
            const k = Math.round(m.track * AUDIO_RATE);
            if (k < 0 || k >= mL.length) continue;
            L[i] += mL[k] * m.gain; R[i] += mR[k] * m.gain;
          }
        }
      }
      encode(L, R);
      while (aenc.encodeQueueSize > 20) await sleep(1);
      if (encErr) throw encErr;
      report("audio", p / totalSamples);
    }
    streams.forEach(([st]) => st.close());
  }
  if (acfg.codec.startsWith("mp4a")) encode(new Float32Array(2112), new Float32Array(2112));
  await aenc.flush();
  aenc.close();
  if (encErr) throw encErr;

  // ---------------------------------------------------------------- video pass
  let vErr = null;
  let ai = 0;
  const venc = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta);
      while (ai < audioChunks.length && audioChunks[ai].chunk.timestamp <= chunk.timestamp) {
        muxer.addAudioChunk(audioChunks[ai].chunk, audioChunks[ai].meta); ai++;
      }
    },
    error: (e) => { vErr = e; },
  });
  venc.configure(vcfg);

  const readers = {
    host: new VideoReader(sources.host),
    guest: sources.guest ? new VideoReader(sources.guest) : null,
    hostintro: sources.hostintro ? new VideoReader(sources.hostintro) : null,
    bumper: assets.bumper?.kind === "video" ? new VideoReader(assets.bumper.src) : null,
    title: assets.titleBg?.kind === "video" ? new VideoReader(assets.titleBg.src) : null,
    outro: assets.outro?.kind === "video" ? new VideoReader(assets.outro.src) : null,
  };
  const asImg = (a) => (a?.kind === "image" ? { img: a.bitmap, w: a.w, h: a.h } : null);
  const frameImg = (f) => (f ? { img: f, w: f.displayWidth, h: f.displayHeight } : null);
  const sp = STYLE.split;
  const so = STYLE.solo;
  const camTime = (role, st) => (role === "guest" ? st + off : st);
  const cropFor = (fr, role, ow, oh, fh, fy, time) => fr && paths[role].crop(time, fr.displayWidth, fr.displayHeight, ow, oh, fh, fy, STYLE.maxUpscale);

  const N = Math.round(tl.duration * FPS);
  let idx = 0;
  const t0 = performance.now();
  try {
    for (let f = 0; f < N; f++) {
      check();
      const t = f / FPS;
      while (idx < tl.items.length - 1 && t >= tl.items[idx].outEnd - 1e-6) idx++;
      const it = tl.items[idx];
      const local = t - it.outStart;
      if (it.kind === "footage") {
        const st = it.srcStart + local * (it.speed || 1);
        const gc = it.overlays.find((o) => o.kind === "guestcard" && t >= o.outStart && t < o.outEnd);
        const bo = it.overlays.find((o) => o.kind === "bumper" && t >= o.outStart && t < o.outEnd);
        if (bo) {
          // Intro clip still on screen; this footage's audio is already playing underneath
          const bl = t - bo.bumperStart;
          comp.drawBumper(readers.bumper ? frameImg(await readers.bumper.frameAt(bl)) : asImg(assets.bumper), bl);
        } else if (gc && t < gc.cardEnd) {
          comp.drawGuestCard(t - gc.outStart, gc.person);
        } else if (it.layout === "split") {
          const hf = await readers.host.frameAt(st);
          const gf = readers.guest && st + off >= 0 ? await readers.guest.frameAt(st + off) : null;
          comp.drawFootage("split",
            { img: hf, crop: cropFor(hf, "host", sp.panelW, sp.panelH, sp.faceHeight, sp.faceY, st) },
            { img: gf, crop: cropFor(gf, "guest", sp.panelW, sp.panelH, sp.faceHeight, sp.faceY, st + off) });
        } else {
          const role = it.src === "hostintro" ? "hostintro" : it.camera === "guest" && readers.guest ? "guest" : "host";
          const ct = camTime(role, st);
          const fr = ct >= 0 ? await readers[role].frameAt(ct) : null;
          const src = { img: fr, crop: cropFor(fr, role, STYLE.width, STYLE.height, so.faceHeight, so.faceY, ct) };
          if (gc) {
            comp.drawGuestCard(t - gc.outStart, gc.person);
            comp.drawSlidePanel((t - gc.cardEnd) / (gc.outEnd - gc.cardEnd), src);
          } else comp.drawFootage("solo", src);
        }
        for (const ov of it.overlays) {
          if (ov.kind === "l3" && t >= ov.outStart && t < ov.outEnd) comp.drawL3(t - ov.outStart, ov.outEnd - ov.outStart, ov.person, it.layout, ov.role);
        }
      } else if (it.kind === "bumper") {
        comp.drawBumper(readers.bumper ? frameImg(await readers.bumper.frameAt(local)) : asImg(assets.bumper), local);
      } else if (it.kind === "title") {
        const bg = readers.title ? frameImg(await readers.title.frameAt(local)) : asImg(assets.titleBg);
        comp.drawTitle(local, it.duration, it.text, bg);
      } else {
        comp.drawOutro(readers.outro ? frameImg(await readers.outro.frameAt(local)) : asImg(assets.outro), local);
      }
      const vf = new VideoFrame(canvas, { timestamp: Math.round(t * 1e6), duration: Math.round(1e6 / FPS) });
      venc.encode(vf, { keyFrame: f % (FPS * 2) === 0 });
      vf.close();
      while (venc.encodeQueueSize > 6) await sleep(1);
      if (vErr) throw vErr;
      if (f % 15 === 0) {
        const el = (performance.now() - t0) / 1000;
        report("video", f / N, { speed: el > 0 ? t / el : 0, eta: el > 1 ? (el / (f + 1)) * (N - f) : null });
      }
    }
    await venc.flush();
    while (ai < audioChunks.length) { muxer.addAudioChunk(audioChunks[ai].chunk, audioChunks[ai].meta); ai++; }
    muxer.finalize();
  } finally {
    Object.values(readers).forEach((r) => r?.close());
    if (venc.state !== "closed") venc.close();
  }
  report("done", 1);
  const chapters = tl.chapters.map((c) => `${fmtShort(c.t)} ${c.name}`).join("\n") + "\n";
  if (writable) { await writable.close(); return { chapters }; }
  return { blob: new Blob([target.buffer], { type: "video/mp4" }), chapters };
}

function fmtShort(t) {
  const s = Math.floor(t);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/**
 * Export one source on its own, face-framed full screen (1920x1080, 30 fps), with its own audio.
 * src: Mp4Source · path: CameraPath · volumeDb: mic level
 */
export async function renderFramedSource({ src, path, volumeDb = 0, writable, onProgress, signal }) {
  const W = STYLE.width, H = STYLE.height;
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d", { alpha: false });
  const vcfg = await pickVideoConfig(W, H, false);
  const acfg = await pickAudioConfig();
  const target = writable ? new Mp4Muxer.FileSystemWritableFileStreamTarget(writable) : new Mp4Muxer.ArrayBufferTarget();
  const muxer = new Mp4Muxer.Muxer({
    target,
    video: { codec: "avc", width: W, height: H, frameRate: FPS },
    audio: { codec: acfg.codec === "opus" ? "opus" : "aac", numberOfChannels: 2, sampleRate: AUDIO_RATE },
    fastStart: writable ? false : "in-memory",
    firstTimestampBehavior: "offset",
  });
  const check = () => { if (signal?.aborted) throw new DOMException("Cancelled", "AbortError"); };
  const dur = Math.floor(src.duration * FPS) / FPS;

  // audio (same AAC priming compensation as the episode render)
  const chunks = [];
  let err = null;
  const aenc = new AudioEncoder({ output: (c, m) => chunks.push({ chunk: c, meta: m }), error: (e) => { err = e; } });
  aenc.configure(acfg);
  const gain = Math.pow(10, volumeDb / 20);
  let skip = acfg.codec.startsWith("mp4a") ? 2112 : 0, pos = 0;
  const encode = (L, R) => {
    let a = 0;
    if (skip > 0) { a = Math.min(skip, L.length); skip -= a; }
    const n = L.length - a;
    if (n <= 0) return;
    const data = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { data[i] = Math.max(-1, Math.min(1, L[a + i] * gain)); data[n + i] = Math.max(-1, Math.min(1, R[a + i] * gain)); }
    const ad = new AudioData({ format: "f32-planar", sampleRate: AUDIO_RATE, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((pos / AUDIO_RATE) * 1e6), data });
    pos += n;
    aenc.encode(ad);
    ad.close();
  };
  const total = Math.round(dur * AUDIO_RATE);
  const as = new AudioStream(src, 0);
  for (let p = 0; p < total; p += 4800) {
    check();
    const [l, r] = await as.read(Math.min(4800, total - p));
    encode(l, r);
    while (aenc.encodeQueueSize > 20) await sleep(1);
    if (err) throw err;
    onProgress?.({ phase: "audio", frac: p / total });
  }
  if (acfg.codec.startsWith("mp4a")) encode(new Float32Array(2112), new Float32Array(2112));
  await aenc.flush(); aenc.close(); as.close();

  // video
  let vErr = null, ai = 0;
  const venc = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta);
      while (ai < chunks.length && chunks[ai].chunk.timestamp <= chunk.timestamp) { muxer.addAudioChunk(chunks[ai].chunk, chunks[ai].meta); ai++; }
    },
    error: (e) => { vErr = e; },
  });
  venc.configure(vcfg);
  const reader = new VideoReader(src);
  const N = Math.round(dur * FPS);
  const so = STYLE.solo;
  try {
    for (let f = 0; f < N; f++) {
      check();
      const t = f / FPS;
      const fr = await reader.frameAt(t);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
      if (fr) ctx.drawImage(fr, ...path.crop(t, fr.displayWidth, fr.displayHeight, W, H, so.faceHeight, so.faceY, STYLE.maxUpscale), 0, 0, W, H);
      const vf = new VideoFrame(canvas, { timestamp: Math.round(t * 1e6), duration: Math.round(1e6 / FPS) });
      venc.encode(vf, { keyFrame: f % (FPS * 2) === 0 });
      vf.close();
      while (venc.encodeQueueSize > 6) await sleep(1);
      if (vErr) throw vErr;
      if (f % 15 === 0) onProgress?.({ phase: "video", frac: f / N });
    }
    await venc.flush();
    while (ai < chunks.length) { muxer.addAudioChunk(chunks[ai].chunk, chunks[ai].meta); ai++; }
    muxer.finalize();
  } finally {
    reader.close();
    if (venc.state !== "closed") venc.close();
  }
  if (writable) { await writable.close(); return {}; }
  return { blob: new Blob([target.buffer], { type: "video/mp4" }) };
}
