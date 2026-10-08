// Služby MP Blansko – společné jádro pro mobilní (index.html) i desktopovou (desktop.html) verzi.
// Jen čisté funkce a data bez práce se stránkou: kódy směn, plán po výměnách, kontroly výměn,
// dlouhodobý plán a výpočty volna. Při změně zvyš verzi v sw.js.
const COLLECTION = "planSluzeb";
const MONTHS = ["leden","únor","březen","duben","květen","červen","červenec","srpen","září","říjen","listopad","prosinec"];
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const CODES = {
  D12:{k:"D", s:[7,0],  e:[19,0]},
  D8: {k:"D", s:[10,0], e:[18,0]},
  N13:{k:"N", s:[19,0], e:[8,0]},
  N12:{k:"N", s:[19,0], e:[7,0]},
  Nz7:{k:"N", s:[19,0], e:[24,0]},
  Nk8:{k:"K", s:[0,0],  e:[8,0]},
  D2: {k:"P", s:[8,0],  e:[10,0]},
  DOV:{k:"A", label:"Dovolená"},
  ZdV:{k:"A", label:"Zdravotní volno"}
};
const DOW = ["ne","po","út","st","čt","pá","so"];
const DOW_FULL = ["neděle","pondělí","úterý","středa","čtvrtek","pátek","sobota"];
const DOW_T = ["Ne","Po","Út","St","Čt","Pá","So"];

const esc = s => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

const KIND_LBL = {D:"denní", N:"noční"};
const kindOf = c => { c = c.replace(/\*$/, ""); return (c === "D12" || c === "D8") ? "D" : (c === "N12" || c === "N13" || c === "Nz7") ? "N" : null; };
const surname = n => String(n).split(" ")[0];

/* --- efektivní plán = plán + přijaté výměny --- */
function tokensOf(plan){
  const T = {};
  for (const [n, s] of Object.entries(plan || {})) T[n] = String(s).trim().split(/\s+/);
  return T;
}
function moveShift(T, from, to, den, kind, len){
  const arr = T[from]; if (!arr) return false;
  const parts = (arr[den-1] || ".") === "." ? [] : arr[den-1].split("+");
  const i = parts.findIndex(p => kindOf(p) === kind); if (i < 0) return false;
  const part = parts.splice(i, 1)[0];
  arr[den-1] = parts.length ? parts.join("+") : ".";
  if (!T[to]) T[to] = Array(len).fill(".");
  const t = T[to][den-1] || ".";
  T[to][den-1] = t === "." ? part : t + "+" + part;
  return true;
}
const hasShift = (T, name, den, kind) => !!T[name] && (T[name][den-1] || ".").split("+").some(p => kindOf(p) === kind);
const tsMs = x => (x && x.toMillis) ? x.toMillis() : Date.now();
function applySwaps(plan, swaps, len){
  const T = tokensOf(plan), notes = {};
  swaps.filter(r => r.stav === "prijato").sort((a,b) => tsMs(a.vyrizeno) - tsMs(b.vyrizeno)).forEach(r => {
    if (!r.za || !r.za.jmeno) return;
    if (moveShift(T, r.od.jmeno, r.za.jmeno, r.od.den, r.od.kind, len)) notes[`${r.od.den}|${r.od.kind}|${r.za.jmeno}`] = `za ${surname(r.od.jmeno)}`;
    if (r.typ === "vymena" && r.za.den && moveShift(T, r.za.jmeno, r.od.jmeno, r.za.den, r.za.kind, len)) notes[`${r.za.den}|${r.za.kind}|${r.od.jmeno}`] = `za ${surname(r.za.jmeno)}`;
  });
  return {T, notes};
}

