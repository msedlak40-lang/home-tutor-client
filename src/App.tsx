import { useEffect, useRef, useState } from "react";
import "./index.css";
import { openDB } from "idb";
import { supabase } from "./supabase";
import { marked } from "marked";
import DOMPurify from "dompurify";
import markedKatex from "marked-katex-extension";
import "katex/dist/katex.min.css";

type Subject = "reading" | "writing" | "math" | "science" | "study";
type Theme = "light" | "dark" | "high-contrast";
type GradeLevel = "K"|"1"|"2"|"3"|"4"|"5"|"6"|"7"|"8";
type FontSize = "sm"|"md"|"lg"|"xl";
type LineSpacing = 1.6|1.8|2.0;

const PROXY_URL = import.meta.env.VITE_PROXY_URL || "";
const FONT_MAP: Record<FontSize, number> = { sm: 15, md: 17, lg: 19, xl: 21 };
const GRADES: GradeLevel[] = ["K","1","2","3","4","5","6","7","8"];

// KaTeX for inline $...$ and block $$...$$
marked.use(markedKatex({ throwOnError: false }));

// -------- keep THIS normalizeMath exactly as requested --------
function normalizeMath(input: string) {
  let s = input;

  // Convert \( ... \) and \[ ... \] to $...$ / $$...$$ if they appear
  s = s.replace(/\\\(([\s\S]*?)\\\)/g, (_, m) => `$${m}$`);
  s = s.replace(/\\\[([\s\S]*?)\\\]/g, (_, m) => `$$${m}$$`);

  // Wrap plain parentheses that contain LaTeX commands like \frac, \sqrt, \times, \div, \cdot
  // Example: ( \frac{2}{3} )  ->  $\frac{2}{3}$
  s = s.replace(/\(\s*\\(frac|sqrt|times|div|cdot|sum|prod|int)[^)]*\)/g, (m) => {
    const inner = m.slice(1, -1).trim(); // drop outer ( )
    return `$${inner}$`;
  });

  return s;
}

// =============== Types for Profiles ===============
interface Profile {
  id: string;
  name: string;
  grade: GradeLevel;
  dyslexiaAssist: boolean;
}

// Defaults for first run
const DEFAULT_PROFILES: Profile[] = [
  { id: "p1", name: "Daughter", grade: "6", dyslexiaAssist: true },
  { id: "p2", name: "Son", grade: "3", dyslexiaAssist: false },
];

// =============== IndexedDB helpers ===============
async function ensureDB() {
  return openDB("tutor-db", 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains("sessions")) {
        const s = db.createObjectStore("sessions", { keyPath: "id" });
        s.createIndex("by_profile_created", ["profileId", "createdAt"]);
      }
    },
  });
}

async function saveSession(entry: {
  profileId: string;
  subject: string;
  prompt: string;
  response: string;
  confusingWords?: string[];
  wins?: string[];
}) {
  const db = await ensureDB();
  const id = crypto.randomUUID();
  await db.put("sessions", { id, createdAt: Date.now(), ...entry });
  return id;
}

async function updateSessionNotes(id: string, notes: { confusingWords?: string[]; wins?: string[] }) {
  const db = await ensureDB();
  const row: any = await db.get("sessions", id);
  if (!row) return;
  await db.put("sessions", { ...row, confusingWords: notes.confusingWords ?? row.confusingWords, wins: notes.wins ?? row.wins });
}

