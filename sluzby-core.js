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
// 4. pád pro štítek výměny „za …“ (za Hlaváčka, za Pavla Tótha…)
const ZA_TVAR = {
  "Hlaváček Michal":"Hlaváčka", "Šenk Kamil":"Šenka", "Tóth Pavel":"Pavla Tótha", "Sehnal Petr":"Sehnala",
  "Přikryl Miroslav":"Přikryla", "Tóth Ondřej":"Ondřeje Tótha", "Menšík Jaroslav":"Menšíka", "Liška Michal":"Lišku",
  "Havel Radek":"Havla", "Vašíček Zdeněk":"Vašíčka", "Grénar Martin":"Grénara", "Chalupa Martin":"Chalupu",
  "Tesař Libor":"Tesaře", "Adámek Jaroslav":"Adámka", "Hofman Radek":"Hofmana", "Parolek Antonín":"Parolka",
  "Juračka Lukáš":"Juračku", "Škvařil Libor":"Škvařila"
};
function zaTvar(n){
  if (ZA_TVAR[n]) return ZA_TVAR[n];
  const s = surname(n);                                   // náhradní pravidlo pro jména mimo seznam
  if (/ek$/.test(s)) return s.slice(0, -2) + "ka";        // Dvořáček → Dvořáčka
  if (/a$/.test(s)) return s.slice(0, -1) + "u";          // Svoboda → Svobodu
  if (/[bcčdďfghjklmnňpqrřsštťvwxzž]$/i.test(s)) return s + "a"; // Novák → Nováka
  return s;
}

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
    if (moveShift(T, r.od.jmeno, r.za.jmeno, r.od.den, r.od.kind, len)) notes[`${r.od.den}|${r.od.kind}|${r.za.jmeno}`] = `za ${zaTvar(r.od.jmeno)}`;
    if (r.typ === "vymena" && r.za.den && moveShift(T, r.za.jmeno, r.od.jmeno, r.za.den, r.za.kind, len)) notes[`${r.za.den}|${r.za.kind}|${r.od.jmeno}`] = `za ${zaTvar(r.za.jmeno)}`;
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

/* =================== přítomnost uživatelů (online/{služební číslo}) ===================
   Každá verze si při otevření a pak každé 2 minuty (jen když je na obrazovce) zapíše,
   kdy byla aktivní. Čte jen administrátor (pravidla Firestore). */
