// In Good Company — browser-only editor. Everything runs on the visitor's machine.
import { parseTc, fmtTc, STYLE, FPS, titleLength } from "./timeline.js";
import { Mp4Source } from "./media.js";
import { analyzeFaces, CameraPath } from "./faces.js";
import { Compositor } from "./compositor.js";
import { renderEpisode, timelineFor, musicAt, renderFramedSource } from "./render.js";
import { parseComments, classify, planCuts } from "./review.js";
import { initTeam, teamEnabled, teamConfig, teamUser, signInPassword, signInGoogle, signOut, listTeamBrand, downloadTeamFile, uploadTeamFile, removeTeamFile } from "./team.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
const ROLES = ["host", "guest"];
const SRC_ROLES = ["host", "guest", "hostintro"];            // video files an episode can use
const ROLE_LABEL = { host: "Host video", guest: "Guest video", hostintro: "Host intro video" };

const S = {
  projects: [],
  project: null,
  sources: {},          // role -> Mp4Source
  urls: {},             // role -> object URL for <video>
  faces: {},            // role -> {status, progress, path}
  brand: { assets: {}, logo: null, quote: null, fonts: {}, info: {} },
  view: "preview",
  zoom: 1,
  tl: null, planErr: null,
  history: [], future: [],
  role: "host",
  preview: true,
  markIn: null, markOut: null, cutStart: null,
  render: null,
  titlePreview: null,
  route: { page: null },
};

// ---------------------------------------------------------------- IndexedDB
const dbp = new Promise((resolve, reject) => {
  const req = indexedDB.open("igc-editor", 1);
  req.onupgradeneeded = () => {
    const db = req.result;
    db.createObjectStore("projects", { keyPath: "id" });
    db.createObjectStore("faces");
    db.createObjectStore("brand");
    db.createObjectStore("handles");
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
async function idb(store, mode, fn) {
  const db = await dbp;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const r = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(r?.result);
    tx.onerror = () => reject(tx.error);
  });
}
const dbGet = (s, k) => idb(s, "readonly", (st) => st.get(k));
const dbPut = (s, v, k) => idb(s, "readwrite", (st) => (k === undefined ? st.put(v) : st.put(v, k)));
const dbDel = (s, k) => idb(s, "readwrite", (st) => st.delete(k));
const dbAll = (s) => idb(s, "readonly", (st) => st.getAll());
const dbKeys = (s) => idb(s, "readonly", (st) => st.getAllKeys());

// ---------------------------------------------------------------- utils
function toast(msg, err = false) {
  const t = document.createElement("div");
  t.className = "toast" + (err ? " err" : "");
  t.textContent = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), err ? 7000 : 3000);
}
const fps = () => FPS;
const tcToSec = (v) => { try { return parseTc(v, fps()); } catch { return NaN; } };
const secToTc = (t) => fmtTc(t, fps());
const fmtDb = (v) => { v = Number(v) || 0; return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1).replace(/\.0$/, "")} dB`; };
const fmtSize = (b) => (b > 1e9 ? (b / 1e9).toFixed(2) + " GB" : b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.round(b / 1e3) + " KB");
const fmtDur = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`);
function ago(ts) {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  return new Date(ts).toLocaleDateString("en-US");
}
function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
function modal(html, onMount) {
  const m = $("#modal");
  m.innerHTML = `<div class="modal-box">${html}</div>`;
  m.classList.remove("hidden");
  onMount?.(m);
  $("input", m)?.focus();
}
const closeModal = () => { $("#modal").classList.add("hidden"); $("#modal").innerHTML = ""; };

// ---------------------------------------------------------------- projects
function blankProject(name) {
  return {
    id: uid(), name, created: Date.now(), updated: Date.now(),
    people: {
      host: { name: "Jacob Kosior", title: "VP, Client Strategy", company: "EliseAI" },
      guest: { name: "", title: "", company: "" },
    },
    sources: { host: null, guest: null },
    intro: null, in: "00:00:00:00", cuts: [], moves: [], lower_thirds: [], titles: [],
    layouts: [], end_card: true, out: null, guest_card: true, auto_l3: false, music_db: -20,
  };
}

async function loadProjects() {
  S.projects = (await dbAll("projects")).sort((a, b) => b.updated - a.updated);
  renderEpList();
}

let saveTimer = null;
function scheduleSave() {
  $("#saveState").textContent = "Saving…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await dbPut("projects", JSON.parse(JSON.stringify(S.project)));
    $("#saveState").textContent = "Saved in this browser";
    loadProjects();
  }, 400);
}

function mutate(fn) {
  S.history.push(JSON.stringify(S.project));
  if (S.history.length > 200) S.history.shift();
  S.future = [];
  fn(S.project);
  S.project.updated = Date.now();
  scheduleSave();
  refresh();
}
function undo() {
  if (!S.history.length) return;
  S.future.push(JSON.stringify(S.project));
  S.project = JSON.parse(S.history.pop());
  scheduleSave(); refresh(true); toast("Undo");
}
function redo() {
  if (!S.future.length) return;
  S.history.push(JSON.stringify(S.project));
  S.project = JSON.parse(S.future.pop());
  scheduleSave(); refresh(true); toast("Redo");
}

function newEpisode() {
  modal(`<h2>New episode</h2><p>e.g. EP12 Alex O'Brien</p><input id="epIn" placeholder="Episode name">
    <div class="actions"><button class="btn" id="c">Cancel</button><button class="btn primary" id="ok">Create</button></div>`, (m) => {
    const go = async () => {
      const name = $("#epIn").value.trim();
      if (!name) return;
      const p = blankProject(name);
      await dbPut("projects", p);
      closeModal();
      await loadProjects();
      location.hash = `#/ep/${p.id}`;
    };
    $("#ok", m).onclick = go;
    $("#c", m).onclick = closeModal;
    $("#epIn", m).onkeydown = (e) => { if (e.key === "Enter" && !e.isComposing) go(); };
  });
}

async function importProject(file) {
  try {
    const p = JSON.parse(await file.text());
    if (!p.people || !Array.isArray(p.cuts)) throw new Error("This is not an episode file");
    p.id = uid(); p.updated = Date.now();
    for (const k of ["cuts", "lower_thirds", "titles"]) (p[k] || []).forEach((x) => { x.id = x.id || uid(); });
    await dbPut("projects", p);
    await loadProjects();
    location.hash = `#/ep/${p.id}`;
    toast("Episode imported. Just choose the source video files again.");
  } catch (e) { toast("Import failed: " + e.message, true); }
}

function renderEpList() {
  const cur = S.route.page === "ep" ? S.route.id : null;
  $("#epList").innerHTML = S.projects.length ? S.projects.map((p) => `
    <a class="ep-item ${p.id === cur ? "active" : ""}" href="#/ep/${p.id}">
      <b>${esc(p.name)}</b><span>${esc(p.people?.guest?.name || "Guest TBD")} · ${ago(p.updated)}</span>
      <button class="icon-btn danger ep-del" data-del="${p.id}" title="Delete">✕</button>
    </a>`).join("") : `<div class="empty" style="padding:8px 10px">No episodes yet</div>`;
  $("#brandLink").style.color = S.route.page === "brand" ? "var(--purple)" : "";
}

// ---------------------------------------------------------------- brand assets
const BRAND = {
  bumper: ["Intro", "The show intro clip, right after the Cold Open (InGoodCompany_Intro.mp4). The host's audio starts 1 s into it.", "video/mp4,video/quicktime,image/*"],
  music: ["Intro music", "Plays from 0:00 under the intro, the bumper and the guest card, then fades out as the host appears.", "audio/*,.wav,.mp3,.m4a,.aac"],
  outro: ["Outro", "Added to the end of every episode. e.g. InGoodCompany_EPOutro.mp4", "video/mp4,video/quicktime,image/*"],
  title_background: ["Title background", "Background behind transition titles (image or video). A video's sound is used as a sting.", "video/mp4,video/quicktime,image/*"],
  logo: ["Logo", "IN GOOD COMPANY logo PNG (transparent background)", "image/png,image/*"],
  quote: ["Guest card quote mark", "The quote mark above the guest's name (PNG)", "image/png,image/*"],
  font_title: ["Title font", "Titles and the default wordmark (.otf / .ttf / .woff2)", ".otf,.ttf,.woff,.woff2"],
  font_bold: ["Bold font", "Bold text (.otf / .ttf / .woff2)", ".otf,.ttf,.woff,.woff2"],
  font_regular: ["Regular font", "Lower thirds, guest card, split-screen labels", ".otf,.ttf,.woff,.woff2"],
};
const ASSET_KEY = { bumper: "bumper", outro: "outro", title_background: "titleBg" };

/** Team brand files (signed in): {slot: {name, blob, path}}, downloaded only when they changed. */
async function teamBrandFiles() {
  if (!teamEnabled() || !teamUser()) return {};
  let list = null;
  try { list = await listTeamBrand(); } catch (e) { S.teamBrandErr = e.message; }
  const out = {};
  for (const key of Object.keys(BRAND)) {
    const cached = await dbGet("brand", "team:" + key);
    const remote = list?.[key];
    if (list && !remote) { if (cached) await dbDel("brand", "team:" + key); continue; }
    if (remote && (!cached || cached.updated !== remote.updated || cached.path !== remote.path)) {
      try {
        const blob = await downloadTeamFile(remote.path);
        const rec = { name: remote.name, blob, updated: remote.updated, path: remote.path };
        await dbPut("brand", rec, "team:" + key);
        out[key] = rec;
        continue;
      } catch (e) { S.teamBrandErr = e.message; }
    }
    if (cached) out[key] = cached;                      // offline or unchanged: use the copy in this browser
  }
  return out;
}

