/* Plán služeb MP Blansko – notifikace
   - výměny služeb (nová žádost, přijetí, odmítnutí, nabídky, zrušení)
   - připomínka před službou (každou hodinu se zkontroluje, komu co začíná)
   - nový nebo upravený plán
   - chat: vlákna hlídek podle plánu a notifikace o nových zprávách */
const { onDocumentCreated, onDocumentUpdated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions, logger } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp();
setGlobalOptions({ region: "europe-west1", maxInstances: 5 });
const db = admin.firestore();

const BASE_URL = "https://rzscannerbk.github.io/sluzby-/";
const ICON = BASE_URL + "icon-192.png";
const VYM = BASE_URL + "?open=vymeny"; // klepnutí na notifikaci o výměně otevře okno výměn
const BADGE = BASE_URL + "badge-96.png"; // jednobarevná ikona do horní lišty Androidu
const TZ = "Europe/Prague";
const MONTHS = ["leden","únor","březen","duben","květen","červen","červenec","srpen","září","říjen","listopad","prosinec"];
const MONTHS_GEN = ["leden","únor","březen","duben","květen","červen","červenec","srpen","září","říjen","listopad","prosinec"];
const DOW = ["ne","po","út","st","čt","pá","so"];
const KIND = { D: "denní", N: "noční" };
const CODES = { D12: [7, 19], D8: [10, 18], N12: [19, 7], N13: [19, 8], Nz7: [19, 24] };
const kindOf = c => { c = String(c).replace(/\*$/, ""); return (c === "D12" || c === "D8") ? "D" : (c === "N12" || c === "N13" || c === "Nz7") ? "N" : null; };
const surname = n => String(n || "").split(" ")[0];

