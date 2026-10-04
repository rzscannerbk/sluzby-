/* Plán služeb MP Blansko – notifikace
   - výměny služeb (nová žádost, přijetí, odmítnutí, nabídky, zrušení)
   - připomínka před službou (každou hodinu se zkontroluje, komu co začíná)
   - nový nebo upravený plán */
const { onDocumentCreated, onDocumentUpdated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions, logger } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp();
setGlobalOptions({ region: "europe-west1", maxInstances: 5 });
const db = admin.firestore();

const BASE_URL = "https://rzscannerbk.github.io/sluzby-/";
const ICON = BASE_URL + "icon-192.png";
const TZ = "Europe/Prague";
const MONTHS = ["leden","únor","březen","duben","květen","červen","červenec","srpen","září","říjen","listopad","prosinec"];
const MONTHS_GEN = ["leden","únor","březen","duben","květen","červen","červenec","srpen","září","říjen","listopad","prosinec"];
const DOW = ["ne","po","út","st","čt","pá","so"];
const KIND = { D: "denní", N: "noční" };
const CODES = { D12: [7, 19], N12: [19, 7], N13: [19, 8], Nz7: [19, 24] };
const kindOf = c => { c = String(c).replace(/\*$/, ""); return c === "D12" ? "D" : (c === "N12" || c === "N13" || c === "Nz7") ? "N" : null; };
const surname = n => String(n || "").split(" ")[0];

/* ---------- odesílání ---------- */
async function tokensFor(filter) {
  const snap = await db.collection("pushTokens").get();
  return snap.docs.filter(d => filter(d.data())).map(d => d.id);
}
async function send(tokens, title, body, link = BASE_URL) {
  tokens = [...new Set(tokens)].filter(Boolean);
  if (!tokens.length) return;
  for (let i = 0; i < tokens.length; i += 500) {
    const chunk = tokens.slice(i, i + 500);
    const res = await admin.messaging().sendEachForMulticast({
      tokens: chunk,
      webpush: { notification: { title, body, icon: ICON, badge: ICON }, fcmOptions: { link } }
    });
    // neplatné tokeny (odinstalováno, odhlášeno) uklidit
    const dead = [];
    res.responses.forEach((r, k) => {
      const code = r.error && r.error.code;
      if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token" || code === "messaging/invalid-argument") dead.push(chunk[k]);
    });
    await Promise.all(dead.map(t => db.collection("pushTokens").doc(t).delete().catch(() => {})));
    logger.info(`Odesláno ${res.successCount}/${chunk.length}: ${title}`);
  }
}
const toNumber = n => tokensFor(t => String(t.cislo) === String(n));

/* ---------- formátování ---------- */
function fmtShift(mesic, x) {
  const [y, m] = mesic.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, x.den));
  return `${DOW[d.getUTCDay()]} ${x.den}. ${m}. ${KIND[x.kind]}`;
}

/* ---------- 1) výměny služeb ---------- */
exports.vymenaNova = onDocumentCreated("vymeny/{id}", async ev => {
  const r = ev.data && ev.data.data(); if (!r) return;
  const co = fmtShift(r.mesic, r.od);
  // změna provedená správcem – platí hned, oznámit oběma strážníkům
  if (r.admin && r.stav === "prijato") {
    const t = [...await toNumber(r.odCislo), ...await toNumber(r.zaCislo)];
    const body = r.typ === "vymena"
      ? `Výměna služeb: ${r.od.jmeno} (${co}) ⇄ ${r.za.jmeno} (${fmtShift(r.mesic, r.za)}).`
      : `Služba ${co} převedena: ${r.od.jmeno} → ${r.za.jmeno}.`;
    return send(t, "Změna administrátorem", body + (r.pozn ? ` „${r.pozn}“` : ""));
  }
  if (r.stav !== "ceka") return;
  if (r.typ === "nabidka") {
    const t = await tokensFor(x => String(x.cislo) !== String(r.odCislo));
    return send(t, "Nabídka služby", `${r.od.jmeno} nabízí službu ${co}.${r.pozn ? " „" + r.pozn + "“" : ""}`);
  }
  const body = r.typ === "vymena"
    ? `${r.od.jmeno} chce vyměnit svou ${co} za tvoji ${fmtShift(r.mesic, r.za)}.`
    : `${r.od.jmeno} tě žádá o převzetí služby ${co}.`;
  return send(await toNumber(r.zaCislo), r.typ === "vymena" ? "Žádost o výměnu služby" : "Žádost o převzetí služby", body + (r.pozn ? ` „${r.pozn}“` : ""));
});