async function loadRecent(profileId: string, limit = 5) {
  const db = await ensureDB();
  const store = db.transaction("sessions").store;
  const all = await store.getAll();
  return all
    .filter((r: any) => r.profileId === profileId)
    .sort((a: any, b: any) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

async function clearHistory(profileId?: string) {
  const db = await ensureDB();
  if (!profileId) return db.clear("sessions");
  const all = (await db.getAll("sessions")) as any[];
  const tx = db.transaction("sessions", "readwrite");
  const store = tx.store;
  for (const row of all) if (row.profileId === profileId) await store.delete(row.id);
  await tx.done;
}

async function exportSessions(profileId: string) {
  const db = await ensureDB();
  const all = await db.getAll("sessions");
  const mine = all.filter((r: any) => r.profileId === profileId);
  const blob = new Blob([JSON.stringify(mine, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `sessions-${profileId}.json`; a.click();
  URL.revokeObjectURL(url);
}

async function importSessions(profileId: string, file: File) {
  const text = await file.text();
  const rows = JSON.parse(text);
  const db = await ensureDB();
  const tx = db.transaction("sessions", "readwrite");
  const store = tx.store;
  for (const r of rows) {
    await store.put({
      id: r.id ?? crypto.randomUUID(),
      profileId,
      subject: r.subject ?? "study",
      prompt: r.prompt ?? "",
      response: r.response ?? "",
      confusingWords: r.confusingWords ?? undefined,
      wins: r.wins ?? undefined,
      createdAt: r.createdAt ?? Date.now(),
    });
  }
  await tx.done;
}

// =============== Cloud sync ===============
async function syncToCloud(profileId: string) {
  const db = await ensureDB();
  const all = await db.getAll("sessions");
  const mine = all.filter((r: any) => r.profileId === profileId);
  if (mine.length === 0) return alert("Nothing to sync.");

  const rows = mine.map((r: any) => ({
    id: r.id,
    profile_id: r.profileId,
    subject: r.subject,
    prompt: r.prompt,
    response: r.response,
    confusing_words: r.confusingWords ?? null,
    wins: r.wins ?? null,
    created_at: new Date(r.createdAt).toISOString(),
  }));

  const { error, count } = await supabase
    .from("sessions_cloud")
    .upsert(rows, { onConflict: "id", ignoreDuplicates: false, count: "exact" });

  if (error) alert(`Sync failed: ${error.message}`);
  else alert(`Synced ${count ?? rows.length} rows to cloud ✅`);
}

async function pullFromCloud(profileId: string) {
  const { data, error } = await supabase
    .from("sessions_cloud")
    .select("*")
    .eq("profile_id", profileId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) { alert(`Pull failed: ${error.message}`); return { pulled: 0, recent: [] as any[] }; }
  if (!data || data.length === 0) { alert("No cloud sessions found."); return { pulled: 0, recent: [] as any[] }; }

  const db = await ensureDB();
  const tx = db.transaction("sessions", "readwrite");
  const store = tx.store;
  for (const r of data) {
    await store.put({
      id: r.id,
      profileId: r.profile_id,
      subject: r.subject,
      prompt: r.prompt,
      response: r.response,
      confusingWords: r.confusing_words ?? undefined,
      wins: r.wins ?? undefined,
      createdAt: new Date(r.created_at).getTime(),
    });
  }
  await tx.done;

  const recent = await loadRecent(profileId, 5);
  return { pulled: data.length, recent };
}

// =============== UX helpers ===============
function speak(text: string) {
  try { const u = new SpeechSynthesisUtterance(text); u.rate = 1.0; window.speechSynthesis.cancel(); window.speechSynthesis.speak(u); } catch {}
}
async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); alert("Copied!"); }
  catch { alert("Couldn’t copy to clipboard."); }
}

// =============== Component ===============
export default function App() {
  // ---------- Profiles store ----------
  const [profiles, setProfiles] = useState<Profile[]>(() => {
    const saved = localStorage.getItem("profiles");
    return saved ? JSON.parse(saved) : DEFAULT_PROFILES;
  });
  const [currentProfileId, setCurrentProfileId] = useState<string>(() => {
    return localStorage.getItem("currentProfileId") || "p1";
  });

  // Derived current profile (kept for convenience with existing code)
  const currentProfile = profiles.find(p => p.id === currentProfileId) || profiles[0];
  const [profile, setProfile] = useState<Profile>(currentProfile);

  // Persist profiles + current id; keep profile state in sync
  useEffect(() => { localStorage.setItem("profiles", JSON.stringify(profiles)); }, [profiles]);
  useEffect(() => { localStorage.setItem("currentProfileId", currentProfileId); }, [currentProfileId]);
  useEffect(() => {
    const found = profiles.find(p => p.id === currentProfileId);
    if (found) setProfile(found);
  }, [profiles, currentProfileId]);

  // Theme (persisted)
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("theme") as Theme) || "light");
  useEffect(() => {
    localStorage.setItem("theme", theme);
    const el = document.documentElement;
    el.classList.remove("theme-light","theme-dark","theme-hc");
    el.classList.add(theme === "light" ? "theme-light" : theme === "dark" ? "theme-dark" : "theme-hc");
  }, [theme]);

  // Parent PIN (persisted)
  const [parentPin, setParentPin] = useState<string>(() => localStorage.getItem("parentPin") || "1234");
  useEffect(() => { localStorage.setItem("parentPin", parentPin); }, [parentPin]);

  // Typography (persisted)
  const [fontSize, setFontSize] = useState<FontSize>(() => (localStorage.getItem("fontSize") as FontSize) || "md");
  const [lineSpacing, setLineSpacing] = useState<LineSpacing>(() => (Number(localStorage.getItem("lineSpacing")) as LineSpacing) || 1.8);
  useEffect(() => { localStorage.setItem("fontSize", fontSize); }, [fontSize]);
  useEffect(() => { localStorage.setItem("lineSpacing", String(lineSpacing)); }, [lineSpacing]);

  // Tutor UI
  const [subject, setSubject] = useState<Subject>("math");
  const [message, setMessage] = useState("I’m working on dividing fractions.");
  const [response, setResponse] = useState("");
  const [recent, setRecent] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  // Notes for last session
  const [lastSessionId, setLastSessionId] = useState<string | null>(null);
  const [confusingInput, setConfusingInput] = useState("");
  const [winInput, setWinInput] = useState("");
  const [lastConfusing, setLastConfusing] = useState<string[]>([]);
  const [lastWins, setLastWins] = useState<string[]>([]);

  // PWA install
  const [canInstall, setCanInstall] = useState(false);
  const deferredPromptRef = useRef<any>(null);
  useEffect(() => {
    function onBeforeInstallPrompt(e: any) { e.preventDefault(); deferredPromptRef.current = e; setCanInstall(true); }
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
  }, []);
  async function installPWA() { const evt = deferredPromptRef.current; if (!evt) return; setCanInstall(false); await evt.prompt(); deferredPromptRef.current = null; }

  // Supabase smoke test
  async function testSupabase() {
    try {
      const { data, error, status } = await supabase.from("sessions_cloud").select("*").limit(1);
      if (error) alert(`Supabase reachable ✅ (status ${status}). Table likely missing: ${error.message}`);
      else alert(`Supabase reachable ✅. Found rows: ${data?.length ?? 0}`);
    } catch (e: any) { alert(`Supabase NOT reachable ❌: ${e?.message ?? e}`); }
  }

  // Network call
  async function callTutor(body: { subject: Subject; message: string }) {
    setLoading(true);
    try {
const r = await fetch(`${PROXY_URL}/.netlify/functions/tutor`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    profile: { grade: profile.grade, dyslexiaAssist: profile.dyslexiaAssist },
    subject: body.subject,
    message: body.message,
  }),
});
      if (!r.ok) throw new Error("proxy");
      const json = await r.json();
      const text = json.text ?? "";
      setResponse(text);

      const id = await saveSession({
        profileId: profile.id, subject, prompt: message, response: text, confusingWords: [], wins: [],
      });
      setLastSessionId(id); setLastConfusing([]); setLastWins([]);
    } catch {
      setResponse("Couldn’t reach the tutor proxy. Is http://localhost:8787 running?");
    } finally { setLoading(false); }
  }
  const ask = () => callTutor({ subject, message });
  const askWith = (mode: "simplify" | "steps" | "hint") =>
    callTutor({
      subject,
      message:
        message + "\n\n" +
        (mode === "simplify"
          ? "Please simplify the explanation even more."
          : mode === "steps"
          ? "Show numbered steps with one action per line."
          : "Give me one helpful hint, not the full answer."),
    });

  async function showRecent() { setRecent(await loadRecent(profile.id, 5)); }
  async function onClear() {
    const pin = prompt("Parent PIN to clear history:"); if (pin !== parentPin) return alert("Incorrect PIN.");
    await clearHistory(profile.id); setRecent([]);
  }
  async function onImportSelected(file?: File) {
    if (!file) return; await importSessions(profile.id, file); setRecent(await loadRecent(profile.id, 5));
    if (fileInputRef.current) fileInputRef.current.value = "";
  }
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Notes handlers
  async function addConfusingWord() {
    if (!lastSessionId || !confusingInput.trim()) return;
    const next = [...lastConfusing, confusingInput.trim()];
    setLastConfusing(next); setConfusingInput("");
    await updateSessionNotes(lastSessionId, { confusingWords: next });
  }
  async function addWin() {
    if (!lastSessionId || !winInput.trim()) return;
    const next = [...lastWins, winInput.trim()];
    setLastWins(next); setWinInput("");
    await updateSessionNotes(lastSessionId, { wins: next });
  }

  // ---------- Profiles screen state ----------
  type View = "chat" | "profiles";
  const [view, setView] = useState<View>("chat");

  // Helpers for Profiles screen
  const emptyDraft: Profile = { id: "", name: "", grade: "3", dyslexiaAssist: false };
  const [draft, setDraft] = useState<Profile>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);

  function startAdd() {
    const pin = prompt("Parent PIN:");
    if (pin !== parentPin) { alert("Incorrect PIN."); return; }
    setEditingId(null);
    setDraft({ ...emptyDraft, id: crypto.randomUUID() });
  }
  function startEdit(p: Profile) {
    const pin = prompt("Parent PIN:");
    if (pin !== parentPin) { alert("Incorrect PIN."); return; }
    setEditingId(p.id);
    setDraft({ ...p });
  }
  function cancelEdit() {
    setEditingId(null);
    setDraft(emptyDraft);
  }
  function saveDraft() {
    if (!draft.name.trim()) return alert("Please enter a name.");
    if (!GRADES.includes(draft.grade)) return alert("Choose a grade.");
    if (editingId) {
      setProfiles(prev => prev.map(p => p.id === editingId ? { ...draft } : p));
      if (currentProfileId === editingId) setProfile({ ...draft });
    } else {
      setProfiles(prev => [...prev, { ...draft }]);
      // if it's the first profile ever, select it
      if (profiles.length === 0) setCurrentProfileId(draft.id);
    }
    cancelEdit();
  }
  function removeProfile(id: string) {
    const pin = prompt("Parent PIN:");
    if (pin !== parentPin) { alert("Incorrect PIN."); return; }
    if (!confirm("Delete this profile? This won't delete saved sessions.")) return;
    setProfiles(prev => prev.filter(p => p.id !== id));
    if (currentProfileId === id) {
      const remaining = profiles.filter(p => p.id !== id);
      const next = remaining[0] ?? DEFAULT_PROFILES[0];
      setCurrentProfileId(next.id);
    }
  }
  function selectProfile(id: string) {
    setCurrentProfileId(id);
    const found = profiles.find(p => p.id === id);
    if (found) setProfile(found);
    setView("chat");
  }

  // ---------- UI ----------
  return (
    <div className="mx-auto max-w-[72ch] p-6 min-h-screen" style={{ fontSize: FONT_MAP[fontSize] }}>
      {/* Top bar */}
      <header className="card mb-3 flex items-center gap-2 flex-wrap">
        <h1 className="text-2xl font-semibold">Home Tutor</h1>
        <button className="btn btn-outline" onClick={() => setView(view === "chat" ? "profiles" : "chat")}>
          {view === "chat" ? "Profiles" : "Back to Tutor"}
        </button>
        {canInstall && (<button onClick={installPWA} className="btn btn-outline">Install App</button>)}
        <button onClick={testSupabase} className="btn btn-outline">Test Supabase</button>
        <div className="ml-auto flex items-center gap-2 text-sm">
          <span>Theme:</span>
          {(["light","dark","high-contrast"] as Theme[]).map(t => (
            <button key={t} onClick={() => setTheme(t)}
              className={`btn btn-outline rounded-full ${theme===t ? "bg-sky-500 text-white" : ""}`}
              aria-pressed={theme===t}>{t}</button>
          ))}
        </div>
      </header>

      {/* Settings row (global controls) */}
      <section className="card mb-3">
        <div className="flex items-center gap-3 flex-wrap">
          <label className="flex items-center gap-2">
            <span>Font</span>
            <select value={fontSize} onChange={e=>setFontSize(e.target.value as FontSize)} className="border rounded px-2 py-1">
              <option value="sm">Small</option><option value="md">Default</option>
              <option value="lg">Large</option><option value="xl">XL</option>
            </select>
          </label>
          <label className="flex items-center gap-2">
            <span>Line</span>
            <select value={lineSpacing} onChange={e=>setLineSpacing(Number(e.target.value) as LineSpacing)} className="border rounded px-2 py-1">
              <option value={1.6}>1.6</option><option value={1.8}>1.8</option><option value={2.0}>2.0</option>
            </select>
          </label>
          <div className="flex items-center gap-2 text-sm">
            <label className="flex items-center gap-2">
              <span>Parent PIN</span>
              <input type="password" value={parentPin} onChange={e=>setParentPin(e.target.value.trim())}
                className="border rounded px-2 py-1 w-24" inputMode="numeric" />
            </label>
          </div>
        </div>
      </section>

      {/* Profiles screen */}
      {view === "profiles" ? (
        <section className="card">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-lg font-semibold">Profiles</div>
            <button className="btn btn-primary" onClick={startAdd}>Add Profile</button>
          </div>

          {/* Profile cards */}
          <div className="grid gap-3">
            {profiles.map(p => (
              <div key={p.id} className="p-3 rounded-xl border flex items-center justify-between">
                <div className="space-y-0.5">
                  <div className="font-medium">
                    {p.name} {p.id === currentProfileId && <span className="opacity-70">(Active)</span>}
                  </div>
                  <div className="text-sm opacity-80">Grade {p.grade} • Dyslexia Assist {p.dyslexiaAssist ? "ON" : "OFF"}</div>
                </div>
                <div className="flex gap-2">
                  <button className="btn btn-outline" onClick={() => selectProfile(p.id)}>Use</button>
                  <button className="btn btn-outline" onClick={() => startEdit(p)}>Edit</button>
                  <button className="btn btn-outline" onClick={() => removeProfile(p.id)}>Delete</button>
                </div>
              </div>
            ))}
            {profiles.length === 0 && (
              <div className="opacity-70 text-sm">No profiles yet. Click “Add Profile”.</div>
            )}
          </div>

          {/* Editor */}
          {(editingId !== null || draft.id) && (
            <div className="mt-4 p-3 rounded-xl border">
              <div className="font-medium mb-2">{editingId ? "Edit Profile" : "New Profile"}</div>
              <div className="flex flex-wrap gap-3">
                <label className="flex items-center gap-2">
                  <span>Name</span>
                  <input
                    className="border rounded px-2 py-1"
                    value={draft.name}
                    onChange={e=>setDraft({ ...draft, name: e.target.value })}
                    placeholder="e.g., Daughter"
                  />
                </label>
                <label className="flex items-center gap-2">
                  <span>Grade</span>
                  <select
                    className="border rounded px-2 py-1"
                    value={draft.grade}
                    onChange={e=>setDraft({ ...draft, grade: e.target.value as GradeLevel })}
                  >
                    {GRADES.map(g => <option key={g} value={g}>{g}</option>)}
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={draft.dyslexiaAssist}
                    onChange={e=>setDraft({ ...draft, dyslexiaAssist: e.target.checked })}
                  />
                  <span>Dyslexia Assist</span>
                </label>
              </div>
              <div className="mt-3 flex gap-2">
                <button className="btn btn-primary" onClick={saveDraft}>{editingId ? "Save" : "Create"}</button>
                <button className="btn btn-outline" onClick={cancelEdit}>Cancel</button>
              </div>
            </div>
          )}
        </section>
      ) : (
        <>
          {/* Tutor: profile context */}
          <section className="card mb-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="text-sm opacity-80">
                Profile: <b>{profile.name}</b> (Grade {profile.grade}) • Dyslexia Assist {profile.dyslexiaAssist ? "ON" : "OFF"}
              </div>
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={profile.dyslexiaAssist}
                  onChange={(e) => {
                    const updated = { ...profile, dyslexiaAssist: e.target.checked };
                    setProfile(updated);
                    setProfiles(prev => prev.map(p => p.id === profile.id ? updated : p));
                  }}
                />
                <span>Dyslexia Assist</span>
              </label>
              <label className="flex items-center gap-2">
                <span>Grade</span>
                <select
                  className="border rounded px-2 py-1"
                  value={profile.grade}
                  onChange={(e) => {
                    const updated = { ...profile, grade: e.target.value as GradeLevel };
                    setProfile(updated);
                    setProfiles(prev => prev.map(p => p.id === profile.id ? updated : p));
                  }}
                >
                  {GRADES.map(g => <option key={g} value={g}>{g}</option>)}
                </select>
              </label>
            </div>
          </section>

          {/* Subject + prompt card */}
          <section className="card mb-3">
            <div className="flex gap-2 mb-3 flex-wrap">
              {(["reading","writing","math","science","study"] as Subject[]).map(s => (
                <button key={s} onClick={() => setSubject(s)}
                  className={`btn btn-outline rounded-full ${subject===s ? "bg-sky-600 text-white" : ""}`}>
                  {s}
                </button>
              ))}
            </div>

            <textarea
              className="w-full border rounded p-3"
              rows={3}
              style={{ lineHeight: lineSpacing }}
              value={message}
              onChange={e=>setMessage(e.target.value)}
              placeholder="Tell me what you’re working on…"
            />

            <div className="mt-3 flex flex-wrap gap-2">
              <button onClick={ask} disabled={loading}
                className={`btn btn-primary ${loading ? "opacity-70 cursor-not-allowed" : ""}`}>
                {loading ? "Thinking..." : "Ask"}
              </button>
              <button onClick={() => askWith("simplify")} disabled={loading}
                className={`btn btn-outline ${loading ? "opacity-50 cursor-not-allowed" : ""}`}>Simplify</button>
              <button onClick={() => askWith("steps")} disabled={loading}
                className={`btn btn-outline ${loading ? "opacity-50 cursor-not-allowed" : ""}`}>Show steps</button>
              <button onClick={() => askWith("hint")} disabled={loading}
                className={`btn btn-outline ${loading ? "opacity-50 cursor-not-allowed" : ""}`}>Hint</button>

              {response && (
                <>
                  <button onClick={()=>speak(response)} className="btn btn-outline">Read Aloud</button>
                  <button onClick={()=>copy(response)}  className="btn btn-outline">Copy</button>
                </>
              )}
            </div>
          </section>

          {/* Answer card */}
          {response && (
            <section className="card mb-3 p-4">
              <div
                className={`${profile.dyslexiaAssist ? "dyslexia-on" : ""} answer-body`}
                style={{ lineHeight: lineSpacing }}
                dangerouslySetInnerHTML={{
                  __html: DOMPurify.sanitize(marked.parse(normalizeMath(response)) as string),
                }}
              />
            </section>
          )}

          {/* Notes card */}
          {lastSessionId && (
            <section className="card mb-3">
              <div className="font-medium mb-2">Notes for this turn</div>
              <div className="flex gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <input value={confusingInput} onChange={e=>setConfusingInput(e.target.value)}
                    className="border rounded px-2 py-1" placeholder="Add a tricky word"/>
                  <button onClick={addConfusingWord} className="btn btn-outline">Add word</button>
                </div>
                <div className="flex items-center gap-2">
                  <input value={winInput} onChange={e=>setWinInput(e.target.value)}
                    className="border rounded px-2 py-1" placeholder="Add a win"/>
                  <button onClick={addWin} className="btn btn-outline">Add win</button>
                </div>
              </div>

              {(lastConfusing.length > 0 || lastWins.length > 0) && (
                <div className="mt-2 text-sm">
                  {lastConfusing.length > 0 && (<div className="mb-1"><span className="font-medium">Tricky words:</span> {lastConfusing.join(", ")}</div>)}
                  {lastWins.length > 0 && (<div><span className="font-medium">Wins:</span> {lastWins.join(", ")}</div>)}
                </div>
              )}
            </section>
          )}

          {/* History + Import/Export + Cloud */}
          <section className="card">
            <div className="flex flex-wrap gap-2">
              <button onClick={showRecent} className="btn btn-outline">View last 5</button>
              <button onClick={onClear}    className="btn btn-outline">Clear history</button>
              <button onClick={()=>exportSessions(profile.id)} className="btn btn-outline">Export JSON</button>
              <button onClick={()=>syncToCloud(profile.id)}     className="btn btn-outline">Sync to cloud</button>
              <button
                onClick={async()=>{ const { pulled, recent } = await pullFromCloud(profile.id); if (recent.length) setRecent(recent); if (pulled>0) alert(`Pulled ${pulled} rows from cloud ✅`); }}
                className="btn btn-outline"
              >
                Pull from cloud
              </button>

              <input ref={fileInputRef} id="importFile" type="file" accept="application/json" className="hidden"
                onChange={async e => { const f = e.target.files?.[0]; await onImportSelected(f); }} />
              <button onClick={()=>fileInputRef.current?.click()} className="btn btn-outline">Import JSON</button>
            </div>

            {recent.length > 0 && (
              <div className="mt-3 space-y-2 text-sm">
                {recent.map(r => (
                  <div key={r.id} className="p-3 rounded border">
                    <div className="opacity-70">{new Date(r.createdAt).toLocaleString()}</div>
                    <div className="font-medium">Subject: {r.subject}</div>
                    <div className="mt-1">Q: {r.prompt}</div>
                    {r.confusingWords?.length ? <div className="mt-1">Tricky: {r.confusingWords.join(", ")}</div> : null}
                    {r.wins?.length ? <div className="mt-1">Wins: {r.wins.join(", ")}</div> : null}
                    <div className="mt-1 whitespace-pre-wrap">A: {r.response}</div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
