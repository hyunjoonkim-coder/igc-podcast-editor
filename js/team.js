// Team sign-in and shared brand assets on Supabase (optional).
// Settings live in team.json next to index.html; with no Supabase URL there the editor works
// exactly as before (everything stays in this browser). Talks to Supabase's REST API directly.

const SESSION_KEY = "igc_session";
let cfg = null;
let session = null;

export async function initTeam() {
  cfg = await fetch("team.json", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey) { cfg = null; return null; }
  cfg.supabaseUrl = cfg.supabaseUrl.replace(/\/+$/, "");
  cfg.brandBucket = cfg.brandBucket || "brand";
  try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch { session = null; }
  captureRedirect();
  if (session) { try { await token(); } catch { signOutLocal(); } }
  return cfg;
}

export const teamEnabled = () => !!cfg;
export const teamConfig = () => cfg;
export const teamUser = () => (session ? { email: session.user?.email || "" } : null);

const okDomain = (email) => !cfg.allowedDomain || String(email).toLowerCase().endsWith("@" + cfg.allowedDomain.toLowerCase());

function save(s) {
  session = s;
  try { s ? localStorage.setItem(SESSION_KEY, JSON.stringify(s)) : localStorage.removeItem(SESSION_KEY); } catch { /* private mode */ }
}
function fromAuthResponse(j) {
  return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Math.floor(Date.now() / 1000) + Number(j.expires_in || 3600), user: { email: j.user?.email || "" } };
}
function signOutLocal() { save(null); }