async function loadBrand() {
  const site = await fetch("brand/brand.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  S.teamBrandErr = null;
  const team = await teamBrandFiles();
  const assets = {}, fonts = {}, info = {};
  let logo = null, quote = null;
  for (const key of Object.keys(BRAND)) {
    let blob = null, name = null, from = null;
    const local = await dbGet("brand", key);
    if (local) { blob = local.blob; name = local.name; from = "local"; }
    else if (team[key]) { blob = team[key].blob; name = team[key].name; from = "team"; }
    else if (site[key]) {
      try {
        const r = await fetch("brand/" + encodeURIComponent(site[key]));
        if (r.ok) { blob = await r.blob(); name = site[key]; from = "site"; }
      } catch (e) { /* missing */ }
    }
    if (!blob) continue;
    info[key] = { name, from, teamPath: team[key]?.path || null };
    try {
      const isImg = blob.type.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/i.test(name);
      if (key.startsWith("font_")) {
        const fam = `IGC ${key}`;
        const ff = new FontFace(fam, await blob.arrayBuffer());
        await ff.load();
        document.fonts.add(ff);
        fonts[{ font_title: "title", font_bold: "bold", font_regular: "regular" }[key]] = fam;
      } else if (key === "logo") {
        logo = await createImageBitmap(blob);
      } else if (key === "quote") {
        quote = await createImageBitmap(blob);
      } else if (key === "music") {
        const buffer = await new OfflineAudioContext(2, 1, 48000).decodeAudioData(await blob.arrayBuffer());
        assets.music = { buffer, duration: buffer.duration, url: URL.createObjectURL(blob) };
      } else if (isImg) {
        const bm = await createImageBitmap(blob);
        assets[ASSET_KEY[key]] = { kind: "image", bitmap: bm, w: bm.width, h: bm.height, duration: key === "bumper" ? STYLE.bumperFallback : STYLE.outroFallback, url: URL.createObjectURL(blob) };
      } else {
        const src = await Mp4Source.open(new File([blob], name, { type: blob.type }));
        await src.checkSupport();
        assets[ASSET_KEY[key]] = { kind: "video", src, duration: src.duration, url: URL.createObjectURL(blob) };
      }
    } catch (e) { info[key].error = e.message; }
  }
  S.brand = { assets, fonts, logo, quote, info };
  previewComp = null;
}

function renderBrand() {
  $("#crumb").textContent = "Brand assets";
  $("#main").innerHTML = `<div class="brandpage">
    <h1 style="margin:0 0 4px;font-size:24px">Brand assets</h1>
    <p class="muted" style="margin:0">${teamEnabled()
      ? (teamUser() ? `<b>Team</b> files are shared with everyone signed in to the team; <b>This browser</b> files only apply here and win over the team's.` : `Sign in (top right) to use and share the team's brand files. Files added here otherwise stay in this browser.`)
      : "Files added here are stored in this browser only and used by every episode. Empty slots use the site's default design."}</p>
    ${S.teamBrandErr ? `<p class="brand-src" style="color:var(--cut)">Team files: ${esc(S.teamBrandErr)}</p>` : ""}
    <div class="brand-grid">${Object.entries(BRAND).map(([k, [label, desc, accept]]) => {
      const cur = S.brand.info[k];
      return `<div class="card brand-card">
        <h3>${label}</h3><p>${desc}</p>
        ${k === "logo" && S.brand.logo ? `<canvas id="logoPrev" height="70"></canvas>` : ""}
        <div class="row"><span class="pill ${cur && !cur.error ? "ok" : cur?.error ? "err" : ""}">${cur ? esc(cur.name) : "Using default"}</span>
          ${cur ? `<span class="brand-src">${cur.from === "site" ? "Site default" : cur.from === "team" ? "Team" : "This browser"}</span>` : ""}</div>
        ${cur?.error ? `<div class="brand-src" style="color:var(--cut)">${esc(cur.error)}</div>` : ""}
        <div class="row">
          <label class="btn small">${teamUser() ? "Use in this browser" : "Choose file"}<input type="file" accept="${accept}" hidden data-brand="${k}"></label>
          ${cur?.from === "local" ? `<button class="btn small ghost" data-brand-del="${k}">Remove</button>` : ""}
          ${teamUser() ? `<label class="btn small primary">Upload for team<input type="file" accept="${accept}" hidden data-team-up="${k}"></label>` : ""}
          ${teamUser() && cur?.teamPath ? `<button class="btn small ghost" data-team-del="${k}" data-path="${esc(cur.teamPath)}">Remove from team</button>` : ""}
        </div></div>`;
    }).join("")}</div></div>`;
  const lp = $("#logoPrev");
  if (lp) { const b = S.brand.logo; lp.width = (b.width * 70) / b.height; lp.getContext("2d").drawImage(b, 0, 0, lp.width, 70); }
  $$("[data-brand]").forEach((el) => (el.onchange = async () => {
    const f = el.files[0];
    if (!f) return;
    await dbPut("brand", { name: f.name, blob: f }, el.dataset.brand);
    await loadBrand(); renderBrand(); toast("Saved");
  }));
  $$("[data-brand-del]").forEach((el) => (el.onclick = async () => {
    await dbDel("brand", el.dataset.brandDel);
    await loadBrand(); renderBrand();
  }));
  $$("[data-team-up]").forEach((el) => (el.onchange = async () => {
    const f = el.files[0];
    if (!f) return;
    const slot = el.dataset.teamUp;
    toast(`Uploading ${f.name}…`);
    try {
      await uploadTeamFile(slot, f, S.brand.info[slot]?.teamPath || null);
      await loadBrand(); renderBrand(); toast("Shared with the team");
    } catch (e) { toast("Upload failed: " + e.message, true); }
  }));
  $$("[data-team-del]").forEach((el) => (el.onclick = async () => {
    if (!confirm("Remove this file for everyone on the team?")) return;
    try { await removeTeamFile(el.dataset.path); await loadBrand(); renderBrand(); toast("Removed from the team"); }
    catch (e) { toast("Couldn't remove: " + e.message, true); }
  }));
}

// ---------------------------------------------------------------- home
function renderHome() {
  $("#crumb").textContent = "";
  $("#main").innerHTML = `<div class="home">
    <h1>In Good Company Podcast Editor</h1>
    <p class="muted">Choose the host and guest recordings, enter timecodes, and hit render. Removed parts, the intro, lower thirds, transition titles, the split layout and the end card are added automatically.</p>
    <p class="muted">Everything is processed in this browser on your computer, and your videos are never uploaded. Your work is saved in this browser automatically. To share an episode with someone, <b>Export</b> it and send them the file.</p>
    <div style="margin-top:16px"><button class="btn primary" id="homeNew">+ New episode</button></div>
    <div class="ep-grid">${S.projects.map((p) => `
      <a class="card ep-card" href="#/ep/${p.id}"><b>${esc(p.name)}</b>
        <div class="muted">${esc(p.people?.guest?.name || "Guest TBD")}</div>
        <div class="muted" style="font-size:12px;margin-top:8px">${ago(p.updated)}</div></a>`).join("")}</div></div>`;
  $("#homeNew").onclick = newEpisode;
}

// ---------------------------------------------------------------- routing
async function route() {
  const h = location.hash.replace(/^#\/?/, "");
  const r = h.startsWith("ep/") ? { page: "ep", id: h.slice(3) } : h === "brand" ? { page: "brand" } : { page: "home" };
  if (S.render && JSON.stringify(r) !== JSON.stringify(S.route)) {
    toast("You can't leave this page while rendering", true);
    history.replaceState(null, "", S.route.page === "ep" ? `#/ep/${S.route.id}` : "#/");
    return;
  }
  S.route = r;
  renderEpList();
  if (r.page === "home") renderHome();
  else if (r.page === "brand") renderBrand();
  else await openEpisode(r.id);
}

async function openEpisode(id) {
  const p = await dbGet("projects", id);
  if (!p) { $("#main").innerHTML = `<div class="home"><h1>Episode not found</h1></div>`; return; }
  for (const u of Object.values(S.urls)) URL.revokeObjectURL(u);
  Object.assign(S, { project: p, sources: {}, urls: {}, faces: {}, history: [], future: [], markIn: null, markOut: null, role: "host", tl: null });
  buildEpisode();
  refresh(true);
  for (const role of SRC_ROLES) {
    const h = await dbGet("handles", `${id}:${role}`);
    if (!h) continue;
    try {
      if ((await h.queryPermission({ mode: "read" })) === "granted") await loadSource(role, await h.getFile());
      else { S.faces[role] = { status: "reconnect", handle: h }; renderSources(); renderReconnect(); }
    } catch (e) { /* file moved */ }
  }
}

// ---------------------------------------------------------------- sources
async function pickSource(role) {
  try {
    if (window.showOpenFilePicker) {
      const [h] = await showOpenFilePicker({ types: [{ description: "Video", accept: { "video/*": [".mp4", ".mov", ".m4v"] } }] });
      await dbPut("handles", h, `${S.project.id}:${role}`);
      await loadSource(role, await h.getFile());
    } else {
      const inp = document.createElement("input");
      inp.type = "file"; inp.accept = "video/mp4,video/quicktime,.mov,.mp4,.m4v";
      inp.onchange = () => inp.files[0] && loadSource(role, inp.files[0]);
      inp.click();
    }
  } catch (e) { if (e.name !== "AbortError") toast(e.message, true); }
}

async function reconnect(role) {
  const h = S.faces[role]?.handle;
  if (!h) return;
  try {
    if ((await h.requestPermission({ mode: "read" })) === "granted") await loadSource(role, await h.getFile());
  } catch (e) { toast(`Couldn't open ${ROLE_LABEL[role].toLowerCase()}: ${e.message}. Choose it again.`, true); }
  renderReconnect();
}

/** After a refresh the browser asks again before we can read the videos: one click reconnects all. */
async function reconnectAll() {
  for (const role of SRC_ROLES) if (S.faces[role]?.status === "reconnect") await reconnect(role);
}

function renderReconnect() {
  const bar = $("#reconnectBar");
  if (!bar) return;
  const need = SRC_ROLES.filter((r) => S.faces[r]?.status === "reconnect");
  bar.classList.toggle("hidden", !need.length);
  if (!need.length) return;
  bar.innerHTML = `<div><b>Reconnect ${need.length} video file${need.length > 1 ? "s" : ""}</b>
      <div class="muted" style="font-size:12px">The browser asks again after a refresh: ${need.map((r) => esc(S.project.sources?.[r]?.name || ROLE_LABEL[r])).join(", ")}.
      In Chrome pick <b>“Allow on every visit”</b> and it won't ask again.</div></div>
    <button class="btn primary" data-act="reconnectAll">Reconnect files</button>`;
}

async function loadSource(role, file) {
  const expected = S.project.sources?.[role];
  if (expected && expected.name && expected.name !== file.name) toast(`The name differs from the previous file (${expected.name}). Make sure it's the right one.`);
  S.faces[role] = { status: "opening" };
  renderSources();
  try {
    const src = await Mp4Source.open(file);
    await src.checkSupport();
    S.sources[role] = src;
    renderReconnect();
    if (S.urls[role]) URL.revokeObjectURL(S.urls[role]);
    S.urls[role] = URL.createObjectURL(file);
    const prev = S.project.sources?.[role] || {};
    S.project.sources = { ...(S.project.sources || {}), [role]: { ...prev, name: file.name, size: file.size, offset: prev.offset || 0 } };
    // A host intro file only does something once it's in the edit list: add it (whole file) when a
    // new file comes in. A reconnect after refresh keeps whatever the edit list already says.
    if (role === "hostintro" && !S.project.host_intro && (S.project.host_intro === undefined || prev.name !== file.name)) {
      S.project.host_intro = { seq: nextSeq() };
      toast("Host intro added to the edit list (whole file). Set Start/End there to trim it.");
    }
    scheduleSave();
    refresh();
    loadVideo();
    runFaces(role, file, src);
  } catch (e) {
    S.faces[role] = { status: "error", error: e.message };
    renderSources();
    toast(e.message, true);
  }
}

let faceQueue = Promise.resolve();
/** Face analyses run one at a time so they don't fight over the GPU. */
function runFaces(role, file, src) {
  S.faces[role] = { status: "running", progress: 0 };
  renderSources();
  faceQueue = faceQueue.then(() => runFacesNow(role, file, src)).catch(() => {});
  return faceQueue;
}

async function runFacesNow(role, file, src) {
  const key = `${file.name}|${file.size}|${file.lastModified}`;
  const cached = await dbGet("faces", key);
  if (cached) { S.faces[role] = { status: "done", path: new CameraPath(cached) }; renderSources(); return; }
  S.faces[role] = { status: "running", progress: 0 };
  renderSources();
  try {
    const samples = await analyzeFaces(src, (p) => { S.faces[role].progress = p; renderFaceRow(role); });
    await dbPut("faces", samples, key);
    S.faces[role] = { status: "done", path: new CameraPath(samples) };
    if (!S.faces[role].path.found) toast(`No face found in the ${role} video, so it will be framed at the center`);
  } catch (e) {
    console.error(e);
    S.faces[role] = { status: "done", path: new CameraPath([]), error: e.message };
    toast("Face analysis failed, framing at the center (" + e.message + ")", true);
  }
  renderSources();
}

function pathFor(role) { return S.faces[role]?.path || new CameraPath([]); }

// ---------------------------------------------------------------- episode layout
function tcField(attrs, placeholder = "00:00:00:00") {
  // each timecode keeps its own ⌖ / ↗ buttons (rows like Start → End have two of these)
  return `<span class="tcf"><input class="tc" ${attrs} data-tc="1" placeholder="${placeholder}">
    <button class="icon-btn" data-act="here" title="Use the current playhead position"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 1v3.5M8 11.5V15M1 8h3.5M11.5 8H15" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>
    <button class="icon-btn" data-act="go" title="Jump to this position">↗</button></span>`;
}

function buildEpisode() {
  $("#main").innerHTML = `
  ${!window.VideoEncoder ? `<div class="notice err">This browser doesn't support video rendering (WebCodecs). Please open this page in the latest Chrome or Edge.</div>` : ""}
  <div class="ep">
    <div class="ep-left">
      <div class="notice reconnect hidden" id="reconnectBar"></div>
      <div class="card">
        <div class="player-wrap" id="pwrap">
          <video id="vid" preload="auto" playsinline></video>
          ${[0, 1].map((i) => `<video id="pg_h${i}" preload="auto" playsinline hidden></video><video id="pg_g${i}" preload="auto" playsinline hidden></video>`).join("")}
          <video id="pg_i" preload="auto" playsinline hidden></video><video id="pg_b" preload="auto" playsinline hidden></video><video id="pg_o" preload="auto" playsinline hidden></video><video id="pg_t" preload="auto" playsinline hidden></video>
          <canvas id="pcv" width="1920" height="1080"></canvas>
          <div class="player-msg" id="vidMsg"></div>
          <span class="badge" id="pbadge"></span>
        </div>
        <video id="gvid" preload="auto" playsinline hidden></video>
        <audio id="mvid" preload="auto" hidden></audio>
        <div class="transport">
          <span class="tc-kind" id="tcKind">RAW</span><span class="tc-big" id="tcNow" title="Click to copy">00:00:00:00</span>
          <button class="icon-btn" data-act="step" data-d="-1" title="Back 1 second (Shift+←)">«</button>
          <button class="icon-btn" data-act="frame" data-d="-1" title="Back 1 frame (←)">‹</button>
          <button class="icon-btn" data-act="play" id="playBtn" title="Play/Pause (Space)">▶</button>
          <button class="icon-btn" data-act="frame" data-d="1" title="Forward 1 frame (→)">›</button>
          <button class="icon-btn" data-act="step" data-d="1" title="Forward 1 second (Shift+→)">»</button>
          <select id="rateSel" class="rate-sel" title="Playback speed for reviewing raw footage (does not change the edit)">
            ${RAW_RATES.map((r) => `<option value="${r}">${r}×</option>`).join("")}
          </select>
          <span class="marks" id="marks"></span>
          <span style="flex:1"></span>
          <div class="seg-toggle" id="viewToggle">
            <button data-view="program" title="Play the edited episode with cuts, intro, titles and outro">Final</button><button data-view="preview" title="Raw playhead, drawn as it will look">Raw</button><button data-view="host">Host</button><button data-view="guest">Guest</button><button data-view="hostintro">Host intro</button>
          </div>
        </div>
        <div class="tl">
          <div class="bar-label">Final Preview</div>
          <div class="tl-scroll" id="pgScroll"><div class="tl-inner"><div class="pg-bar" id="pgBar"></div><div class="tl-scale" id="pgScale"></div></div></div>
          <div class="bar-label" style="margin-top:10px"><span id="srcBarLabel">Raw Footage</span></div>
          <div class="tl-scroll" id="tlScroll"><div class="tl-inner"><div class="tl-bar" id="tlBar"></div><div class="tl-scale" id="tlScale"></div></div></div>
          <div class="legend">
            <span><i style="background:var(--purple-2)"></i>Cold Open</span><span><i style="background:#5E8FD0"></i>Host intro</span><span><i style="background:var(--cut)"></i>Remove</span><span><i style="background:#E8A317"></i>Speed up</span><span><i style="background:var(--move)"></i>Move</span>
            <span><i style="background:var(--title)"></i>Title</span><span><i style="background:var(--l3)"></i>L3</span>
            <span><i style="background:#9BB4D6"></i>Host only</span><span><i style="background:#E0B3C8"></i>Guest only</span><span><i style="background:var(--purple-2)"></i>Split</span>
            <span><i style="background:#1E0A4E"></i>Intro</span><span><i style="background:#8C8FA3"></i>Outro</span>
          </div>
          <div class="keys"><kbd>C</kbd> start a remove, <kbd>C</kbd> again to end it · <kbd>Shift</kbd>+drag to move/speed <span id="zoomLbl" class="muted"></span></div>
        </div>
      </div>
      <div class="card"><div class="card-h"><span>Edit list</span><small id="planSum"></small></div>
        <div class="card-b">
          <div class="cat-filter" id="catFilter"></div>
          <div id="planErr"></div>
          <div id="editList" class="edit-list"></div>
          <div class="incl">
            <label class="chk"><input type="checkbox" data-path="guest_card" data-bool="1"> Guest card</label>
            <label class="chk"><input type="checkbox" data-path="end_card" data-bool="1"> Outro</label>
          </div>
          <div class="sec-foot" style="margin-top:10px">
            <button class="btn small" data-act="addCut">+ Remove</button>
            <button class="btn small" data-act="addL3">+ Lower third</button>
            <button class="btn small" data-act="addTitle">+ Title</button>
            <button class="btn small" data-act="addLayout">+ Layout</button>
            <button class="btn small" data-act="addIntro" id="addIntroBtn">+ Cold Open</button>
            <button class="btn small" data-act="addHostIntro" id="addHostIntroBtn">+ Host intro</button>
            <span style="flex:1"></span>
            <button class="btn small" data-act="reviewImport" title="Paste the review comments on the original video: Cut comments are removed automatically">Paste review comments</button>
            <button class="btn small" data-act="reviewReport" id="reviewReportBtn" hidden>Last review import</button>
          </div>
        </div></div>
      <div class="card"><div class="card-h"><span>Render</span>
          <div class="render-actions">
            <button class="btn" data-act="render" data-draft="1">Draft render (low quality)</button>
            <button class="btn primary" data-act="render">Final render</button>
          </div></div>
        <div class="card-b" id="renderBox"></div></div>
    </div>

    <div class="ep-right" id="editor">
      <div class="card sec"><div class="card-h"><span>Source videos</span></div>
        <div class="card-b">
          <div class="upload" id="src_host"></div>
          <div class="upload" id="src_guest"></div>
          <div class="upload" id="src_hostintro"></div>
          <div class="row"><span class="muted" style="font-size:12px;flex:1">Offset</span>
            <input type="number" step="0.01" style="width:96px" data-path="sources.guest.offset" data-num="1"></div>
        </div></div>

      <div class="card sec"><div class="card-h"><span>People</span><small>Lower thirds · split-screen labels</small></div>
        <div class="card-b"><div class="grid2">${ROLES.map((r) => `
          <div class="person"><h4>${r === "host" ? "Host" : "Guest"}</h4>
            <label class="field">Name<input data-path="people.${r}.name"></label>
            <label class="field">Job title<textarea class="grow-lines" rows="1" data-path="people.${r}.title" title="Press Enter for a second line"></textarea></label>
            <label class="field">Company<input data-path="people.${r}.company"></label></div>`).join("")}</div></div></div>

    </div>
  </div>`;
  wireEpisode();
  setView(S.view || "preview");
  setZoom(S.zoom || 1);
}

// ---------------------------------------------------------------- state -> UI
const getPath = (o, path) => path.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
function setPath(o, path, v) {
  const ks = path.split(".");
  let cur = o;
  for (const k of ks.slice(0, -1)) { if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {}; cur = cur[k]; }
  if (v === null || v === undefined) delete cur[ks[ks.length - 1]]; else cur[ks[ks.length - 1]] = v;
}

function computePlan() {
  S.tl = null; S.planErr = null;
  if (!S.sources.host) { S.planErr = "Choose the host source video"; return; }
  try {
    S.tl = timelineFor(S.project, S.sources, S.brand.assets);
  } catch (e) { S.planErr = e.message; }
}

function refresh(full = false) {
  if (S.route.page !== "ep" || !S.project) return;
  const p = S.project;
  computePlan();
  if (!$("#crumbName") || $("#crumbName").textContent !== p.name) {
    $("#crumb").innerHTML = `<span id="crumbName">${esc(p.name)}</span><button class="btn small" data-act="export" style="margin-left:10px">Export</button>`;
  }
  renderEditList(full);                          // build rows first so their fields get filled below
  $$("#main [data-path]").forEach((el) => {
    if (el === document.activeElement && !full) return;
    let v = getPath(p, el.dataset.path);
    if (el.dataset.path === "split_from" && (v === "first_title" || v === "never")) v = "";
    if (el.type === "checkbox") el.checked = el.dataset.bool ? v !== false : !!v;
    else if (el.dataset.path === "intro.camera") el.value = v || "guest";
    else if (el.dataset.path === "host_intro.start" && !v) el.value = S.sources.hostintro ? secToTc(0) : "";
    else if (el.dataset.path === "host_intro.end" && !v) el.value = S.sources.hostintro ? secToTc(Math.floor(S.sources.hostintro.duration * FPS) / FPS) : "";
    else if (el.dataset.path === "music_db") { el.value = String(v ?? -20); $("#musicVal").textContent = fmtDb(el.value); }
    else el.value = v ?? (el.dataset.num ? 0 : "");
    el.classList.remove("invalid");
  });
  $$("#main textarea.grow-lines").forEach(fitLines);
  renderSources();
  applyMicLevels();
  const hl = $("#hiLen");
  if (hl) hl.textContent = S.tl?.hostIntroRange ? `= ${secToTc(S.tl.hostIntroRange[1] - S.tl.hostIntroRange[0])} long` : "";
  renderPlanSummary();
  renderRenderBox();
  renderTimeline();
}

// One list for everything in the edit. Each category has its own colour and label.
const CATS = {
  intro: { label: "Cold Open", color: "var(--purple-2)" },
  hostintro: { label: "Host intro", color: "#5E8FD0" },
  layouts: { label: "Layout", color: "#B07CD8" },
  lower_thirds: { label: "Lower third", color: "var(--l3)" },
  titles: { label: "Title", color: "var(--title)" },
  cuts: { label: "Remove", color: "var(--cut)" },
  moves: { label: "Move", color: "var(--move)" },
};
const ARRAY_CATS = ["layouts", "lower_thirds", "titles", "cuts", "moves"];
const nextSeq = () => Date.now();
const isSpeedCut = (c) => c && (c.mode === "speed" || Number(c.speed) > 1);
const cutSpeed = (c) => Math.min(2, Math.max(1, Number(c.speed) || 1));
const fmtX = (v) => `${Number(v).toFixed(1)}×`;

/** Rows in the order they were added (new ones at the bottom). */
function editRows() {
  const p = S.project, rows = [];
  if (p.intro) rows.push({ cat: "intro", id: "intro", seq: p.intro.seq ?? -2 });
  if (p.host_intro) rows.push({ cat: "hostintro", id: "hostintro", seq: p.host_intro.seq ?? -1 });
  ARRAY_CATS.forEach((cat, ci) => (p[cat] || []).forEach((it, i) => rows.push({ cat, id: it.id, it, seq: it.seq ?? ci + i / 1000 })));
  rows.sort((a, b) => a.seq - b.seq);
  // cuts keep their slots in the list, but fill them in timeline order
  const cutRows = rows.filter((r) => r.cat === "cuts");
  const at = (r) => { const x = tcToSec(r.it.start); return Number.isFinite(x) ? x : Infinity; };
  const byTime = [...cutRows].sort((a, b) => (at(a) - at(b)) || a.seq - b.seq);
  let k = 0;
  return rows.map((r) => (r.cat === "cuts" ? byTime[k++] : r));
}

const chip = (cat) => `<span class="cat-chip" style="--c:${CATS[cat].color}"><i></i>${CATS[cat].label}</span>`;
const del = (cat, id) => cat === "intro" ? `<button class="icon-btn danger" data-act="removeIntro" title="Delete">✕</button>`
  : cat === "hostintro" ? `<button class="icon-btn danger" data-act="removeHostIntro" title="Delete">✕</button>`
  : `<button class="icon-btn danger" data-act="remove" data-list="${cat}" data-id="${id}" title="Delete">✕</button>`;
const f = (cat, id, field, extra = "") => `data-list="${cat}" data-id="${id}" data-field="${field}" ${extra}`;

function rowHtml(r) {
  const { cat, id, it } = r;
  let body = "";
  if (cat === "intro") body = `${tcField('data-path="intro.start"')}${tcField('data-path="intro.end"')}
      <select data-path="intro.camera" style="width:auto"><option value="guest">Guest camera</option><option value="host">Host camera</option></select>`;
  else if (cat === "hostintro") body = `${tcField('data-path="host_intro.start" data-clock="hostintro"', "Start of file")}${tcField('data-path="host_intro.end" data-clock="hostintro"', "End of file")}`;
  else if (cat === "layouts") body = `${tcField(f(cat, id, "at"))}
      <select ${f(cat, id, "layout")} style="width:auto"><option value="split">Split (host + guest)</option><option value="host">Host only</option><option value="guest">Guest only</option></select>`;
  else if (cat === "lower_thirds") body = `${tcField(f(cat, id, "at", 'data-clock="edited"'))}
      <select ${f(cat, id, "person")} style="width:auto"><option value="host">Host</option><option value="guest">Guest</option><option value="custom">Custom</option></select>
      <span class="muted" style="font-size:11px">Final Preview</span>`;
  else if (cat === "titles") body = `${tcField(f(cat, id, "at"))}<input class="grow" placeholder="Title text" ${f(cat, id, "text")}>
      <button class="icon-btn" data-act="previewTitle" data-id="${id}" title="Preview title">▶</button>`;
  else if (cat === "cuts") body = `${tcField(f(cat, id, "start"))}${tcField(f(cat, id, "end"))}`;
  else if (cat === "moves") body = `${tcField(f(cat, id, "start"))}${tcField(f(cat, id, "end"))}
      <span class="muted" style="font-size:11px">insert before</span>${tcField(f(cat, id, "to"), "End")}`;
  const extra = cat === "cuts" && it.note ? `<div class="er-note" title="From review comment">📝 ${esc(it.note)}</div>`
    : cat === "titles" ? `<div class="er-warn" data-warn="${id}" hidden></div>`
    : cat === "lower_thirds" && it.person === "custom" ? `<div class="row er-sub"><input placeholder="Name" ${f(cat, id, "name")}>
      <textarea class="grow-lines" rows="1" placeholder="Job title (Enter for a 2nd line)" ${f(cat, id, "title")}></textarea><input placeholder="Company" ${f(cat, id, "company")}></div>` : "";
  return `<div class="item er" data-id="${id}" data-cat="${cat}" style="--c:${CATS[cat].color}">
    <div class="row er-main">${chip(cat)}<div class="row grow er-fields">${body}</div>${del(cat, id)}</div>${extra}</div>`;
}

// ---------------------------------------------------------------- review comments → cuts
// Paste the review comments (timecodes of the original review video = the host recording).
// Definite "Cut" comments with a start and an end become cuts; everything else is listed.
const fmtLen = (t) => { const s = Math.round(t * FPS) / FPS; const m = Math.floor(s / 60); return `${m ? m + "m " : ""}${(s - m * 60).toFixed(1)}s`; };
const tcSpan = (c) => esc(c.startTc + (c.endTc ? " – " + c.endTc : ""));

function reviewAnalyze(text) {
  const src = S.sources.host;
  const fpsV = src?.video?.fps || FPS;
  const duration = src?.duration ?? Infinity;
  const items = parseComments(text, fpsV).map((c) => classify(c, duration));
  const existing = (S.project.cuts || []).filter((c) => !isSpeedCut(c)).map((c) => [tcToSec(c.start), tcToSec(c.end)]).filter(([a, b]) => b > a);
  const plan = planCuts(items, { fps: fpsV, duration, existing });
  // the final length after applying, from a real timeline build
  let before = S.tl?.duration ?? null, after = null;
  try {
    const p = JSON.parse(JSON.stringify(S.project));
    p.cuts = [...(p.cuts || []), ...plan.cuts.filter((c) => !c.skip).map((c) => ({ start: secToTc(c.a), end: secToTc(c.b) }))];
    after = timelineFor(p, S.sources, S.brand.assets).duration;
  } catch (e) { /* no host video yet */ }
  return { items, plan, fpsV, before, after };
}

function openReviewImport(prev = "") {
  if (!S.sources.host) return toast("Choose the host video first: comment timecodes are times in that video", true);
  modal(`<h2>Review comments → removes</h2>
    <p>Paste the comments from the review of the original video. Only comments with a start and an end that say <b>Cut</b> are removed automatically; everything else is listed for you.</p>
    <textarea id="revIn" class="rev-in" placeholder="00:01:10 - 00:01:25 Cut&#10;00:05:30 Transition slide&#10;00:07:05 Probably cut this first &quot;well&quot;"></textarea>
    <div class="actions"><button class="btn" id="c">Cancel</button><button class="btn primary" id="go">Review removes</button></div>`, (m) => {
    m.querySelector(".modal-box").classList.add("wide");
    const ta = $("#revIn", m);
    ta.value = prev;
    ta.focus();
    $("#c", m).onclick = closeModal;
    $("#go", m).onclick = () => {
      if (!ta.value.trim()) return;
      showReviewPreview(ta.value, reviewAnalyze(ta.value));
    };
  });
}

function reviewLists(items, plan) {
  const byN = Object.fromEntries(items.map((c) => [c.n, c]));
  const manual = items.filter((c) => c.kind === "manual");
  const excluded = items.filter((c) => c.kind === "excluded");
  const row = (c, extra) => `<tr><td class="tc-c">${tcSpan(c)}</td><td>${extra}</td><td class="cm">${esc(c.text) || "<i>(no text)</i>"}</td></tr>`;
  return {
    byN,
    manualHtml: manual.length ? `<h3>⚠ Needs a manual check (${manual.length})</h3><table class="rev"><tbody>${manual.map((c) => row(c, `<b>${esc(c.reason)}</b>`)).join("")}</tbody></table>` : "",
    excludedHtml: excluded.length ? `<h3>Not removes — left alone (${excluded.length})</h3><table class="rev"><tbody>${excluded.map((c) => row(c, `<span class="chip">${esc(c.type)}</span> ${esc(c.reason)}`)).join("")}</tbody></table>` : "",
  };
}

function showReviewPreview(text, r) {
  const { items, plan, before, after, fpsV } = r;
  const L = reviewLists(items, plan);
  const todo = plan.cuts.filter((c) => !c.skip);
  const cutRows = plan.cuts.map((c, i) => `<tr class="${c.skip ? "skip" : ""}"><td>${i + 1}</td><td class="tc-c">${secToTc(c.a)}</td><td class="tc-c">${secToTc(c.b)}</td>
      <td>${c.skip ? "already removed" : fmtLen(c.b - c.a)}</td>
      <td class="cm">${c.refs.map((n) => `<div>${tcSpan(L.byN[n])} · ${esc(L.byN[n].text)}</div>`).join("")}${c.merged ? `<div class="muted">overlapping comments merged</div>` : ""}</td>
      <td class="cm">${c.memos.map((m) => `📝 ${esc(m.text)}`).join("<br>")}</td></tr>`).join("");
  modal(`<h2>Parts to remove</h2>
    <div class="rev-sum">
      <div><b>${items.length}</b> comments read</div>
      <div><b>${todo.length}</b> part${todo.length === 1 ? "" : "s"} to remove</div>
      <div>removes <b>${fmtLen(plan.removed)}</b> of the recording</div>
      ${plan.already > 0.001 ? `<div>${fmtLen(plan.already)} was already removed</div>` : ""}
      ${before !== null && after !== null ? `<div>final length <b>${fmtTc(before)}</b> → <b>${fmtTc(after)}</b></div>` : ""}
    </div>
    <p class="muted" style="font-size:12px">Timecodes are times in the host recording (${fpsV.toFixed(2)} fps), snapped to its frames. Removes already in the edit are kept; overlapping parts aren't removed twice.</p>
    ${plan.cuts.length ? `<table class="rev"><thead><tr><th>#</th><th>Start</th><th>End</th><th>Length</th><th>Comment</th><th>Note</th></tr></thead><tbody>${cutRows}</tbody></table>` : `<p><b>No comments to remove automatically.</b></p>`}
    ${L.manualHtml}${L.excludedHtml}
    <div class="actions"><button class="btn" id="back">Back</button><button class="btn" id="c">Cancel</button>
      <button class="btn primary" id="apply" ${todo.length ? "" : "disabled"}>Remove ${todo.length} part${todo.length === 1 ? "" : "s"}</button></div>`, (m) => {
    m.querySelector(".modal-box").classList.add("wide");
    $("#back", m).onclick = () => openReviewImport(text);
    $("#c", m).onclick = closeModal;
    $("#apply", m).onclick = () => applyReviewCuts(r);
  });
}

function applyReviewCuts(r) {
  const { items, plan } = r;
  const todo = plan.cuts.filter((c) => !c.skip);
  const seq = nextSeq();
  // one edit = one ⌘Z
  mutate((p) => {
    p.cuts = p.cuts || [];
    todo.forEach((c, i) => p.cuts.push({
      id: uid(), seq: seq + i, start: secToTc(c.a), end: secToTc(c.b), from: "review",
      note: c.memos.map((m) => m.text).join(" · ") || undefined,
    }));
    p.review_import = {
      at: Date.now(), removed: plan.removed,
      cuts: plan.cuts.map((c) => ({ a: c.a, b: c.b, refs: c.refs, skip: !!c.skip, memos: c.memos })),
      items: items.map(({ n, startTc, endTc, text, kind, reason, type, memo }) => ({ n, startTc, endTc, text, kind, reason, type, memo })),
    };
  });
  showReviewReport(S.project.review_import, true);
}

function showReviewReport(rep, justApplied = false) {
  if (!rep) return;
  const L = reviewLists(rep.items, rep);
  const done = rep.items.filter((c) => c.kind === "cut");
  const cutsOf = (n) => rep.cuts.filter((c) => c.refs.includes(n));
  modal(`<h2>${justApplied ? "Review comments applied" : "Last review import"}</h2>
    <div class="rev-sum">
      <div><b>${done.length}</b> comment${done.length === 1 ? "" : "s"} applied</div>
      <div>removed <b>${fmtLen(rep.removed)}</b></div>
      <div><b>${rep.items.filter((c) => c.kind === "manual").length}</b> to check</div>
      <div><b>${rep.items.filter((c) => c.kind === "excluded").length}</b> left alone</div>
    </div>
    ${done.length ? `<h3>✓ Processed (${done.length})</h3><table class="rev"><tbody>${done.map((c) => {
      const ks = cutsOf(c.n);
      return `<tr><td class="tc-c">${tcSpan(c)}</td><td class="tc-c">${ks.map((k) => (k.skip ? "already removed" : `removed ${secToTc(k.a)} – ${secToTc(k.b)}`)).join("<br>")}</td><td class="cm">${esc(c.text)}${c.memo ? `<div class="muted">📝 note kept on the remove</div>` : ""}</td></tr>`;
    }).join("")}</tbody></table>` : ""}
    ${L.manualHtml}${L.excludedHtml}
    <div class="actions">${justApplied ? `<button class="btn" id="undo">Undo this import</button>` : ""}<button class="btn primary" id="c">Done</button></div>`, (m) => {
    m.querySelector(".modal-box").classList.add("wide");
    $("#c", m).onclick = closeModal;
    const u = $("#undo", m);
    if (u) u.onclick = () => { undo(); closeModal(); toast("Review import undone"); };
  });
}

/** A job title box shows as many lines as it has (a 2-line title = 2 rows). */
function fitLines(el) { el.rows = Math.max(1, Math.min(4, el.value.split("\n").length)); }

// ---------------------------------------------------------------- team sign-in (Supabase, optional)
function renderAccount() {
  const box = $("#account");
  if (!box) return;
  if (!teamEnabled()) { box.innerHTML = ""; return; }
  const u = teamUser();
  box.innerHTML = u
    ? `<span class="acct" title="Signed in to the team">${esc(u.email)}</span><button class="btn small ghost" id="signOutBtn">Sign out</button>`
    : `<button class="btn small" id="signInBtn">Sign in</button>`;
  const so = $("#signOutBtn");
  if (so) so.onclick = async () => { await signOut(); renderAccount(); await loadBrand(); refreshPage(); toast("Signed out"); };
  const si = $("#signInBtn");
  if (si) si.onclick = openSignIn;
}

function refreshPage() { if (S.route.page === "brand") renderBrand(); else if (S.route.page === "ep") { previewComp = null; refresh(true); } }

function openSignIn() {
  const c = teamConfig();
  modal(`<h2>Sign in</h2><p>Use your team account${c.allowedDomain ? ` (@${esc(c.allowedDomain)})` : ""} to get the team's brand files.</p>
    ${c.googleLogin ? `<button class="btn" id="g" style="width:100%;margin-bottom:12px">Continue with Google</button><div class="muted" style="text-align:center;font-size:12px;margin-bottom:10px">or</div>` : ""}
    <input id="em" type="email" placeholder="Email" autocomplete="username">
    <input id="pw" type="password" placeholder="Password" autocomplete="current-password" style="margin-top:8px">
    <div class="brand-src" id="siErr" style="color:var(--cut);margin-top:8px"></div>
    <div class="actions"><button class="btn" id="c">Cancel</button><button class="btn primary" id="ok">Sign in</button></div>`, (m) => {
    const go = async () => {
      const em = $("#em", m).value.trim(), pw = $("#pw", m).value;
      if (!em || !pw) return;
      $("#ok", m).disabled = true;
      try {
        await signInPassword(em, pw);
        closeModal(); renderAccount();
        toast("Signed in · loading the team's brand files");
        await loadBrand(); refreshPage();
      } catch (e) { $("#siErr", m).textContent = e.status === 400 ? "Wrong email or password" : e.message; $("#ok", m).disabled = false; }
    };
    $("#ok", m).onclick = go;
    $("#c", m).onclick = closeModal;
    $("#pw", m).onkeydown = (e) => { if (e.key === "Enter") go(); };
    const g = $("#g", m);
    if (g) g.onclick = signInGoogle;
  });
}

// A transition title that wraps to 5+ lines doesn't fit the card: warn under its row.
const TITLE_MAX_LINES = 4;
function titleWarn(id, text) {
  const el = document.querySelector(`[data-warn="${id}"]`);
  if (!el) return;
  const n = text ? comp().titleLines(text) : 0;
  el.hidden = n <= TITLE_MAX_LINES;
  el.textContent = n > TITLE_MAX_LINES ? `⚠ Too long: this title takes ${n} lines on screen (max ${TITLE_MAX_LINES}). Please shorten it.` : "";
}

function renderEditList(full) {
  const box = $("#editList");
  if (!box) return;
  const rows = editRows();
  const sig = rows.map((r) => r.id + (r.cat === "lower_thirds" ? ":" + r.it.person : "") + (r.cat === "cuts" ? ":" + (isSpeedCut(r.it) ? "s" : "r") + (r.it.note ? "n" : "") : "")).join(",");
  const typing = box.contains(document.activeElement) && document.activeElement.matches("input, select, textarea");
  if (box.dataset.sig !== sig && (full || !typing)) {
    box.innerHTML = rows.length ? rows.map(rowHtml).join("") : `<div class="empty">Nothing yet. Use the buttons below or the keyboard (C, L, T).</div>`;
    box.dataset.sig = sig;
  }
  for (const el of $$("[data-field]", box)) {
    if (el === document.activeElement && !full) continue;
    const it = (S.project[el.dataset.list] || []).find((x) => x.id === el.dataset.id);
    if (!it) continue;
    el.value = it[el.dataset.field] ?? (el.dataset.field === "person" ? "host" : el.dataset.field === "layout" ? "split" : "");
    el.classList.remove("invalid");
  }
  for (const t of S.project.titles || []) titleWarn(t.id, t.text);
  const rr = $("#reviewReportBtn");
  if (rr) rr.hidden = !S.project.review_import;
  // speed sliders follow changes made elsewhere (e.g. the panel on the Edited bar)
  for (const el of $$("[data-spd]", box)) {
    if (el === document.activeElement && !full) continue;
    const c = (S.project.cuts || []).find((x) => x.id === el.dataset.spd);
    if (!c) continue;
    el.value = cutSpeed(c);
    const lbl = $("#spd_" + c.id);
    if (lbl) lbl.textContent = fmtX(cutSpeed(c));
  }
  // category filter chips with counts
  const counts = {};
  rows.forEach((r) => { counts[r.cat] = (counts[r.cat] || 0) + 1; });
  const fsel = S.listFilter || "all";
  $("#catFilter").innerHTML = `<button class="cf ${fsel === "all" ? "on" : ""}" data-filter="all">All <b>${rows.length}</b></button>` +
    Object.keys(CATS).map((c) => `<button class="cf ${fsel === c ? "on" : ""}" data-filter="${c}" style="--c:${CATS[c].color}"><i></i>${CATS[c].label} <b>${counts[c] || 0}</b></button>`).join("");
  $$(".er", box).forEach((el) => el.classList.toggle("hidden", fsel !== "all" && el.dataset.cat !== fsel));
  $("#addIntroBtn").disabled = !!S.project.intro;
  $("#addHostIntroBtn").disabled = !!S.project.host_intro;
}

function renderPlanSummary() {
  const tl = S.tl;
  $("#planSum").textContent = tl ? `Final length ${fmtTc(tl.duration)} · 30fps` : "";
  $("#planErr").innerHTML = S.planErr ? `<div class="plan-err" style="margin-bottom:8px">${esc(S.planErr)}</div>` : "";
}

function sortList(items) {
  const key = (x) => { const t = tcToSec(x.at ?? x.start); return isNaN(t) || t === null ? Infinity : t; };
  items.sort((a, b) => key(a) - key(b));
}

function renderSources() {
  if (!$("#src_host")) return;
  for (const role of SRC_ROLES) {
    const box = $(`#src_${role}`);
    if (!box) continue;
    const src = S.sources[role];
    const f = S.faces[role] || {};
    const saved = S.project.sources?.[role];
    const label = ROLE_LABEL[role];
    let body;
    if (src) {
      const v = src.video;
      body = `<div class="u-name">${esc(src.name)}</div>
        <div class="muted" style="font-size:12px">${secToTc(src.duration)} · ${v.width}×${v.height} · ${v.fps.toFixed(2)}fps · ${fmtSize(src.file.size)}${src.audio ? "" : " · no audio"}</div>
        <div class="face-row" id="face_${role}"></div>
        ${role === "hostintro" && !S.project.host_intro ? `<div class="hi-off">Not used in the episode yet. <button class="btn small primary" data-act="addHostIntro">Use as host intro</button></div>` : ""}
        <div class="lvl"><span class="lvl-l">Mic level</span>
          <input type="range" min="-20" max="20" step="0.5" value="${Number(saved?.volume_db ?? 0)}" data-path="sources.${role}.volume_db" data-num="1" data-lvl="lvl_${role}">
          <span class="stat" id="lvl_${role}">${fmtDb(saved?.volume_db ?? 0)}</span>
          <button class="icon-btn" data-act="resetLvl" data-role="${role}" title="Back to 0 dB">↺</button></div>`;
    } else if (f.status === "reconnect") {
      body = `<div class="muted" style="font-size:12px">${esc(saved?.name || "")} — reconnect the file to continue</div>
        <div><button class="btn small primary" data-act="reconnect" data-role="${role}">Reconnect file</button></div>`;
    } else if (f.status === "opening") body = `<div class="muted" style="font-size:12px">Opening file…</div>`;
    else body = `<div class="muted" style="font-size:12px">${saved?.name ? `Previous file: ${esc(saved.name)} · choose it again` : "Drop a file here or choose one"}</div>
        ${f.status === "error" ? `<div style="font-size:12px;color:var(--cut)">${esc(f.error)}</div>` : ""}`;
    box.innerHTML = `<div class="u-top"><b style="font-size:13px">${label}</b></div>${body}
      <div class="row" style="gap:6px"><button class="btn small" data-act="pick" data-role="${role}">${src ? "Replace" : "Choose file"}</button>
        ${src ? `<button class="btn small" data-act="exportFramed" data-role="${role}" ${S.exporting ? "disabled" : ""} title="Export this video on its own, face-framed (1920×1080)">Export framed</button>` : ""}
        <span class="stat" id="exp_${role}">${S.exporting?.role === role ? S.exporting.label : ""}</span></div>`;
    renderFaceRow(role);
  }
}

function renderFaceRow(role) {
  const el = $(`#face_${role}`);
  if (!el) return;
  const f = S.faces[role] || {};
  if (f.status === "running") el.innerHTML = `<span class="pill run">Analyzing faces</span><div class="bar"><i style="width:${Math.round((f.progress || 0) * 100)}%"></i></div><span>${Math.round((f.progress || 0) * 100)}%</span>`;
  else if (f.status === "done") el.innerHTML = f.path.found ? `<span class="pill ok">Face framing ready</span>` : `<span class="pill err">No face found · centered</span>`;
  else el.innerHTML = "";
}

function renderRenderBox() {
  const box = $("#renderBox");
  if (!box) return;
  const r = S.render;
  let html = "";
  if (r && r.running) {
    const pct = r.phase === "audio" ? r.frac * 10 : 10 + r.frac * 90;
    html = `<div class="progress-box"><div class="job-top"><b>${r.draft ? "Draft" : "Final"} render · ${r.phase === "audio" ? "mixing audio" : "compositing video"}</b>
      <button class="btn small" data-act="cancelRender">Cancel</button></div>
      <div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>
      <div class="stat">${pct.toFixed(1)}%${r.speed ? ` · ${r.speed.toFixed(1)}× real time` : ""}${r.eta ? ` · about ${fmtDur(r.eta)} left` : ""}</div>
      <div class="muted" style="font-size:12px;margin-top:6px">Keep this tab open and in front — closing it or leaving it in the background can slow down or stop the render.</div></div>`;
  }
  if (S.lastOutput) {
    const o = S.lastOutput;
    html += `<div class="out-row"><span class="pill ${o.draft ? "" : "ok"}">${o.draft ? "Draft" : "Final"}</span>
      <span class="nm">${esc(o.name)}</span><span class="muted" style="font-size:12px">${o.saved ? "Saved" : fmtSize(o.blob.size)}</span>
      ${o.blob ? `<button class="btn small" data-act="dlOut">Download</button>` : ""}
      <button class="btn small" data-act="dlChapters">Chapters .txt</button></div>`;
  }
  if (!html) html = `<div class="empty">Final renders are 1920×1080 H.264 MP4. In Chrome/Edge you pick where to save first, and the video is written straight to that file while it renders.</div>`;
  box.innerHTML = html;
}

// ---------------------------------------------------------------- player
// Two ways to watch:
//  • Source  — the raw recordings (host / guest), or "Source preview" = the raw playhead drawn as it will look.
//  • Program — the edited episode played live: cuts closed up, intro, bumper, guest card, titles, outro.
//    Footage uses two pairs of <video> elements (A/B) so the next shot is already cued at every cut.
const vid = () => $("#vid");
const gvid = () => $("#gvid");
const mvid = () => $("#mvid");
const off = () => Number(S.project?.sources?.guest?.offset || 0);
const viewRole = () => (["guest", "hostintro"].includes(S.view) ? S.view : "host");
const PG = { pair: 0, idx: -1, playing: false, t: 0, wall: 0, armed: null };
const pgEl = (kind, i) => $(`#pg_${kind}${i ?? ""}`);

function masterTime() {
  if (S.view === "program") {
    const it = pgItem();
    if (!it) return 0;
    const local = Math.min(PG.t, it.outEnd - 1e-3) - it.outStart;
    return it.kind === "footage" ? it.srcStart + local * (it.speed || 1) : (it.srcStart ?? 0);
  }
  const v = vid();
  return v ? v.currentTime - (viewRole() === "guest" ? off() : 0) : 0;
}

function seekMaster(t) {
  if (t === null || isNaN(t)) return;
  if (S.view === "program") setView("preview");
  const v = vid();
  if (!v) return;
  v.currentTime = Math.max(0, t + (viewRole() === "guest" ? off() : 0));
  syncAux(true);
  updateTc();
}

// raw-footage review speed (playback only, never part of the edit)
const RAW_RATES = [1, 1.25, 1.5, 2, 3, 4];
let rawRate = 1;
try { rawRate = RAW_RATES.includes(Number(localStorage.igc_rate)) ? Number(localStorage.igc_rate) : 1; } catch {}
function applyRate() {
  const r = S.view === "program" ? 1 : rawRate;
  for (const el of [vid(), gvid(), mvid()]) {
    if (!el) continue;
    el.preservesPitch = true;
    el.defaultPlaybackRate = r;
    el.playbackRate = r;
  }
  const sel = $("#rateSel");
  if (sel) { sel.value = String(rawRate); sel.hidden = S.view === "program"; }
}
document.addEventListener("change", (e) => {
  if (e.target.id !== "rateSel") return;
  rawRate = Number(e.target.value) || 1;
  try { localStorage.igc_rate = rawRate; } catch {}
  applyRate();
  e.target.blur();   // keep Space / C shortcuts working
});

function setView(view) {
  if (S.view === "program" && view !== "program") pgPause();
  if (view !== "program") vid().pause();
  S.view = view;
  S.preview = view === "preview" || view === "program";
  $$("#viewToggle button").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
  loadVideo();
  if (view === "program") pgSeek(PG.t);
  applyMicLevels();
  applyRate();
  renderTimeline();
  updateTc();
}

function setSrc(el, url) {
  if (url && el.dataset.src !== url) { el.dataset.src = url; el.src = url; }
}

function loadVideo() {
  const v = vid();
  if (!v) return;
  const role = viewRole();
  const keep = v.currentSrc ? v.currentTime - (role === "guest" ? off() : 0) : null;
  $("#pcv").style.display = S.preview ? "block" : "none";
  $("#vidMsg").textContent = S.urls[role] ? "" : `Choose the ${ROLE_LABEL[role].toLowerCase()}`;
  if (S.urls[role] && v.dataset.src !== S.urls[role]) {
    setSrc(v, S.urls[role]);
    v.onloadedmetadata = () => { if (keep !== null) seekMaster(keep); renderTimeline(); };
  }
  setSrc(gvid(), S.urls.guest);
  gvid().muted = S.view !== "preview";
  v.muted = S.view === "program";
  for (const i of [0, 1]) { setSrc(pgEl("h", i), S.urls.host); setSrc(pgEl("g", i), S.urls.guest); }
  setSrc(pgEl("i"), S.urls.hostintro);
  const A = S.brand.assets;
  if (A.bumper?.kind === "video") setSrc(pgEl("b"), A.bumper.url);
  if (A.outro?.kind === "video") setSrc(pgEl("o"), A.outro.url);
  if (A.titleBg?.kind === "video") setSrc(pgEl("t"), A.titleBg.url);
  if (A.music) setSrc(mvid(), A.music.url);
}

// ---------------------------------------------------------------- mic levels in the preview
let audioCtx = null;
const gainNodes = new WeakMap();
function elGain(el, linear) {
  if (!el) return;
  if (linear <= 1 && !gainNodes.has(el)) { el.volume = linear; return; }   // no Web Audio needed
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    let g = gainNodes.get(el);
    if (!g) {
      const srcNode = audioCtx.createMediaElementSource(el);
      g = audioCtx.createGain();
      srcNode.connect(g).connect(audioCtx.destination);
      gainNodes.set(el, g);
      el.volume = 1;
    }
    g.gain.value = linear;
  } catch (e) { el.volume = Math.min(1, linear); }
}
const micGain = (role) => Math.pow(10, Number(S.project?.sources?.[role]?.volume_db ?? 0) / 20);
/** Apply mic levels to every player showing that source. */
function applyMicLevels(only) {
  const set = (role, els) => { if (!only || only === role) els.forEach((el) => elGain(el, micGain(role))); };
  set("host", [pgEl("h", 0), pgEl("h", 1)]);
  set("guest", [gvid(), pgEl("g", 0), pgEl("g", 1)]);
  set("hostintro", [pgEl("i")]);
  if (!only || only === viewRole()) elGain(vid(), micGain(viewRole()));
}