exports.vymenaZmena = onDocumentUpdated("vymeny/{id}", async ev => {
  const a = ev.data.before.data(), b = ev.data.after.data();
  if (!a || !b || a.stav === b.stav) return;
  const co = fmtShift(b.mesic, b.od);
  const kdo = b.za && b.za.jmeno;
  if (a.stav === "ceka" && b.stav === "prijato") {
    const title = b.typ === "nabidka" ? "Nabídka přijata" : "Žádost přijata";
    const body = b.typ === "nabidka" ? `${kdo} vzal tvoji službu ${co}.` : `${kdo} přijal tvoji žádost – služba ${co}.`;
    return send(await toNumber(b.odCislo), title, body);
  }
  if (a.stav === "ceka" && b.stav === "odmitnuto") {
    return send(await toNumber(b.odCislo), "Žádost odmítnuta", `${kdo} odmítl tvoji žádost – služba ${co}.`);
  }
  if (a.stav === "ceka" && b.stav === "zruseno" && b.zaCislo) {
    return send(await toNumber(b.zaCislo), "Žádost zrušena", `${b.od.jmeno} zrušil žádost – služba ${co}.`);
  }
  if (a.stav === "prijato" && b.stav === "zruseno") {
    const t = [...await toNumber(b.odCislo), ...(b.zaCislo ? await toNumber(b.zaCislo) : [])];
    return send(t, "Výměna zrušena správcem", `Výměna služby ${co} (${surname(b.od.jmeno)} → ${surname(kdo)}) byla zrušena. Platí původní plán.`);
  }
});

/* ---------- 2) nový nebo upravený plán ---------- */
exports.planZmena = onDocumentWritten("planSluzeb/{id}", async ev => {
  const id = ev.params.id; if (!/^\d{4}-\d{2}$/.test(id)) return;
  const a = ev.data.before.exists ? ev.data.before.data() : null;
  const b = ev.data.after.exists ? ev.data.after.data() : null;
  if (!b) return;
  if (a && JSON.stringify(a.plan) === JSON.stringify(b.plan) && JSON.stringify(a.udalosti || {}) === JSON.stringify(b.udalosti || {})) return;
  const [y, m] = id.split("-").map(Number);
  const nazev = `${MONTHS[m - 1]} ${y}`;
  const cisla = ((await db.collection("planSluzeb").doc("straznici").get()).data() || {}).cisla || {};
  const jmenoPodleCisla = Object.fromEntries(Object.entries(cisla).map(([n, c]) => [String(c), n]));
  const snap = await db.collection("pushTokens").get();
  const moje = [], ostatni = [];
  snap.docs.forEach(d => {
    const t = d.data(); if (t.plan === false) return;
    const jm = jmenoPodleCisla[String(t.cislo)];
    const zmena = a && jm && (a.plan || {})[jm] !== (b.plan || {})[jm];
    (zmena ? moje : ostatni).push(d.id);
  });
  if (!a) return send([...moje, ...ostatni], "Nový plán služeb", `Je nahraný plán na ${nazev}.`);
  await send(moje, "Změna ve tvých službách", `V plánu na ${nazev} se změnil tvůj rozpis.`);
  await send(ostatni, "Plán služeb upraven", `Plán na ${nazev} byl upraven.`);
});

