// MP4/MOV demuxing (mp4box.js) + WebCodecs decoding with random access.
// Only the moov box and the samples we need are read, so multi-GB files are fine.
/* global MP4Box, DataStream */

export const AUDIO_RATE = 48000;

async function readBytes(file, start, end) {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

async function topLevelBoxes(file) {
  const boxes = [];
  let pos = 0;
  while (pos + 8 <= file.size) {
    const h = await readBytes(file, pos, Math.min(pos + 16, file.size));
    const dv = new DataView(h.buffer);
    let size = dv.getUint32(0);
    const type = String.fromCharCode(h[4], h[5], h[6], h[7]);
    if (size === 1) size = Number(dv.getBigUint64(8));
    else if (size === 0) size = file.size - pos;
    if (size < 8) break;
    boxes.push({ type, start: pos, size });
    pos += size;
  }
  return boxes;
}

function editDelay(trak) {
  // first edit-list entry's media_time = how far the track's timestamps are shifted (B-frames / AAC priming)
  const e = trak.edts?.elst?.entries?.find((x) => x.media_time >= 0);
  return e ? e.media_time : 0;
}

export class Mp4Source {
  static async open(file) {
    const src = new Mp4Source();
    src.file = file;
    src.name = file.name;
    const boxes = await topLevelBoxes(file);
    const moov = boxes.find((b) => b.type === "moov");
    if (!moov) throw new Error(`${file.name}: not an MP4/MOV file, or the file is damaged`);
    const mp4 = MP4Box.createFile();
    let info = null;
    mp4.onReady = (i) => { info = i; };
    mp4.onError = (e) => { throw new Error(e); };
    // Feed ftyp + moov back to back: sample offsets come from the moov tables (absolute
    // file positions), so we never need to read the multi-GB mdat to parse.
    const parts = [];
    for (const b of boxes.filter((x) => x.type === "ftyp" || x.type === "moov")) parts.push(await readBytes(file, b.start, b.start + b.size));
    const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let pos = 0;
    for (const p of parts) { joined.set(p, pos); pos += p.length; }
    const buf = joined.buffer;
    buf.fileStart = 0;
    mp4.appendBuffer(buf);
    mp4.flush();
    if (!info) throw new Error(`${file.name}: couldn't read the video information`);
    src.mp4 = mp4;
    src.duration = info.duration / info.timescale;
    const vt = info.videoTracks[0];
    const at = info.audioTracks[0];
    if (vt) src.video = src._videoTrack(vt);
    if (at) src.audio = src._audioTrack(at);
    // picture length (edit-list corrected) when there is video; audio tracks often run a few ms longer
    if (vt && src.video.duration) src.duration = src.video.duration;
    return src;
  }

  _videoTrack(t) {
    const trak = this.mp4.getTrackById(t.id);
    const entry = trak.mdia.minf.stbl.stsd.entries[0];
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    let description;
    if (box) {
      const ds = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
      box.write(ds);
      description = new Uint8Array(ds.buffer, 8);
    }
    const samples = trak.samples;
    const ts = t.timescale;
    const shift = editDelay(trak);
    const sync = samples.map((s, i) => ({ i, cts: (s.cts - shift) / ts })).filter((x) => samples[x.i].is_sync).sort((a, b) => a.cts - b.cts);
    const dur = samples.length ? (samples.reduce((m, s) => Math.max(m, s.cts + s.duration), 0) - shift) / ts : 0;
    return {
      id: t.id, timescale: ts, samples, sync, duration: dur, shift,
      width: t.video.width, height: t.video.height,
      fps: samples.length && dur ? samples.length / dur : 30,
      config: { codec: t.codec, codedWidth: t.video.width, codedHeight: t.video.height, description },
    };
  }

  _audioTrack(t) {
    const trak = this.mp4.getTrackById(t.id);
    const entry = trak.mdia.minf.stbl.stsd.entries[0];
    let description;
    try {
      const dsi = entry.esds?.esd?.descs?.[0]?.descs?.[0]?.data;
      if (dsi) description = new Uint8Array(dsi);
    } catch (e) { /* not AAC */ }
    const codec = t.codec.startsWith("mp4a") ? (t.codec === "mp4a" ? "mp4a.40.2" : t.codec) : t.codec;
    return {
      id: t.id, timescale: t.timescale, samples: trak.samples, shift: editDelay(trak),
      sampleRate: t.audio.sample_rate, channels: t.audio.channel_count,
      config: { codec, sampleRate: t.audio.sample_rate, numberOfChannels: t.audio.channel_count, description },
    };
  }

  /** Read several consecutive samples with one file read when they are close together. */
  async readSamples(samples) {
    if (!samples.length) return [];
    const lo = Math.min(...samples.map((s) => s.offset));
    const hi = Math.max(...samples.map((s) => s.offset + s.size));
    if (hi - lo < 24 * 1024 * 1024) {
      const buf = await readBytes(this.file, lo, hi);
      return samples.map((s) => buf.subarray(s.offset - lo, s.offset - lo + s.size));
    }
    return Promise.all(samples.map((s) => readBytes(this.file, s.offset, s.offset + s.size)));
  }

  async checkSupport() {
    if (!this.video) throw new Error(`${this.name}: no video track`);
    const r = await VideoDecoder.isConfigSupported(this.video.config);
    if (!r.supported) throw new Error(`${this.name}: this browser can't decode ${this.video.config.codec}. Please convert it to H.264 MP4.`);
    if (this.audio) {
      const a = await AudioDecoder.isConfigSupported(this.audio.config).catch(() => ({ supported: false }));
      if (!a.supported) this.audio = null; // play silent rather than fail
    }
  }
}

// ---------------------------------------------------------------------------
export class VideoReader {
  constructor(src) {
    this.src = src;
    this.track = src.video;
    this.dec = null;
    this.queue = [];
    this.next = 0;
    this.ended = false;
    this.lastTs = -Infinity;
    this.wake = null;
    this.error = null;
  }

  _reset(index) {
    for (const f of this.queue) f.close();
    this.queue = [];
    if (this.dec && this.dec.state !== "closed") this.dec.close();
    this.dec = new VideoDecoder({
      output: (f) => { this.queue.push(f); this.queue.sort((a, b) => a.timestamp - b.timestamp); this.wake?.(); },
      error: (e) => { this.error = e; this.wake?.(); },
    });
    this.dec.configure({ ...this.track.config, hardwareAcceleration: "prefer-hardware", optimizeForLatency: false });
    this.next = index;
    this.ended = false;
    this.lastTs = -Infinity;
  }

  _keyIndex(t) {
    const sync = this.track.sync;
    let lo = 0, hi = sync.length - 1, best = sync[0]?.i ?? 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sync[mid].cts <= t + 1e-6) { best = sync[mid].i; lo = mid + 1; } else hi = mid - 1;
    }
    return best;
  }

  async _feed(maxCount) {
    const s = this.track.samples;
    const batch = [];
    while (this.next < s.length && batch.length < maxCount) batch.push(s[this.next++]);
    if (!batch.length) return;
    const datas = await this.src.readSamples(batch);
    const ts = this.track.timescale;
    batch.forEach((smp, k) => {
      this.dec.decode(new EncodedVideoChunk({
        type: smp.is_sync ? "key" : "delta",
        timestamp: Math.round(((smp.cts - this.track.shift) / ts) * 1e6),
        duration: Math.round((smp.duration / ts) * 1e6),
        data: datas[k],
      }));
    });
  }

  _waitOutput(ms = 40) {
    return new Promise((res) => {
      const t = setTimeout(() => { this.wake = null; res(); }, ms);
      this.wake = () => { clearTimeout(t); this.wake = null; res(); };
    });
  }

  /** Frame shown at time t (seconds, file time). The frame stays valid until the next call. */
  async frameAt(t) {
    const tus = t * 1e6 + 500;
    const k = this._keyIndex(t);
    if (!this.dec || tus < this.lastTs - 1000 || k > this.next) this._reset(k);
    for (let guard = 0; guard < 100000; guard++) {
      if (this.error) throw this.error;
      while (this.queue.length >= 2 && this.queue[1].timestamp <= tus) this.queue.shift().close();
      const q = this.queue;
      if (q.length && (q[0].timestamp > tus || q.length >= 2 || this.ended)) {
        this.lastTs = q[0].timestamp;
        return q[0];
      }
      if (this.ended && !q.length) return null;
      if (this.next < this.track.samples.length) {
        if (this.dec.decodeQueueSize < 12 && q.length < 6) await this._feed(12);
        await this._waitOutput(this.dec.decodeQueueSize > 0 ? 40 : 1);
      } else {
        await this.dec.flush();
        this.ended = true;
      }
    }
    throw new Error("Decoding stalled");
  }

  close() {
    for (const f of this.queue) f.close();
    this.queue = [];
    if (this.dec && this.dec.state !== "closed") this.dec.close();
  }
}