const ONLINE_COL = "online";
const ONLINE_MS = 3 * 60 * 1000;      // „právě online“ = aktivita za poslední 3 minuty
function devicePlatform(){
  const ua = navigator.userAgent;
  if (/iPhone|iPod/.test(ua)) return "iPhone";
  if (/iPad/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return "Windows";
  if (/Mac/.test(ua)) return "Mac";
  return "jiné";
}
function presenceStart(opts){
  // opts: {db, firebase, cislo, email, jmeno:() => string, typ:"mobil"|"desktop", verze}
  const ref = opts.db.collection(ONLINE_COL).doc(String(opts.cislo)), FV = opts.firebase.firestore.FieldValue;
  const standalone = !!(navigator.standalone || (window.matchMedia && matchMedia("(display-mode: standalone)").matches));
  let last = 0;
  const beat = force => {
    if (!force && (document.hidden || Date.now() - last < 60e3)) return;
    last = Date.now();
    const jm = opts.jmeno() || "";
    ref.set({
      ...(jm ? {jmeno:jm} : {}), email:opts.email, prihlasen:true, posledni:FV.serverTimestamp(),
      zarizeni:{[opts.typ]:{posledni:FV.serverTimestamp(), verze:opts.verze, platforma:devicePlatform(), naPlose:standalone}}
    }, {merge:true}).catch(() => {});
  };
  beat(true);
  const t = setInterval(() => beat(false), 120e3);
  const vis = () => beat(true); // při odchodu i návratu zapsat čas aktivity
  document.addEventListener("visibilitychange", vis);
  return {
    beat:() => beat(true),
    stop(){ clearInterval(t); document.removeEventListener("visibilitychange", vis); },
    async logout(){ clearInterval(t); document.removeEventListener("visibilitychange", vis);
      try { await ref.set({prihlasen:false, odhlasen:FV.serverTimestamp()}, {merge:true}); } catch (e){} }
  };
}
function fmtSeen(ms, now){
  if (!ms) return "";
  const d = new Date(ms), diff = now - ms, hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (diff < ONLINE_MS) return "teď";
  if (diff < 60 * 60e3) return `před ${Math.max(1, Math.round(diff / 60e3))} min`;
  const t0 = new Date(now); t0.setHours(0, 0, 0, 0);
  if (ms >= t0.getTime()) return `dnes ${hm}`;
  if (ms >= t0.getTime() - 864e5) return `včera ${hm}`;
  return `${d.getDate()}. ${d.getMonth() + 1}.${d.getFullYear() !== new Date(now).getFullYear() ? " " + d.getFullYear() : ""} ${hm}`;
}
function presenceHTML(officers, online, now, verze){
  // officers: {jméno: číslo}, online: {číslo: data}, verze: {mobil:"v4.43", desktop:"v1.1"}
  const ms = x => (x && x.toMillis) ? x.toMillis() : 0;
  const rows = Object.keys(officers).sort((a, b) => a.localeCompare(b, "cs")).map(name => {
    const o = online[String(officers[name])] || null, last = o ? ms(o.posledni) : 0;
    const on = !!o && o.prihlasen !== false && now - last < ONLINE_MS;
    const t0 = new Date(now); t0.setHours(0, 0, 0, 0);
    const st = !o ? "nikdy" : on ? "online" : o.prihlasen === false ? "odhlasen" : (last >= t0.getTime() ? "dnes" : "davno");
    const dev = o && o.zarizeni ? Object.entries(o.zarizeni).map(([typ, z]) => ({typ, ...z, ms:ms(z.posledni)})).sort((a, b) => b.ms - a.ms) : [];
    return {name, st, last, dev, on};
  });
  // aktuální verze = nejvyšší, kterou někdo má (zvlášť pro mobil a desktop); starší jsou červeně
  const vnum = v => String(v || "").replace(/[^0-9.]/g, "").split(".").map(Number);
  const newer = (a, b) => { const x = vnum(a), y = vnum(b); for (let i = 0; i < Math.max(x.length, y.length); i++){ if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
  const top = {...(verze || {})};
  rows.forEach(r => r.dev.forEach(z => { if (z.verze && (!top[z.typ] || newer(z.verze, top[z.typ]))) top[z.typ] = z.verze; }));
  verze = top;
  const cnt = k => rows.filter(r => r.st === k).length;
  const logged = rows.filter(r => r.st !== "nikdy" && r.st !== "odhlasen").length;
  const LBL = {online:"online", dnes:"aktivní dnes", davno:"přihlášen", odhlasen:"odhlášen", nikdy:"zatím bez záznamu"};
  const sorted = rows.slice().sort((a, b) => (b.on - a.on) || (b.last - a.last) || a.name.localeCompare(b.name, "cs"));
  return `<div class="pres-sum">
      <div><b class="pres-on">${cnt("online")}</b><span>právě online</span></div>
      <div><b>${logged}</b><span>přihlášeno z ${rows.length}</span></div>
      <div><b>${cnt("nikdy")}</b><span>bez záznamu</span></div>
    </div>
    <div class="pres-list">${sorted.map(r => `<div class="pres-row">
      <span class="pres-dot ${r.st}" aria-hidden="true"></span>
      <div class="pres-main"><b>${esc(r.name)}</b><span>${LBL[r.st]}${r.last && !r.on ? " · " + fmtSeen(r.last, now) : ""}</span></div>
      <div class="pres-dev">${r.dev.map(z => `<span class="${verze[z.typ] && z.verze && newer(verze[z.typ], z.verze) ? "old" : ""}" title="${esc(z.typ)} ${esc(z.verze || "")}">${z.typ === "desktop" ? "počítač" : "mobil"} · ${esc(z.platforma || "")}${z.typ === "mobil" && z.naPlose === false ? " (prohlížeč)" : ""} · ${esc(z.verze || "?")} · ${fmtSeen(z.ms, now)}</span>`).join("") || "<span>–</span>"}</div>
    </div>`).join("")}</div>
    <p class="pres-note">Online = aktivita za poslední 3 minuty. Údaje se sbírají od verze, která přítomnost zapisuje – kdo si ji ještě neotevřel, je „bez záznamu“. Červeně = stará verze aplikace.</p>`;
}
const PRES_CSS = `.pres-sum{display:flex;gap:10px;flex-wrap:wrap;margin:6px 0 14px}
.pres-sum div{flex:1 1 100px;border-radius:12px;padding:10px 12px;background:rgba(127,140,170,.12);display:flex;flex-direction:column}
.pres-sum b{font-size:28px;line-height:1.1}.pres-sum .pres-on{color:#2E9E5B}.pres-sum span{font-size:13px;opacity:.8}
.pres-list{display:flex;flex-direction:column}
.pres-row{display:flex;align-items:center;gap:10px;padding:9px 2px;border-bottom:1px solid rgba(127,140,170,.25);flex-wrap:wrap}
.pres-dot{width:12px;height:12px;border-radius:50%;flex:none;background:#C3C8D2}
.pres-dot.online{background:#2E9E5B;box-shadow:0 0 0 3px rgba(46,158,91,.25)}.pres-dot.dnes{background:#E3B341}.pres-dot.davno{background:#8C96B2}.pres-dot.odhlasen{background:transparent;border:2px solid #8C96B2}.pres-dot.nikdy{background:transparent;border:2px dashed #C3C8D2}
.pres-main{flex:1 1 160px;display:flex;flex-direction:column;line-height:1.3}.pres-main span{font-size:13px;opacity:.8}
.pres-dev{flex:2 1 220px;display:flex;flex-direction:column;font-size:13px;opacity:.85;line-height:1.35}.pres-dev .old{color:#C0392B;font-weight:600}
.pres-note{font-size:12px;opacity:.75;margin:10px 0 0}`;