/** Source view: keep the hidden guest player and the music in step with the main player. */
function syncAux(force = false) {
  if (S.view === "program") return;
  if (S.view !== "preview") { if (!gvid().paused) gvid().pause(); if (!mvid().paused) mvid().pause(); return; }
  const t = masterTime();
  const g = gvid();
  if (S.urls.guest && g.readyState >= 1) {
    const want = t + off();
    if (force && Math.abs(g.currentTime - want) > 0.02) g.currentTime = Math.max(0, want);
    else follow(g, want, rawRate, !vid().paused);
    if (vid().paused !== g.paused) vid().paused ? g.pause() : g.play().catch(() => {});
  }
  syncMusic(previewOut(t), !vid().paused, force);
}

function syncMusic(o, playing, force) {
  const m = mvid();
  if (!S.brand.assets.music || !S.tl || o === null || m.readyState < 1) { if (!m.paused) m.pause(); return; }
  const cl = musicAt(S.tl, S.project, o).sort((a, b) => b.gain - a.gain)[0];
  if (!cl) { if (!m.paused) m.pause(); return; }
  m.volume = Math.min(1, cl.gain);
  if (force || Math.abs(m.currentTime - cl.track) > 0.25) m.currentTime = Math.max(0, cl.track);
  if (playing && m.paused) m.play().catch(() => {});
  if (!playing && !m.paused) m.pause();
}