/* --- kontroly: kolize, odpočinek, dovolená --- */
const SPAN = {D12:[7,19,0], D8:[10,18,0], N12:[19,7,1], N13:[19,8,1], Nz7:[19,0,1], Nk8:[0,8,0]};
function intervals(T, name, y, m){
  const out = [];
  (T[name] || []).forEach((tok, i) => {
    if (tok === ".") return;
    tok.split("+").forEach(p => {
      const c = p.replace(/\*$/, ""), sp = SPAN[c]; if (!sp) return;
      const s = new Date(y, m, i+1, sp[0]), e = new Date(y, m, i+1 + sp[2], sp[1]);
      out.push({s, e, day:i+1, lbl:`${i+1}. ${c === "Nk8" ? "dojezd noci" : KIND_LBL[kindOf(c)]} (${c})`});
    });
  });
  return out.sort((a,b) => a.s - b.s);
}
function checkPerson(T, name, days, y, m, out, skipAbs){
  const tok = n => (T[name] && T[name][n-1]) || ".";
  if (!skipAbs) days.forEach(d => { if (/DOV|ZdV/.test(tok(d)) && tok(d).split("+").some(p => kindOf(p))) out.e.push(`${name} má ${d}. ${m+1}. ${/ZdV/.test(tok(d)) ? "zdravotní volno" : "dovolenou"}.`); });
  const iv = intervals(T, name, y, m);
  for (let k = 0; k < iv.length - 1; k++){
    const a = iv[k], b = iv[k+1];
    if (!days.has(a.day) && !days.has(b.day)) continue;
    // služby po sobě jsou povolené, překryv do 1 hodiny (noc N13 do 8:00 → denní od 7:00) se zanedbává
    if (a.e - b.s > 36e5){
      const hm = d => `${d.getHours()}:${String(d.getMinutes()).padStart(2,"0")}`;
      out.e.push(`${name}: ${a.lbl} končí v ${hm(a.e)}, ale ${b.lbl} začíná už v ${hm(b.s)}.`);
    }
  }
}
/* simulace žádosti nad stavem měsíce; accepter = kdo bere nabídku */
function simulate(T0, req, accepter, y, m){
  const len = new Date(y, m + 1, 0).getDate();
  const T = {}; for (const [n, a] of Object.entries(T0)) T[n] = a.slice();
  const out = {e:[], w:[], i:[]};
  if (!hasShift(T, req.od.jmeno, req.od.den, req.od.kind)) out.e.push(`${req.od.jmeno} už službu ${req.od.den}. ${m+1}. nemá – mohla být mezitím vyměněna.`);
  if (req.typ === "vymena" && !hasShift(T, req.za.jmeno, req.za.den, req.za.kind)) out.e.push(`${req.za.jmeno} už službu ${req.za.den}. ${m+1}. nemá – mohla být mezitím vyměněna.`);
  const recv = req.typ === "nabidka" ? accepter : req.za && req.za.jmeno;
  if (out.e.length || !recv) return out;
  if (recv === req.od.jmeno){ out.e.push("Nemůžeš převzít vlastní službu."); return out; }
  if (hasShift(T, recv, req.od.den, req.od.kind)) out.e.push(`${recv} už v té službě je.`);
  if (req.typ === "vymena" && hasShift(T, req.od.jmeno, req.za.den, req.za.kind)) out.e.push(`${req.od.jmeno} už ve službě ${req.za.den}. ${m+1}. je.`);
  if (out.e.length) return out;
  moveShift(T, req.od.jmeno, recv, req.od.den, req.od.kind, len);
  if (req.typ === "vymena") moveShift(T, req.za.jmeno, req.od.jmeno, req.za.den, req.za.kind, len);
  checkPerson(T, recv, new Set([req.od.den]), y, m, out);
  if (req.typ === "vymena") checkPerson(T, req.od.jmeno, new Set([req.za.den]), y, m, out, true);
  if (/\*$/.test(req.od.kod)) out.i.push(`${recv} převezme i stálou službu ${req.od.den}. ${m+1}.`);
  if (req.typ === "vymena" && /\*$/.test(req.za.kod)) out.i.push(`${req.od.jmeno} převezme i stálou službu ${req.za.den}. ${m+1}.`);
  return out;
}

const ymOf = id => { const [y, m] = id.split("-").map(Number); return [y, m - 1]; };

function fmtS(mesic, x){
  const [y, m] = ymOf(mesic), d = new Date(y, m, x.den);
  return `${DOW[d.getDay()]} ${x.den}. ${m+1}. ${KIND_LBL[x.kind]}${/\*$/.test(x.kod || "") ? " (stálá)" : ""}`;
}

const parseProp = t => { const [den, kind, kod] = String(t).split("|"); return {den:+den, kind, kod}; };

const docId = (y, m) => `${y}-${String(m+1).padStart(2,"0")}`;