/* ---------- 3) připomínka před službou ---------- */
function pragueNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24 };
}
function addDays({ y, m, d }, n) {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
const monthId = ({ y, m }) => `${y}-${String(m).padStart(2, "0")}`;
// efektivní plán měsíce = plán + přijaté výměny (stejně jako ve stránce)
async function effectivePlan(id) {
  const p = await db.collection("planSluzeb").doc(id).get(); if (!p.exists) return null;
  const T = {}; for (const [n, s] of Object.entries(p.data().plan || {})) T[n] = String(s).trim().split(/\s+/);
  const sw = await db.collection("vymeny").where("mesic", "==", id).where("stav", "==", "prijato").get();
  const ts = x => (x && x.toMillis) ? x.toMillis() : 0;
  const move = (from, to, den, kind) => {
    const arr = T[from]; if (!arr) return;
    const parts = (arr[den - 1] || ".") === "." ? [] : arr[den - 1].split("+");
    const i = parts.findIndex(x => kindOf(x) === kind); if (i < 0) return;
    const part = parts.splice(i, 1)[0]; arr[den - 1] = parts.length ? parts.join("+") : ".";
    if (!T[to]) T[to] = Array(31).fill(".");
    const t = T[to][den - 1] || "."; T[to][den - 1] = t === "." ? part : t + "+" + part;
  };
  sw.docs.map(d => d.data()).sort((a, b) => ts(a.vyrizeno) - ts(b.vyrizeno)).forEach(r => {
    if (!r.za || !r.za.jmeno) return;
    move(r.od.jmeno, r.za.jmeno, r.od.den, r.od.kind);
    if (r.typ === "vymena" && r.za.den) move(r.za.jmeno, r.od.jmeno, r.za.den, r.za.kind);
  });
  return T;
}
// služby (D/N), které daný den začínají v hodině startHour (nebo kdykoli, když null)
function shiftsOn(T, day, startHour) {
  const out = [];
  for (const [name, arr] of Object.entries(T || {})) {
    (arr[day.d - 1] || ".").split("+").forEach(p => {
      const c = p.replace(/\*$/, ""), k = kindOf(c); if (!k || !CODES[c]) return;
      if (startHour !== null && CODES[c][0] !== startHour) return;
      out.push({ name, kind: k, code: c, stala: p.endsWith("*") });
    });
  }
  return out;
}
const casy = c => `${CODES[c][0]}:00–${CODES[c][1] === 24 ? "24" : CODES[c][1]}:00`;

exports.pripominka = onSchedule({ schedule: "0 * * * *", timeZone: TZ }, async () => {
  const now = pragueNow();
  const tokens = (await db.collection("pushTokens").get()).docs.map(d => ({ id: d.id, ...d.data() })).filter(t => t.pripominka && t.pripominka !== "off");
  if (!tokens.length) return;
  const cisla = ((await db.collection("planSluzeb").doc("straznici").get()).data() || {}).cisla || {};
  const jmenoPodleCisla = Object.fromEntries(Object.entries(cisla).map(([n, c]) => [String(c), n]));
  const cache = {};
  const plan = async day => { const id = monthId(day); if (!(id in cache)) cache[id] = await effectivePlan(id); return cache[id]; };
  const jobs = [];

  // den předem v 18:00 – služby, které začínají zítra
  if (now.h === 18) {
    const tom = addDays(now, 1);
    const list = shiftsOn(await plan(tom), tom, null);
    for (const s of list) {
      const t = tokens.filter(x => x.pripominka === "18" && jmenoPodleCisla[String(x.cislo)] === s.name).map(x => x.id);
      const dd = new Date(Date.UTC(tom.y, tom.m - 1, tom.d));
      jobs.push(send(t, "Zítra máš službu", `${DOW[dd.getUTCDay()]} ${tom.d}. ${tom.m}. ${KIND[s.kind]} služba ${casy(s.code)}${s.stala ? " – stálá služba" : ""}.`));
    }
  }
  // 2 hodiny před začátkem
  if (now.h + 2 < 24) {
    const list = shiftsOn(await plan(now), now, now.h + 2);
    for (const s of list) {
      const t = tokens.filter(x => x.pripominka === "2h" && jmenoPodleCisla[String(x.cislo)] === s.name).map(x => x.id);
      jobs.push(send(t, "Za 2 hodiny začíná služba", `Tvoje ${KIND[s.kind]} služba ${casy(s.code)}${s.stala ? " – stálá služba" : ""}.`));
    }
  }
  await Promise.all(jobs);
});