/** Where the raw playhead lands in the output, preferring the intro range. */
function previewOut(t) {
  const tl = S.tl;
  if (!tl) return null;
  if (tl.introRange && t >= tl.introRange[0] && t < tl.introRange[1]) return tl.intro.start + (t - tl.introRange[0]);
  if (tl.keep.some(([a, b]) => t >= a && t < b)) return tl.toOut(t);
  return null;
}

// ---------------------------------------------------------------- program playback
function pgItemIndex(t) {
  const items = S.tl?.items || [];
  for (let i = 0; i < items.length; i++) if (t < items[i].outEnd - 1e-6) return i;
  return items.length - 1;
}
const pgItem = () => (S.tl ? S.tl.items[pgItemIndex(PG.t)] : null);
const camRole = (it) => (it.src === "hostintro" ? "hostintro" : it.camera === "guest" && S.sources.guest ? "guest" : "host");

/** Put pair p on footage item `it` at local time `local`. */
function cuePair(p, it, local) {
  const st = it.srcStart + local * (it.speed || 1);
  const h = pgEl("h", p), g = pgEl("g", p);
  if (h.readyState >= 1 && Math.abs(h.currentTime - st) > 0.04) h.currentTime = Math.max(0, st);
  if (S.urls.guest && g.readyState >= 1 && Math.abs(g.currentTime - (st + off())) > 0.04) g.currentTime = Math.max(0, st + off());
}