// ---------------------------------------------------------------------------
/** Sequential 48 kHz stereo reader starting at a file time. Silent if no audio. */
export class AudioStream {
  constructor(src, start) {
    this.src = src;
    this.track = src?.audio || null;
    this.pos = Math.round(start * AUDIO_RATE);   // absolute sample index (48k) of next read
    this.chunks = [];                             // [{start, L, R}]
    this.decodedEnd = null;
    this.ended = !this.track;
    if (!this.track) return;
    const s = this.track.samples;
    const ts = this.track.timescale;
    // start one AAC frame early so the decoder is primed
    let i = 0;
    while (i < s.length - 1 && (s[i + 1].cts - this.track.shift) / ts <= start - 0.05) i++;
    this.next = i;
    this.dec = new AudioDecoder({
      output: (ad) => this._onData(ad),
      error: (e) => { this.error = e; },
    });
    this.dec.configure(this.track.config);
  }

  _onData(ad) {
    const n = ad.numberOfFrames;
    const ch = ad.numberOfChannels;
    const planes = [];
    for (let c = 0; c < Math.min(ch, 2); c++) {
      const buf = new Float32Array(n);
      ad.copyTo(buf, { planeIndex: c, format: "f32-planar" });
      planes.push(buf);
    }
    if (planes.length === 1) planes.push(planes[0]);
    let [L, R] = planes;
    const rate = ad.sampleRate;
    if (rate !== AUDIO_RATE) { L = resample(L, rate); R = resample(R, rate); }
    let start = this.decodedEnd;
    if (start === null) start = Math.round((ad.timestamp / 1e6) * AUDIO_RATE);
    ad.close();
    this.chunks.push({ start, L, R });
    this.decodedEnd = start + L.length;
  }