const DLP = {2026:{"Hlaváček Michal":".DDN...DDN...DDN...DDN...DDN...|.DN....DN...DDN...DDN...DDN.|..DDN...DDN....DN...DDN...DDN..|.DDN...DDN...DDN...DDN....DN..|..DN...DDN...DDN...DDN...DDN...|DDN....DN...DDN...DDN...DDN...|DDN...DDN...DDN....DN....DN...D|DN...DDN...DDN...DDN...DDN....D|N...DDN...DDN...DDN...DDN...DD|N...DDN....DN....DN...DDN...DDN|...DDN...DDN...DDN....DN...DDN|...DDN.DDN...DDN....DN...DDN...","Sehnal Petr":"..DDN...DDN...DDN...DDN...DDN..|.DDN....DN....DN...DDN...DDN|...DDN...DDN...DDN....DN...DDN.|..DDN...DDN...DDN...DDN...DDN.|...DN....DN...DDN...DDN...DDN..|.DDN...DDN....DN...DDN...DDN..|.DDN...DDN...DDN...DDN....DN...|.DN...DDN...DDN...DDN...DDN...D|DN....DN...DDN...DDN...DDN...D|DN...DDN...DDN....DN....DN...DD|N...DDN...DDN...DDN...DDN....D|N...DDN...DDN.DDN...DDN....DN..","Tesař Libor":"N...DDN....DN...DDN...DDN...DDN|...DDN...DDN...DDN....DN....|DN...DDN...DDN...DDN...DDN...DD|N....DN...DDN...DDN...DDN...DD|N...DDN...DDN....DN....DN...DDN|...DDN...DDN...DDN...DDN....DN|...DDN...DDN...DDN...DDN...DDN.|..DDN....DN....DN...DDN...DDN..|.DDN...DDN...DDN....DN...DDN..|.DDN...DDN...DDN...DDN...DDN...|.DN....DN...DDN...DDN...DDN...|DDN...DDN....DN...DDN...DDN.DDN","Menšík Jaroslav":"DDN...DDN...DDN...DDN....DN...D|DN...DDN...DDN...DDN...DDN..|.DDN....DN....DN...DDN...DDN...|DDN...DDN...DDN....DN...DDN...|DDN...DDN...DDN...DDN...DDN....|DN....DN...DDN...DDN...DDN...D|DN...DDN....DN...DDN...DDN...DD|N...DDN...DDN...DDN....DN....DN|...DDN...DDN...DDN...DDN...DDN|....DN...DDN...DDN.DDN...DDN...|.DN...DDN...DDN...DDN...DDN...|DDN...DDN....DN....DN...DDN...D","Parolek Antonín":"....DN...DDN...DDN...DDN...DDN.|..DDN...DDN....DN....DN...DD|N...DDN...DDN...DDN...DDN....DN|...DDN...DDN...DDN...DDN...DDN|...DDN....DN....DN...DDN...DDN.|..DDN...DDN...DDN....DN...DDN.|..DDN...DDN...DDN...DDN...DDN..|..DN....DN...DDN...DDN...DDN...|DDN...DDN....DN...DDN...DDN...|DDN...DDN...DDN...DDN....DN....|DN...DDN...DDN...DDN...DDN...D|DN....DN...DDN...DDN.DDN...DDN.","Šenk Kamil":".DDN...DDN...DDN...DDN...DDN...|.DN....DN...DDN...DDN...DDN.|..DDN...DDN....DN...DDN...DDN..|.DDN...DDN...DDN...DDN....DN..|..DN...DDN...DDN...DDN...DDN...|DDN....DN...DDN...DDN...DDN...|DDN...DDN...DDN....DN....DN...D|DN...DDN...DDN...DDN...DDN....D|N...DDN...DDN...DDN...DDN...DD|N...DDN....DN....DN...DDN...DDN|...DDN...DDN...DDN....DN...DDN|...DDN.DDN...DDN....DN...DDN...","Tóth Pavel":".DDN...DDN...DDN...DDN...DDN...|.DN....DN...DDN...DDN...DDN.|..DDN...DDN....DN...DDN...DDN..|.DDN...DDN...DDN...DDN....DN..|..DN...DDN...DDN...DDN...DDN...|DDN....DN...DDN...DDN...DDN...|DDN...DDN...DDN....DN....DN...D|DN...DDN...DDN...DDN...DDN....D|N...DDN...DDN...DDN...DDN...DD|N...DDN....DN....DN...DDN...DDN|...DDN...DDN...DDN....DN...DDN|...DDN.DDN...DDN....DN...DDN...","Adámek Jaroslav":"N...DDN....DN...DDN...DDN...DDN|...DDN...DDN...DDN....DN....|DN...DDN...DDN...DDN...DDN...DD|N....DN...DDN...DDN...DDN...DD|N...DDN...DDN....DN....DN...DDN|...DDN...DDN...DDN...DDN....DN|...DDN...DDN...DDN...DDN...DDN.|..DDN....DN....DN...DDN...DDN..|.DDN...DDN...DDN....DN...DDN..|.DDN...DDN...DDN...DDN...DDN...|.DN....DN...DDN...DDN...DDN...|DDN...DDN....DN...DDN...DDN.DDN","Juračka Lukáš":"....DN...DDN...DDN...DDN...DDN.|..DDN...DDN....DN....DN...DD|N...DDN...DDN...DDN...DDN....DN|...DDN...DDN...DDN...DDN...DDN|...DDN....DN....DN...DDN...DDN.|..DDN...DDN...DDN....DN...DDN.|..DDN...DDN...DDN...DDN...DDN..|..DN....DN...DDN...DDN...DDN...|DDN...DDN....DN...DDN...DDN...|DDN...DDN...DDN...DDN....DN....|DN...DDN...DDN...DDN...DDN...D|DN....DN...DDN...DDN.DDN...DDN.","Vašíček Zdeněk":".DDN.DDN...DDN....DN...DDN...DD|N...DDN...DDN...DDN...DDN...|.DN....DN...DDN...DDN...DDN...D|DN...DDN....DN...DDN...DDN...D|DN...DDN...DDN...DDN....DN....D|N...DDN...DDN...DDN...DDN...DD|N....DN...DDN...DDN...DDN...DDN|...DDN...DDN....DN....DN...DDN.|..DDN...DDN...DDN...DDN....DN.|..DDN...DDN...DDN...DDN...DDN..|.DDN....DN....DN...DDN...DDN..|.DDN...DDN...DDN....DN...DDN...","Škvařil Libor":"....DN...DDN...DDN...DDN...DDN.|..DDN...DDN....DN....DN...DD|N...DDN...DDN...DDN...DDN....DN|...DDN...DDN...DDN...DDN...DDN|...DDN....DN....DN...DDN...DDN.|..DDN...DDN...DDN....DN...DDN.|..DDN...DDN...DDN...DDN...DDN..|..DN....DN...DDN...DDN...DDN...|DDN...DDN....DN...DDN...DDN...|DDN...DDN...DDN...DDN....DN....|DN...DDN...DDN...DDN...DDN...D|DN....DN...DDN...DDN.DDN...DDN.","Hofman Radek":"N...DDN....DN...DDN...DDN...DDN|...DDN...DDN...DDN....DN....|DN...DDN...DDN...DDN...DDN...DD|N....DN...DDN...DDN...DDN...DD|N...DDN...DDN....DN....DN...DDN|...DDN...DDN...DDN...DDN....DN|...DDN...DDN...DDN...DDN...DDN.|..DDN....DN....DN...DDN...DDN..|.DDN...DDN...DDN....DN...DDN..|.DDN...DDN...DDN...DDN...DDN...|.DN....DN...DDN...DDN...DDN...|DDN...DDN....DN...DDN...DDN.DDN","Grénar Martin":".DDN.DDN...DDN....DN...DDN...DD|N...DDN...DDN...DDN...DDN...|.DN....DN...DDN...DDN...DDN...D|DN...DDN....DN...DDN...DDN...D|DN...DDN...DDN...DDN....DN....D|N...DDN...DDN...DDN...DDN...DD|N....DN...DDN...DDN...DDN...DDN|...DDN...DDN....DN....DN...DDN.|..DDN...DDN...DDN...DDN....DN.|..DDN...DDN...DDN...DDN...DDN..|.DDN....DN....DN...DDN...DDN..|.DDN...DDN...DDN....DN...DDN...","Chalupa Martin":".DDN.DDN...DDN....DN...DDN...DD|N...DDN...DDN...DDN...DDN...|.DN....DN...DDN...DDN...DDN...D|DN...DDN....DN...DDN...DDN...D|DN...DDN...DDN...DDN....DN....D|N...DDN...DDN...DDN...DDN...DD|N....DN...DDN...DDN...DDN...DDN|...DDN...DDN....DN....DN...DDN.|..DDN...DDN...DDN...DDN....DN.|..DDN...DDN...DDN...DDN...DDN..|.DDN....DN....DN...DDN...DDN..|.DDN...DDN...DDN....DN...DDN...","Havel Radek":"DDN...DDN...DDN...DDN....DN...D|DN...DDN...DDN...DDN...DDN..|.DDN....DN....DN...DDN...DDN...|DDN...DDN...DDN....DN...DDN...|DDN...DDN...DDN...DDN...DDN....|DN....DN...DDN...DDN...DDN...D|DN...DDN....DN...DDN...DDN...DD|N...DDN...DDN...DDN....DN....DN|...DDN...DDN...DDN...DDN...DDN|....DN...DDN...DDN.DDN...DDN...|.DN...DDN...DDN...DDN...DDN...|DDN...DDN....DN....DN...DDN....","Přikryl Miroslav":"..DDN...DDN...DDN...DDN...DDN..|.DDN....DN....DN...DDN...DDN|...DDN...DDN...DDN....DN...DDN.|..DDN...DDN...DDN...DDN...DDN.|...DN....DN...DDN...DDN...DDN..|.DDN...DDN....DN...DDN...DDN..|.DDN...DDN...DDN...DDN....DN...|.DN...DDN...DDN...DDN...DDN...D|DN....DN...DDN...DDN...DDN...D|DN...DDN...DDN....DN....DN...DD|N...DDN...DDN...DDN...DDN....D|N...DDN...DDN.DDN...DDN....DN..","Liška Michal":"DDN...DDN...DDN...DDN....DN...D|DN...DDN...DDN...DDN...DDN..|.DDN....DN....DN...DDN...DDN...|DDN...DDN...DDN....DN...DDN...|DDN...DDN...DDN...DDN...DDN....|DN....DN...DDN...DDN...DDN...D|DN...DDN....DN...DDN...DDN...DD|N...DDN...DDN...DDN....DN....DN|...DDN...DDN...DDN...DDN...DDN|....DN...DDN...DDN.DDN...DDN...|.DN...DDN...DDN...DDN...DDN...|DDN...DDN....DN....DN...DDN...."}};

