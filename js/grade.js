// Colour curves for the host / guest cameras (like Premiere's RGB Curves).
// A grade is { rgb: [[x, y], …], r: […], g: […], b: […] } with x, y in 0..1. Each channel curve
// is applied first, then the RGB (master) curve. Applied on the GPU with a 256-entry lookup table.

export const CHANNELS = ["rgb", "r", "g", "b"];
const IDENT = [[0, 0], [1, 1]];

export const gradeKey = (role) => (role === "hostintro" ? "host" : role);

export function curvePoints(g, ch) {
  const p = g?.[ch];
  return Array.isArray(p) && p.length >= 2 ? p.map(([x, y]) => [x, y]).sort((a, b) => a[0] - b[0]) : IDENT.map((q) => [...q]);
}

export function isIdentity(g) {
  if (!g) return true;
  return CHANNELS.every((ch) => {
    const p = curvePoints(g, ch);
    return p.every(([x, y]) => Math.abs(x - y) < 1e-4) && p[0][0] <= 1e-4 && p[p.length - 1][0] >= 1 - 1e-4;
  });
}

/** Smooth curve through the points that never overshoots (monotone cubic, Fritsch–Carlson). */
export function curveFn(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0]);
  const n = p.length;
  if (n < 2) return (x) => x;
  const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
  const d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

/** 256 x RGBA lookup table for a grade. */
export function gradeLut(g) {
  const f = Object.fromEntries(CHANNELS.map((ch) => [ch, curveFn(curvePoints(g, ch))]));
  const out = new Uint8Array(256 * 4);
  const cl = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    out[i * 4] = cl(f.rgb(Math.min(1, Math.max(0, f.r(x)))));
    out[i * 4 + 1] = cl(f.rgb(Math.min(1, Math.max(0, f.g(x)))));
    out[i * 4 + 2] = cl(f.rgb(Math.min(1, Math.max(0, f.b(x)))));
    out[i * 4 + 3] = 255;
  }
  return out;
}

const VS = `#version 300 es
in vec2 p; out vec2 uv; uniform vec4 r;
void main() { vec2 t = (p + 1.0) * 0.5; uv = vec2(r.x + t.x * r.z, r.y + (1.0 - t.y) * r.w); gl_Position = vec4(p, 0.0, 1.0); }`;
const FS = `#version 300 es
precision highp float;
in vec2 uv; uniform sampler2D img; uniform sampler2D lut; out vec4 o;
float L(float v, int c) { return texture(lut, vec2(v * 255.0 / 256.0 + 0.5 / 256.0, 0.5))[c]; }
void main() { vec3 c = texture(img, uv).rgb; o = vec4(L(c.r, 0), L(c.g, 1), L(c.b, 2), 1.0); }`;

/** Runs the lookup table over (a crop of) a frame on the GPU. */
export class Grader {
  constructor() {
    this.ok = false;
    try {
      this.canvas = new OffscreenCanvas(16, 16);
      const gl = (this.gl = this.canvas.getContext("webgl2", { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false }));
      if (!gl) return;
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
      const pr = (this.prog = gl.createProgram());
      gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
      gl.useProgram(pr);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(pr, "p");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      const tex = (unit) => {
        const t = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
      };
      this.imgTex = tex(0);
      this.lutTex = tex(1);
      gl.uniform1i(gl.getUniformLocation(pr, "img"), 0);
      gl.uniform1i(gl.getUniformLocation(pr, "lut"), 1);
      this.uR = gl.getUniformLocation(pr, "r");
      this.lut = null;
      this.ok = true;
    } catch (e) {
      console.warn("Colour curves unavailable:", e);
      this.ok = false;
    }
  }

  /** The crop [sx, sy, sw, sh] of img with the lookup table applied, as a canvas of about sw x sh. */
  apply(img, crop, lut, iw, ih) {
    const gl = this.gl;
    const [sx, sy, sw, sh] = crop;
    const w = Math.max(1, Math.round(sw)), h = Math.max(1, Math.round(sh));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    gl.viewport(0, 0, w, h);
    if (this.lut !== lut) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut);
      this.lut = lut;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.imgTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.uniform4f(this.uR, sx / iw, sy / ih, sw / iw, sh / ih);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return { canvas: this.canvas, w, h };
  }
}

/** Natural size of anything drawImage accepts. */
export function imgSize(img) {
  return [img.displayWidth ?? img.videoWidth ?? img.width, img.displayHeight ?? img.videoHeight ?? img.height];
}