  async _pump() {
    const s = this.track.samples;
    if (this.next >= s.length) {
      // only flush at the very end: a flush resets the AAC decoder, which would put a click
      // at every batch boundary (every 64 frames = 1.37 s)
      await this.dec.flush();
      if (this.error) throw this.error;
      this.ended = true;
      return;
    }
    const batch = s.slice(this.next, this.next + 64);
    this.next += batch.length;
    const datas = await this.src.readSamples(batch);
    const ts = this.track.timescale;
    batch.forEach((smp, k) => this.dec.decode(new EncodedAudioChunk({
      type: "key", timestamp: Math.round(((smp.cts - this.track.shift) / ts) * 1e6),
      duration: Math.round((smp.duration / ts) * 1e6), data: datas[k],
    })));
    // wait until the decoder has taken the whole batch and delivered what it can
    while (this.dec.decodeQueueSize > 0 && !this.error) await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    if (this.error) throw this.error;
  }

  /** Returns [L, R] Float32Arrays of n samples, advancing the read position. */
  async read(n) {
    const L = new Float32Array(n), R = new Float32Array(n);
    if (!this.track) { this.pos += n; return [L, R]; }
    const want = this.pos + n;
    while (!this.ended && (this.decodedEnd === null || this.decodedEnd < want)) await this._pump();
    for (const c of this.chunks) {
      const a = Math.max(c.start, this.pos), b = Math.min(c.start + c.L.length, want);
      if (b <= a) continue;
      L.set(c.L.subarray(a - c.start, b - c.start), a - this.pos);
      R.set(c.R.subarray(a - c.start, b - c.start), a - this.pos);
    }
    this.pos = want;
    this.chunks = this.chunks.filter((c) => c.start + c.L.length > this.pos);
    return [L, R];
  }

  close() { if (this.dec && this.dec.state !== "closed") this.dec.close(); }
}

function resample(x, rate) {
  const n = Math.round((x.length * AUDIO_RATE) / rate);
  const out = new Float32Array(n);
  const k = rate / AUDIO_RATE;
  for (let i = 0; i < n; i++) {
    const p = i * k, j = Math.floor(p), f = p - j;
    out[i] = (x[j] ?? 0) * (1 - f) + (x[j + 1] ?? x[j] ?? 0) * f;
  }
  return out;
}