function pgPauseAll(except = []) {
  for (const el of [pgEl("h", 0), pgEl("h", 1), pgEl("g", 0), pgEl("g", 1), pgEl("i"), pgEl("b"), pgEl("o"), pgEl("t")]) {
    if (el && !except.includes(el) && !el.paused) el.pause();
  }
}

function pgArmNext() {
  const items = S.tl.items;
  for (let j = PG.idx + 1; j < items.length; j++) {
    if (items[j].src === "hostintro") {
      const e = pgEl("i");
      if (e.readyState >= 1) e.currentTime = items[j].srcStart;
      continue;
    }
    if (items[j].kind === "footage") {
      const p = 1 - PG.pair;
      cuePair(p, items[j], 0);
      PG.armed = { idx: j, pair: p };
      return;
    }
  }
  PG.armed = null;
}

function pgEnter(idx, local) {
  const it = S.tl.items[idx];
  PG.idx = idx;
  if (it.src === "hostintro") {
    const e = pgEl("i");
    pgPauseAll([e, pgEl("b")]);
    if (e.readyState >= 1 && Math.abs(e.currentTime - (it.srcStart + local)) > 0.04) e.currentTime = it.srcStart + local;
    e.muted = false;
    if (PG.playing) e.play().catch(() => {});
    pgArmNext();
  } else if (it.kind === "footage") {
    if (PG.armed && PG.armed.idx === idx && local < 0.05) PG.pair = PG.armed.pair;
    cuePair(PG.pair, it, local);
    const h = pgEl("h", PG.pair), g = pgEl("g", PG.pair);
    for (const el of [h, g]) { el.preservesPitch = true; el.playbackRate = it.speed || 1; }   // sped-up ranges
    pgPauseAll([h, g, pgEl("b")]);
    if (PG.playing) { h.play().catch(() => {}); if (S.urls.guest) g.play().catch(() => {}); }
    pgArmNext();
  } else {
    const el = { bumper: pgEl("b"), outro: pgEl("o"), title: pgEl("t") }[it.kind];
    const hasClip = el && el.dataset.src;
    pgPauseAll(hasClip ? [el] : []);
    if (hasClip && el.readyState >= 1) {
      if (Math.abs(el.currentTime - local) > 0.05) el.currentTime = local;
      el.muted = false;
      if (PG.playing) el.play().catch(() => {});
    }
    pgArmNext();
  }
}

function pgSeek(t) {
  if (!S.tl) return;
  PG.t = Math.max(0, Math.min(S.tl.duration - 1 / 30, t));
  const idx = pgItemIndex(PG.t);
  PG.armed = null;
  pgEnter(idx, PG.t - S.tl.items[idx].outStart);
  PG.wall = performance.now();
  syncMusic(PG.t, PG.playing, true);
  pgSyncBumper(PG.t, PG.playing);
  updateTc();
}

function pgPlay() {
  if (!S.tl) return;
  if (PG.t >= S.tl.duration - 0.05) PG.t = 0;
  PG.playing = true;
  pgSeek(PG.t);
}
function pgPause() {
  PG.playing = false;
  pgPauseAll();
  if (!mvid().paused) mvid().pause();
  updateTc();
}

/** While the Intro clip overlaps the next footage, keep its <video> playing and in step. */
function pgSyncBumper(t, playing) {
  const b = pgEl("b");
  if (!b?.dataset.src) return;
  const bo = S.tl.overlays.find((x) => x.kind === "bumper" && t >= x.outStart && t < x.outEnd);
  if (!bo) return;
  const want = t - bo.bumperStart;
  if (b.readyState >= 1 && Math.abs(b.currentTime - want) > 0.1) b.currentTime = want;
  if (playing && b.paused) b.play().catch(() => {});
}

function pgTick() {
  if (!PG.playing || !S.tl) return;
  const it = S.tl.items[PG.idx];
  const now = performance.now();
  if (it.src === "hostintro") {
    PG.t = it.outStart + Math.max(0, pgEl("i").currentTime - it.srcStart);
  } else if (it.kind === "footage") {
    const role = camRole(it);
    const el = pgEl(role === "guest" ? "g" : "h", PG.pair);
    const local = (el.currentTime - (role === "guest" ? off() : 0) - it.srcStart) / (it.speed || 1);
    PG.t = it.outStart + Math.max(0, local);
    // keep the other camera of the pair locked to this one
    const other = role === "guest" ? pgEl("h", PG.pair) : pgEl("g", PG.pair);
    const want = role === "guest" ? el.currentTime - off() : el.currentTime + off();
    follow(other, want, it.speed || 1, !el.paused);
  } else {
    PG.t += (now - PG.wall) / 1000;
  }
  PG.wall = now;
  if (PG.t >= it.outEnd - 1 / 60) {
    if (PG.idx >= S.tl.items.length - 1) { PG.t = S.tl.duration; pgPause(); return; }
    PG.t = it.outEnd;
    pgEnter(PG.idx + 1, 0);
  }
  syncMusic(PG.t, true, false);
  pgSyncBumper(PG.t, true);
  const b = pgEl("b");
  if (b && !b.paused && S.tl.items[PG.idx].kind !== "bumper" && !S.tl.overlays.some((x) => x.kind === "bumper" && PG.t >= x.outStart && PG.t < x.outEnd)) b.pause();
}

// ---------------------------------------------------------------- painting
let previewComp = null;
function comp() {
  const cv = $("#pcv");
  if (!previewComp || previewComp.canvas !== cv) {
    previewComp = new Compositor(cv);
    previewComp.setBrand({ logo: S.brand.logo, quote: S.brand.quote, fonts: S.brand.fonts });
  }
  previewComp.setPeople(S.project.people);
  return previewComp;
}

// Each <video> keeps a copy of its last good frame, so a resync seek never blanks the picture.
const heldFrames = new WeakMap();
function elImg(el) {
  if (!el || !el.dataset.src) return null;
  let h = heldFrames.get(el);
  if (h && h.src !== el.dataset.src) { heldFrames.delete(el); h = null; }
  if (el.readyState >= 2 && !el.seeking && el.videoWidth) {
    if (!h) { h = { src: el.dataset.src, cv: document.createElement("canvas"), t: -1 }; heldFrames.set(el, h); }
    if (h.t !== el.currentTime) {
      if (h.cv.width !== el.videoWidth || h.cv.height !== el.videoHeight) { h.cv.width = el.videoWidth; h.cv.height = el.videoHeight; }
      h.cv.getContext("2d").drawImage(el, 0, 0);
      h.t = el.currentTime;
    }
    return { img: el, w: el.videoWidth, h: el.videoHeight };
  }
  return h && h.t >= 0 ? { img: h.cv, w: h.cv.width, h: h.cv.height } : null;
}

/** Keep a follower <video> in step with a target time: nudge its speed for small drift, seek only for big jumps. */
function follow(el, want, baseRate, playing) {
  if (!el?.dataset.src || el.readyState < 1) return;
  want = Math.max(0, want);
  const d = want - el.currentTime;
  if (!playing || Math.abs(d) > 0.6) {
    if (Math.abs(d) > (playing ? 0.6 : 0.02) && !el.seeking) el.currentTime = want;
    if (el.playbackRate !== baseRate) el.playbackRate = baseRate;
    return;
  }
  const r = baseRate * (1 + Math.max(-0.15, Math.min(0.15, d * 0.8)));
  if (Math.abs(el.playbackRate - r) > 0.004) el.playbackRate = r;
}

/** Draw output time o. frameOf(role) gives the element showing that camera at the right moment. */
function paintOutput(c, o, frameOf) {
  const tl = S.tl;
  const it = tl.items[pgItemIndex(o)];
  const local = o - it.outStart;
  const sp = STYLE.split, so = STYLE.solo;
  if (it.kind === "footage") {
    const st = it.srcStart + local * (it.speed || 1);
    const cam = (role, ow, oh, fh, fy) => {
      const e = frameOf(role);
      if (!e) return null;
      const time = role === "guest" ? st + off() : st;
      return { img: e.img, crop: pathFor(role).crop(time, e.w, e.h, ow, oh, fh, fy, STYLE.maxUpscale) };
    };
    const gc = it.overlays.find((x) => x.kind === "guestcard" && o >= x.outStart && o < x.outEnd);
    const bo = it.overlays.find((x) => x.kind === "bumper" && o >= x.outStart && o < x.outEnd);
    if (bo) {
      const A = S.brand.assets;
      c.drawBumper(elImg(pgEl("b")) || (A.bumper?.kind === "image" ? { img: A.bumper.bitmap, w: A.bumper.w, h: A.bumper.h } : null), o - bo.bumperStart);
      return "Intro";
    }
    if (gc && o < gc.cardEnd) c.drawGuestCard(o - gc.outStart, gc.person);
    else if (it.layout === "split") c.drawFootage("split", cam("host", sp.panelW, sp.panelH, sp.faceHeight, sp.faceY), cam("guest", sp.panelW, sp.panelH, sp.faceHeight, sp.faceY));
    else {
      const src = cam(camRole(it), STYLE.width, STYLE.height, so.faceHeight, so.faceY);
      if (gc) { c.drawGuestCard(o - gc.outStart, gc.person); c.drawSlidePanel((o - gc.cardEnd) / (gc.outEnd - gc.cardEnd), src); }
      else c.drawFootage("solo", src);
    }
    for (const ov of it.overlays) if (ov.kind === "l3" && o >= ov.outStart && o < ov.outEnd) c.drawL3(o - ov.outStart, ov.outEnd - ov.outStart, ov.person, it.layout, ov.role);
    return gc && o < gc.cardEnd ? "Guest card" : it.part === "intro" ? "Cold Open" : it.part === "hostintro" ? "Host intro" : it.layout === "split" ? "Split" : `${camRole(it) === "guest" ? "Guest" : "Host"} solo`;
  }
  const A = S.brand.assets;
  const still = (a) => (a?.kind === "image" ? { img: a.bitmap, w: a.w, h: a.h } : null);
  if (it.kind === "bumper") { c.drawBumper(elImg(pgEl("b")) || still(A.bumper), local); return "Intro"; }
  if (it.kind === "title") { c.drawTitle(local, it.duration, it.text, elImg(pgEl("t")) || still(A.titleBg)); return "Title"; }
  c.drawOutro(elImg(pgEl("o")) || still(A.outro), local);
  return "Outro";
}

function blank(c, cv, msg = "") {
  const x = c.ctx;
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.fillStyle = "#000";
  x.fillRect(0, 0, cv.width, cv.height);
  if (msg) { x.fillStyle = "#aab"; x.font = "600 22px Inter, sans-serif"; x.textAlign = "center"; x.fillText(msg, cv.width / 2, cv.height / 2); x.textAlign = "left"; }
}

function drawPreview() {
  const cv = $("#pcv");
  if (!cv || !S.preview) return;
  const c = comp();
  const badge = $("#pbadge");
  if (S.titlePreview) {
    const el = (performance.now() - S.titlePreview.start) / 1000;
    const tdur = titleLength(S.titlePreview.text);
    if (el < tdur) {
      const bg = S.brand.assets.titleBg;
      c.drawTitle(el, tdur, S.titlePreview.text, bg?.kind === "image" ? { img: bg.bitmap, w: bg.w, h: bg.h } : null);
      badge.textContent = "Title preview";
      return;
    }
    S.titlePreview = null;
  }
  if (!S.tl) { blank(c, cv); badge.textContent = ""; return; }
  if (S.view === "program") {
    const label = paintOutput(c, PG.t, (role) => elImg(role === "hostintro" ? pgEl("i") : pgEl(role === "guest" ? "g" : "h", PG.pair)));
    badge.textContent = `PROGRAM · ${label} · ${fmtTc(PG.t)}`;
    return;
  }
  const v = vid();
  if (v.readyState < 2) { blank(c, cv); return; }
  const t = masterTime();
  const o = previewOut(t);
  if (o === null) {
    c.drawFootage("solo", { img: v, crop: pathFor("host").crop(t, v.videoWidth, v.videoHeight, STYLE.width, STYLE.height, STYLE.solo.faceHeight, STYLE.solo.faceY, STYLE.maxUpscale) });
    const x = c.ctx;
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.fillStyle = "rgba(14,14,18,.65)";
    x.fillRect(0, 0, cv.width, cv.height);
    x.fillStyle = "#fff"; x.font = "700 28px Inter, sans-serif"; x.textAlign = "center";
    x.fillText("This part is not used", cv.width / 2, cv.height / 2);
    x.textAlign = "left";
    badge.textContent = "Not used";
    return;
  }
  const label = paintOutput(c, o, (role) => elImg(role === "guest" ? gvid() : v));
  badge.textContent = `${label} · final ${fmtTc(o)}`;
}

function updateTc() {
  const prog = S.view === "program";
  $("#tcNow").textContent = prog ? fmtTc(PG.t) : secToTc(Math.max(0, masterTime()));
  $("#tcKind").textContent = prog ? "FINAL" : "RAW";
  const dur = S.sources[viewRole() === "hostintro" ? "hostintro" : "host"]?.duration;
  const ph = $("#tlBar .ph");
  if (ph && dur) ph.style.left = (Math.max(0, Math.min(1, masterTime() / dur)) * 100) + "%";
  const pph = $("#pgBar .ph");
  if (pph && S.tl) pph.style.left = (Math.max(0, Math.min(1, (prog ? PG.t : previewOut(masterTime()) ?? 0) / S.tl.duration)) * 100) + "%";
  const playing = prog ? PG.playing : vid()?.paused === false;
  $("#playBtn").textContent = playing ? "❚❚" : "▶";
  if (playing && S.zoom > 1) followPlayhead();
  // stretch the pending-cut highlight to the playhead (no full redraw)
  const pend = $("#tlBar .r.pending");
  if (pend && dur && S.cutStart !== null && S.cutStart !== undefined) {
    const now = masterTime(), a = Math.min(S.cutStart, now), b = Math.max(S.cutStart, now);
    pend.style.left = (Math.max(0, a / dur) * 100) + "%";
    pend.style.width = (Math.max(0, (b - a) / dur) * 100) + "%";
  }
}

function tick() {
  if (S.route.page === "ep" && vid()) {
    if (S.view === "program") { pgTick(); updateTc(); }
    else if (!vid().paused) { updateTc(); syncAux(); }
    if (S.preview) drawPreview();
  }
  requestAnimationFrame(tick);
}

// Backup clock: some browsers throttle animation frames while the page looks idle (all the
// playing <video> elements are hidden), which would freeze the edited-view playhead.
setInterval(() => {
  if (S.route.page === "ep" && S.view === "program" && PG.playing) { pgTick(); updateTc(); drawPreview(); }
}, 40);

function togglePlay() {
  if (S.view === "program") { PG.playing ? pgPause() : pgPlay(); return; }
  const v = vid();
  if (!v.readyState) return;
  v.paused ? v.play() : v.pause();
  setTimeout(() => { updateTc(); syncAux(true); }, 30);
}