/** Google sign-in comes back as #access_token=…&refresh_token=… : keep it and tidy the address bar. */
function captureRedirect() {
  const h = location.hash;
  if (!/access_token=|error_description=/.test(h)) return;
  const q = new URLSearchParams(h.replace(/^#\/?/, ""));
  if (q.get("access_token")) {
    const email = parseJwt(q.get("access_token"))?.email || "";
    save({ access_token: q.get("access_token"), refresh_token: q.get("refresh_token"), expires_at: Number(q.get("expires_at")) || Math.floor(Date.now() / 1000) + Number(q.get("expires_in") || 3600), user: { email } });
  }
  history.replaceState(null, "", location.pathname + location.search + "#/");
}
function parseJwt(t) {
  try { return JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch { return null; }
}

async function api(path, opts = {}) {
  const r = await fetch(cfg.supabaseUrl + path, {
    ...opts,
    headers: { apikey: cfg.supabaseAnonKey, ...(opts.json ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) },
    body: opts.json ? JSON.stringify(opts.json) : opts.body,
  });
  if (!r.ok) {
    let msg = `${r.status}`;
    try { const j = await r.json(); msg = j.error_description || j.msg || j.message || j.error || msg; } catch { /* not json */ }
    const e = new Error(msg); e.status = r.status; throw e;
  }
  return r;
}

/** A valid access token (refreshed when it's about to expire). */
async function token() {
  if (!session) throw new Error("Not signed in");
  if (session.expires_at - 60 > Date.now() / 1000) return session.access_token;
  const j = await (await api("/auth/v1/token?grant_type=refresh_token", { method: "POST", json: { refresh_token: session.refresh_token } })).json();
  save(fromAuthResponse(j));
  return session.access_token;
}

export async function signInPassword(email, password) {
  if (!okDomain(email)) throw new Error(`Use your @${cfg.allowedDomain} account`);
  const j = await (await api("/auth/v1/token?grant_type=password", { method: "POST", json: { email, password } })).json();
  save(fromAuthResponse(j));
  return teamUser();
}

export function signInGoogle() {
  const back = location.origin + location.pathname;
  location.href = `${cfg.supabaseUrl}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(back)}`;
}

export async function signOut() {
  try { await api("/auth/v1/logout", { method: "POST", headers: { Authorization: `Bearer ${await token()}` } }); } catch { /* already gone */ }
  signOutLocal();
}

// ---------------------------------------------------------------- shared brand assets
// Files sit in a private bucket as "<slot>__<file name>", e.g. "bumper__InGoodCompany_Intro.mp4".
const objName = (slot, file) => `${slot}__${file.replace(/[^\w.\- ]+/g, "_")}`;

/** {slot: {path, name, updated, size}} for the files in the team bucket. */
export async function listTeamBrand() {
  const auth = { Authorization: `Bearer ${await token()}` };
  const rows = await (await api(`/storage/v1/object/list/${cfg.brandBucket}`, { method: "POST", headers: auth, json: { prefix: "", limit: 1000, sortBy: { column: "name", order: "asc" } } })).json();
  const out = {};
  for (const r of rows) {
    const m = /^([a-z_]+)__(.+)$/.exec(r.name || "");
    if (!m || !r.id) continue;                       // folders have no id
    const cur = out[m[1]];
    const updated = r.updated_at || r.created_at || "";
    if (!cur || updated > cur.updated) out[m[1]] = { path: r.name, name: m[2], updated, size: r.metadata?.size ?? null };
  }
  return out;
}

export async function downloadTeamFile(path) {
  const r = await api(`/storage/v1/object/authenticated/${cfg.brandBucket}/${encodeURIComponent(path)}`, { headers: { Authorization: `Bearer ${await token()}` } });
  return r.blob();
}

/** Put a file in the team slot (replacing what was there). */
export async function uploadTeamFile(slot, file, old = null) {
  const auth = { Authorization: `Bearer ${await token()}` };
  const path = objName(slot, file.name);
  await api(`/storage/v1/object/${cfg.brandBucket}/${encodeURIComponent(path)}`, {
    method: "POST", headers: { ...auth, "x-upsert": "true", "Content-Type": file.type || "application/octet-stream" }, body: file,
  });
  if (old && old !== path) await removeTeamFile(old).catch(() => {});
  return path;
}

export async function removeTeamFile(path) {
  await api(`/storage/v1/object/${cfg.brandBucket}`, { method: "DELETE", headers: { Authorization: `Bearer ${await token()}` }, json: { prefixes: [path] } });
}

// ---------------------------------------------------------------- shared episodes
// One row per shared episode: the edit itself (no videos). `version` goes up by one on every
// save, and a save only succeeds on top of the version it was based on, so two people can't
// silently overwrite each other.
const rest = async (path, opts = {}) => api("/rest/v1/" + path, { ...opts, headers: { Authorization: `Bearer ${await token()}`, ...(opts.headers || {}) } });
const LOCAL_ONLY = ["rev", "dirty", "team"];
const strip = (p) => Object.fromEntries(Object.entries(p).filter(([k]) => !LOCAL_ONLY.includes(k)));

/** [{id, name, version, updated_at, updated_by, guest}] */
export async function listTeamEpisodes() {
  return (await rest("episodes?select=id,name,version,updated_at,updated_by,guest:data->people->guest->>name&order=updated_at.desc")).json();
}

/** Full row, or null when it isn't shared (any more). */
export async function getTeamEpisode(id) {
  const rows = await (await rest(`episodes?id=eq.${encodeURIComponent(id)}&select=*`)).json();
  return rows[0] || null;
}

/** Who saved last / who has it open right now. */
export async function teamEpisodeMeta(id) {
  const rows = await (await rest(`episodes?id=eq.${encodeURIComponent(id)}&select=version,updated_at,updated_by,editing_by,editing_at`)).json();
  return rows[0] || null;
}

/** First save of an episode to the team. Returns the new version. */
export async function shareEpisode(p) {
  const me = teamUser()?.email || null;
  const rows = await (await rest("episodes", {
    method: "POST", headers: { Prefer: "return=representation" },
    json: { id: p.id, name: p.name, data: strip(p), version: 1, updated_at: new Date().toISOString(), updated_by: me },
  })).json();
  return rows[0].version;
}

/** Save on top of `baseVersion`. Returns the new version, or null when someone else saved first. */
export async function saveTeamEpisode(p, baseVersion) {
  const me = teamUser()?.email || null;
  const rows = await (await rest(`episodes?id=eq.${encodeURIComponent(p.id)}&version=eq.${baseVersion}`, {
    method: "PATCH", headers: { Prefer: "return=representation" },
    json: { name: p.name, data: strip(p), version: baseVersion + 1, updated_at: new Date().toISOString(), updated_by: me },
  })).json();
  return rows.length ? rows[0].version : null;
}

export async function deleteTeamEpisode(id) {
  await rest(`episodes?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** "I have this episode open" (refreshed every ~20 s while it's open; cleared when leaving). */
export async function markEditing(id, on = true) {
  // clearing only touches my own flag, never someone else's
  const mine = on ? "" : `&editing_by=eq.${encodeURIComponent(teamUser()?.email || "")}`;
  await rest(`episodes?id=eq.${encodeURIComponent(id)}${mine}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    json: on ? { editing_by: teamUser()?.email || null, editing_at: new Date().toISOString() } : { editing_by: null, editing_at: null },
  });
}
