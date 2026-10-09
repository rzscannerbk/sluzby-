/* Služby MP Blansko – chat (sdílený modul pro index.html i desktop.html)
   Vlákna:  dm_<číslo>_<číslo>   soukromá zpráva 1:1
            vsichni               všichni strážníci
            h_<RRRR-MM-DD>_<D|N>  hlídka – členy zapisuje jen server (Cloud Function) podle efektivního plánu
   Data:    chaty/{id}            typ, clenove, pocet, videno{č: počet}, lastSeen{č: čas}, typing{č: čas},
                                  muted{č: bool}, pinned{id,text,jmeno}, posledni{text,od,jmeno,at}
                                  + u hlídky: datum, kind, nazev, start, konec, zobrazitOd, archivOd, stala[]
            chaty/{id}/zpravy/{id} od, jmeno, text, image, at, replyTo{id,jmeno,text}, reakce{klic:[č]}, upraveno, smazano
            nastaveni/chat        vsem (bool), testeri [čísla] – před spuštěním pro všechny jen testeři */
(function(){
"use strict";
const CH = {};
const REAKCE = [["palec","👍"],["srdce","❤️"],["smich","😂"],["wow","😮"],["smutek","😢"],["diky","🙏"]];
const REAKCE_EMO = Object.fromEntries(REAKCE);
const DOW_F = ["neděle","pondělí","úterý","středa","čtvrtek","pátek","sobota"];
const DOW_S = ["ne","po","út","st","čt","pá","so"];
const MONTHS = ["leden","únor","březen","duben","květen","červen","červenec","srpen","září","říjen","listopad","prosinec"];
const DAY = 864e5;
const ic = (d, n) => `<svg class="ch-ico" width="${n || 22}" height="${n || 22}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICO = {
  reply: '<path d="M9 7 4 12l5 5"/><path d="M4 12h10a6 6 0 0 1 6 6v1"/>',
  copy:  '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  pin:   '<path d="M9 3h6l-1 6 4 4H6l4-4z"/><path d="M12 13v8"/>',
  unpin: '<path d="M9 3h6l-1 6 4 4H6l4-4z"/><path d="M12 13v8"/><path d="M3 3l18 18"/>',
  edit:  '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  del:   '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  fwd:   '<path d="M15 7l5 5-5 5"/><path d="M20 12H10a6 6 0 0 0-6 6v1"/>',
  save:  '<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/>'
};

let O = null;                 // volby z init()
let S = null;                 // stav
const $ = id => document.getElementById(id);
const esc = t => String(t == null ? "" : t).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const ms = x => !x ? 0 : typeof x === "number" ? x : x.toMillis ? x.toMillis() : x.seconds ? x.seconds * 1000 : new Date(x).getTime() || 0;
const now = () => (O && O.now ? O.now() : new Date()).getTime();
const norm = t => String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/* ---------- jména ---------- */
function officers(){ return (O && O.officers && O.officers()) || {}; }
function nameOf(c){ c = String(c); const o = officers(); return Object.keys(o).find(n => String(o[n]) === c) || ("č. " + c); }
function shortName(n){ const p = String(n).split(" "); return p.length > 1 ? `${p[0]} ${p[1][0]}.` : n; }
function surname(n){ return String(n).split(" ")[0]; }
function meName(){ return typeof O.meName === "function" ? O.meName() : O.meName || nameOf(O.me); }

/* ---------- oprávnění ---------- */
function testeri(){ return ((S.set && S.set.testeri) || []).map(String); }
function allowedNo(c){ return !!S.set && (S.set.vsem === true || testeri().includes(String(c))); }
function allowedMe(){ return !!O.isAdmin || allowedNo(O.me); }

/* ---------- vlákna ---------- */
const dmId = (a, b) => { const x = [String(a), String(b)].sort(); return `dm_${x[0]}_${x[1]}`; };
function thread(id){ return id === "vsichni" ? S.vsichni : S.threads[id] || null; }
function hState(t){ // stav vlákna hlídky
  const n = now();
  if (n < ms(t.zobrazitOd)) return "skryte";
  if (n >= ms(t.archivOd)) return "archiv";
  if (n < ms(t.start)) return "brzy";
  if (n < ms(t.konec)) return "probiha";
  return "skoncila";
}
function unreadOf(t){ if (!t) return 0; return Math.max(0, (t.pocet || 0) - ((t.videno || {})[O.me] || 0)); }
function isMuted(t){ return !!(t && t.muted && t.muted[O.me]); }
function visibleThreads(){
  const out = [];
  Object.entries(S.threads).forEach(([id, t]) => {
    if (t.typ === "hlidka"){ const st = hState(t); if (st === "skryte" || st === "archiv") return; }
    out.push([id, t]);
  });
  if (S.vsichni) out.push(["vsichni", S.vsichni]);
  return out;
}
function badgeCount(){ return visibleThreads().reduce((s, [, t]) => s + (isMuted(t) ? 0 : unreadOf(t)), 0); }
function titleOf(id, t){
  if (id === "vsichni") return "Zpráva všem";
  if (!t && id.startsWith("dm_")) return nameOf(id.split("_").slice(1).find(c => c !== String(O.me)));
  if (t && t.typ === "dm") return nameOf((t.clenove || []).map(String).find(c => c !== String(O.me)) || O.me);
  if (t && t.typ === "hlidka") return hTitle(t);
  return "Chat";
}
function hTitle(t, short){
  const [y, m, d] = String(t.datum).split("-").map(Number), dt = new Date(y, m - 1, d);
  return `${t.kind === "N" ? "Noční" : "Denní"} · ${(short ? DOW_S : DOW_F)[dt.getDay()]} ${d}. ${m}.`;
}
function hTimes(t){
  const a = new Date(ms(t.start)), b = new Date(ms(t.konec));
  return `${a.getHours()}:00 – ${b.getDate() !== a.getDate() ? DOW_S[b.getDay()] + " " : ""}${b.getHours()}:00`;
}
// průběh služby (jako na hlavní časové ose): pruh + Uběhlo / Zbývá; obnovuje se každou půlminutu
function durTxt(x){ const m = Math.max(0, Math.round(x / 6e4)), h = Math.floor(m / 60); return h ? `${h} h ${m % 60} min` : `${m % 60} min`; }
function progHTML(t){
  if (!t || t.typ !== "hlidka" || hState(t) !== "probiha") return "";
  return `<span class="ch-prog" data-s="${ms(t.start)}" data-e="${ms(t.konec)}">${progInner(ms(t.start), ms(t.konec))}</span>`;
}
function progInner(s, e){
  const tot = e - s, done = Math.min(tot, Math.max(0, now() - s));
  return `<span class="ch-pb"><i style="width:${(done / tot * 100).toFixed(1)}%"></i></span><span class="ch-pl"><span>Uběhlo <b>${durTxt(done)}</b></span><span>Zbývá <b>${durTxt(tot - done)}</b></span></span>`;
}
function tickProg(){
  let ended = false;
  document.querySelectorAll(".ch-prog[data-s]").forEach(el => { const s = +el.dataset.s, e = +el.dataset.e; if (now() >= e) ended = true; el.innerHTML = progInner(s, e); });
  if (ended && S && S.open){ renderList(); if (S.view === "thread" || S.two) renderHead(); }
}
function hMembers(t, full){
  const st = (t.stala || []).map(String);
  const list = (t.clenove || []).map(String).sort((a, b) => (st.includes(b) - st.includes(a)) || nameOf(a).localeCompare(nameOf(b), "cs"));
  return list.map(c => `<span class="${st.includes(c) ? "ch-st" : ""}${c === String(O.me) ? " ch-me" : ""}">${esc(full ? nameOf(c) : shortName(nameOf(c)))}</span>`).join("");
}

/* ---------- formát času ---------- */
const hm = t => { const d = new Date(t); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`; };
function dayLabel(t){
  const d = new Date(t), today = new Date(now()); today.setHours(0,0,0,0);
  const x = new Date(d); x.setHours(0,0,0,0);
  const diff = Math.round((today - x) / DAY);
  if (diff === 0) return "Dnes";
  if (diff === 1) return "Včera";
  return `${DOW_F[d.getDay()]} ${d.getDate()}. ${d.getMonth() + 1}.${d.getFullYear() !== today.getFullYear() ? " " + d.getFullYear() : ""}`;
}
function whenShort(t){
  if (!t) return "";
  const d = new Date(t), today = new Date(now());
  if (d.toDateString() === today.toDateString()) return hm(t);
  const diff = (new Date(today).setHours(0,0,0,0) - new Date(d).setHours(0,0,0,0)) / DAY;
  if (diff === 1) return "včera";
  if (diff < 7) return DOW_S[d.getDay()];
  return `${d.getDate()}. ${d.getMonth() + 1}.`;
}
function linkify(t){
  return esc(t).replace(/(https?:\/\/[^\s<]+)/g, u => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`).replace(/\n/g, "<br>");
}

/* ---------- styl ---------- */
const STYLE = `
.ch-root{position:fixed;inset:0;z-index:60;display:flex;background:var(--paper,var(--bg,#E6EAE4));color:var(--ink,#1D2A4D);font-family:var(--f-body,sans-serif);font-size:15px}
.ch-root[hidden],.ch-root [hidden]{display:none!important}
.ch-root.desk{left:var(--ch-left,0px);box-shadow:-8px 0 30px rgba(0,0,0,.18)}
.ch-root *{box-sizing:border-box}
.ch-root,.ch-root *,.ch-sheet,.ch-sheet *,.ch-view,.ch-view *{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent}
.ch-root textarea,.ch-root input{-webkit-user-select:text;user-select:text;-webkit-touch-callout:default}
.ch-root button{font:inherit;color:inherit;cursor:pointer}
.ch-pane{display:flex;flex-direction:column;min-width:0;min-height:0;flex:1}
.ch-list{overflow-y:auto;padding:calc(env(safe-area-inset-top,0px) + 14px) 14px calc(env(safe-area-inset-bottom,0px) + 90px)}
.ch-root.two .ch-list{flex:0 0 380px;border-right:1.5px solid var(--line,#DDE1E7);padding-bottom:24px}
.ch-root:not(.two).in-thread .ch-list{display:none}
.ch-root:not(.two):not(.in-thread) .ch-thread{display:none}
.ch-root.two .ch-back{display:none}
.ch-root.two .ch-th .ch-x{display:none}
.ch-h{display:flex;align-items:center;gap:10px;margin:0 0 12px}
.ch-h h2{font-family:var(--f-cond,sans-serif);font-weight:700;font-size:30px;margin:0;flex:1;line-height:1}
.ch-root .ch-x{width:40px;height:40px;border-radius:50%;border:0;background:var(--ink,#1D2A4D);color:var(--paper,#fff);font-size:19px;display:flex;align-items:center;justify-content:center;padding:0}
.ch-root:not(.desk) .ch-list > .ch-h .ch-x{position:fixed;right:24px;bottom:calc(env(safe-area-inset-bottom,0px) + 16px);width:48px;height:48px;font-size:21px;box-shadow:0 6px 18px rgba(0,0,0,.3);z-index:2}
.ch-test{font-size:13px;line-height:1.35;background:rgba(242,228,67,.35);border:1px dashed #B9A21E;border-radius:10px;padding:8px 10px;margin:0 0 12px}
.ch-sec{font-family:var(--f-cond,sans-serif);font-weight:700;font-size:18px;margin:16px 2px 8px;display:flex;align-items:center;justify-content:space-between}
.ch-sec button{font-family:var(--f-body,sans-serif);font-size:13px;font-weight:600;border:1.5px solid var(--ink,#1D2A4D);background:transparent;border-radius:8px;padding:4px 10px}
.ch-row{display:flex;align-items:center;gap:12px;width:100%;text-align:left;border:0;background:var(--sheet,#FAFBF7);border-radius:12px;padding:10px 12px;margin:0 0 6px;box-shadow:0 1px 0 rgba(0,0,0,.05)}
.ch-row:hover{outline:1.5px solid var(--ink2,#5A6480)}
.ch-row.on{outline:2.5px solid var(--ink,#1D2A4D)}
.ch-av{flex:none;width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:var(--f-cond,sans-serif);font-weight:700;font-size:16px;background:var(--ink,#1D2A4D);color:var(--paper,#fff)}
.ch-av.all{background:#2E7D4F;color:#fff}
.ch-av.img{background:#fff center/cover no-repeat;color:transparent;box-shadow:0 0 0 1px rgba(127,127,127,.25)}
.ch-adm .ch-fg{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:10px;margin-top:8px}
.ch-adm .ch-fg>div{display:flex;flex-direction:column;align-items:center;gap:4px;text-align:center;font-size:12px;line-height:1.2;position:relative}
.ch-adm .ch-fg .ch-av{width:56px;height:56px;font-size:20px;border:0;padding:0;cursor:pointer}
.ch-adm .ch-fg .ch-fx{position:absolute;top:-4px;right:calc(50% - 36px);width:22px;height:22px;border-radius:50%;border:0;background:#C0392B;color:#fff;font-size:13px;line-height:22px;padding:0;cursor:pointer}
.ch-rb{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.ch-rt{display:flex;align-items:baseline;gap:8px}
.ch-rt b{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:700}
.ch-rt small{color:var(--ink2,#5A6480);font-size:12px;flex:none}
.ch-rl{display:flex;align-items:center;gap:8px;color:var(--ink2,#5A6480);font-size:13.5px}
.ch-rl span{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ch-un{flex:none;min-width:20px;height:20px;border-radius:999px;background:#D04848;color:#fff;font-size:12px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;padding:0 6px}
.ch-un.mut{background:#9AA1B0}
.ch-mute{font-size:12px;opacity:.7}
.ch-hc{display:block;width:100%;text-align:left;border:2px solid var(--day-line,var(--dayBd,#E2C33A));background:var(--dayBg,var(--day,#FBEFB8));color:var(--ink,#1D2A4D);border-radius:14px;padding:10px 12px;margin:0 0 8px}
.ch-hc.N{background:var(--night,#4B3F9E);border-color:var(--night-line,#6C61C4);color:#fff}
.ch-hc.on{outline:3px solid var(--ink,#1D2A4D);outline-offset:1px}
.ch-hc .ch-rt b{font-family:var(--f-cond,sans-serif);font-size:19px}
.ch-hc .ch-rl{color:inherit;opacity:.85}
.ch-prog{display:block;margin:7px 0 6px}
.ch-pb{display:block;height:7px;border-radius:4px;background:rgba(29,42,77,.14);overflow:hidden}
.ch-pb i{display:block;height:100%;border-radius:4px;background:var(--ink,#1D2A4D)}
.ch-hc.N .ch-pb,.ch-th.N .ch-pb{background:rgba(255,255,255,.18)}
.ch-hc.N .ch-pb i,.ch-th.N .ch-pb i{background:#8FB0FF}
.ch-pl{display:flex;justify-content:space-between;font-size:12.5px;margin-top:3px;opacity:.85}
.ch-th{flex-wrap:wrap}
.ch-thp{flex:0 0 100%;padding:0 6px}
.ch-thp .ch-prog{margin:2px 0 0}
.ch-hst{font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:2px 7px;border-radius:6px;background:rgba(0,0,0,.12);flex:none}
.ch-hst.probiha{background:#1E63C6;color:#fff}
.ch-mem{display:flex;flex-wrap:wrap;gap:3px 8px;font-size:13px;margin:4px 0 2px}
.ch-mem .ch-st{background:#2E7D4F;color:#fff;border-radius:4px;padding:0 5px;font-weight:600}
.ch-mem .ch-me{text-decoration:underline;text-underline-offset:2px;font-weight:700}
.ch-arch{width:100%;border:1.5px dashed var(--ink2,#5A6480);background:transparent;border-radius:12px;padding:10px;margin-top:14px;font-weight:600}
.ch-empty{color:var(--ink2,#5A6480);font-size:14px;margin:4px 2px 10px}
.ch-pick{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.ch-pick button{border:1.5px solid var(--line,#B9C0B4);background:var(--sheet,#fff);border-radius:10px;padding:9px 10px;text-align:center;font-weight:600}
/* vlákno */
.ch-thread{background:var(--paper,var(--bg,#E6EAE4));position:relative}
.ch-th{display:flex;align-items:center;gap:8px;padding:calc(env(safe-area-inset-top,0px) + 10px) 10px 10px;background:var(--sheet,#FAFBF7);border-bottom:1.5px solid var(--line,#DDE1E7)}
.ch-th.D{background:var(--dayBg,var(--day,#FBEFB8))}
.ch-th.N{background:var(--night,#4B3F9E);color:#fff}
.ch-tb{flex:1;min-width:0;text-align:center}
.ch-tb.av{display:flex;align-items:center;justify-content:center;gap:8px;text-align:left}
.ch-tb.av>span:last-child{min-width:0}
.ch-tb .ch-av{width:34px;height:34px;font-size:13px}
.ch-root.two .ch-tb.av{justify-content:flex-start}
.ch-pick button{display:flex;align-items:center;gap:10px}
.ch-pick button>span:last-child{flex:1;text-align:center;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ch-pick .ch-av{width:34px;height:34px;font-size:13px}
.ch-sheet .ch-act .ch-av{width:28px;height:28px;font-size:11px}
.ch-side{flex:0 0 auto;min-width:92px;display:flex;gap:8px;align-items:center}
.ch-side.r{justify-content:flex-end}
.ch-root.two .ch-side.l{display:none}
.ch-root.two .ch-tb{text-align:left}
.ch-tb b{display:block;font-family:var(--f-cond,sans-serif);font-size:21px;line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ch-tb small#chPeer.on{color:#2E9E5B;opacity:1;font-weight:600}
.ch-th.N .ch-tb small#chPeer.on{color:#9BE7B5}
.ch-tb small{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;font-size:12.5px;line-height:1.25;opacity:.8;overflow:hidden}
.ch-root .ch-ib{flex:none;width:42px;height:42px;border-radius:50%;border:1.5px solid currentColor;background:transparent;color:inherit;display:flex;align-items:center;justify-content:center;padding:0}
.ch-root .ch-ib.on{background:var(--ink,#1D2A4D);border-color:var(--ink,#1D2A4D);color:var(--paper,#fff)}
.ch-th.N .ch-ib.on{background:#fff;border-color:#fff;color:var(--night,#4B3F9E)}
.ch-root .ch-back{flex:none;width:46px;height:46px;border-radius:50%;border:2px solid currentColor;background:transparent;color:inherit;display:flex;align-items:center;justify-content:center;padding:0}
.ch-pin{display:flex;align-items:center;gap:8px;padding:7px 12px;background:var(--sheet,#FAFBF7);border-bottom:1px solid var(--line,#DDE1E7);font-size:13.5px}
.ch-pin button{border:0;background:transparent;padding:0;text-align:left;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ch-pin .ch-unpin{flex:none;font-size:16px;opacity:.6}
.ch-search{display:flex;gap:8px;align-items:center;padding:7px 10px;background:var(--sheet,#FAFBF7);border-bottom:1px solid var(--line,#DDE1E7)}
.ch-search input{flex:1;min-width:0;border:1.5px solid var(--line,#B9C0B4);border-radius:8px;padding:7px 10px;background:var(--paper,#fff);color:inherit;font:inherit}
.ch-search small{color:var(--ink2,#5A6480);white-space:nowrap}
.ch-msgs{flex:1;overflow-y:auto;padding:12px 12px 6px;display:flex;flex-direction:column;gap:3px;overscroll-behavior:contain}
.ch-day{align-self:center;font-size:12px;font-weight:600;color:var(--ink2,#5A6480);background:var(--sheet,#FAFBF7);border-radius:999px;padding:3px 10px;margin:10px 0 6px}
.ch-m{max-width:min(78%,520px);align-self:flex-start;position:relative;display:flex;flex-direction:column;align-items:flex-start;margin-top:2px;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}
.ch-m.mine{align-self:flex-end;align-items:flex-end}
.ch-m .ch-who{font-size:12px;font-weight:700;color:var(--ink2,#5A6480);margin:6px 10px 2px}
.ch-bub{background:var(--sheet,#FFFFFF);border-radius:16px 16px 16px 5px;padding:7px 11px 6px;line-height:1.38;word-wrap:break-word;overflow-wrap:anywhere;box-shadow:0 1px 0 rgba(0,0,0,.06);min-width:60px}
.ch-m.mine .ch-bub{background:var(--ink,#1D2A4D);color:var(--paper,#fff);border-radius:16px 16px 5px 16px}
.ch-m.mine .ch-bub a{color:inherit}
.ch-bub img{display:block;max-width:100%;max-height:320px;border-radius:10px;margin:2px 0 4px;cursor:zoom-in}
.ch-grid{display:grid;grid-template-columns:1fr 1fr;gap:3px;width:min(280px,64vw);margin:2px 0 5px;border-radius:10px;overflow:hidden}
.ch-grid button{position:relative;display:block;padding:0;border:0;aspect-ratio:1/1;background:#000;cursor:zoom-in}
.ch-grid.n3 button:first-child{grid-column:span 2;aspect-ratio:2/1}
.ch-bub .ch-grid img{width:100%;height:100%;max-height:none;object-fit:cover;display:block;margin:0;border-radius:0}
.ch-grid .more{position:absolute;inset:0;background:rgba(0,0,0,.5);color:#fff;font-size:26px;font-weight:700;display:flex;align-items:center;justify-content:center}
.ch-view .ch-vx,.ch-view .ch-vb{position:absolute;width:48px;height:48px;border-radius:50%;border:2px solid rgba(255,255,255,.8);background:rgba(0,0,0,.35);color:#fff;display:flex;align-items:center;justify-content:center;padding:0;cursor:pointer}
.ch-view .ch-vx{top:calc(env(safe-area-inset-top,0px) + 12px);right:14px}
.ch-view .ch-vb{top:50%;transform:translateY(-50%)}
.ch-view .ch-vb.l{left:12px}.ch-view .ch-vb.r{right:12px}
.ch-view .ch-vb:disabled{opacity:.25;cursor:default}
.ch-view .ch-vn{position:absolute;bottom:calc(env(safe-area-inset-bottom,0px) + 18px);left:0;right:0;text-align:center;color:#fff;font-weight:600;font-size:15px}
.ch-bub .ch-del{font-style:italic;opacity:.65}
.ch-meta{display:flex;justify-content:flex-end;gap:6px;font-size:11px;opacity:.65;margin-top:2px}
.ch-q{display:block;width:100%;text-align:left;border:0;border-left:3px solid #E2C33A;background:rgba(0,0,0,.07);border-radius:6px;padding:4px 8px;margin:2px 0 5px;font-size:13px;line-height:1.3;color:inherit}
.ch-m.mine .ch-q{background:rgba(255,255,255,.14)}
.ch-q b{display:block;font-size:12px}
.ch-fwd{display:flex;align-items:center;gap:4px;font-size:12px;font-style:italic;opacity:.75;margin:0 0 4px}
.ch-fwd .ch-ico{flex:none}
.ch-sheet .ch-fl{max-height:min(60vh,520px);overflow-y:auto;-webkit-overflow-scrolling:touch;margin:0 -4px;padding:0 4px}
.ch-sheet h3{margin:2px 4px 10px;font-size:17px}
.ch-sheet .ch-fs{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;opacity:.6;margin:10px 4px 4px}
.ch-sheet .ch-act small{display:block;font-weight:400;font-size:12px;opacity:.7}
.ch-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(env(safe-area-inset-bottom,0px) + 120px);z-index:80;background:#1D2A4D;color:#fff;border-radius:22px;padding:10px 16px;font-size:14px;font-weight:600;box-shadow:0 6px 20px rgba(0,0,0,.3);display:flex;gap:12px;align-items:center;max-width:92vw;border:0}
.ch-toast u{color:#E2C33A;text-decoration:none}
.ch-view .ch-vs{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(env(safe-area-inset-bottom,0px) + 52px);z-index:2;display:flex;align-items:center;gap:8px;border:2px solid rgba(255,255,255,.8);background:rgba(0,0,0,.45);color:#fff;border-radius:24px;padding:10px 20px;font-size:16px;font-weight:600;cursor:pointer}
.ch-rx{display:flex;flex-wrap:wrap;gap:4px;margin:3px 4px 0}
.ch-rx button{border:1.5px solid var(--line,#B9C0B4);background:var(--sheet,#fff);border-radius:999px;padding:1px 7px;font-size:13px}
.ch-rx button.my{border-color:var(--ink,#1D2A4D);background:rgba(242,228,67,.45)}
.ch-seen{font-size:11.5px;color:var(--ink2,#5A6480);margin:2px 6px 4px;align-self:flex-end}
.ch-typing{font-size:12.5px;color:var(--ink2,#5A6480);font-style:italic;padding:0 14px 4px;min-height:18px}
.ch-m.flash .ch-bub{outline:3px solid #E2C33A}
.ch-m.hit .ch-bub{outline:2.5px solid #1E63C6}
.ch-more{position:absolute;top:50%;transform:translateY(-50%);right:-34px;width:28px;height:28px;border-radius:50%;border:0;background:transparent;opacity:0;font-size:18px;padding:0}
.ch-m.mine .ch-more{right:auto;left:-34px}
.ch-m:hover .ch-more{opacity:.6}
@media (hover:none){.ch-more{display:none}}
.ch-in{padding:8px 10px calc(env(safe-area-inset-bottom,0px) + 8px);background:var(--sheet,#FAFBF7);border-top:1.5px solid var(--line,#DDE1E7)}
.ch-bar{display:flex;align-items:center;gap:8px;font-size:13px;background:rgba(0,0,0,.05);border-left:3px solid #E2C33A;border-radius:6px;padding:5px 8px;margin:0 0 7px}
.ch-bar .ch-ico,.ch-pin .ch-ico{vertical-align:-3px;flex:none}
.ch-bar span{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ch-bar button{border:0;background:transparent;font-size:16px;padding:0 4px}
.ch-row2{display:flex;align-items:flex-end;gap:8px}
.ch-row2 textarea::-webkit-scrollbar{width:0;height:0}
.ch-row2 textarea{overflow-y:hidden;scrollbar-width:none;flex:1;min-width:0;resize:none;border:1.5px solid var(--line,#B9C0B4);border-radius:18px;padding:9px 14px;background:var(--paper,#fff);color:inherit;font:inherit;font-size:16px;line-height:1.3;max-height:140px}
.ch-send,.ch-photo{flex:none;width:42px;height:42px;border-radius:50%;border:0;display:flex;align-items:center;justify-content:center;padding:0}
.ch-root .ch-send{background:var(--ink,#1D2A4D);color:var(--paper,#fff)}
.ch-photo{background:transparent;border:1.5px solid var(--ink,#1D2A4D)}
.ch-root.kb .ch-in{padding-bottom:6px}
.ch-ro{text-align:center;font-size:13.5px;color:var(--ink2,#5A6480);padding:4px 0}
.ch-none{flex:1;display:flex;align-items:center;justify-content:center;color:var(--ink2,#5A6480);padding:20px;text-align:center}
.ch-err{color:#B83A3A;font-size:13px;margin:0 0 6px}
/* nabídka u zprávy a prohlížeč fotek */
.ch-sheet{position:fixed;inset:0;z-index:70;background:rgba(10,14,25,.45);display:flex;align-items:flex-end;justify-content:center}
.ch-sheet>div{width:min(460px,100%);background:var(--sheet,#fff);color:var(--ink,#1D2A4D);border-radius:18px 18px 0 0;padding:14px 14px calc(env(safe-area-inset-bottom,0px) + 14px)}
.ch-root.desk ~ .ch-sheet{align-items:center}
.ch-root.desk ~ .ch-sheet>div{border-radius:18px}
.ch-sheet .ch-emo{display:flex;justify-content:space-between;margin:0 0 10px}
.ch-sheet .ch-emo button{font-size:26px;border:0;background:transparent;width:46px;height:46px;border-radius:50%}
.ch-sheet .ch-emo button.my{background:rgba(242,228,67,.55)}
.ch-sheet .ch-act .ch-ico{flex:none}
.ch-sheet .ch-act{display:flex;align-items:center;gap:14px;width:100%;text-align:left;border:0;border-top:1px solid var(--line,#DDE1E7);background:transparent;padding:13px 6px;font-size:16px;font-weight:600;color:inherit}
.ch-sheet .ch-act.red{color:#C03A3A}
.ch-view{position:fixed;inset:0;z-index:75;background:#000;display:flex;align-items:center;justify-content:center;padding:20px;touch-action:none;overflow:hidden;overscroll-behavior:contain}
.ch-view img{max-width:100%;max-height:100%;border-radius:6px;transform-origin:center center;will-change:transform;-webkit-user-drag:none}
.ch-view .ch-vx,.ch-view .ch-vb,.ch-view .ch-vn{z-index:2}
/* administrace */
.ch-adm{margin-top:18px;padding:14px;border:1.5px solid var(--line,#DDE1E7);border-radius:12px;background:var(--sheet,#fff)}
.ch-adm h3{font-family:var(--f-cond,sans-serif);font-size:20px;margin:0 0 6px}
.ch-adm p{margin:4px 0 10px;font-size:14px}
.ch-adm .ch-tg{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:4px 12px;margin-top:8px}
.ch-adm label{display:flex;align-items:center;gap:8px;font-size:14px}
.ch-adm .ch-ab{border:1.5px solid var(--ink,#1D2A4D);background:var(--ink,#1D2A4D);color:var(--paper,#fff);border-radius:8px;padding:7px 14px;font-weight:600}
.ch-adm .ch-ab.sec{background:transparent;color:var(--ink,#1D2A4D)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .ch-m:not(.mine) .ch-bub{background:#232A3D}}
`;

/* ---------- inicializace ---------- */
CH.init = function(opts){
  if (O) { CH.refresh(); return; }
  O = opts; S = {set:undefined, threads:{}, vsichni:null, unsubs:[], tid:null, msgs:[], msgUnsub:null, msgFor:null, reply:null, edit:null,
    search:"", searchOn:false, view:"list", archive:false, pick:false, pending:null, typingAt:0, err:"", open:false, firstScroll:true};
  if (!$("chCss")){ const st = document.createElement("style"); st.id = "chCss"; st.textContent = STYLE; document.head.appendChild(st); }
  const root = document.createElement("div");
  root.className = "ch-root" + (O.desk ? " desk" : ""); root.id = "chRoot"; root.hidden = true;
  root.setAttribute("role", "dialog"); root.setAttribute("aria-label", "Chat");
  root.innerHTML = `<div class="ch-pane ch-list" id="chList"></div><div class="ch-pane ch-thread" id="chThread"></div>`;
  document.body.appendChild(root);
  bind(root);
  const db = O.db;
  S.unsubs.push(db.collection("nastaveni").doc("chat").onSnapshot(s => {
    S.set = s.exists ? s.data() : null;
    if (!s.exists) ensureDefault();
    applyAllowed();
    if (O.onAdminChange) O.onAdminChange();
  }, () => { S.set = null; applyAllowed(); }));
  // profilové fotky v kroužcích (nahrává správce v administraci): nastaveni/chatFoto {fotky:{<číslo>|vsichni: dataURL}}
  S.unsubs.push(db.collection("nastaveni").doc("chatFoto").onSnapshot(s => {
    S.fotky = (s.exists && s.data().fotky) || {};
    if (S.open){ renderList(); if (S.view === "thread" || S.two) renderHead(); }
    if (O.onAdminChange) O.onAdminChange();
  }, () => { S.fotky = {}; }));
  window.addEventListener("resize", layout);
  // iPhone: okno chatu se drží přesně viditelné plochy nad klávesnicí (stejně jako chat v KoKrŠNeKu).
  // Android to řeší sám – index.html má v meta viewport interactive-widget=resizes-content, takže se stránka nad klávesnici zmenší.
  // Výška bez klávesnice se zapamatuje při otevření – podle ní se pozná vysunutá klávesnice a zruší se spodní
  // rezerva pro domečkovou lištu, která jinak dělala mezeru mezi polem pro psaní a klávesnicí.
  const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (window.visualViewport && !O.desk && iOS){
    const vv = window.visualViewport;
    const fit = () => {
      const r = $("chRoot"); if (!r || r.hidden){ S.vvBase = null; return; }
      if (S.vvBase == null || vv.height > S.vvBase) S.vvBase = vv.height;
      r.style.top = vv.offsetTop + "px"; r.style.height = vv.height + "px"; r.style.bottom = "auto";
      const kb = S.vvBase - vv.height > 80;
      r.classList.toggle("kb", kb);
      const box = $("chMsgs"); if (box && kb) box.scrollTop = box.scrollHeight;
    };
    S.fit = fit;
    vv.addEventListener("resize", fit); vv.addEventListener("scroll", fit);
  }
  setInterval(() => { const pe = $("chPeer"); if (pe) pe.textContent = peerLine();
    if (S && S.open) { renderTyping(); if (S.view === "list") renderList(); } updBadge(); }, 30e3);
};
CH.refresh = function(){ if (!O) return; if (S.set === null) ensureDefault(); applyAllowed(); if (O.onAdminChange) O.onAdminChange(); };
function ensureDefault(){
  // první spuštění: nastavení vytvoří správce – testeři = správce + Sehnal Petr
  if (!O.isAdmin || S.creating) return;
  const o = officers(); if (!Object.keys(o).length) return;
  S.creating = true;
  const t = [String(O.me)]; if (o["Sehnal Petr"]) t.push(String(o["Sehnal Petr"]));
  O.db.collection("nastaveni").doc("chat").set({vsem:false, testeri:t}).catch(() => { S.creating = false; });
}
let LIVE = false;
function applyAllowed(){
  const ok = allowedMe() && S.set !== undefined && S.set !== null;
  if (O.onAllowed) O.onAllowed(ok);
  if (ok && !LIVE) startLive();
  if (!ok && LIVE) stopLive();
}
/* naposledy online: každý si zapisuje chatOnline/{své číslo} (jen čas) – při otevřené stránce každou minutu */
function beat(){
  if (!LIVE) return;
  O.db.collection("chatOnline").doc(String(O.me)).set({at:FV().serverTimestamp()}).catch(() => {});
}
function peerLine(){
  const at = S.peerAt; if (!at) return "Soukromá zpráva";
  const d = now() - at;
  if (d < 150e3) return "online";
  const t = new Date(at), today = new Date(now());
  const y = new Date(today); y.setDate(y.getDate() - 1);
  const day = t.toDateString() === today.toDateString() ? "dnes" : t.toDateString() === y.toDateString() ? "včera" : `${DOW_S[t.getDay()]} ${t.getDate()}. ${t.getMonth() + 1}.`;
  return `naposledy online ${day} ${hm(at)}`;
}
function watchPeer(){
  const tid = S.tid, peer = tid && tid.startsWith("dm_") ? tid.split("_").slice(1).find(c => c !== String(O.me)) : null;
  if (S.peerFor === peer) return;
  if (S.peerUnsub){ S.peerUnsub(); S.peerUnsub = null; }
  S.peerFor = peer; S.peerAt = 0;
  if (!peer) return;
  S.peerUnsub = O.db.collection("chatOnline").doc(peer).onSnapshot(s => {
    S.peerAt = s.exists ? ms(s.data({serverTimestamps:"estimate"}).at) : 0;
    const el = $("chPeer"); if (el){ el.textContent = peerLine(); el.classList.toggle("on", peerLine() === "online"); }
  }, () => {});
}
function startLive(){
  LIVE = true;
  clearInterval(S.progT); S.progT = setInterval(tickProg, 30e3);
  beat(); clearInterval(S.beatT); S.beatT = setInterval(() => { if (document.visibilityState === "visible") beat(); }, 60e3);
  const col = O.db.collection("chaty");
  S.liveUnsubs = [];
  S.liveUnsubs.push(col.where("clenove", "array-contains", String(O.me)).onSnapshot(s => {
    const T = {}; s.docs.forEach(d => { T[d.id] = d.data({serverTimestamps:"estimate"}); });
    S.threads = T; afterThreads();
  }, e => { console.warn("chat: vlákna", e); }));
  S.liveUnsubs.push(col.doc("vsichni").onSnapshot(s => {
    if (!s.exists){ S.vsichni = null; col.doc("vsichni").set({typ:"vsichni", pocet:0}, {merge:true}).catch(() => {}); }
    else S.vsichni = s.data({serverTimestamps:"estimate"});
    afterThreads();
  }, () => {}));
}
function stopLive(){
  LIVE = false;
  (S.liveUnsubs || []).forEach(u => { try { u(); } catch(e){} });
  S.liveUnsubs = []; S.threads = {}; S.vsichni = null; clearInterval(S.beatT);
  if (S.peerUnsub){ S.peerUnsub(); S.peerUnsub = null; S.peerFor = null; }
  if (S.msgUnsub){ S.msgUnsub(); S.msgUnsub = null; S.msgFor = null; }
  CH.close(); updBadge();
}
function afterThreads(){
  updBadge();
  if (S.pending && (thread(S.pending) || S.pending.startsWith("dm_"))){ const p = S.pending; S.pending = null; CH.openThread(p); return; }
  if (!S.open) return;
  if (S.tid) ensureMsgSub();
  renderList();
  if (S.tid) { renderHead(); renderMsgs(false); markSeen(); }
}
function updBadge(){ if (O && O.onBadge) O.onBadge(LIVE ? badgeCount() : 0); }
CH.stop = function(){
  if (!O) return;
  stopLive();
  (S.unsubs || []).forEach(u => { try { u(); } catch(e){} });
  const r = $("chRoot"); if (r) r.remove();
  O = null; S = null; LIVE = false;
};
CH.isViewing = tid => !!(S && S.open && S.tid === tid && document.visibilityState === "visible");
CH.allowed = () => !!(S && LIVE);

/* ---------- otevření a zavření ---------- */
CH.open = function(){
  if (!S || !LIVE) return;
  S.open = true; $("chRoot").hidden = false; layout(); if (S.fit) S.fit();
  if (!S.tid || !S.two) { S.view = "list"; }
  renderList(); if (S.tid) { renderThread(); }
  else $("chThread").innerHTML = `<div class="ch-none">Vyber vlákno vlevo.</div>`;
  $("chRoot").classList.toggle("in-thread", S.view === "thread");
};
CH.close = function(){
  if (!S) return;
  S.open = false; S.vvBase = null; const r = $("chRoot"); if (r){ r.hidden = true; r.classList.remove("kb"); }
  closeSheet();
  if (O && O.onClose) O.onClose();
};
CH.openThread = function(tid){
  if (!S) return;
  if (!LIVE || (!thread(tid) && !tid.startsWith("dm_"))){ S.pending = tid; if (LIVE) CH.open(); return; }
  if (!S.open){ S.open = true; $("chRoot").hidden = false; layout(); if (S.fit) S.fit(); }
  if (S.tid !== tid){ S.reply = null; S.edit = null; S.search = ""; S.searchOn = false; S.firstScroll = true; S.err = ""; }
  S.tid = tid; S.view = "thread"; S.pick = false; S.atBottom = true;
  const t0 = thread(tid); if (t0 && t0.typ === "hlidka" && hState(t0) === "archiv") S.archive = true;
  $("chRoot").classList.add("in-thread");
  renderList(); renderThread();
  setTimeout(() => { const ta = $("chText"); if (ta && S.two) ta.focus(); }, 60);
};
function layout(){
  const r = $("chRoot"); if (!r) return;
  S.two = (r.clientWidth || window.innerWidth) >= 860;
  r.classList.toggle("two", S.two);
}
function backToList(){
  S.view = "list"; $("chRoot").classList.remove("in-thread");
  if (S.msgUnsub && !S.two){ /* poslech necháme – rychlý návrat */ }
  S.tid = S.two ? S.tid : null;
  renderList();
}

/* ---------- seznam vláken ---------- */
function initials(n){ return String(n).split(" ").map(x => x[0]).slice(0, 2).join(""); }
function avHTML(key, letters, cls){
  const f = S.fotky && S.fotky[key];
  return f ? `<span class="ch-av img" style="background-image:url('${f}')" aria-hidden="true"></span>` : `<span class="ch-av${cls ? " " + cls : ""}">${esc(letters)}</span>`;
}
function rowHTML(id, t){
  const un = unreadOf(t), mut = isMuted(t), last = t && t.posledni;
  const title = titleOf(id, t);
  const lastTxt = last ? `${String(last.od) === String(O.me) ? "Ty: " : (id === "vsichni" ? surname(last.jmeno || nameOf(last.od)) + ": " : "")}${last.text || ""}` : "Zatím žádné zprávy";
  const peer = id.startsWith("dm_") ? id.split("_").slice(1).find(c => c !== String(O.me)) || String(O.me) : null;
  const av = id === "vsichni" ? avHTML("vsichni", "VŠ", "all") : avHTML(peer, initials(title));
  return `<button type="button" class="ch-row${S.tid === id && S.two ? " on" : ""}" data-cht="${esc(id)}">${av}<span class="ch-rb"><span class="ch-rt"><b>${esc(title)}</b><small>${whenShort(last && ms(last.at))}</small></span><span class="ch-rl"><span>${esc(lastTxt)}</span>${mut ? `<i class="ch-mute" title="Ztlumeno">🔕</i>` : ""}${un ? `<i class="ch-un${mut ? " mut" : ""}">${un > 99 ? "99+" : un}</i>` : ""}</span></span></button>`;
}
function hCardHTML(id, t){
  const st = hState(t), un = unreadOf(t), mut = isMuted(t), last = t.posledni;
  const lbl = {brzy:"Zítra", probiha:"Probíhá", skoncila:"Skončila", archiv:"Archiv"}[st] || "";
  const soon = st === "brzy" && new Date(ms(t.start)).toDateString() === new Date(now()).toDateString() ? "Dnes" : lbl;
  return `<button type="button" class="ch-hc ${t.kind === "N" ? "N" : "D"}${S.tid === id && S.two ? " on" : ""}" data-cht="${esc(id)}">
    <span class="ch-rt"><b>${esc(hTitle(t))}</b><span class="ch-hst ${st}">${soon}</span></span>
    <span class="ch-rl"><span>${hTimes(t)}</span>${mut ? `<i class="ch-mute">🔕</i>` : ""}${un ? `<i class="ch-un${mut ? " mut" : ""}">${un}</i>` : ""}</span>
    ${progHTML(t)}
    <span class="ch-mem">${hMembers(t)}</span>
    ${last ? `<span class="ch-rl"><span>${esc(String(last.od) === String(O.me) ? "Ty" : surname(last.jmeno || nameOf(last.od)))}: ${esc(last.text || "")}</span><small>${whenShort(ms(last.at))}</small></span>` : ""}
  </button>`;
}
function renderList(){
  const el = $("chList"); if (!el || !S.open) return;
  const head = `<div class="ch-h"><h2>${S.archive ? "Archiv hlídek" : S.pick ? "Nová zpráva" : "Chat"}</h2>${S.archive || S.pick ? `<button type="button" class="ch-sec" data-chback-list style="margin:0;border:1.5px solid currentColor;border-radius:8px;padding:5px 10px;background:transparent;font-size:14px">‹ Zpět</button>` : ""}<button type="button" class="ch-x" data-chclose aria-label="Zavřít chat">✕</button></div>`;
  const test = S.set && !S.set.vsem ? `<p class="ch-test"><b>Testovací provoz</b> – chat zatím vidí jen ${testeri().map(c => esc(nameOf(c))).join(", ")}.</p>` : "";
  if (S.pick){
    const list = Object.entries(officers()).filter(([n, c]) => String(c) !== String(O.me) && (S.set.vsem || testeri().includes(String(c)))).sort((a, b) => a[0].localeCompare(b[0], "cs"));
    el.innerHTML = head + (list.length ? `<div class="ch-pick">${list.map(([n, c]) => `<button type="button" data-chdm="${esc(c)}">${avHTML(String(c), initials(n))}<span>${esc(n)}</span></button>`).join("")}</div>` : `<p class="ch-empty">Zatím nikdo další nemá chat povolený.</p>`);
    return;
  }
  const H = Object.entries(S.threads).filter(([, t]) => t.typ === "hlidka");
  if (S.archive){
    const arch = H.filter(([, t]) => hState(t) === "archiv").sort((a, b) => ms(b[1].start) - ms(a[1].start));
    let html = head, lastM = "";
    arch.forEach(([id, t]) => {
      const d = new Date(ms(t.start)), mk = `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
      if (mk !== lastM){ html += `<div class="ch-sec">${mk.charAt(0).toUpperCase() + mk.slice(1)}</div>`; lastM = mk; }
      html += hCardHTML(id, t);
    });
    if (!arch.length) html += `<p class="ch-empty">Archiv je zatím prázdný. Vlákno hlídky se sem přesune po skončení další stejné služby.</p>`;
    el.innerHTML = html; return;
  }
  const act = H.filter(([, t]) => { const s = hState(t); return s !== "skryte" && s !== "archiv"; }).sort((a, b) => ms(a[1].start) - ms(b[1].start));
  const nArch = H.filter(([, t]) => hState(t) === "archiv").length;
  const dms = Object.entries(S.threads).filter(([, t]) => t.typ === "dm").sort((a, b) => ms(b[1].posledni && b[1].posledni.at) - ms(a[1].posledni && a[1].posledni.at));
  el.innerHTML = head + test
    + `<div class="ch-sec">Hlídky</div>` + (act.length ? act.map(([id, t]) => hCardHTML(id, t)).join("") : `<p class="ch-empty">Teď nemáš žádnou hlídku. Vlákno se objeví den před službou.</p>`)
    + `<div class="ch-sec">Společné</div>` + rowHTML("vsichni", S.vsichni)
    + `<div class="ch-sec">Soukromé zprávy <button type="button" data-chnew>+ Nová</button></div>`
    + (dms.length ? dms.map(([id, t]) => rowHTML(id, t)).join("") : `<p class="ch-empty">Zatím žádné. Napiš kolegovi přes „+ Nová“.</p>`)
    + `<button type="button" class="ch-arch" data-charch>Archiv hlídek${nArch ? ` (${nArch})` : ""}</button>`;
}

/* ---------- vlákno ---------- */
function ensureMsgSub(){
  const tid = S.tid; if (!tid) return;
  if (S.msgFor === tid) return;
  if (!thread(tid)) { S.msgs = []; return; } // nové soukromé vlákno vznikne první zprávou
  if (S.msgUnsub) S.msgUnsub();
  S.msgFor = tid; S.msgs = []; S.firstScroll = true;
  S.msgUnsub = O.db.collection("chaty").doc(tid).collection("zpravy").orderBy("at").limitToLast(400).onSnapshot(s => {
    if (S.msgFor !== tid) return;
    S.msgs = s.docs.map(d => ({id:d.id, _pend:!!(d.metadata && d.metadata.hasPendingWrites), ...d.data({serverTimestamps:"estimate"})}));
    renderMsgs(true); markSeen();
  }, e => { console.warn("chat: zprávy", e); S.err = "Zprávy nejde načíst (" + (e.code || "chyba") + ")."; renderMsgs(false); });
}
function renderThread(){
  const el = $("chThread"); if (!el) return;
  const tid = S.tid; if (!tid){ el.innerHTML = `<div class="ch-none">Vyber vlákno.</div>`; return; }
  const t = thread(tid);
  const ro = t && t.typ === "hlidka" && hState(t) === "archiv";
  el.innerHTML = `<div class="ch-th" id="chHead"></div><div id="chPinBox"></div><div id="chSearchBox"></div>
    <div class="ch-msgs" id="chMsgs" aria-live="polite"></div><div class="ch-typing" id="chTyping"></div>
    <div class="ch-in" id="chIn">${ro ? `<p class="ch-ro">Archiv hlídky – jen ke čtení.</p>` : `
      <div id="chBar"></div><p class="ch-err" id="chErr" hidden></p>
      <div class="ch-row2">
        <button type="button" class="ch-photo" data-chphoto aria-label="Poslat fotku"><svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg></button>
        <input type="file" id="chFile" accept="image/*" multiple hidden>
        <textarea id="chText" rows="1" maxlength="2000" placeholder="Zpráva"></textarea>
        <button type="button" class="ch-send" data-chsend aria-label="Odeslat"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 20.5 21 12 3 3.5l2.4 7.1L14 12l-8.6 1.4z"/></svg></button>
      </div>`}</div>`;
  const mb = $("chMsgs");
  mb.addEventListener("scroll", () => { S.atBottom = mb.scrollHeight - mb.scrollTop - mb.clientHeight < 80; }, {passive:true});
  if (window.ResizeObserver){ if (S.ro) S.ro.disconnect(); S.ro = new ResizeObserver(stickBottom); S.ro.observe(mb); }
  ensureMsgSub(); watchPeer();
  renderHead(); renderMsgs(true); renderBar();
  const ta = $("chText");
  if (ta){
    ta.addEventListener("input", () => { grow(ta); typingPing(); });
    // po vysunutí klávesnice zůstane vidět poslední zpráva
    ta.addEventListener("focus", () => { [120, 350, 700].forEach(t => setTimeout(stickBottom, t)); });
    ta.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && (O.desk || window.matchMedia("(hover:hover)").matches)){ e.preventDefault(); send(); } });
    const draft = (() => { try { return localStorage.getItem("chDraft_" + tid) || ""; } catch(e){ return ""; } })();
    if (draft && !S.edit) { ta.value = draft; grow(ta); }
  }
  const f = $("chFile"); if (f) f.addEventListener("change", () => { const files = [...(f.files || [])]; f.value = ""; sendPhotos(files); });
  markSeen();
}
// držet konec konverzace: po otevření, po vysunutí klávesnice a po načtení fotek
function stickBottom(){ const b = $("chMsgs"); if (b && S && S.atBottom !== false) b.scrollTop = b.scrollHeight; }
function grow(ta){ ta.style.height = "auto"; const h = ta.scrollHeight + 2; ta.style.height = Math.min(140, h) + "px"; ta.style.overflowY = h > 140 ? "auto" : "hidden"; }
function renderHead(){
  const h = $("chHead"); if (!h) return;
  const tid = S.tid, t = thread(tid), mut = isMuted(t);
  let sub = "";
  if (t && t.typ === "hlidka") sub = `${hTimes(t)} · ${(t.clenove || []).map(c => surname(nameOf(c))).join(", ")}`;
  else if (tid === "vsichni") sub = S.set && S.set.vsem ? "Všichni strážníci" : "Testovací provoz – jen testeři";
  else sub = null;
  const peer = tid && tid.startsWith("dm_") ? tid.split("_").slice(1).find(c => c !== String(O.me)) || String(O.me) : null;
  const hav = tid === "vsichni" ? avHTML("vsichni", "VŠ", "all") : peer ? avHTML(peer, initials(nameOf(peer))) : "";
  h.className = "ch-th" + (t && t.typ === "hlidka" ? " " + (t.kind === "N" ? "N" : "D") : "");
  h.innerHTML = `<div class="ch-side l"><button type="button" class="ch-back" data-chback aria-label="Zpět na seznam chatů"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></button></div>
    <div class="ch-tb${hav ? " av" : ""}">${hav}<span><b>${esc(t && t.typ === "hlidka" && !S.two ? hTitle(t, true) : titleOf(tid, t))}</b>${sub === null ? `<small id="chPeer" class="${peerLine() === "online" ? "on" : ""}">${esc(peerLine())}</small>` : `<small>${esc(sub)}</small>`}</span></div>
    <div class="ch-side r"><button type="button" class="ch-ib${S.searchOn ? " on" : ""}" data-chsearch aria-label="Hledat ve vlákně" title="Hledat"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/></svg></button>
    ${t ? `<button type="button" class="ch-ib${mut ? " on" : ""}" data-chmute aria-pressed="${mut}" aria-label="${mut ? "Zrušit ztlumení" : "Ztlumit upozornění"}" title="${mut ? "Ztlumeno – upozornění vypnutá" : "Ztlumit upozornění"}">${mut ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/><path d="M4 4l16 16"/></svg>` : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>`}</button>` : ""}
    ${O.desk ? `<button type="button" class="ch-x" data-chclose aria-label="Zavřít chat">✕</button>` : ""}</div>${progHTML(t) ? `<div class="ch-thp">${progHTML(t)}</div>` : ""}`;
  const pb = $("chPinBox");
  if (pb) pb.innerHTML = t && t.pinned ? `<div class="ch-pin">${ic(ICO.pin, 18)}<button type="button" data-chgo="${esc(t.pinned.id)}"><b>${esc(surname(t.pinned.jmeno || ""))}:</b> ${esc(t.pinned.text || "fotka")}</button><button type="button" class="ch-unpin" data-chunpin aria-label="Odepnout">✕</button></div>` : "";
  const sb = $("chSearchBox");
  if (sb && S.searchOn && !$("chQ")){
    sb.innerHTML = `<div class="ch-search"><input id="chQ" type="search" placeholder="Hledat ve zprávách" value="${esc(S.search)}"><small id="chQn"></small></div>`;
    const q = $("chQ"); q.addEventListener("input", () => { S.search = q.value; renderMsgs(false, true); }); setTimeout(() => q.focus(), 30);
  } else if (sb && !S.searchOn) sb.innerHTML = "";
}
// stav vlastní zprávy: odesílá se / doručeno (čas) / přečteno (kdo a kdy)
// lastSeen se zapisuje jen při přečtení nových zpráv od ostatních, takže u poslední zprávy je čas přečtení přesný
function whenRead(t){ const d = new Date(t), n = new Date(now()); return d.toDateString() === n.toDateString() ? hm(t) : `${DOW_S[d.getDay()]} ${hm(t)}`; }
function statusLine(t, m, isLast){
  if (!m || m.smazano) return "";
  if (m._pend) return "Odesílá se…";
  const at = ms(m.at), ls = (t && t.lastSeen) || {};
  const others = !t ? [] : t.typ === "vsichni" ? Object.keys(ls).filter(c => c !== String(O.me)) : (t.clenove || []).map(String).filter(c => c !== String(O.me));
  const seen = others.filter(c => ms(ls[c]) >= at);
  const sent = `Doručeno ${whenRead(at)}`;
  if (!seen.length) return sent;
  if (t.typ === "dm") return isLast ? `Přečteno ${whenRead(ms(ls[seen[0]]))}` : "Přečteno";
  return "Přečetli: " + seen.map(c => surname(nameOf(c)) + (isLast ? " " + whenRead(ms(ls[c])) : "")).join(", ");
}
function renderMsgs(autoscroll, keepScroll){
  const box = $("chMsgs"); if (!box) return;
  const t = thread(S.tid), group = !t || t.typ !== "dm";
  const nearBottom = S.atBottom !== false;
  const q = norm(S.searchOn ? S.search.trim() : "");
  let html = "", lastDay = "", lastFrom = null, hits = 0;
  if (S.err) html += `<p class="ch-err">${esc(S.err)}</p>`;
  if (!S.msgs.length) html += `<div class="ch-none">${t ? "Zatím žádné zprávy." : "Napiš první zprávu."}</div>`;
  const lastMine = [...S.msgs].reverse().find(m => String(m.od) === String(O.me) && !m.smazano);
  // po sobě jdoucí fotky odeslané najednou (stejná „skupina“) se zobrazí jako jedna zpráva s mřížkou
  const items = [];
  S.msgs.forEach(m => {
    const p = items[items.length - 1];
    if (m.skupina && p && p.g === m.skupina && String(p.od) === String(m.od)) p.list.push(m);
    else items.push({g:m.skupina || null, od:m.od, list:[m]});
  });
  S.gal = {}; S.groupOf = {};
  items.forEach(it => {
    const m = it.list[0], lastM = it.list[it.list.length - 1];
    const at = ms(m.at), dl = dayLabel(at);
    if (dl !== lastDay){ html += `<div class="ch-day">${dl}</div>`; lastDay = dl; lastFrom = null; }
    const mine = String(m.od) === String(O.me);
    const hit = q && norm(m.text).includes(q); if (hit) hits++;
    const rx = Object.entries(m.reakce || {}).filter(([, a]) => a && a.length).map(([k, a]) => `<button type="button" class="${a.map(String).includes(String(O.me)) ? "my" : ""}" data-chrx="${k}" data-mid="${m.id}" title="${esc(a.map(c => surname(nameOf(c))).join(", "))}">${REAKCE_EMO[k] || "?"} ${a.length}</button>`).join("");
    const imgs = it.list.filter(x => !x.smazano && x.image);
    const allDel = it.list.every(x => x.smazano);
    S.groupOf[m.id] = it.list.map(x => x.id);
    if (imgs.length) S.gal[m.id] = imgs.map(x => x.image);
    let pics = "";
    if (imgs.length === 1 && it.list.length === 1) pics = `<img src="${imgs[0].image}" alt="Fotka" data-chgal="${m.id}" data-i="0" loading="lazy">`;
    else if (imgs.length){
      const show = imgs.slice(0, 4), more = imgs.length - show.length;
      pics = `<div class="ch-grid n${Math.min(imgs.length, 4)}">${show.map((x, i) => `<button type="button" data-chgal="${m.id}" data-i="${i}" aria-label="Fotka ${i + 1} z ${imgs.length}"><img src="${x.image}" alt="" loading="lazy">${i === 3 && more > 0 ? `<span class="more">+${more}</span>` : ""}</button>`).join("")}</div>`;
    }
    const body = allDel ? `<span class="ch-del">${it.list.length > 1 ? "Fotky byly smazány" : "Zpráva byla smazána"}</span>` : `${m.preposlano ? `<span class="ch-fwd">${ic(ICO.fwd, 14)}Přeposláno od ${esc(m.preposlano.jmeno || "")}</span>` : ""}${m.replyTo ? `<button type="button" class="ch-q" data-chgo="${esc(m.replyTo.id)}"><b>${esc(m.replyTo.jmeno || "")}</b>${esc(m.replyTo.text || "📷 Fotka")}</button>` : ""}${pics}${m.text && !m.smazano ? linkify(m.text) : ""}`;
    html += `<div class="ch-m${mine ? " mine" : ""}${hit ? " hit" : ""}" data-mid="${m.id}">${group && !mine && lastFrom !== m.od ? `<span class="ch-who">${esc(m.jmeno || nameOf(m.od))}</span>` : ""}
      <div class="ch-bub">${body}<div class="ch-meta">${imgs.length > 1 ? `${imgs.length} ${imgs.length < 5 ? "fotky" : "fotek"} · ` : ""}${m.upraveno && !m.smazano ? "upraveno · " : ""}${hm(ms(lastM.at))}</div></div>${rx ? `<div class="ch-rx">${rx}</div>` : ""}${allDel ? "" : `<button type="button" class="ch-more" data-chmore="${m.id}" aria-label="Možnosti zprávy">⋯</button>`}</div>`;
    const stM = it.list.includes(lastMine) ? lastMine : (mine && it.list.some(x => x.id === S.infoMid) ? lastM : null);
    if (stM){ const sl = statusLine(t, stM, stM === lastMine); if (sl) html += `<div class="ch-seen">${esc(sl)}</div>`; }
    lastFrom = m.od;
  });
  const prev = box.scrollTop;
  box.innerHTML = html;
  const qn = $("chQn"); if (qn) qn.textContent = q ? `${hits} ${hits === 1 ? "výsledek" : hits >= 2 && hits <= 4 ? "výsledky" : "výsledků"}` : "";
  if (q && hits && keepScroll){ const f = box.querySelector(".ch-m.hit"); if (f) f.scrollIntoView({block:"center"}); return; }
  if (S.firstScroll || nearBottom){
    box.scrollTop = box.scrollHeight; S.atBottom = true; if (S.msgs.length) S.firstScroll = false;
    box.querySelectorAll("img").forEach(im => { if (!im.complete) im.addEventListener("load", stickBottom, {once:true}); });
  }
  else box.scrollTop = prev;
  renderTyping();
}
function renderTyping(){
  const el = $("chTyping"); if (!el) return;
  const t = thread(S.tid); if (!t){ el.textContent = ""; return; }
  const n = now(), who = Object.entries(t.typing || {}).filter(([c, v]) => c !== String(O.me) && n - ms(v) < 7000).map(([c]) => surname(nameOf(c)));
  el.textContent = who.length ? `${who.join(", ")} ${who.length > 1 ? "píšou" : "píše"}…` : "";
  if (who.length){ clearTimeout(S.typT); S.typT = setTimeout(renderTyping, 3000); }
}
function renderBar(){
  const b = $("chBar"); if (!b) return;
  if (S.edit) b.innerHTML = `<div class="ch-bar"><span>${ic(ICO.edit, 16)} Upravuješ zprávu</span><button type="button" data-chcancel aria-label="Zrušit úpravu">✕</button></div>`;
  else if (S.reply) b.innerHTML = `<div class="ch-bar"><span>${ic(ICO.reply, 16)} <b>${esc(S.reply.jmeno)}:</b> ${esc(S.reply.text || "📷 Fotka")}</span><button type="button" data-chcancel aria-label="Zrušit odpověď">✕</button></div>`;
  else b.innerHTML = "";
}
function showErr(msg){ const e = $("chErr"); if (e){ e.textContent = msg; e.hidden = !msg; } }

/* ---------- zápisy ---------- */
function FV(){ return O.firebase.firestore.FieldValue; }
function tref(tid){ return O.db.collection("chaty").doc(tid || S.tid); }
function threadBase(tid){
  if (tid.startsWith("dm_")){ const c = tid.split("_").slice(1); return {typ:"dm", clenove:c}; }
  return {};
}
let seenBusy = false;
function markSeen(){
  if (!S.open || S.view !== "thread" && !S.two || !S.tid || document.visibilityState !== "visible") return;
  const t = thread(S.tid); if (!t) return;
  const need = (t.videno || {})[O.me] !== (t.pocet || 0);
  const fromOthers = S.msgs.filter(m => String(m.od) !== String(O.me));
  const lastAt = fromOthers.length ? ms(fromOthers[fromOthers.length - 1].at) : 0;
  const seenAt = ms((t.lastSeen || {})[O.me]);
  if (!need && seenAt >= lastAt) return;
  if (seenBusy) return; seenBusy = true;
  tref().set({videno:{[O.me]:t.pocet || 0}, lastSeen:{[O.me]:FV().serverTimestamp()}}, {merge:true}).catch(() => {}).then(() => { seenBusy = false; });
}
function typingPing(){
  const t = now(); if (t - S.typingAt < 3000 || !thread(S.tid)) return;
  S.typingAt = t;
  tref().set({typing:{[O.me]:FV().serverTimestamp()}}, {merge:true}).catch(() => {});
  try { localStorage.setItem("chDraft_" + S.tid, $("chText").value); } catch(e){}
}
function preview(text, image){ return image ? (text ? "📷 " + text : "📷 Fotka") : String(text).slice(0, 140); }
async function writeMsg(data, tid){
  tid = tid || S.tid; const fv = FV(), ref = tref(tid), m = ref.collection("zpravy").doc();
  const b = O.db.batch();
  b.set(m, {od:String(O.me), jmeno:meName(), at:fv.serverTimestamp(), ...data});
  b.set(ref, {...threadBase(tid), pocet:fv.increment(1), videno:{[O.me]:fv.increment(1)},
    typing:{[O.me]:fv.delete()}, posledni:{text:preview(data.text || "", data.image), od:String(O.me), jmeno:meName(), at:fv.serverTimestamp()}}, {merge:true});
  await b.commit();
}
async function send(){
  const ta = $("chText"); if (!ta || S.sending) return;
  const text = ta.value.trim(); if (!text) return;
  S.sending = true; showErr("");
  // pole se vyprázdní hned (zpráva se ve vlákně objeví okamžitě jako „Odesílá se…“), při chybě se text vrátí
  const edit = S.edit, reply = S.reply;
  ta.value = ""; grow(ta); S.edit = null; S.reply = null; renderBar();
  try { localStorage.removeItem("chDraft_" + S.tid); } catch(e){}
  S.atBottom = true; stickBottom();
  try {
    if (edit) await tref().collection("zpravy").doc(edit).update({text, upraveno:FV().serverTimestamp()});
    else {
      const data = {text};
      if (reply) data.replyTo = {id:reply.id, jmeno:reply.jmeno, text:String(reply.text || "").slice(0, 120)};
      const p = writeMsg(data); S.sending = false; ensureMsgSub(); await p;
    }
  } catch (e){
    if (!ta.value){ ta.value = text; grow(ta); S.edit = edit; S.reply = reply; renderBar(); }
    showErr(e.code === "permission-denied" ? "Odeslání zamítnuto pravidly Firestore." : "Zprávu se nepodařilo odeslat.");
  } finally { S.sending = false; }
}
async function sendPhotos(files){
  if (!files.length) return;
  const ta = $("chText"); let text = ta ? ta.value.trim().slice(0, 300) : "";
  const btn = document.querySelector("[data-chphoto]");
  const gid = files.length > 1 ? Date.now().toString(36) + Math.random().toString(36).slice(2, 6) : null; // fotky poslané najednou = jedna zpráva s mřížkou
  for (let i = 0; i < files.length; i++){
    if (btn) btn.textContent = files.length > 1 ? `${i + 1}/${files.length}` : "…";
    try {
      const image = await compress(files[i]);
      const data = {image, text};
      if (gid){ data.skupina = gid; data.skupinaN = files.length; }
      if (S.reply){ data.replyTo = {id:S.reply.id, jmeno:S.reply.jmeno, text:String(S.reply.text || "").slice(0, 120)}; S.reply = null; }
      await writeMsg(data); text = "";
    } catch (e){ showErr(e.code === "permission-denied" ? "Odeslání zamítnuto pravidly Firestore." : "Fotku se nepodařilo odeslat."); }
  }
  if (ta){ ta.value = ""; grow(ta); }
  renderThread();
}
function compress(file){
  // zmenšení fotky na text (JPEG) do ~700 kB – ukládá se přímo do zprávy, bez úložiště souborů
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const tries = [[1280, .6], [1000, .55], [800, .45], [640, .35], [480, .3]];
      for (const [dim, q] of tries){
        const k = Math.min(1, dim / Math.max(img.width, img.height));
        const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        const d = c.toDataURL("image/jpeg", q);
        if (d.length <= 700 * 1024) return res(d);
      }
      rej(new Error("velká fotka"));
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("fotka")); };
    img.src = url;
  });
}
function msgById(id){ return S.msgs.find(m => m.id === id); }
function toggleRx(mid, key){
  const m = msgById(mid); if (!m) return;
  const has = ((m.reakce || {})[key] || []).map(String).includes(String(O.me));
  const fv = FV();
  tref().collection("zpravy").doc(mid).update({["reakce." + key]: has ? fv.arrayRemove(String(O.me)) : fv.arrayUnion(String(O.me))}).catch(() => {});
}

/* ---------- nabídka u zprávy ---------- */
function closeSheet(){ const s = document.querySelector(".ch-sheet"); if (s) s.remove(); }
function openSheet(mid){
  const m = msgById(mid); if (!m || m.smazano) return;
  const t = thread(S.tid), ro = t && t.typ === "hlidka" && hState(t) === "archiv";
  const mine = String(m.od) === String(O.me), pinned = t && t.pinned && t.pinned.id === mid;
  closeSheet();
  const s = document.createElement("div"); s.className = "ch-sheet";
  s.innerHTML = `<div role="dialog" aria-label="Možnosti zprávy">
    ${ro ? "" : `<div class="ch-emo">${REAKCE.map(([k, e]) => `<button type="button" data-chsrx="${k}" class="${((m.reakce || {})[k] || []).map(String).includes(String(O.me)) ? "my" : ""}" aria-label="Reakce ${e}">${e}</button>`).join("")}</div>`}
    ${ro ? "" : `<button type="button" class="ch-act" data-chs="reply">${ic(ICO.reply)}Odpovědět</button>`}
    <button type="button" class="ch-act" data-chs="fwd">${ic(ICO.fwd)}Přeposlat</button>
    ${m.text ? `<button type="button" class="ch-act" data-chs="copy">${ic(ICO.copy)}Kopírovat text</button>` : ""}
    ${t && !ro ? `<button type="button" class="ch-act" data-chs="pin">${ic(pinned ? ICO.unpin : ICO.pin)}${pinned ? "Odepnout" : "Připnout nahoru"}</button>` : ""}
    ${mine && m.text && !ro ? `<button type="button" class="ch-act" data-chs="edit">${ic(ICO.edit)}Upravit</button>` : ""}
    ${mine && !ro ? `<button type="button" class="ch-act red" data-chs="del">${ic(ICO.del)}Smazat</button>` : ""}
    <button type="button" class="ch-act" data-chs="x">${ic(ICO.close)}Zavřít</button></div>`;
  s.addEventListener("click", async e => {
    if (e.target === s){ closeSheet(); return; }
    const rx = e.target.closest("[data-chsrx]"); if (rx){ toggleRx(mid, rx.dataset.chsrx); closeSheet(); return; }
    const a = e.target.closest("[data-chs]"); if (!a) return;
    const act = a.dataset.chs; closeSheet();
    if (act === "reply"){ S.edit = null; S.reply = {id:mid, jmeno:m.jmeno || nameOf(m.od), text:m.text || ""}; renderBar(); const ta = $("chText"); if (ta) ta.focus(); }
    else if (act === "fwd") openFwd(mid);
    else if (act === "copy"){ try { await navigator.clipboard.writeText(m.text); } catch(_){ prompt("Zkopíruj text:", m.text); } }
    else if (act === "pin"){ tref().set({pinned: pinned ? FV().delete() : {id:mid, text:(m.text || "📷 Fotka").slice(0, 140), jmeno:m.jmeno || nameOf(m.od)}}, {merge:true}).catch(() => {}); }
    else if (act === "edit"){ S.reply = null; S.edit = mid; renderBar(); const ta = $("chText"); if (ta){ ta.value = m.text; grow(ta); ta.focus(); } }
    else if (act === "del"){
      const ids = (S.groupOf && S.groupOf[mid]) || [mid];
      if (!confirm(ids.length > 1 ? `Smazat všech ${ids.length} ${ids.length < 5 ? "fotky" : "fotek"}?` : "Smazat tuto zprávu?")) return;
      ids.forEach(id => tref().collection("zpravy").doc(id).update({smazano:true, text:"", image:FV().delete(), upraveno:FV().serverTimestamp()}).catch(() => {}));
    }
  });
  document.body.appendChild(s);
}
/* ---------- přeposlání zprávy (u fotek celé skupiny) do jiného vlákna ---------- */
function fwdTargets(){
  const out = [], seen = new Set();
  const hl = Object.entries(S.threads).filter(([id, t]) => t.typ === "hlidka" && id !== S.tid && ["brzy", "probiha", "skoncila"].includes(hState(t)))
    .sort((a, b) => ms(a[1].start) - ms(b[1].start));
  hl.forEach(([id, t]) => out.push({sec:"Hlídky", id, title:hTitle(t), sub:hTimes(t)}));
  if (S.tid !== "vsichni") out.push({sec:"Společné", id:"vsichni", title:"Zpráva všem", av:avHTML("vsichni", "VŠ", "all")});
  const dms = Object.entries(S.threads).filter(([, t]) => t.typ === "dm").sort((a, b) => ms(b[1].posledni && b[1].posledni.at) - ms(a[1].posledni && a[1].posledni.at));
  dms.forEach(([id, t]) => { seen.add(id); if (id !== S.tid){ const pc = id.split("_").slice(1).find(c => c !== String(O.me)) || String(O.me); out.push({sec:"Soukromé zprávy", id, title:titleOf(id, t), av:avHTML(pc, initials(titleOf(id, t)))}); } });
  Object.entries(officers()).filter(([, c]) => String(c) !== String(O.me) && allowedNo(c)).sort((a, b) => a[0].localeCompare(b[0], "cs"))
    .forEach(([n, c]) => { const id = dmId(O.me, c); if (!seen.has(id) && id !== S.tid) out.push({sec:"Soukromé zprávy", id, title:n, av:avHTML(String(c), initials(n))}); });
  return out;
}
function openFwd(mid){
  const list = fwdTargets(); closeSheet();
  const s = document.createElement("div"); s.className = "ch-sheet";
  let html = "", sec = "";
  list.forEach(x => { if (x.sec !== sec){ html += `<div class="ch-fs">${x.sec}</div>`; sec = x.sec; }
    html += `<button type="button" class="ch-act" data-chf="${esc(x.id)}">${x.av || ic(ICO.fwd)}<span>${esc(x.title)}${x.sub ? `<small>${esc(x.sub)}</small>` : ""}</span></button>`; });
  s.innerHTML = `<div role="dialog" aria-label="Přeposlat zprávu"><h3>Přeposlat do…</h3><div class="ch-fl">${html || `<p class="ch-empty">Není kam přeposlat.</p>`}</div>
    <button type="button" class="ch-act" data-chf="">${ic(ICO.close)}Zrušit</button></div>`;
  s.addEventListener("click", e => {
    if (e.target === s){ closeSheet(); return; }
    const b = e.target.closest("[data-chf]"); if (!b) return;
    closeSheet(); if (b.dataset.chf) forward(mid, b.dataset.chf, b.querySelector(":scope > span:last-child").firstChild.textContent);
  });
  document.body.appendChild(s);
}
async function forward(mid, tid, title){
  const ids = (S.groupOf && S.groupOf[mid]) || [mid];
  const list = ids.map(msgById).filter(x => x && !x.smazano && (x.text || x.image));
  if (!list.length) return;
  const gid = list.length > 1 ? Date.now().toString(36) + Math.random().toString(36).slice(2, 6) : null;
  try {
    for (const x of list){
      const data = {text:x.text || "", preposlano:{jmeno:(x.preposlano && x.preposlano.jmeno) || x.jmeno || nameOf(x.od)}};
      if (x.image) data.image = x.image;
      if (gid){ data.skupina = gid; data.skupinaN = list.length; }
      await writeMsg(data, tid);
    }
    toast(`Přeposláno – ${title}`, "Otevřít", () => CH.openThread(tid));
  } catch (e){ toast(e.code === "permission-denied" ? "Přeposlání zamítnuto pravidly." : "Přeposlání se nepovedlo."); }
}
function toast(text, act, fn){
  const old = document.querySelector(".ch-toast"); if (old) old.remove();
  const t = document.createElement("button"); t.type = "button"; t.className = "ch-toast";
  t.innerHTML = `<span>${esc(text)}</span>${act ? `<u>${esc(act)}</u>` : ""}`;
  t.addEventListener("click", () => { t.remove(); if (fn) fn(); });
  document.body.appendChild(t); setTimeout(() => t.remove(), 4000);
}

/* ---------- uložení fotky do telefonu ---------- */
function saveImage(dataUrl, k){
  const d = new Date(now()), p = n => String(n).padStart(2, "0");
  const name = `sluzby-foto-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-${k + 1}.jpg`;
  let file = null;
  try {
    const [head, b64] = dataUrl.split(","), mime = (head.match(/data:([^;]+)/) || [])[1] || "image/jpeg";
    const bin = atob(b64), arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    file = new File([arr], name, {type:mime});
  } catch(e){}
  // iPhone: systémová nabídka sdílení → „Uložit obrázek“ (fotka jde do Fotek); jinde se fotka stáhne
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (ios && file && navigator.canShare && navigator.canShare({files:[file]})){
    navigator.share({files:[file]}).catch(() => {}); return;
  }
  const a = document.createElement("a"); a.href = file ? URL.createObjectURL(file) : dataUrl; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  if (file) setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast("Fotka uložena do Stažených souborů");
}
function goTo(mid){
  const el = document.querySelector(`.ch-m[data-mid="${CSS.escape(mid)}"]`); if (!el) return;
  el.scrollIntoView({block:"center", behavior:"smooth"}); el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1600);
}

/* ---------- prohlížeč fotek (listování šipkami nebo přejetím prstem) ---------- */
function openGallery(list, i){
  if (!list.length) return;
  const old = document.querySelector(".ch-view"); if (old) old.remove();
  const v = document.createElement("div"); v.className = "ch-view"; v.setAttribute("role", "dialog"); v.setAttribute("aria-label", "Fotky");
  let k = i;
  const draw = () => {
    v.innerHTML = `<img src="${list[k]}" alt="Fotka ${k + 1} z ${list.length}">
      <button type="button" class="ch-vx" data-v="x" aria-label="Zavřít">${ic(ICO.close, 24)}</button>
      ${list.length > 1 ? `<button type="button" class="ch-vb l" data-v="-1" aria-label="Předchozí fotka" ${k === 0 ? "disabled" : ""}>${ic('<path d="M15 5l-7 7 7 7"/>', 26)}</button>
      <button type="button" class="ch-vb r" data-v="1" aria-label="Další fotka" ${k === list.length - 1 ? "disabled" : ""}>${ic('<path d="M9 5l7 7-7 7"/>', 26)}</button>
      <span class="ch-vn">${k + 1} / ${list.length}</span>` : ""}
      <button type="button" class="ch-vs" data-v="save">${ic(ICO.save, 20)}Uložit</button>`;
  };
  const go = d => { const n = k + d; if (n < 0 || n >= list.length) return; k = n; z = 1; tx = 0; ty = 0; draw(); };
  v.addEventListener("click", e => {
    const b = e.target.closest("[data-v]");
    if (b){ if (b.dataset.v === "x") close(); else if (b.dataset.v === "save") saveImage(list[k], k); else go(+b.dataset.v); return; }
    if (e.target === v && Date.now() - lastTouch > 700) close();
  });
  /* zvětšování jen fotky (dva prsty, dvojklik/dvojí ťuknutí, kolečko myši) – stránka se nezvětšuje */
  let z = 1, tx = 0, ty = 0, pinch = null, pan = null, sw = null, lastTap = 0, moved = false, lastTouch = 0;
  const img = () => v.querySelector("img");
  const clamp = () => {
    const el = img(); if (!el) return; if (z <= 1.01){ z = 1; tx = 0; ty = 0; return; }
    const mx = Math.max(0, (el.offsetWidth * z - v.clientWidth) / 2), my = Math.max(0, (el.offsetHeight * z - v.clientHeight) / 2);
    tx = Math.min(mx, Math.max(-mx, tx)); ty = Math.min(my, Math.max(-my, ty));
  };
  const apply = anim => { const el = img(); if (!el) return; el.style.transition = anim ? "transform .2s ease" : "none"; el.style.transform = `translate(${tx}px,${ty}px) scale(${z})`; };
  const zoomAt = (nz, cx, cy) => { // přiblížení kolem bodu (cx, cy) na obrazovce
    const el = img(); if (!el) return; nz = Math.min(5, Math.max(1, nz));
    const r = v.getBoundingClientRect(), ox = cx - r.left - r.width / 2, oy = cy - r.top - r.height / 2;
    tx = ox - (ox - tx) * nz / z; ty = oy - (oy - ty) * nz / z; z = nz; clamp();
  };
  const reset = () => { z = 1; tx = 0; ty = 0; };
  const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const mid = t => [(t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2];
  v.addEventListener("touchstart", e => {
    lastTouch = Date.now();
    if (e.target.closest("[data-v]")) return;
    e.preventDefault(); moved = false;
    if (e.touches.length === 2){ pinch = {d:dist(e.touches), z, m:mid(e.touches), tx, ty}; pan = null; sw = null; return; }
    const t = e.touches[0];
    if (z > 1) pan = {x:t.clientX, y:t.clientY, tx, ty}; else sw = {x:t.clientX, y:t.clientY};
  }, {passive:false});
  v.addEventListener("touchmove", e => {
    if (e.target.closest("[data-v]")) return;
    e.preventDefault();
    if (pinch && e.touches.length === 2){
      moved = true; const m = mid(e.touches);
      z = pinch.z; tx = pinch.tx + (m[0] - pinch.m[0]); ty = pinch.ty + (m[1] - pinch.m[1]);
      zoomAt(pinch.z * dist(e.touches) / pinch.d, m[0], m[1]); apply(false); return;
    }
    const t = e.touches[0];
    if (pan){ moved = true; tx = pan.tx + t.clientX - pan.x; ty = pan.ty + t.clientY - pan.y; clamp(); apply(false); }
    else if (sw && Math.hypot(t.clientX - sw.x, t.clientY - sw.y) > 10) moved = true;
  }, {passive:false});
  v.addEventListener("touchend", e => {
    if (e.target.closest("[data-v]")) return;
    if (pinch){ if (e.touches.length < 2){ pinch = null; clamp(); apply(true); if (e.touches.length === 1 && z > 1){ const t = e.touches[0]; pan = {x:t.clientX, y:t.clientY, tx, ty}; } } return; }
    if (e.touches.length) return;
    const t = e.changedTouches[0];
    if (sw && moved){ const dx = t.clientX - sw.x, dy = t.clientY - sw.y;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
      else if (dy > 90 && Math.abs(dy) > Math.abs(dx)) close(); // přejetí dolů zavře
    }
    if (!moved){ // ťuknutí: dvojí ťuknutí přiblíží / oddálí, ťuknutí vedle fotky zavře
      const now = Date.now();
      if (now - lastTap < 300){ lastTap = 0; if (z > 1) reset(); else zoomAt(2.5, t.clientX, t.clientY); apply(true); }
      else { lastTap = now; const onImg = e.target === img(); setTimeout(() => { if (lastTap === now && !onImg && z === 1) close(); }, 300); }
    }
    pan = null; sw = null;
  });
  v.addEventListener("dblclick", e => { if (e.target.closest("[data-v]")) return; if (z > 1) reset(); else zoomAt(2.5, e.clientX, e.clientY); apply(true); });
  v.addEventListener("wheel", e => { e.preventDefault(); zoomAt(z * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY); apply(false); }, {passive:false});
  let md = null; // posun přiblížené fotky myší
  v.addEventListener("mousedown", e => { if (z > 1 && e.target === img()){ e.preventDefault(); md = {x:e.clientX, y:e.clientY, tx, ty}; } });
  const mm = e => { if (!md) return; tx = md.tx + e.clientX - md.x; ty = md.ty + e.clientY - md.y; clamp(); apply(false); }, mu = () => { md = null; };
  window.addEventListener("mousemove", mm); window.addEventListener("mouseup", mu);
  ["gesturestart", "gesturechange"].forEach(ev => v.addEventListener(ev, e => e.preventDefault())); // iOS: nezvětšovat stránku
  const key = e => { if (e.key === "ArrowLeft") go(-1); else if (e.key === "ArrowRight") go(1); };
  function close(){ v.remove(); document.removeEventListener("keydown", key); window.removeEventListener("mousemove", mm); window.removeEventListener("mouseup", mu); }
  document.addEventListener("keydown", key);
  draw(); document.body.appendChild(v);
}

/* ---------- události ---------- */
let lpT = null, lpFired = false, lpXY = null;
function bind(root){
  root.addEventListener("click", e => {
    if (lpFired){ lpFired = false; e.preventDefault(); e.stopPropagation(); return; }
    const c = x => e.target.closest(x);
    if (c("[data-chclose]")){ CH.close(); return; }
    if (c("[data-chback]")){ backToList(); return; }
    if (c("[data-chback-list]")){ S.archive = false; S.pick = false; renderList(); return; }
    if (c("[data-charch]")){ S.archive = true; renderList(); $("chList").scrollTop = 0; return; }
    if (c("[data-chnew]")){ S.pick = true; renderList(); return; }
    const dm = c("[data-chdm]"); if (dm){ S.pick = false; CH.openThread(dmId(O.me, dm.dataset.chdm)); return; }
    const th = c("[data-cht]"); if (th){ CH.openThread(th.dataset.cht); return; }
    const sb = c("[data-chsend]"); if (sb){ if (sb.dataset.tt){ delete sb.dataset.tt; return; } send(); return; }
    if (c("[data-chphoto]")){ const f = $("chFile"); if (f) f.click(); return; }
    if (c("[data-chcancel]")){ if (S.edit){ const ta = $("chText"); if (ta){ ta.value = ""; grow(ta); } } S.edit = null; S.reply = null; renderBar(); return; }
    if (c("[data-chmute]")){ const t = thread(S.tid); tref().set({muted:{[O.me]:!isMuted(t)}}, {merge:true}).catch(() => {}); return; }
    if (c("[data-chunpin]")){ tref().set({pinned:FV().delete()}, {merge:true}).catch(() => {}); return; }
    if (c("[data-chsearch]")){ S.searchOn = !S.searchOn; if (!S.searchOn) S.search = ""; renderHead(); renderMsgs(false); return; }
    const go = c("[data-chgo]"); if (go){ goTo(go.dataset.chgo); return; }
    const rx = c("[data-chrx]"); if (rx){ toggleRx(rx.dataset.mid, rx.dataset.chrx); return; }
    const mo = c("[data-chmore]"); if (mo){ openSheet(mo.dataset.chmore); return; }
    const own = c(".ch-m.mine .ch-bub"); if (own && !c("[data-chgal],a,.ch-q,.ch-rx")){ const mid = own.closest(".ch-m").dataset.mid; S.infoMid = S.infoMid === mid ? null : mid; renderMsgs(false); return; }
    const gl = c("[data-chgal]"); if (gl){ openGallery(S.gal[gl.dataset.chgal] || [], +gl.dataset.i || 0); return; }
  });
  // tlačítko odeslat nesmí vzít poli pro psaní fokus – jinak první klepnutí na iPhonu jen schová klávesnici
  // a okno se posune, takže se zpráva odešle až napodruhé; takhle zůstane klávesnice otevřená a odešle se hned
  ["pointerdown","mousedown","touchstart"].forEach(t => root.addEventListener(t, e => {
    if (e.target.closest("[data-chsend]") && document.activeElement && document.activeElement.id === "chText"){
      e.preventDefault();
      if (t === "touchstart"){ const sb = e.target.closest("[data-chsend]"); sb.dataset.tt = "1"; setTimeout(() => { delete sb.dataset.tt; }, 700); send(); }
    }
  }, {passive:false}));
  // dlouhé podržení zprávy = nabídka (mobil), pravé tlačítko = nabídka (počítač)
  root.addEventListener("pointerdown", e => {
    const m = e.target.closest(".ch-m[data-mid]"); if (!m || e.target.closest("button:not([data-chgal]),a")) return;
    lpFired = false; lpXY = [e.clientX, e.clientY];
    lpT = setTimeout(() => { lpFired = true; lpT = null; if (navigator.vibrate) navigator.vibrate(12); openSheet(m.dataset.mid); }, 480);
  });
  root.addEventListener("pointermove", e => { if (lpT && lpXY && Math.hypot(e.clientX - lpXY[0], e.clientY - lpXY[1]) > 10){ clearTimeout(lpT); lpT = null; } });
  ["pointerup","pointercancel","pointerleave"].forEach(t => root.addEventListener(t, () => { if (lpT){ clearTimeout(lpT); lpT = null; } }));
  root.addEventListener("contextmenu", e => { if (e.target.closest("textarea,input")) return; e.preventDefault(); const m = e.target.closest(".ch-m[data-mid]"); if (m && !lpFired) openSheet(m.dataset.mid); });
  root.addEventListener("selectstart", e => { if (!e.target.closest || !e.target.closest("textarea,input")) e.preventDefault(); });
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape" || !S || !S.open) return;
    if (document.querySelector(".ch-view")){ document.querySelector(".ch-view").remove(); return; }
    if (document.querySelector(".ch-sheet")){ closeSheet(); return; }
    if (S.edit || S.reply){ S.edit = null; S.reply = null; renderBar(); return; }
    if (S.view === "thread" && !S.two){ backToList(); return; }
    CH.close();
  });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") markSeen(); beat(); });
  // administrace (HTML vkládá stránka, kliky se chytají tady)
  document.addEventListener("change", e => {
    const t = e.target.closest("[data-chadm-t]"); if (!t || !O || !O.isAdmin) return;
    const c = String(t.dataset.chadmT), list = testeri().filter(x => x !== c);
    if (t.checked) list.push(c);
    O.db.collection("nastaveni").doc("chat").set({testeri:list}, {merge:true}).catch(() => alert("Uložení zamítnuto pravidly Firestore."));
  });
  document.addEventListener("click", e => {
    const fx = e.target.closest("[data-chfx]");
    if (fx && O && O.isAdmin){
      if (!confirm("Odebrat fotku?")) return;
      O.db.collection("nastaveni").doc("chatFoto").set({fotky:{[fx.dataset.chfx]:FV().delete()}}, {merge:true}).catch(() => alert("Uložení zamítnuto pravidly Firestore."));
      return;
    }
    const fp = e.target.closest("[data-chfp]");
    if (fp && O && O.isAdmin){
      const key = fp.dataset.chfp, inp = document.createElement("input");
      inp.type = "file"; inp.accept = "image/*";
      inp.onchange = () => { const f = inp.files && inp.files[0]; if (!f) return;
        avatarFrom(f).then(url => O.db.collection("nastaveni").doc("chatFoto").set({fotky:{[key]:url}}, {merge:true}))
          .catch(err => alert(err && err.code === "permission-denied" ? "Uložení zamítnuto pravidly Firestore." : "Fotku se nepodařilo načíst.")); };
      inp.click(); return;
    }
    const b = e.target.closest("[data-chadm]"); if (!b || !O || !O.isAdmin) return;
    const v = b.dataset.chadm;
    if (v === "vsem" && !confirm("Spustit chat pro všechny strážníky?")) return;
    O.db.collection("nastaveni").doc("chat").set({vsem: v === "vsem"}, {merge:true}).catch(() => alert("Uložení zamítnuto pravidly Firestore."));
  });
}

/* ---------- administrace ---------- */
function avatarFrom(file){ // čtvercový výřez ze středu, 160 × 160 px JPEG (~10 kB)
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const side = Math.min(img.width, img.height), N = 160, c = document.createElement("canvas"); c.width = c.height = N;
      // u portrétů je obličej spíš v horní části – výřez se bere z horní třetiny
      const sx = (img.width - side) / 2, sy = img.height > img.width ? Math.min((img.height - side) / 3, img.height - side) : 0;
      const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, N, N); g.drawImage(img, sx, sy, side, side, 0, 0, N, N);
      res(c.toDataURL("image/jpeg", .82));
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("fotka")); };
    img.src = url;
  });
}
CH.adminHTML = function(){
  if (!O || !O.isAdmin) return "";
  if (S.set === undefined) return `<section class="ch-adm"><h3>Chat</h3><p>Načítám nastavení…</p></section>`;
  if (!S.set) return `<section class="ch-adm"><h3>Chat</h3><p>Nastavení chatu ještě není vytvořené (vytvoří se samo po načtení seznamu strážníků). Pokud se nevytvoří, chybí pravidla pro <code>nastaveni</code> ve Firestore.</p></section>`;
  const t = testeri(), list = Object.entries(officers()).sort((a, b) => a[0].localeCompare(b[0], "cs"));
  return `<section class="ch-adm"><h3>Chat</h3>
    <p>Stav: <b>${S.set.vsem ? "spuštěno pro všechny" : "testovací provoz – jen testeři"}</b></p>
    ${S.set.vsem ? `<button type="button" class="ch-ab sec" data-chadm="test">Vrátit jen testerům</button>` : `<button type="button" class="ch-ab" data-chadm="vsem">Spustit pro všechny</button>`}
    <p style="margin-top:12px">Testeři${S.set.vsem ? " (při spuštění pro všechny nehrají roli)" : ""}:</p>
    <div class="ch-tg">${list.map(([n, c]) => `<label><input type="checkbox" data-chadm-t="${esc(c)}" ${t.includes(String(c)) ? "checked" : ""}> ${esc(n)}</label>`).join("")}</div></section>
    <section class="ch-adm"><h3>Fotky v chatu</h3>
    <p>Klepni na kroužek a vyber fotku – ořízne se na čtverec a zmenší. Kdo fotku nemá, zůstanou mu iniciály.</p>
    <div class="ch-fg">${[["Zpráva všem", "vsichni"], ...list].map(([n, c]) => { const k = String(c), has = S.fotky && S.fotky[k];
      return `<div>${has ? `<span class="ch-av img" data-chfp="${esc(k)}" role="button" style="background-image:url('${has}')"></span><button type="button" class="ch-fx" data-chfx="${esc(k)}" aria-label="Odebrat fotku">✕</button>` : `<span class="ch-av${k === "vsichni" ? " all" : ""}" data-chfp="${esc(k)}" role="button">${esc(k === "vsichni" ? "VŠ" : initials(n))}</span>`}${esc(n)}</div>`; }).join("")}</div></section>`;
};

window.SluzbyChat = CH;
})();