/** Step by whole frames from the current frame (30 frames = 1 second). */
function stepFrames(n) {
  if (S.view === "program") { pgPause(); pgSeek((Math.round(PG.t * FPS) + n) / FPS); return; }
  vid().pause();
  // land a tenth of a frame inside the target frame so the player shows exactly that frame
  seekMaster((Math.round(masterTime() * FPS) + n + 0.1) / FPS);
}
const stepBy = (dt) => stepFrames(Math.round(dt * FPS));

/** +/- : zoom both timeline bars around the playhead. */
function setZoom(z) {
  S.zoom = Math.max(1, Math.min(64, z));
  for (const id of ["#pgScroll", "#tlScroll"]) { const sc = $(id); if (sc) sc.firstElementChild.style.width = `${S.zoom * 100}%`; }
  $("#zoomLbl").textContent = S.zoom > 1 ? `(${S.zoom}×)` : "";
  renderTimeline();
  followPlayhead(true);
}

/** Keep the playhead visible in a zoomed bar. */
function followPlayhead(center = false) {
  if (S.zoom <= 1) return;
  for (const id of ["#pgScroll", "#tlScroll"]) {
    const sc = $(id), ph = sc?.querySelector(".ph");
    if (!ph) continue;
    const x = ph.offsetLeft, w = sc.clientWidth;
    if (center || x < sc.scrollLeft + 20 || x > sc.scrollLeft + w - 20) sc.scrollLeft = x - (center ? w / 2 : w * 0.15);
  }
}

function renderMarks() {
  const cutting = S.cutStart !== null && S.cutStart !== undefined;   // orange playheads while a cut is open
  $("#tlBar")?.classList.toggle("cutting", cutting);
  $("#pgBar")?.classList.toggle("cutting", cutting);
  if (S.cutStart !== null && S.cutStart !== undefined) {
    $("#marks").innerHTML = `<span class="cut-pending">REMOVE from <b>${secToTc(S.cutStart)}</b> · press C at the end</span>`;
    renderTimeline();
    return;
  }
  $("#marks").innerHTML = (S.markIn !== null ? `IN <b>${secToTc(S.markIn)}</b> ` : "") + (S.markOut !== null ? `OUT <b>${secToTc(S.markOut)}</b>` : "");
  renderTimeline();
}

/** Segment speed panel on the Edited bar. a..b = the segment's source range (between two cuts). */
/**
 * Speed panel for one or more source ranges [{a, b}] (a Final Preview range can cover several
 * pieces of the recording). `label` describes the range on the Final timeline.
 */
function openSpeedPop(ranges, clientX, clientY, cur = 1, label = "") {
  $("#speedPop")?.remove();                             // keep the selection band showing
  cur = Math.min(2, Math.max(1, Number(cur) || 1));
  const host = $("#pgScroll").parentElement;
  const hr = host.getBoundingClientRect();
  const pop = document.createElement("div");
  pop.className = "speed-pop";
  pop.id = "speedPop";
  pop.innerHTML = `<div class="sp-h"><b>Speed</b><span class="muted">${label}</span><button class="icon-btn" data-sp="close" title="Close">✕</button></div>
    <div class="lvl"><input type="range" min="1" max="2" step="0.1" value="${cur}" id="spPopRange"><b class="sp-v" id="spPopVal">${fmtX(cur)}</b></div>
    <div class="sp-f"><button class="btn small" data-sp="reset">Normal speed</button><button class="btn small primary" data-sp="close">Done</button></div>`;
  host.appendChild(pop);
  pop.style.left = `${Math.max(0, Math.min(hr.width - 280, clientX - hr.left - 140))}px`;
  pop.style.top = `${clientY - hr.top + 16}px`;
  // only these ranges change: older speed ranges that overlap them are trimmed, not removed
  const set = (v) => mutate((p) => {
    let list = p.speeds || [];
    for (const { a, b } of ranges) {
      const out = [];
      for (const x of list) {
        const s0 = tcToSec(x.start), e0 = tcToSec(x.end);
        if (!(e0 > a + 1e-6 && s0 < b - 1e-6)) { out.push(x); continue; }
        if (s0 < a - 1e-6) out.push({ ...x, id: uid(), end: secToTc(a) });
        if (e0 > b + 1e-6) out.push({ ...x, id: uid(), start: secToTc(b) });
      }
      if (v > 1.0001) out.push({ id: uid(), start: secToTc(a), end: secToTc(b), speed: Math.round(v * 10) / 10 });
      list = out;
    }
    p.speeds = list;
  });
  const range = $("#spPopRange", pop);
  range.addEventListener("input", () => { $("#spPopVal").textContent = fmtX(range.value); });
  range.addEventListener("change", () => set(Number(range.value)));
  pop.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-sp]");
    if (!btn) return;
    if (btn.dataset.sp === "reset") set(1);
    closeSpeedPop();
  });
}

/** The segment of Final Preview under output time o (between two visible cut points), as a source range. */
function segmentAt(o) {
  const tl = S.tl;
  const it = tl?.items[pgItemIndex(o)];
  if (!it || it.part !== "main") return null;
  const items = tl.items;
  const joins = (x, y) => x?.part === "main" && y?.part === "main" && Math.abs(x.srcStart + x.srcDur - y.srcStart) < 0.01;
  let i = items.indexOf(it), j = i;
  while (joins(items[i - 1], items[i])) i--;
  while (joins(items[j], items[j + 1])) j++;
  return { a: items[i].srcStart, b: items[j].srcStart + items[j].srcDur, speed: it.speed || 1, oa: items[i].outStart, ob: items[j].outEnd };
}

function closeSpeedPop() { $("#speedPop")?.remove(); $("#pgBar .pg-sel")?.remove(); }

/** The pieces of the recording that play between Final times o1 and o2 (main episode only). */
function sourceRangesBetween(o1, o2) {
  const out = [];
  for (const it of S.tl.items) {
    if (it.part !== "main" || it.outEnd <= o1 + 1e-6 || it.outStart >= o2 - 1e-6) continue;
    const sp = it.speed || 1;
    const a = snapF(it.srcStart + (Math.max(o1, it.outStart) - it.outStart) * sp);
    const b = snapF(it.srcStart + (Math.min(o2, it.outEnd) - it.outStart) * sp);
    if (b - a < 1 / FPS) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last.b - a) < 1e-6) last.b = b; else out.push({ a, b });
  }
  return out;
}
document.addEventListener("pointerdown", (e) => { if ($("#speedPop") && !e.target.closest?.("#speedPop, #pgBar")) closeSpeedPop(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeSpeedPop(); if (S.sel && !e.target.matches?.("input, select, textarea")) { S.sel = null; renderTimeline(); } } });

/** Drag anywhere on a bar to scrub. */
function scrubbable(bar, onPos, onClick) {
  bar.addEventListener("pointerdown", (e) => {
    const th = e.target.closest?.(".trim-h");
    if (th) return dragTrimHandle(th, e);
    if (bar._intercept?.(e)) return;
    const x0 = e.clientX, y0 = e.clientY;
    let moved = false;
    bar.setPointerCapture(e.pointerId);
    const at = (ev) => { const r = bar.getBoundingClientRect(); return Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)); };
    onPos(at(e));
    let raf = 0, last = null;
    const move = (ev) => { if (Math.abs(ev.clientX - x0) > 4) moved = true; last = at(ev); if (!raf) raf = requestAnimationFrame(() => { raf = 0; onPos(last); }); };
    const up = (ev) => { if (!moved && onClick && ev.type === "pointerup") onClick(at(ev), x0, y0); bar.removeEventListener("pointermove", move); bar.removeEventListener("pointerup", up); bar.removeEventListener("pointercancel", up); };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up);
    bar.addEventListener("pointercancel", up);
  });
}

// ---------------------------------------------------------------- move parts of the footage
// Shift+drag on Raw Footage selects any part (no cuts needed); drag the selection, or ⌥-drag a
// segment of Final Preview, and drop it anywhere on either bar. The footage splits at the drop point.
const snapF = (t) => Math.round(t * FPS) / FPS;

function rawBarPointer(e) {
  if (S.view === "hostintro" || !S.sources.host?.duration) return false;
  const bar = $("#tlBar"), dur = S.sources.host.duration;
  const at = (ev) => { const r = bar.getBoundingClientRect(); return snapF(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * dur); };
  if (e.target.closest(".sel") && S.sel && !e.shiftKey) { startMoveDrag(e, S.sel.a, S.sel.b); return true; }
  if (!e.shiftKey) return false;
  // Shift+drag: select a part
  e.preventDefault();
  try { bar.setPointerCapture(e.pointerId); } catch {}
  const t0 = at(e);
  S.sel = { a: t0, b: t0 };
  const move = (ev) => {
    const t = at(ev);
    S.sel = { a: Math.min(t0, t), b: Math.max(t0, t) };
    if (S.view === "program") setView("preview");
    vid().pause();
    seekMaster(t);
    renderTimeline();
  };
  const up = () => {
    bar.removeEventListener("pointermove", move);
    bar.removeEventListener("pointerup", up);
    bar.removeEventListener("pointercancel", up);
    if (!S.sel || S.sel.b - S.sel.a < 1 / FPS) { S.sel = null; renderTimeline(); return; }
    renderTimeline();
    toast("Drag the selection onto Final Preview (or Raw Footage) to move it · Esc to clear");
  };
  bar.addEventListener("pointermove", move);
  bar.addEventListener("pointerup", up);
  bar.addEventListener("pointercancel", up);
  return true;
}

function finalBarPointer(e) {
  if (e.shiftKey && S.tl) return selectSpeedRange(e);
  if (!e.altKey || !S.tl) return false;
  const bar = $("#pgBar"), r = bar.getBoundingClientRect();
  const o = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * S.tl.duration;
  const it = S.tl.items[pgItemIndex(o)];
  if (!it || it.part !== "main") { toast("Only main episode footage can be moved", true); return true; }
  // the whole uninterrupted piece under the pointer
  let i = S.tl.items.indexOf(it), j = i;
  const items = S.tl.items;
  const joins = (x, y) => x?.part === "main" && y?.part === "main" && Math.abs(x.srcStart + x.srcDur - y.srcStart) < 0.01;
  while (joins(items[i - 1], items[i])) i--;
  while (joins(items[j], items[j + 1])) j++;
  startMoveDrag(e, items[i].srcStart, items[j].srcStart + items[j].srcDur);
  return true;
}

/** Shift+drag on Final Preview: pick any stretch (no cuts needed) and give it a speed. */
function selectSpeedRange(e) {
  e.preventDefault();
  closeSpeedPop();
  const bar = $("#pgBar"), D = S.tl.duration;
  try { bar.setPointerCapture(e.pointerId); } catch {}
  const at = (ev) => { const r = bar.getBoundingClientRect(); return snapF(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * D); };
  const o0 = at(e);
  let o1 = o0;
  const band = document.createElement("div");
  band.className = "pg-sel";
  bar.append(band);
  const draw = () => {
    if (!bar.contains(band)) bar.append(band);          // the bar may have been redrawn
    const a = Math.min(o0, o1), b = Math.max(o0, o1);
    band.style.left = `${(a / D) * 100}%`;
    band.style.width = `${((b - a) / D) * 100}%`;
    band.dataset.l = `${fmtTc(a)} – ${fmtTc(b)}`;
  };
  draw();
  const move = (ev) => {
    o1 = at(ev);
    draw();
    if (S.view !== "program") setView("program");
    pgPause();
    pgSeek(o1);
  };
  const up = (ev) => {
    bar.removeEventListener("pointermove", move);
    bar.removeEventListener("pointerup", up);
    bar.removeEventListener("pointercancel", up);
    const a = Math.min(o0, o1), b = Math.max(o0, o1);
    const ranges = b - a >= 1 / FPS ? sourceRangesBetween(a, b) : [];
    if (!ranges.length) { band.remove(); if (b - a >= 1 / FPS) toast("Only main episode footage can be sped up", true); return; }
    if (!bar.contains(band)) bar.append(band);
    const it = S.tl.items[pgItemIndex(a)];
    openSpeedPop(ranges, ev.clientX, ev.clientY, it?.part === "main" ? it.speed || 1 : 1, `${fmtTc(a)} → ${fmtTc(b)}`);
  };
  bar.addEventListener("pointermove", move);
  bar.addEventListener("pointerup", up);
  bar.addEventListener("pointercancel", up);
  return true;
}

/** Where a drop at clientX/clientY would insert: {to (source time or null = end), out (edited time), bar} */
function dropTarget(x, y) {
  const tl = S.tl;
  if (!tl) return null;
  for (const id of ["pgBar", "tlBar"]) {
    const bar = $("#" + id), r = bar.getBoundingClientRect();
    if (y < r.top - 14 || y > r.bottom + 14 || x < r.left - 4 || x > r.right + 4) continue;
    const u = Math.max(0, Math.min(1, (x - r.left) / r.width));
    if (id === "tlBar") {
      const dur = S.sources.host.duration;
      const t = snapF(u * dur);
      return { bar, u, to: t, out: previewOut(t) };
    }
    let o = u * tl.duration;
    // snap to piece boundaries within 8 px
    const px = 8 / r.width * tl.duration;
    for (const it of tl.items) if (Math.abs(it.outStart - o) < px) { o = it.outStart; break; }
    const it = tl.items[pgItemIndex(o)];
    const firstMain = tl.items.find((x) => x.part === "main");
    let to, out;
    if (it.part === "main") { to = snapF(it.srcStart + (o - it.outStart) * (it.speed || 1)); out = o; }
    else if (it.kind === "title") { const nx = tl.items.slice(tl.items.indexOf(it)).find((x) => x.part === "main"); to = nx ? nx.srcStart : null; out = it.outStart; }
    else if (it.kind === "outro") { to = null; out = it.outStart; }
    else { to = firstMain ? firstMain.srcStart : null; out = firstMain ? firstMain.outStart : o; }
    return { bar, u: out / tl.duration, to, out };
  }
  return null;
}

function startMoveDrag(e, a, b) {
  e.preventDefault();
  e.stopPropagation();
  const src = e.target;
  try { src.setPointerCapture(e.pointerId); } catch {}
  const x0 = e.clientX;
  let dragging = false, tgt = null;
  const line = document.createElement("div"); line.className = "ins-line";
  const tip = document.createElement("div"); tip.className = "ins-tip";
  const clear = () => { line.remove(); tip.remove(); document.body.classList.remove("moving"); };
  const move = (ev) => {
    if (!dragging && Math.abs(ev.clientX - x0) < 4) return;
    if (!dragging) { dragging = true; document.body.classList.add("moving"); document.body.append(tip); }
    tgt = dropTarget(ev.clientX, ev.clientY);
    const bad = tgt && tgt.to !== null && tgt.to > a + 1e-6 && tgt.to < b - 1e-6;
    if (!tgt) { line.remove(); tip.textContent = `${secToTc(a)} – ${secToTc(b)} · drop on a timeline`; }
    else {
      if (line.parentElement !== tgt.bar) tgt.bar.append(line);
      line.style.left = `${tgt.u * 100}%`;
      line.classList.toggle("bad", !!bad);
      tip.textContent = bad ? "Can't drop a part inside itself"
        : `Insert at ${tgt.out !== null && tgt.out !== undefined ? "FINAL " + fmtTc(tgt.out) : "—"} · RAW ${tgt.to === null ? "end" : secToTc(tgt.to)}`;
    }
    tip.classList.toggle("bad", !!bad);
    tip.style.left = `${ev.clientX + 14}px`;
    tip.style.top = `${ev.clientY + 16}px`;
  };
  const up = (ev) => {
    src.removeEventListener("pointermove", move);
    src.removeEventListener("pointerup", up);
    src.removeEventListener("pointercancel", up);
    clear();
    if (!dragging || ev.type !== "pointerup") return;
    tgt = dropTarget(ev.clientX, ev.clientY);                 // released off the bars = cancel
    if (!tgt) return;
    if (tgt.to !== null && tgt.to > a + 1e-6 && tgt.to < b - 1e-6) return;
    if (tgt.to !== null && (Math.abs(tgt.to - a) < 1e-6 || Math.abs(tgt.to - b) < 1e-6)) return;   // dropped where it already is
    S.sel = null;
    mutate((p) => { (p.moves = p.moves || []).push({ id: uid(), seq: nextSeq(), start: secToTc(a), end: secToTc(b), to: tgt.to === null ? null : secToTc(tgt.to) }); });
    revealNew("moves");
    toast(`Moved ${secToTc(a)} – ${secToTc(b)} · ⌘Z to undo`);
  };
  src.addEventListener("pointermove", move);
  src.addEventListener("pointerup", up);
  src.addEventListener("pointercancel", up);
}

