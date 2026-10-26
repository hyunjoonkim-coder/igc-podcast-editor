// Pitch-preserving time stretch (WSOLA) for sped-up ranges: speech gets faster, not higher.

const N = 1024;        // frame (≈21 ms at 48 kHz)
const HS = N / 2;      // synthesis hop
const TOL = 256;       // how far we may shift each frame to keep waveforms aligned

let hann = null;
function window() {
  if (!hann) {
    hann = new Float32Array(N);
    for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  }
  return hann;
}

/**
 * Stretch stereo audio (L, R) to `outLen` samples. speed = input length / output length.
 * Input should be at least outLen * speed + N samples long (shorter input is zero-padded).
 */
export function timeStretch(L, R, speed, outLen) {
  if (speed <= 1.0001) return [L.subarray(0, outLen), R.subarray(0, outLen)];
  const w = window();
  const len = L.length;
  const mono = new Float32Array(len);
  for (let i = 0; i < len; i++) mono[i] = L[i] + R[i];
  const oL = new Float32Array(outLen + N), oR = new Float32Array(outLen + N), ws = new Float32Array(outLen + N);
  const at = (x, i) => (i >= 0 && i < len ? x[i] : 0);
  let prev = 0;
  for (let k = 0; k * HS < outLen; k++) {
    const nominal = Math.round(k * HS * speed);
    let best = nominal;
    if (k > 0) {
      // pick the shift whose start best matches where the previous frame would naturally continue
      const target = prev + HS;
      let bestScore = -Infinity;
      for (let d = -TOL; d <= TOL; d += 4) {
        const cand = nominal + d;
        if (cand < 0) continue;
        let sc = 0;
        for (let i = 0; i < HS; i += 2) sc += at(mono, cand + i) * at(mono, target + i);
        if (sc > bestScore) { bestScore = sc; best = cand; }
      }
      for (let d = best - 3; d <= best + 3; d++) {      // refine around the coarse match
        if (d < 0) continue;
        let sc = 0;
        for (let i = 0; i < HS; i++) sc += at(mono, d + i) * at(mono, target + i);
        if (sc > bestScore) { bestScore = sc; best = d; }
      }
    }
    const o = k * HS;
    for (let i = 0; i < N; i++) {
      oL[o + i] += at(L, best + i) * w[i];
      oR[o + i] += at(R, best + i) * w[i];
      ws[o + i] += w[i];
    }
    prev = best;
  }
  for (let i = 0; i < outLen; i++) {
    const g = ws[i] > 1e-3 ? 1 / ws[i] : 0;
    oL[i] *= g; oR[i] *= g;
  }
  return [oL.subarray(0, outLen), oR.subarray(0, outLen)];
}