/* ---------- odesílání ---------- */
async function tokensFor(filter) {
  const snap = await db.collection("pushTokens").get();
  return snap.docs.filter(d => filter(d.data())).map(d => d.id);
}
async function send(tokens, title, body, link = BASE_URL, tag = null) {
  tokens = [...new Set(tokens)].filter(Boolean);
  if (!tokens.length) return;
  for (let i = 0; i < tokens.length; i += 500) {
    const chunk = tokens.slice(i, i + 500);
    const res = await admin.messaging().sendEachForMulticast({
      tokens: chunk,
      webpush: { notification: { title, body, icon: ICON, badge: BADGE, ...(tag ? { tag, renotify: true } : {}) }, fcmOptions: { link } }
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
const SPRAVCI = ["1048"]; // služební čísla správců – dostávají žádosti o přesun služby ke schválení
exports.vymenaNova = onDocumentCreated("vymeny/{id}", async ev => {
  const r = ev.data && ev.data.data(); if (!r) return;
  const co = fmtShift(r.mesic, r.od);
  // změna provedená správcem – platí hned, oznámit oběma strážníkům
  if (r.admin && r.stav === "prijato") {
    const t = [...await toNumber(r.odCislo), ...await toNumber(r.zaCislo)];
    const body = r.typ === "vymena"
      ? `Výměna služeb: ${r.od.jmeno} (${co}) ⇄ ${r.za.jmeno} (${fmtShift(r.mesic, r.za)}).`
      : `Služba ${co} převedena: ${r.od.jmeno} → ${r.za.jmeno}.`;
    return send(t, "Změna administrátorem", body + (r.pozn ? ` „${r.pozn}“` : ""), VYM);
  }
  if (r.stav !== "ceka") return;
  if (r.typ === "presun") { // přesun schvaluje správce
    const t = (await Promise.all(SPRAVCI.map(c => toNumber(c)))).flat();
    return send(t, "Žádost o přesun služby", `${r.od.jmeno} chce přesunout službu ${co} na ${fmtShift(r.mesic, r.za)} (${r.za.kod}).${r.pozn ? " „" + r.pozn + "“" : ""}`, VYM);
  }
  if (r.typ === "nabidka") {
    const t = await tokensFor(x => String(x.cislo) !== String(r.odCislo));
    return send(t, "Nabídka služby", `${r.od.jmeno} nabízí službu ${co}.${r.pozn ? " „" + r.pozn + "“" : ""}`, VYM);
  }
  const pp = t => { const [den, kind, kod] = String(t).split("|"); return { den: +den, kind, kod }; };
  const body = r.typ === "vymena" && r.moznosti && !r.za.den
    ? `${r.od.jmeno} chce vyměnit svou ${co} za jednu z tvých služeb: ${r.moznosti.map(t => fmtShift(r.mesic, pp(t))).join(", ")}. Vyber si v přehledu výměn.`
    : r.typ === "vymena"
    ? `${r.od.jmeno} chce vyměnit svou ${co} za tvoji ${fmtShift(r.mesic, r.za)}.`
    : `${r.od.jmeno} tě žádá o převzetí služby ${co}.`;
  const skup = Array.isArray(r.skupina) && r.skupina.length > 1 ? " Žádost dostali i další kolegové – platí, kdo přijme první." : "";
  return send(await toNumber(r.zaCislo), r.typ === "vymena" ? "Žádost o výměnu služby" : "Žádost o převzetí služby", body + (r.pozn ? ` „${r.pozn}“` : "") + skup, VYM);
});

exports.vymenaZmena = onDocumentUpdated("vymeny/{id}", async ev => {
  const a = ev.data.before.data(), b = ev.data.after.data();
  if (!a || !b || a.stav === b.stav) return;
  const co = fmtShift(b.mesic, b.od);
  const kdo = b.za && b.za.jmeno;
  const parseProp = t => { const [den, kind, kod] = String(t).split("|"); return { den: +den, kind, kod }; };
  if (b.typ === "presun") {
    const kam = b.za && b.za.den ? fmtShift(b.mesic, b.za) : "";
    if (a.stav === "ceka" && b.stav === "prijato") return send(await toNumber(b.odCislo), "Přesun schválen", `Přesun služby ${co} na ${kam} je schválený.`, VYM);
    if (a.stav === "ceka" && b.stav === "odmitnuto") return send(await toNumber(b.odCislo), "Přesun zamítnut", `Správce zamítl přesun služby ${co} na ${kam}.`, VYM);
    if (a.stav === "prijato" && b.stav === "zruseno") return send(await toNumber(b.odCislo), "Přesun zrušen správcem", `Přesun služby ${co} na ${kam} byl zrušen. Platí původní plán.`, VYM);
    return;
  }
  // žádost poslaná víc kolegům: po přijetí ostatní zrušit
  if (b.stav === "prijato" && a.stav !== "prijato" && Array.isArray(b.skupina)) {
    await Promise.all(b.skupina.filter(id => id !== ev.params.id).map(async id => {
      const ref = db.collection("vymeny").doc(id);
      await db.runTransaction(async tx => {
        const s = await tx.get(ref);
        if (s.exists && ["ceka", "navrh"].includes(s.data().stav))
          tx.update(ref, { stav: "zruseno", duvod: "jinde", vyrizeno: admin.firestore.FieldValue.serverTimestamp() });
      });
    })).catch(e => logger.error("rušení skupiny", e));
  }
  if (b.stav === "zruseno" && b.duvod === "jinde") {
    return send(await toNumber(b.zaCislo), "Žádost už neplatí", `Výměnu služby ${co} (${b.od.jmeno}) už vzal jiný kolega.`, VYM);
  }
  if (a.stav === "ceka" && b.stav === "navrh") {
    const co2 = (b.navrhy || []).map(t => fmtShift(b.mesic, parseProp(t))).join(", ");
    return send(await toNumber(b.odCislo), "Návrh jiné služby", `${kdo} místo ${b.typ === "vymena" ? (a.za && a.za.den ? "služby " + fmtShift(b.mesic, a.za) : "tebou nabízených variant") : "služby " + co} nabízí: ${co2}. Vyber si v přehledu výměn.`, VYM);
  }
  if (a.stav === "navrh" && b.stav === "prijato") {
    return send(await toNumber(b.zaCislo), "Návrh přijat", `${b.od.jmeno} si vybral tvoji ${fmtShift(b.mesic, b.za)} – výměna za jeho ${co} je provedena.`, VYM);
  }
  if (a.stav === "navrh" && b.stav === "odmitnuto") {
    return send(await toNumber(b.zaCislo), "Návrh odmítnut", `${b.od.jmeno} odmítl tvoje návrhy ke službě ${co}.`, VYM);
  }
  if (a.stav === "navrh" && b.stav === "zruseno") {
    return send(await toNumber(b.zaCislo), "Žádost zrušena", `${b.od.jmeno} zrušil žádost – služba ${co}.`, VYM);
  }
  if (a.stav === "ceka" && b.stav === "prijato") {
    const title = b.typ === "nabidka" ? "Nabídka přijata" : "Žádost přijata";
    const body = b.typ === "nabidka" ? `${kdo} vzal tvoji službu ${co}.`
      : b.moznosti && b.za && b.za.den ? `${kdo} přijal výměnu – za tvoji ${co} ti dá svou ${fmtShift(b.mesic, b.za)}.`
      : `${kdo} přijal tvoji žádost – služba ${co}.`;
    return send(await toNumber(b.odCislo), title, body, VYM);
  }
  if (a.stav === "ceka" && b.stav === "odmitnuto") {
    return send(await toNumber(b.odCislo), "Žádost odmítnuta", `${kdo} odmítl tvoji žádost – služba ${co}.`, VYM);
  }
  if (a.stav === "ceka" && b.stav === "zruseno" && b.zaCislo) {
    return send(await toNumber(b.zaCislo), "Žádost zrušena", `${b.od.jmeno} zrušil žádost – služba ${co}.`, VYM);
  }
  if (a.stav === "prijato" && b.stav === "zruseno") {
    const t = [...await toNumber(b.odCislo), ...(b.zaCislo ? await toNumber(b.zaCislo) : [])];
    return send(t, "Výměna zrušena správcem", `Výměna služby ${co} (${surname(b.od.jmeno)} → ${surname(kdo)}) byla zrušena. Platí původní plán.`, VYM);
  }
});

/* ---------- 2) nový nebo upravený plán ---------- */
exports.planZmena = onDocumentWritten("planSluzeb/{id}", async ev => {
  const id = ev.params.id; if (!/^\d{4}-\d{2}$/.test(id)) return;
  const a = ev.data.before.exists ? ev.data.before.data() : null;
  const b = ev.data.after.exists ? ev.data.after.data() : null;
  if (!b) return;
  await syncHlidky().catch(e => logger.error("syncHlidky", e)); // vlákna hlídek v chatu podle nového plánu
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
    if (r.typ === "presun") { // přesun vlastní služby na jiný den: z od.den pryč, na za.den standardní D12 / N12
      const arr = T[r.od.jmeno]; if (!arr || !r.za || !r.za.den) return;
      const parts = (arr[r.od.den - 1] || ".") === "." ? [] : arr[r.od.den - 1].split("+");
      const i = parts.findIndex(x => kindOf(x) === r.od.kind); if (i < 0) return;
      parts.splice(i, 1); arr[r.od.den - 1] = parts.length ? parts.join("+") : ".";
      const t = arr[r.za.den - 1] || "."; arr[r.za.den - 1] = t === "." ? r.za.kod : t + "+" + r.za.kod;
      return;
    }
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


/* ---------- 4) kalendář služeb k odběru (.ics) ---------- */
const ICS = { D12: [7, 19, 0], D8: [10, 18, 0], N12: [19, 7, 1], N13: [19, 8, 1], Nz7: [19, 24, 0], D2: [8, 10, 0] };
const icsEsc = t => String(t).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
function icsFold(line) {
  const out = []; let cur = "";
  for (const ch of line) { if (cur.length >= 70) { out.push(cur); cur = " "; } cur += ch; }
  out.push(cur); return out.join("\r\n");
}
function icsTime(y, m, d, h) { // m od 1, přetečení dní a hodin ošetří Date.UTC
  const t = new Date(Date.UTC(y, m - 1, d, h));
  const p = n => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}T${p(t.getUTCHours())}0000`;
}
exports.kalendar = onRequest({ invoker: "public" }, async (req, res) => {
  const k = String(req.query.k || "");
  if (!/^[A-Za-z0-9]{20,64}$/.test(k)) { res.status(404).send("Nenalezeno"); return; }
  const t = await db.collection("kalendare").doc(k).get();
  if (!t.exists) { res.status(404).send("Nenalezeno"); return; }
  const cislo = String(t.data().cislo);
  const cisla = ((await db.collection("planSluzeb").doc("straznici").get()).data() || {}).cisla || {};
  const me = Object.keys(cisla).find(n => String(cisla[n]) === cislo);
  if (!me) { res.status(404).send("Nenalezeno"); return; }

  const now = pragueNow();
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//MP Blansko//Plan sluzeb//CS", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:Služby MP Blansko", "X-WR-TIMEZONE:Europe/Prague", "REFRESH-INTERVAL;VALUE=DURATION:PT6H", "X-PUBLISHED-TTL:PT6H",
    "BEGIN:VTIMEZONE", "TZID:Europe/Prague",
    "BEGIN:DAYLIGHT", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "TZNAME:CEST", "DTSTART:19700329T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU", "END:DAYLIGHT",
    "BEGIN:STANDARD", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "TZNAME:CET", "DTSTART:19701025T030000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "END:STANDARD",
    "END:VTIMEZONE"];

  for (let off = -1; off <= 2; off++) {
    const base = new Date(Date.UTC(now.y, now.m - 1 + off, 1));
    const y = base.getUTCFullYear(), m = base.getUTCMonth() + 1;
    const T = await effectivePlan(`${y}-${String(m).padStart(2, "0")}`);
    if (!T || !T[me]) continue;
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    for (let d = 1; d <= days; d++) {
      const parts = (T[me][d - 1] || ".") === "." ? [] : T[me][d - 1].split("+");
      for (const part of parts) {
        const code = part.replace(/\*$/, ""), sp = ICS[code]; if (!sp) continue;
        const stala = part.endsWith("*");
        let title, desc;
        if (code === "D2") {
          const ucast = Object.keys(T).filter(n => (T[n][d - 1] || "").split("+").includes("D2"));
          title = "Porada"; desc = `Porada MP\nÚčastníci: ${ucast.join(", ")}`;
        } else {
          const k2 = kindOf(code);
          let st = null; const hl = [];
          for (const [n, arr] of Object.entries(T)) {
            (arr[d - 1] || ".").split("+").forEach(p => { if (kindOf(p) === k2) { if (p.endsWith("*")) st = n; else hl.push(n); } });
          }
          hl.sort((a, b) => a.localeCompare(b, "cs"));
          title = (k2 === "N" ? "Noc" : "Den") + (stala ? " - stálá" : "");
          desc = `Stálá služba: ${st || "–"}\nHlídka: ${hl.join(", ")}`;
        }
        L.push("BEGIN:VEVENT",
          `UID:${y}${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}-${code}-${cislo}@sluzby-mp-blansko`,
          `DTSTAMP:${stamp}`,
          `DTSTART;TZID=Europe/Prague:${icsTime(y, m, d, sp[0])}`,
          `DTEND;TZID=Europe/Prague:${icsTime(y, m, d + sp[2], sp[1])}`,
          icsFold(`SUMMARY:${icsEsc(title)}`),
          icsFold(`DESCRIPTION:${icsEsc(desc)}`),
          "END:VEVENT");
      }
    }
  }
  L.push("END:VCALENDAR");
  res.set("Content-Type", "text/calendar; charset=utf-8");
  res.set("Content-Disposition", 'inline; filename="sluzby.ics"');
  res.set("Cache-Control", "no-cache, max-age=0");
  res.send(L.join("\r\n") + "\r\n");
});


/* ---------- 5) chat – vlákna hlídek a notifikace o zprávách ---------- */
// Vlákno hlídky h_RRRR-MM-DD_D|N: členy určuje efektivní plán (plán + přijaté výměny).
// Objeví se den před službou, v chatu zůstává do konce další stejné služby, pak jde do archivu.
// Po skončení služby se členové už nemění – archiv vidí jen ti, kdo službu skutečně odsloužili.
const CHAT_URL = BASE_URL + "?open=chat&t=";
const HOUR = 36e5;
function pragueParts(t) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(new Date(t)).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute };
}
function pragueTime(y, m, d, h) { // pražský čas → UTC milisekundy (ošetří letní čas)
  const want = Date.UTC(y, m - 1, d, h);
  let t = want;
  for (let i = 0; i < 3; i++) { const p = pragueParts(t); t += want - Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi); }
  return t;
}
const dayId = ({ y, m, d }) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
async function chatSet() { const s = await db.collection("nastaveni").doc("chat").get(); return s.exists ? s.data() : null; }
const chatAllowed = (set, c) => !!set && (set.vsem === true || (set.testeri || []).map(String).includes(String(c)));

async function syncHlidky() {
  const set = await chatSet(); if (!set) return;
  const cisla = ((await db.collection("planSluzeb").doc("straznici").get()).data() || {}).cisla || {};
  const cache = {};
  const plan = async day => { const id = monthId(day); if (!(id in cache)) cache[id] = await effectivePlan(id); return cache[id]; };
  const today = pragueNow(), nowMs = Date.now(), TS = admin.firestore.Timestamp;
  for (const off of [-1, 0, 1]) {
    const day = addDays(today, off), next = addDays(day, 1);
    const T = (await plan(day)) || {}, Tn = (await plan(next)) || {};
    for (const kind of ["D", "N"]) {
      const memb = new Map(); // jméno → stálá služba
      const codes = []; // [kód, stálá] – podle nich se určí čas služby stejně jako na hlavní časové ose
      for (const [name, arr] of Object.entries(T)) {
        (arr[day.d - 1] || ".").split("+").forEach(p => { if (kindOf(p) === kind){ memb.set(name, !!memb.get(name) || p.endsWith("*")); codes.push([p.replace(/\*$/, ""), p.endsWith("*")]); } });
      }
      // čas služby: kód stálé služby, jinak nejčastější kód hlídky (D12 7–19, D8 10–18, N12 19–7, N13 19–8, Nz7 19–24)
      let base = (codes.find(([, st]) => st) || [])[0];
      if (!base) { const cnt = {}; codes.forEach(([c]) => cnt[c] = (cnt[c] || 0) + 1); base = (Object.entries(cnt).sort((a, b) => b[1] - a[1])[0] || [])[0]; }
      const [hs, he] = CODES[base] || (kind === "D" ? CODES.D12 : CODES.N12);
      const start = pragueTime(day.y, day.m, day.d, hs);
      const konec = he > hs ? (he === 24 ? pragueTime(next.y, next.m, next.d, 0) : pragueTime(day.y, day.m, day.d, he)) : pragueTime(next.y, next.m, next.d, he);
      if (nowMs >= konec) continue; // po skončení služby se členové už nemění
      if (kind === "N") { // konec noci (Nk8) zapsaný až v dalším dni patří k této noci
        for (const [name, arr] of Object.entries(Tn)) {
          (arr[next.d - 1] || ".").split("+").forEach(p => { if (p.replace(/\*$/, "") === "Nk8" && !memb.has(name)) memb.set(name, p.endsWith("*")); });
        }
      }
      const clenove = [...memb.keys()].map(n => cisla[n]).filter(Boolean).map(String).sort();
      const stala = [...memb.entries()].filter(([, s]) => s).map(([n]) => cisla[n]).filter(Boolean).map(String);
      const id = `h_${dayId(day)}_${kind}`, ref = db.collection("chaty").doc(id);
      const cur = await ref.get();
      if (!cur.exists && !clenove.some(c => chatAllowed(set, c))) continue; // při testu jen hlídky s testerem
      const old = cur.exists ? cur.data() : {};
      if (cur.exists && JSON.stringify(old.clenove || []) === JSON.stringify(clenove) && JSON.stringify(old.stala || []) === JSON.stringify(stala)
        && old.start && old.start.toMillis() === start && old.konec && old.konec.toMillis() === konec) continue;
      const dt = new Date(Date.UTC(day.y, day.m - 1, day.d));
      await ref.set({
        typ: "hlidka", datum: dayId(day), kind,
        nazev: `${kind === "N" ? "Noční" : "Denní"} ${DOW[dt.getUTCDay()]} ${day.d}. ${day.m}.`,
        clenove, stala,
        start: TS.fromMillis(start), konec: TS.fromMillis(konec),
        zobrazitOd: TS.fromMillis(start - 24 * HOUR), archivOd: TS.fromMillis(konec + 24 * HOUR)
      }, { merge: true });
      logger.info(`chat: vlákno ${id} – členové ${clenove.join(", ")}`);
    }
  }
}
// každou hodinu (zakládá vlákna na zítřek), po přijetí nebo zrušení výměny a po změně nastavení chatu
exports.hlidkyPlan = onSchedule({ schedule: "5 * * * *", timeZone: TZ }, () => syncHlidky());
exports.hlidkyVymena = onDocumentWritten("vymeny/{id}", async ev => {
  const a = ev.data.before.exists ? ev.data.before.data() : null;
  const b = ev.data.after.exists ? ev.data.after.data() : null;
  if (((a && a.stav) === "prijato") === ((b && b.stav) === "prijato")) return;
  await syncHlidky();
});
exports.chatNastaveni = onDocumentWritten("nastaveni/chat", () => syncHlidky());

// nová zpráva → notifikace ostatním členům vlákna (kromě autora a těch, kdo vlákno ztlumili)
exports.chatZprava = onDocumentCreated("chaty/{tid}/zpravy/{mid}", async ev => {
  const m = ev.data && ev.data.data(); if (!m) return;
  const tid = ev.params.tid;
  const [tSnap, set] = await Promise.all([db.collection("chaty").doc(tid).get(), chatSet()]);
  const t = tSnap.exists ? tSnap.data() : {};
  let to;
  if (t.typ === "vsichni") {
    const cisla = ((await db.collection("planSluzeb").doc("straznici").get()).data() || {}).cisla || {};
    to = Object.values(cisla).map(String);
  } else to = (t.clenove || []).map(String);
  const muted = t.muted || {};
  to = [...new Set(to)].filter(c => c !== String(m.od) && chatAllowed(set, c) && !muted[c]);
  if (!to.length) return;
  const tokens = await tokensFor(x => to.includes(String(x.cislo)) && x.chat !== false);
  const kdo = m.jmeno || "Kolega";
  const title = t.typ === "dm" ? kdo : t.typ === "vsichni" ? `Zpráva všem · ${surname(kdo)}` : `${t.nazev || "Hlídka"} · ${surname(kdo)}`;
  const body = m.image ? (m.text ? "📷 " + m.text : "📷 Fotka") : String(m.text || "").slice(0, 180);
  return send(tokens, title, body, CHAT_URL + encodeURIComponent(tid), "chat-" + tid);
});

// nová reakce (emoji) na zprávu → notifikace autorovi zprávy (pokud vlákno nemá ztlumené)
const REAKCE_EMO = { palec: "👍", srdce: "❤️", smich: "😂", wow: "😮", smutek: "😢", diky: "🙏" };
exports.chatReakce = onDocumentUpdated("chaty/{tid}/zpravy/{mid}", async ev => {
  const a = ev.data.before.data() || {}, b = ev.data.after.data() || {};
  if (b.smazano) return;
  const autor = String(b.od || "");
  const added = []; // [klíč, číslo] nově přidaných reakcí
  for (const [k, arr] of Object.entries(b.reakce || {})) {
    const old = ((a.reakce || {})[k] || []).map(String);
    (arr || []).map(String).forEach(c => { if (!old.includes(c) && c !== autor) added.push([k, c]); });
  }
  if (!added.length || !autor) return;
  const tid = ev.params.tid;
  const [tSnap, set, st] = await Promise.all([db.collection("chaty").doc(tid).get(), chatSet(), db.collection("planSluzeb").doc("straznici").get()]);
  const t = tSnap.exists ? tSnap.data() : {};
  if ((t.muted || {})[autor] || !chatAllowed(set, autor)) return;
  const cisla = (st.data() || {}).cisla || {};
  const jmeno = c => Object.keys(cisla).find(n => String(cisla[n]) === String(c)) || "Kolega";
  const kdo = [...new Set(added.map(([, c]) => surname(jmeno(c))))].join(", ");
  const emo = [...new Set(added.map(([k]) => REAKCE_EMO[k] || "👍"))].join(" ");
  const tokens = await tokensFor(x => String(x.cislo) === autor && x.chat !== false);
  const kde = t.typ === "dm" ? "" : t.typ === "vsichni" ? " · Zpráva všem" : ` · ${t.nazev || "Hlídka"}`;
  const co = b.image ? (b.text ? "📷 " + b.text : "📷 tvoji fotku") : `„${String(b.text || "").slice(0, 120)}“`;
  return send(tokens, `${kdo} ${emo}${kde}`, `Reagoval na ${co}`, CHAT_URL + encodeURIComponent(tid), "chat-" + tid);
});