const LAYOUT_COLOR = { host: "#9BB4D6", guest: "#E0B3C8", split: "var(--purple-2)" };

function renderTimeline() {
  const bar = $("#tlBar");
  if (!bar) return;
  if (S.view === "hostintro") return renderHostIntroBar(bar);
  $("#srcBarLabel").textContent = "Raw Footage";
  const dur = S.sources.host?.duration;
  const tl = S.tl;
  renderProgramBar();
  if (!dur) { bar.innerHTML = ""; $("#tlScale").innerHTML = ""; return; }
  const p = S.project;
  const pct = (t) => (Math.max(0, Math.min(dur, t)) / dur) * 100;
  const span = (a, b, cls, title = "", style = "") => (a === null || b === null || isNaN(a) || isNaN(b) || b <= a) ? "" :
    `<div class="r ${cls}" style="left:${pct(a)}%;width:${pct(b) - pct(a)}%;${style}" title="${esc(title)}"></div>`;
  let html = "";
  const inPt = tl ? tl.inPoint : (tcToSec(p.in) || 0);
  const outPt = tl ? tl.outPoint : dur;
  html += span(0, inPt, "trim", "Before the main start") + span(outPt, dur, "trim", "After the main end");
  if (tl) {
    const sw = [{ at: inPt, layout: "host" }, ...tl.switches.filter((x) => x.at > inPt)];
    sw.forEach((x, i) => {
      const end = Math.min(outPt, sw[i + 1]?.at ?? outPt);
      html += span(Math.max(inPt, x.at), end, "lay", `${x.layout === "split" ? "Split" : x.layout === "guest" ? "Guest only" : "Host only"}`, `background:${LAYOUT_COLOR[x.layout]}`);
    });
  }
  if (p.intro) html += span(tcToSec(p.intro.start), tcToSec(p.intro.end), "intro", "Cold Open");
  if (p.host_intro) html += span(tcToSec(p.host_intro.start), tcToSec(p.host_intro.end), "intro", "Host intro", "background:#5E8FD0");
  for (const c of p.cuts || []) if (!isSpeedCut(c)) html += span(tcToSec(c.start), tcToSec(c.end), "cut", `Remove ${c.start} → ${c.end}`);
  if (S.markIn !== null && S.markOut !== null) html += span(S.markIn, S.markOut, "marked", "IN/OUT");
  if (S.cutStart !== null && S.cutStart !== undefined) {
    const now = masterTime();
    html += `<div class="r cut pending" style="left:${pct(Math.min(S.cutStart, now))}%;width:${pct(Math.max(S.cutStart, now)) - pct(Math.min(S.cutStart, now))}%" title="Part being marked for removal"></div>`;
  }
  for (const r of tl?.speedRanges || []) html += span(r.a, r.b, "speed", `${fmtX(r.speed)} speed`) + `<div class="spd-l" style="left:${pct(r.a)}%">${fmtX(r.speed)}</div>`;
  for (const m of tl?.moves || []) html += span(m.a, m.b, "moved", "Moved part") + (m.to !== null ? `<div class="m move-to" style="left:${pct(m.to)}%" title="Moved part plays here"></div>` : "");
  if (S.sel) html += `<div class="r sel" style="left:${pct(S.sel.a)}%;width:${pct(S.sel.b) - pct(S.sel.a)}%" title="Drag onto a timeline to move this part">
      <span class="sel-l${pct(S.sel.a) + pct(S.sel.b) > 100 ? " right" : ""}">${secToTc(S.sel.a)} – ${secToTc(S.sel.b)} · drag to move</span></div>`;
  for (const t of p.titles || []) { const x = tcToSec(t.at); if (!isNaN(x) && x !== null) html += `<div class="m title" style="left:${pct(x)}%" title="${esc(t.text)}"></div>`; }
  bar.innerHTML = html + `<div class="ph"></div>`;
  const nT = 6 * S.zoom;
  $("#tlScale").innerHTML = Array.from({ length: nT + 1 }, (_, i) => `<span>${secToTc((dur * i) / nT).slice(0, 8)}</span>`).join("");
  updateTc();
}

/** In the Host intro view the source bar shows that file, with the part that's used. */
function renderHostIntroBar(bar) {
  renderProgramBar();
  const dur = S.sources.hostintro?.duration;
  $("#srcBarLabel").textContent = "Host intro video";
  if (!dur) { bar.innerHTML = ""; $("#tlScale").innerHTML = ""; return; }
  const pct = (t) => (Math.max(0, Math.min(dur, t)) / dur) * 100;
  const r = S.tl?.hostIntroRange || [tcToSec(S.project.host_intro?.start) || 0, tcToSec(S.project.host_intro?.end) || dur];
  const used = !!S.project.host_intro;
  bar.innerHTML = `<div class="r trim" style="left:0;width:${pct(r[0])}%"></div><div class="r trim" style="left:${pct(r[1])}%;width:${100 - pct(r[1])}%"></div>
    <div class="r intro" id="hiRange" style="left:${pct(r[0])}%;width:${pct(r[1]) - pct(r[0])}%;background:#5E8FD0;opacity:${used ? 1 : 0.35}" title="Used as the host intro"></div>
    ${used ? `<div class="trim-h" data-edge="start" style="left:${pct(r[0])}%"><span>${secToTc(r[0])}</span></div>
    <div class="trim-h end" data-edge="end" style="left:${pct(r[1])}%"><span>${secToTc(r[1])}</span></div>` : ""}<div class="ph"></div>`;
  const nT = 6 * S.zoom;
  $("#tlScale").innerHTML = Array.from({ length: nT + 1 }, (_, i) => `<span>${secToTc((dur * i) / nT).slice(0, 8)}</span>`).join("");
  updateTc();
}

/** Drag a host-intro trim handle: the picture follows, the edit is saved on release. */
function dragTrimHandle(handle, e) {
  const bar = $("#tlBar"), dur = S.sources.hostintro?.duration;
  if (!dur) return;
  e.preventDefault();
  e.stopPropagation();
  handle.setPointerCapture(e.pointerId);
  const edge = handle.dataset.edge;
  const r0 = S.tl?.hostIntroRange || [0, dur];
  let t = edge === "start" ? r0[0] : r0[1];
  const at = (ev) => { const rc = bar.getBoundingClientRect(); return Math.max(0, Math.min(1, (ev.clientX - rc.left) / rc.width)) * dur; };
  const move = (ev) => {
    t = Math.round(at(ev) * FPS) / FPS;
    if (edge === "start") t = Math.min(t, r0[1] - 1); else t = Math.max(t, r0[0] + 1);
    const pctT = (t / dur) * 100;
    handle.style.left = `${pctT}%`;
    handle.querySelector("span").textContent = secToTc(t);
    const rg = $("#hiRange");
    const a = edge === "start" ? t : r0[0], b = edge === "end" ? t : r0[1];
    rg.style.left = `${(a / dur) * 100}%`;
    rg.style.width = `${((b - a) / dur) * 100}%`;
    vid().pause();
    vid().currentTime = t;                                  // see the frame you're trimming to
  };
  const up = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    handle.removeEventListener("pointercancel", up);
    mutate((p) => { p.host_intro = p.host_intro || {}; p.host_intro[edge] = secToTc(t); });
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", up);
}

function renderProgramBar() {
  const bar = $("#pgBar");
  if (!bar) return;
  const tl = S.tl;
  if (!tl) { bar.innerHTML = ""; $("#pgScale").innerHTML = ""; return; }
  const D = tl.duration;
  const pct = (t) => (t / D) * 100;
  const color = (it) => it.kind === "bumper" ? "#1E0A4E" : it.kind === "title" ? "var(--title)" : it.kind === "outro" ? "#8C8FA3"
    : it.part === "intro" ? "var(--purple-2)" : it.part === "hostintro" ? "#5E8FD0" : LAYOUT_COLOR[it.layout === "split" ? "split" : camRole(it)];
  const label = (it) => it.kind === "bumper" ? "Intro" : it.kind === "title" ? it.text : it.kind === "outro" ? "Outro" : it.part === "intro" ? "Cold Open" : it.part === "hostintro" ? "Host intro" : "";
  let html = tl.items.map((it) => `<div class="blk" style="left:${pct(it.outStart)}%;width:${pct(it.duration)}%;background:${color(it)}" title="${esc(label(it) || (it.layout === "split" ? "Split" : camRole(it) + " solo"))} · ${fmtTc(it.outStart)}">${it.duration / D > 0.06 ? `<span>${esc(label(it))}</span>` : ""}</div>`).join("");
  for (const it of tl.items) if (it.speed > 1) html += `<div class="spd-b" style="left:${pct(it.outStart)}%;width:${pct(it.duration)}%">${fmtX(it.speed)}</div>`;
  for (const it of tl.items) if (it.moveId) html += `<div class="mv-b" style="left:${pct(it.outStart)}%;width:${pct(it.duration)}%" title="Moved part"></div>`;
  for (const ov of tl.overlays) {
    if (ov.kind === "guestcard") html += `<div class="gc" style="left:${pct(ov.outStart)}%;width:${pct(ov.cardEnd - ov.outStart)}%" title="Guest card"></div>`;
    if (ov.kind === "l3") html += `<div class="m l3" style="left:${pct(ov.outStart)}%" title="Lower third · ${esc(ov.person.name)}"></div>`;
  }
  // cut points: where two main shots meet
  tl.items.forEach((it, i) => { const nx = tl.items[i + 1]; if (it.part === "main" && nx?.part === "main" && Math.abs(it.srcStart + it.srcDur - nx.srcStart) > 0.01) html += `<div class="cutpt" style="left:${pct(it.outEnd)}%" title="Edit point"></div>`; });
  bar.innerHTML = html + `<div class="ph"></div>`;
  const nP = 6 * S.zoom;
  $("#pgScale").innerHTML = Array.from({ length: nP + 1 }, (_, i) => `<span>${fmtTc((D * i) / nP).slice(0, 8)}</span>`).join("");
}

// ---------------------------------------------------------------- UI -> state
function readValue(el) {
  if (el.type === "checkbox") return el.checked;
  if (el.dataset.num) return el.value === "" ? null : Number(el.value);
  if (el.dataset.tc) {
    if (el.value.trim() === "") { el.classList.remove("invalid"); return null; }
    const t = tcToSec(el.value);
    if (t === null || isNaN(t)) { el.classList.add("invalid"); toast("Timecode format: 00:01:23:15", true); return undefined; }
    el.classList.remove("invalid");
    el.value = secToTc(t);
    return el.value;
  }
  return el.value;
}
const here = () => secToTc(Math.max(0, masterTime()));

function commitInput(el) {
  const v = readValue(el);
  if (v === undefined) return;
  if (el.dataset.path) mutate((p) => setPath(p, el.dataset.path, v));
  else if (el.dataset.field) {
    mutate((p) => {
      const it = (p[el.dataset.list] || []).find((x) => x.id === el.dataset.id);
      if (!it) return;
      if (v === null) delete it[el.dataset.field]; else it[el.dataset.field] = v;
    });
  }
}

/** C pressed: first press marks where the cut starts, the second press makes the cut. */
function cutKey() {
  const t = masterTime();
  if (S.cutStart === null || S.cutStart === undefined) {
    S.cutStart = t;
    renderMarks();
    toast("Remove start marked · move to the end and press C again (Esc to cancel)");
    return;
  }
  let a = S.cutStart, b = t;
  if (b < a) [a, b] = [b, a];
  S.cutStart = null;
  if (b - a < 1 / FPS) { renderMarks(); return toast("The part to remove needs at least one frame", true); }
  mutate((p) => { p.cuts.push({ id: uid(), seq: nextSeq(), start: secToTc(a), end: secToTc(b) }); });
  revealNew("cuts");
  renderMarks();
}

function addCut() {
  let a = S.markIn, b = S.markOut;
  if (a === null || b === null || b <= a) { a = masterTime(); b = a + 5; }
  mutate((p) => { p.cuts.push({ id: uid(), seq: nextSeq(), start: secToTc(a), end: secToTc(b) }); });
  revealNew("cuts");
  S.markIn = S.markOut = null;
  renderMarks();
}
function addL3() {
  const has = (r) => (S.project.lower_thirds || []).some((x) => x.person === r);
  mutate((p) => { p.lower_thirds.push({ id: uid(), seq: nextSeq(), at: fmtTc(editedNow()), person: has("host") ? "guest" : "host" }); });
  revealNew("lower_thirds");
}
/** Current position on the edited timeline. */
function editedNow() {
  if (S.view === "program") return PG.t;
  return previewOut(masterTime()) ?? 0;
}

/** New items go to the bottom of their list: scroll to it and flash it briefly. */
function revealNew(list) {
  if (S.listFilter && S.listFilter !== "all" && S.listFilter !== list) { S.listFilter = "all"; renderEditList(true); }
  // the newest item of that list (cuts may sit in the middle, sorted by time)
  const items = S.project[list];
  const newest = Array.isArray(items) && items.length ? items.reduce((a, b) => ((b.seq ?? 0) > (a.seq ?? 0) ? b : a)) : null;
  const box = $("#editList");
  const row = newest ? box?.querySelector(`.er[data-cat="${list}"][data-id="${newest.id}"]`) : box?.lastElementChild;
  if (!row || !row.classList.contains("item")) return;
  row.scrollIntoView({ block: "nearest", behavior: "smooth" });
  row.classList.add("flash");
  setTimeout(() => row.classList.remove("flash"), 1200);
}

function addLayout() {
  const last = [...(S.project.layouts || [])].pop();
  mutate((p) => {
    p.layouts = p.layouts || [];
    p.layouts.push({ id: uid(), seq: nextSeq(), at: here(), layout: !last || last.layout !== "split" ? "split" : "host" });
  });
  revealNew("layouts");
}

function addTitle() {
  mutate((p) => { p.titles.push({ id: uid(), seq: nextSeq(), at: here(), text: "New Topic" }); });
  revealNew("titles");
}

// #main lives for the whole session while episode pages come and go: keep exactly one handler per event.
const mainHandlers = {};
function onMain(type, fn) {
  const m = $("#main");
  if (mainHandlers[type]) m.removeEventListener(type, mainHandlers[type]);
  mainHandlers[type] = fn;
  m.addEventListener(type, fn);
}