const DLP_H = 11.5;

const DLP_ANY = name => Object.values(DLP).some(r => r && r[name]);

const capM = m => MONTHS[m].charAt(0).toUpperCase() + MONTHS[m].slice(1);

const dkey = (y, m, d) => `${y}-${String(m+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;

const dparse = k => { const [y, m, d] = k.split("-").map(Number); return {y, m:m-1, d}; };

const dlpOf = (name, y, m) => { const r = DLP[y] && DLP[y][name]; return r ? (r.split("|")[m] || "") : null; };

function volLoad(data){
  if (Array.isArray(data.volnoPlany)) return data.volnoPlany.filter(e => e && Array.isArray(e.dny) && e.dny.length);
  // převod z první verze (dny po měsících)
  const old = data.volno || {}, out = [];
  Object.keys(old).sort().forEach(ym => { const [y, m] = ym.split("-").map(Number);
    const dny = (old[ym] || []).map(Number).sort((a, b) => a - b).map(d => dkey(y, m-1, d));
    if (dny.length) out.push({id:"v" + ym, dny}); });
  return out;
}

const dniTxt = n => n === 1 ? "den" : n >= 2 && n <= 4 ? "dny" : "dní";

function volGroups(dny){
  // souvislé úseky dnů → [{label, dny}], např. „9.–15. 11. 2026“, přes měsíc „28. 11.–5. 12. 2026“
  const ks = [...dny].sort(), out = []; let cur = null;
  const next = k => { const x = dparse(k), t = new Date(x.y, x.m, x.d + 1); return dkey(t.getFullYear(), t.getMonth(), t.getDate()); };
  ks.forEach(k => { if (cur && next(cur[cur.length - 1]) === k) cur.push(k); else { cur = [k]; out.push(cur); } });
  return out.map(g => { const x = dparse(g[0]), z = dparse(g[g.length - 1]);
    const label = g.length === 1 ? `${x.d}. ${x.m+1}. ${x.y}`
      : (x.m === z.m && x.y === z.y) ? `${x.d}.–${z.d}. ${x.m+1}. ${x.y}`
      : `${x.d}. ${x.m+1}.–${z.d}. ${z.m+1}. ${z.y}`;
    return {label, dny:g}; });
}

const volRanges = dny => volGroups(dny).map(g => g.label).join(", ");

// den volna se službou podle dlouhodobého plánu = dovolená, bez služby = volno
const volLine = st => { const sl = st.d + st.n, vo = st.dni - sl, out = [];
  if (sl) out.push(`dovolená ${sl} (denní ${st.d}, noční ${st.n}) = ${fmtH(st.h)}\u00a0h`);
  if (vo) out.push(`volno ${vo} ${dniTxt(vo)}`);
  const t = out.join(" · "); return t.charAt(0).toUpperCase() + t.slice(1); };

function fmtH(h){ return String(h).replace(".", ","); }

/* --- volno pro konkrétního strážníka (desktop i mobil) --- */
const dlpCodeFor = (name, k) => { const x = dparse(k), r = dlpOf(name, x.y, x.m) || ""; return r[x.d-1] || "."; };
function volStatsFor(name, dny){
  let d = 0, n = 0; dny.forEach(k => { const c = dlpCodeFor(name, k); if (c === "D") d++; else if (c === "N") n++; });
  return {dni:dny.length, d, n, h:(d + n) * DLP_H};
}