function wireEpisode() {
  onMain("change", (e) => {
    const el = e.target;
    if (el.dataset.actCutmode) {
      const id = el.dataset.actCutmode;
      return mutate((p) => { const c = p.cuts.find((x) => x.id === id); if (c) { if (el.value === "speed") { c.mode = "speed"; c.speed = cutSpeed(c) > 1 ? cutSpeed(c) : 1.5; } else { delete c.mode; delete c.speed; } } });
    }
    if (el.dataset.spd) return mutate((p) => { const c = p.cuts.find((x) => x.id === el.dataset.spd); if (c) c.speed = Number(el.value); });
    if (el.matches("[data-path],[data-field]")) commitInput(el);
  });
  $(".transport").addEventListener("mousedown", (e) => { if (e.target.closest("button")) e.preventDefault(); });
  onMain("input", (e) => {
    if (e.target.matches?.("textarea.grow-lines")) fitLines(e.target);
    if (e.target.dataset?.list === "titles" && e.target.dataset.field === "text") titleWarn(e.target.dataset.id, e.target.value);
    if (e.target.dataset?.spd) { const o = $("#spd_" + e.target.dataset.spd); if (o) o.textContent = fmtX(e.target.value); }
    const out = e.target.dataset?.lvl && $("#" + e.target.dataset.lvl);
    if (out) out.textContent = fmtDb(e.target.value);
    if (e.target.dataset?.path?.startsWith("sources.")) {            // hear the change right away
      const role = e.target.dataset.path.split(".")[1];
      setPath(S.project, e.target.dataset.path, Number(e.target.value));
      applyMicLevels(role);
    }
  });
  // leaving a field may change the cut order (rows are not rebuilt while typing)
  onMain("focusout", (e) => {
    if (e.target.closest?.("#editList") && e.target.matches("input, select")) setTimeout(() => renderEditList(), 150);
  });
  onMain("keydown", (e) => {
    if (e.key === "Enter" && e.target.matches("input")) e.target.blur();
    if (e.key === "Escape" && e.target.matches("input,select")) e.target.blur();
  });
  onMain("click", async (e) => {
    const row = e.target.closest("tr[data-out]");
    if (row) { if (S.view !== "program") setView("program"); pgPause(); pgSeek(Number(row.dataset.out)); return; }
    const fb = e.target.closest("[data-filter]");
    if (fb) { S.listFilter = fb.dataset.filter; renderEditList(); return; }
    const vb = e.target.closest("[data-view]");
    if (vb) { setView(vb.dataset.view); return; }
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act, v = vid();
    if (act === "play") togglePlay();
    else if (act === "frame") stepFrames(Number(b.dataset.d));
    else if (act === "step") stepFrames(Number(b.dataset.d) * FPS);
    else if (act === "markIn") { S.markIn = masterTime(); renderMarks(); }
    else if (act === "markOut") { S.markOut = masterTime(); renderMarks(); }
    else if (act === "here" || act === "go") {
      const input = b.closest(".tcf").querySelector("input.tc");
      const edited = input.dataset.clock === "edited";
      if (input.dataset.clock === "hostintro") {
        if (!S.urls.hostintro) return toast("Choose the host intro video first", true);
        if (S.view !== "hostintro") setView("hostintro");
        if (act === "go") { vid().pause(); vid().currentTime = tcToSec(input.value) || 0; return; }
        input.value = secToTc(vid().currentTime);
        return commitInput(input);
      }
      if (act === "go") {
        if (edited) { if (S.view !== "program") setView("program"); pgPause(); return pgSeek(tcToSec(input.value)); }
        return seekMaster(tcToSec(input.value));
      }
      input.value = edited ? fmtTc(editedNow()) : here();
      commitInput(input);
    }
    else if (act === "remove") mutate((p) => { p[b.dataset.list] = p[b.dataset.list].filter((x) => x.id !== b.dataset.id); });
    else if (act === "addCut") cutKey();
    else if (act === "reviewImport") openReviewImport();
    else if (act === "reviewReport") showReviewReport(S.project.review_import);
    else if (act === "addL3") addL3();
    else if (act === "addTitle") addTitle();
    else if (act === "addLayout") addLayout();
    else if (act === "addIntro") { mutate((p) => { p.intro = { seq: nextSeq(), start: here(), end: secToTc(masterTime() + 15), camera: "guest" }; }); revealNew("intro"); }
    else if (act === "addHostIntro") { mutate((p) => { p.host_intro = { seq: nextSeq() }; }); revealNew("hostintro"); }
    else if (act === "removeIntro") mutate((p) => { p.intro = null; });
    else if (act === "removeHostIntro") mutate((p) => { p.host_intro = null; });
    else if (act === "previewTitle") {
      const t = S.project.titles.find((x) => x.id === b.dataset.id);
      const it = S.tl?.items.find((x) => x.kind === "title" && x.text === (t?.text || "") && Math.abs(x.srcStart - tcToSec(t.at)) < 600);
      if (it) { if (S.view !== "program") setView("program"); pgPause(); pgSeek(it.outStart); setTimeout(pgPlay, 50); }
      else { S.titlePreview = { text: t?.text || "", start: performance.now() }; if (!S.preview) setView("preview"); }
    }
    else if (act === "pick") pickSource(b.dataset.role);
    else if (act === "reconnect") reconnect(b.dataset.role);
    else if (act === "reconnectAll") reconnectAll();
    else if (act === "exportFramed") exportFramed(b.dataset.role);
    else if (act === "openHostIntro") {
      if (!S.urls.hostintro) return toast("Choose the host intro video first", true);
      setView("hostintro");
      $("#tlScroll").scrollIntoView({ block: "center", behavior: "smooth" });
    }
    else if (act === "resetLvl") mutate((p) => { setPath(p, `sources.${b.dataset.role}.volume_db`, 0); });
    else if (act === "export") {
      const p = JSON.parse(JSON.stringify(S.project));
      download(new Blob([JSON.stringify(p, null, 2)], { type: "application/json" }), `${p.name || "episode"}.igc.json`);
    }
    else if (act === "render") startRender(!!b.dataset.draft);
    else if (act === "cancelRender") S.render?.abort.abort();
    else if (act === "dlOut") download(S.lastOutput.blob, S.lastOutput.name);
    else if (act === "dlChapters") download(new Blob([S.lastOutput.chapters], { type: "text/plain" }), S.lastOutput.name.replace(/\.mp4$/, "_chapters.txt"));
  });
  scrubbable($("#tlBar"), (u) => {
    if (S.view === "hostintro") { const d = S.sources.hostintro?.duration; if (d) { vid().pause(); vid().currentTime = u * d; updateTc(); } return; }
    const dur = S.sources.host?.duration;
    if (!dur) return;
    if (S.view === "program") setView("preview");
    vid().pause();
    seekMaster(u * dur);
  });
  scrubbable($("#pgBar"), (u) => {
    if (!S.tl) return;
    if (S.view !== "program") setView("program");
    pgPause();
    pgSeek(u * S.tl.duration);
  });
  $("#pgBar").addEventListener("dblclick", (e) => {     // double-click: speed for that segment
    if (!S.tl || e.altKey) return;
    const r = $("#pgBar").getBoundingClientRect();
    const seg = segmentAt(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * S.tl.duration);
    if (seg) openSpeedPop([{ a: seg.a, b: seg.b }], e.clientX, e.clientY, seg.speed, `${fmtTc(seg.oa)} → ${fmtTc(seg.ob)}`);
  });
  $("#tlBar")._intercept = rawBarPointer;
  $("#pgBar")._intercept = finalBarPointer;
  const v = vid();
  for (const ev of ["timeupdate", "seeked", "play", "pause"]) v.addEventListener(ev, () => { updateTc(); if (ev !== "timeupdate") syncAux(ev === "seeked"); });
  for (const role of SRC_ROLES) {                 // host, guest and host intro all accept dropped files
    const box = $(`#src_${role}`);
    if (!box) continue;
    box.addEventListener("dragover", (e) => { e.preventDefault(); box.classList.add("drag"); });
    box.addEventListener("dragleave", () => box.classList.remove("drag"));
    box.addEventListener("drop", (e) => {
      e.preventDefault();
      box.classList.remove("drag");
      const item = e.dataTransfer.items?.[0];
      const file = e.dataTransfer.files[0];
      if (!file) return;
      // ask for a reusable handle while the drop event is still live (Chrome/Edge)
      const hp = item?.getAsFileSystemHandle ? item.getAsFileSystemHandle().catch(() => null) : Promise.resolve(null);
      hp.then(async (h) => {
        if (h && h.kind === "file") await dbPut("handles", h, `${S.project.id}:${role}`);
        else toast("This browser can't remember dropped files after a refresh. Use “Choose file” in Chrome or Edge.");
        loadSource(role, file);
      });
    });
  }
}

// ---------------------------------------------------------------- framed export of one source
async function exportFramed(role) {
  if (S.exporting || S.render) return toast("Another export or render is running", true);
  const src = S.sources[role];
  if (!src) return;
  if (S.faces[role]?.status === "running") return toast("Wait for face analysis to finish", true);
  const base = (src.name || role).replace(/\.[^.]+$/, "");
  const name = `${base}_framed.mp4`.replace(/[\\/:*?"<>|]/g, "_");
  let writable = null;
  if (window.showSaveFilePicker) {
    try {
      const h = await showSaveFilePicker({ suggestedName: name, types: [{ description: "MP4 video", accept: { "video/mp4": [".mp4"] } }] });
      writable = await h.createWritable();
    } catch (e) { if (e.name === "AbortError") return; }
  }
  S.exporting = { role, label: "Starting…" };
  renderSources();
  const show = (txt) => { S.exporting.label = txt; const el = $(`#exp_${role}`); if (el) el.textContent = txt; };
  try {
    const res = await renderFramedSource({
      src, path: pathFor(role), volumeDb: Number(S.project.sources?.[role]?.volume_db ?? 0), writable,
      onProgress: (p) => show(`${p.phase === "audio" ? "Audio" : "Video"} ${Math.round(p.frac * 100)}%`),
    });
    if (res.blob) download(res.blob, name);
    toast(`Exported ${name}`);
  } catch (e) {
    if (writable) { try { await writable.abort(); } catch (x) { /* ignore */ } }
    toast("Export failed: " + e.message, true);
  } finally {
    S.exporting = null;
    renderSources();
  }
}

// ---------------------------------------------------------------- render
async function startRender(draft) {
  if (S.render) return;
  computePlan();
  if (S.planErr) return toast(S.planErr, true);
  if (!window.VideoEncoder) return toast("This browser can't render video. Please use Chrome or Edge.", true);
  const waiting = SRC_ROLES.filter((r) => S.sources[r] && S.faces[r]?.status === "running");
  if (waiting.length) return toast("Wait for face analysis to finish before rendering", true);
  const name = `${S.project.name || "episode"}${draft ? "_draft" : ""}.mp4`.replace(/[\\/:*?"<>|]/g, "_");
  let writable = null;
  if (window.showSaveFilePicker) {
    try {
      const h = await showSaveFilePicker({ suggestedName: name, types: [{ description: "MP4 video", accept: { "video/mp4": [".mp4"] } }] });
      writable = await h.createWritable();
    } catch (e) { if (e.name === "AbortError") return; }
  } else if (S.tl.duration > 20 * 60 && !draft) {
    if (!confirm("This browser can't write directly to a file, so the video is built in memory. Long episodes may run out of memory. Continue? (Chrome/Edge recommended)")) return;
  }
  const abort = new AbortController();
  S.render = { running: true, draft, phase: "audio", frac: 0, abort };
  S.lastOutput = null;
  renderRenderBox();
  let wake = null;
  try { wake = await navigator.wakeLock?.request("screen"); } catch (e) { /* optional */ }
  try {
    const res = await renderEpisode({
      project: S.project, sources: S.sources, assets: S.brand.assets,
      paths: { host: pathFor("host"), guest: pathFor("guest"), hostintro: pathFor("hostintro") },
      brand: { logo: S.brand.logo, quote: S.brand.quote, fonts: S.brand.fonts }, draft, writable, signal: abort.signal,
      onProgress: (p) => { Object.assign(S.render, p); renderRenderBox(); },
    });
    S.lastOutput = { name, draft, blob: res.blob || null, saved: !res.blob, chapters: res.chapters };
    toast("Render complete!");
    if (res.blob) download(res.blob, name);
  } catch (e) {
    if (writable) { try { await writable.abort(); } catch (x) { /* ignore */ } }
    if (e.name === "AbortError") toast("Render cancelled");
    else { console.error(e); toast("Render failed: " + e.message, true); }
  } finally {
    wake?.release?.();
    S.render = null;
    renderRenderBox();
  }
}

window.addEventListener("beforeunload", (e) => { if (S.render) { e.preventDefault(); e.returnValue = ""; } });

document.addEventListener("focusin", (e) => { if (e.target.matches?.("input, textarea")) e.target.dataset.orig = e.target.value; });

document.addEventListener("keydown", (e) => {
  const code = e.code;                                   // physical key: same on a Korean input source
  const inField = e.target instanceof Element && e.target.matches("input, textarea, select");
  if ((e.metaKey || e.ctrlKey) && (code === "KeyZ" || /^[zZㅋ]$/.test(e.key))) {
    // inside a field with unsaved typing, let the browser undo the typing; otherwise undo the last edit
    if (inField && e.target.value !== e.target.dataset.orig) return;
    if (S.route.page === "ep") { e.preventDefault(); if (inField) e.target.blur(); e.shiftKey ? redo() : undo(); }
    return;
  }
  if (S.route.page !== "ep" || !vid() || !$("#modal").classList.contains("hidden")) return;
  if (inField) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === " ") { e.preventDefault(); togglePlay(); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); stepFrames(e.shiftKey ? -FPS : -1); }
  else if (e.key === "ArrowRight") { e.preventDefault(); stepFrames(e.shiftKey ? FPS : 1); }
  else if (e.key === "+" || e.key === "=" || code === "Equal" || code === "NumpadAdd") { e.preventDefault(); setZoom(S.zoom * 2); }
  else if (e.key === "-" || e.key === "_" || code === "Minus" || code === "NumpadSubtract") { e.preventDefault(); setZoom(S.zoom / 2); }
  else if (e.key === "Escape" && S.cutStart !== null) { S.cutStart = null; renderMarks(); }
  else if (code === "KeyI" || /^[iIㅑ]$/.test(e.key)) { S.markIn = masterTime(); renderMarks(); }
  else if (code === "KeyO" || /^[oOㅐ]$/.test(e.key)) { S.markOut = masterTime(); renderMarks(); }
  else if (code === "KeyC" || /^[cCㅊ]$/.test(e.key)) cutKey();
  else if (code === "KeyT" || /^[tTㅅ]$/.test(e.key)) addTitle();
  else if (code === "KeyL" || /^[lLㅣ]$/.test(e.key)) addL3();
});

// ---------------------------------------------------------------- boot
$("#newEpBtn").onclick = newEpisode;
$("#crumb").addEventListener("click", (e) => {
  if (!e.target.closest("[data-act=export]") || !S.project) return;
  const p = JSON.parse(JSON.stringify(S.project));
  download(new Blob([JSON.stringify(p, null, 2)], { type: "application/json" }), `${p.name || "episode"}.igc.json`);
});
// collapsible episodes panel (remembered)
const applySide = () => {
  const c = localStorage.getItem("igc_side") === "closed";
  document.body.classList.toggle("side-closed", c);
  $("#sideToggle").textContent = c ? "›" : "‹";
  $("#sideToggle").title = c ? "Show episodes" : "Hide episodes";
};
$("#sideToggle").onclick = () => { localStorage.setItem("igc_side", document.body.classList.contains("side-closed") ? "open" : "closed"); applySide(); };
applySide();
// double-click an episode name to rename it
$("#epList").addEventListener("dblclick", (e) => {
  const item = e.target.closest(".ep-item");
  if (!item) return;
  e.preventDefault();
  const id = item.getAttribute("href").split("/").pop();
  const b = item.querySelector("b");
  const old = b.textContent;
  const inp = document.createElement("input");
  inp.className = "ep-rename";
  inp.value = old;
  b.replaceWith(inp);
  inp.focus(); inp.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const name = inp.value.trim();
    if (save && name && name !== old) {
      if (S.project?.id === id) mutate((p) => { p.name = name; });
      else { const pr = await dbGet("projects", id); if (pr) { pr.name = name; pr.updated = Date.now(); await dbPut("projects", pr); } }
    }
    await loadProjects();
  };
  inp.addEventListener("keydown", (ev) => { ev.stopPropagation(); if (ev.key === "Enter" && !ev.isComposing) finish(true); if (ev.key === "Escape") finish(false); });
  inp.addEventListener("blur", () => finish(true));
  inp.addEventListener("click", (ev) => ev.preventDefault());
});
$("#importIn").onchange = (e) => e.target.files[0] && importProject(e.target.files[0]);
$("#epList").addEventListener("click", async (e) => {
  const d = e.target.closest("[data-del]");
  if (!d) return;
  e.preventDefault();
  const p = S.projects.find((x) => x.id === d.dataset.del);
  if (!confirm(`Delete "${p?.name}" from this browser? (Your source video files are not touched.)`)) return;
  await dbDel("projects", d.dataset.del);
  for (const r of SRC_ROLES) await dbDel("handles", `${d.dataset.del}:${r}`);
  await loadProjects();
  if (S.route.id === d.dataset.del) location.hash = "#/";
});
window.addEventListener("hashchange", route);
requestAnimationFrame(tick);
(async () => {
  try { await navigator.storage?.persist?.(); } catch (e) { /* optional */ }
  await initTeam();
  renderAccount();
  await loadBrand();
  await loadProjects();
  await route();
})();

// click the big timecode to copy it
document.addEventListener("click", async (e) => {
  const el = e.target.closest("#tcNow");
  if (!el) return;
  const tc = el.textContent.trim();
  try { await navigator.clipboard.writeText(tc); toast(`Copied ${tc}`); }
  catch { toast("Couldn't copy the timecode", true); }
});

