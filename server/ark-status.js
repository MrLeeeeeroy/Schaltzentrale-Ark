// ─────────────────────────────────────────────────────────────────────────────
// ARK Status für die Schaltzentrale
// Fragt alle ASA-Server per RCON ab (online/offline + Spieler), dazu CPU, RAM,
// Datenträger, Pi-hole und – mit Shelly-Steckdose – den Stromverbrauch. Ergebnis als
// kleine JSON-Schnittstelle: http://127.0.0.1:8787/status
//
// Die Schnittstelle lauscht NUR auf diesem PC (127.0.0.1). Ins Internet kommt
// sie ausschließlich über Tailscale Funnel. Das RCON-Passwort verlässt den PC nie,
// und über die Schnittstelle kann niemand Befehle an die Server senden.
//
// Start zum Testen:  node ark-status.js
// Braucht keine zusätzlichen Pakete (nur Node.js) und eine config.json.
// ─────────────────────────────────────────────────────────────────────────────

const net = require('net');
const http = require('http');

// ===== Einstellungen ==========================================================
// Alle persönlichen Werte (IP, RCON-Passwort, Kartennamen) stehen in config.json
// neben dieser Datei. config.json gehört NICHT auf GitHub (siehe .gitignore).
const fs = require('fs');
const path = require('path');
const configPfad = path.join(__dirname, 'config.json');
if (!fs.existsSync(configPfad)) {
  console.error('config.json fehlt. Kopiere config.example.json zu config.json und trage deine Werte ein.');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPfad, 'utf8'));

const SERVER_IP = config.serverIp;
const RCON_PASSWORD = config.rconPasswort;
const HTTP_PORT = config.httpPort || 8787;                       // lokaler Port für Tailscale Funnel
const ABFRAGE_ALLE_SEKUNDEN = config.abfrageAlleSekunden || 300; // wie oft alle Server abgefragt werden
const ZEITLIMIT_MS = 4000;                                       // Wartezeit pro Server
const SPIELERNAMEN_ZEIGEN = config.spielernamenZeigen !== false; // false = nur Anzahl
const ERSTER_RCON_PORT = config.ersterRconPort || 27071;         // ASA01; ASA02 = +1 usw.
const ANZAHL_SERVER = config.anzahlServer || 20;
const KARTEN = config.karten || {};                              // { "1": "New Island", ... }
const LAUFWERK = (config.laufwerk || 'E:').replace(/\\$/, '');   // überwachter Datenträger
const SHELLY_IP = config.shellyIp || '';                         // leer = keine Strommessung
const STROMPREIS = config.strompreisProKwh || 0.2917;            // Euro pro kWh
const PIHOLE_URL = (config.piholeUrl || '').replace(/\/+$/, '');  // z. B. http://192.168.x.x – leer = aus
const PIHOLE_PASSWORT = config.piholePasswort || '';             // am besten ein App-Passwort
// ==============================================================================

const servers = Array.from({ length: ANZAHL_SERVER }, (_, i) => {
  const nr = i + 1;
  return {
    id: 'ASA' + String(nr).padStart(2, '0'),
    karte: KARTEN[nr] || KARTEN[String(nr)] || '',
    rconPort: ERSTER_RCON_PORT + i
  };
});

// ---------- RCON (Source-Protokoll) ----------
function paket(id, typ, text) {
  const body = Buffer.from(text, 'utf8');
  const groesse = 4 + 4 + body.length + 2;
  const buf = Buffer.alloc(4 + groesse);
  buf.writeInt32LE(groesse, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(typ, 8);
  body.copy(buf, 12);
  return buf;
}

function rconBefehl(host, port, passwort, befehl) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let puffer = Buffer.alloc(0);
    let verbunden = false;
    let angemeldet = false;
    let fertig = false;

    const ende = (ergebnis) => {
      if (fertig) return;
      fertig = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ergebnis);
    };
    const timer = setTimeout(() => ende({ online: verbunden, antwort: null }), ZEITLIMIT_MS);

    socket.on('connect', () => {
      verbunden = true;
      socket.write(paket(1, 3, passwort)); // Anmeldung
    });

    socket.on('data', (daten) => {
      puffer = Buffer.concat([puffer, daten]);
      while (puffer.length >= 4) {
        const groesse = puffer.readInt32LE(0);
        if (puffer.length < 4 + groesse) break;
        const id = puffer.readInt32LE(4);
        const typ = puffer.readInt32LE(8);
        const text = puffer.toString('utf8', 12, 4 + groesse - 2);
        puffer = puffer.subarray(4 + groesse);

        if (!angemeldet && typ === 2) {
          if (id === -1) return ende({ online: true, antwort: null }); // falsches Passwort
          angemeldet = true;
          socket.write(paket(2, 2, befehl));
        } else if (angemeldet && id === 2 && typ === 0) {
          return ende({ online: true, antwort: text });
        }
      }
    });

    socket.on('error', () => ende({ online: verbunden, antwort: null }));
    socket.on('close', () => ende({ online: verbunden, antwort: null }));
    socket.connect(port, host);
  });
}

// ARK-Antwort auf ListPlayers: "0. Spielername, 000264abc..." pro Zeile
function spielerAuslesen(antwort) {
  if (!antwort) return null;
  const namen = [];
  for (const zeile of antwort.split(/\r?\n/)) {
    const treffer = zeile.trim().match(/^\d+\.\s+(.+?),\s+[0-9a-f]+\s*$/i);
    if (treffer) namen.push(treffer[1]);
  }
  return namen;
}

// ---------- Root-Server: CPU, RAM, Datenträger, Laufzeit ----------
const os = require('os');
const { execFile } = require('child_process');

function cpuSumme() {
  let leer = 0, gesamt = 0;
  for (const c of os.cpus()) {
    for (const t of Object.values(c.times)) gesamt += t;
    leer += c.times.idle;
  }
  return { leer, gesamt };
}
let letzteCpu = cpuSumme();
// Durchschnittliche CPU-Auslastung seit der letzten Abfrage
function cpuProzent() {
  const jetzt = cpuSumme();
  const dGesamt = jetzt.gesamt - letzteCpu.gesamt;
  const dLeer = jetzt.leer - letzteCpu.leer;
  letzteCpu = jetzt;
  return dGesamt > 0 ? Math.round((1 - dLeer / dGesamt) * 100) : null;
}

function laufwerkLesen() {
  return new Promise((resolve) => {
    // Neuere Node-Versionen können das direkt
    if (typeof fs.statfs === 'function') {
      return fs.statfs(LAUFWERK.startsWith('/') ? LAUFWERK : LAUFWERK + '\\', (fehler, st) => {
        if (fehler) return resolve(null);
        const gesamt = st.blocks * st.bsize, frei = st.bavail * st.bsize;
        resolve({ gesamt, frei });
      });
    }
    // Ältere Node-Versionen: über PowerShell
    const buchstabe = LAUFWERK.replace(':', '');
    execFile('powershell', ['-NoProfile', '-Command',
      `$d = Get-PSDrive ${buchstabe}; Write-Output "$($d.Used) $($d.Free)"`],
      { timeout: 10000, windowsHide: true },
      (fehler, ausgabe) => {
        if (fehler) return resolve(null);
        const [belegt, frei] = String(ausgabe).trim().split(/\s+/).map(Number);
        if (!isFinite(belegt) || !isFinite(frei)) return resolve(null);
        resolve({ gesamt: belegt + frei, frei });
      });
  });
}

// Letzter Start laut Windows-Ereignisprotokoll (Kernel-Boot, Ereignis 27).
// os.uptime() reicht nicht: Mit dem Windows-Schnellstart läuft dieser Zähler
// beim Herunterfahren weiter und zeigt dann Tage oder Wochen zu viel.
function startzeitLesen() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    const befehl = "(Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Microsoft-Windows-Kernel-Boot'; Id=27} -MaxEvents 1).TimeCreated.ToUniversalTime().ToString('o')";
    execFile('powershell', ['-NoProfile', '-Command', befehl], { timeout: 15000, windowsHide: true }, (fehler, ausgabe) => {
      if (fehler) return resolve(null);
      const zeit = new Date(String(ausgabe).trim());
      resolve(isNaN(zeit) ? null : zeit);
    });
  });
}

async function laufzeitSekunden() {
  const start = await startzeitLesen();
  if (start) return Math.max(0, Math.round((Date.now() - start) / 1000));
  return Math.round(os.uptime()); // Ersatz, falls das Protokoll nicht lesbar ist
}

async function systemAbfragen() {
  const gb = (b) => Math.round(b / 1024 ** 3);
  const ramGesamt = os.totalmem(), ramFrei = os.freemem();
  const [lw, laufzeit] = await Promise.all([laufwerkLesen(), laufzeitSekunden()]);
  return {
    cpuProzent: cpuProzent(),
    ramProzent: Math.round((1 - ramFrei / ramGesamt) * 100),
    ramGesamtGB: gb(ramGesamt),
    laufwerk: lw ? {
      name: LAUFWERK,
      prozent: Math.round((1 - lw.frei / lw.gesamt) * 100),
      freiGB: gb(lw.frei),
      gesamtGB: gb(lw.gesamt)
    } : { name: LAUFWERK, prozent: null },
    laufzeitSek: laufzeit
  };
}

// ---------- Strom: Shelly Plug S Gen3 (nur lesen, niemals schalten) ----------
const energiePfad = path.join(__dirname, 'energie.json');
let energie = (() => {
  try { return JSON.parse(fs.readFileSync(energiePfad, 'utf8')); } catch { return {}; }
})();
function energieSpeichern() {
  try { fs.writeFileSync(energiePfad, JSON.stringify(energie, null, 2)); } catch (e) { console.error('energie.json:', e.message); }
}

function shellyLesen() {
  return new Promise((resolve) => {
    const req = http.get(`http://${SHELLY_IP}/rpc/Switch.GetStatus?id=0`, { timeout: 4000 }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => {
        try {
          const d = JSON.parse(text);
          resolve({ watt: d.apower, zaehlerWh: d.aenergy && d.aenergy.total });
        } catch { resolve(null); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

// Datum in Berliner Zeit, z. B. "2026-10-03"
function heuteSchluessel(d = new Date()) {
  return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' });
}

async function stromAbfragen() {
  // Ohne Shelly (oder wenn sie nicht antwortet) läuft die Rechnung mit 0 W weiter
  const messung = SHELLY_IP ? await shellyLesen() : null;
  const gueltig = !!(messung && typeof messung.watt === 'number' && typeof messung.zaehlerWh === 'number');

  const jetzt = new Date();
  const tag = heuteSchluessel(jetzt);
  const monat = tag.slice(0, 7);

  // Verbrauch seit der letzten Messung aufaddieren
  let neu = 0;
  if (gueltig) {
    if (typeof energie.letzterZaehlerWh === 'number') {
      neu = messung.zaehlerWh - energie.letzterZaehlerWh;
      if (neu < 0) neu = messung.zaehlerWh; // Zähler der Steckdose wurde zurückgesetzt
    }
    energie.letzterZaehlerWh = messung.zaehlerWh;
  }

  if (energie.tag !== tag) { energie.tag = tag; energie.tagWh = 0; }
  if (energie.monat !== monat) { energie.monat = monat; energie.monatWh = 0; energie.monatStart = jetzt.toISOString(); }
  energie.tagWh += neu;
  energie.monatWh += neu;
  energieSpeichern();

  const watt = gueltig ? messung.watt : 0;

  // Hochrechnung: Durchschnitt seit Messbeginn im Monat, in der ersten Stunde die aktuelle Leistung
  const [j, m] = monat.split('-').map(Number);
  const stundenImMonat = new Date(j, m, 0).getDate() * 24;
  const gemesseneStunden = (jetzt - new Date(energie.monatStart)) / 3600e3;
  const mittlereWatt = gueltig && gemesseneStunden >= 1 && energie.monatWh > 0
    ? energie.monatWh / gemesseneStunden
    : watt;
  const hochrechnung = mittlereWatt * stundenImMonat / 1000 * STROMPREIS;

  const runde = (x, n = 2) => Math.round(x * 10 ** n) / 10 ** n;
  return {
    gemessen: gueltig,                       // false = keine Shelly-Daten, Werte stehen auf 0 W
    watt: Math.round(watt),
    heute: { kwh: runde(energie.tagWh / 1000, 1), euro: runde(energie.tagWh / 1000 * STROMPREIS) },
    monat: { kwh: runde(energie.monatWh / 1000, 1), euro: runde(energie.monatWh / 1000 * STROMPREIS) },
    hochrechnungEuro: Math.round(hochrechnung),
    preisProKwh: STROMPREIS
  };
}

// ---------- Pi-hole (Version 6, nur lesen) ----------
const https = require('https');
let piholeSid = null;

function piholeAnfrage(methode, pfad, koerper) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(PIHOLE_URL + pfad); } catch { return resolve({ status: 0, daten: null }); }
    const modul = url.protocol === 'https:' ? https : http;
    const kopf = { 'Accept': 'application/json' };
    if (piholeSid) kopf['X-FTL-SID'] = piholeSid;
    const text = koerper ? JSON.stringify(koerper) : null;
    if (text) { kopf['Content-Type'] = 'application/json'; kopf['Content-Length'] = Buffer.byteLength(text); }
    const req = modul.request(url, { method: methode, headers: kopf, timeout: 5000, rejectUnauthorized: false }, (res) => {
      let roh = '';
      res.on('data', (d) => (roh += d));
      res.on('end', () => {
        let daten = null;
        try { daten = JSON.parse(roh); } catch {}
        resolve({ status: res.statusCode, daten });
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ status: 0, daten: null }));
    if (text) req.write(text);
    req.end();
  });
}

async function piholeAnmelden() {
  piholeSid = null;
  if (!PIHOLE_PASSWORT) return false;
  const { status, daten } = await piholeAnfrage('POST', '/api/auth', { password: PIHOLE_PASSWORT });
  if (status === 200 && daten && daten.session && daten.session.sid) {
    piholeSid = daten.session.sid;
    return true;
  }
  return false;
}

async function piholeAbfragen() {
  if (!PIHOLE_URL) return null;
  let antwort = await piholeAnfrage('GET', '/api/stats/summary');
  // Sitzung abgelaufen oder noch nicht angemeldet: einmal anmelden und erneut versuchen
  if ((antwort.status === 401 || antwort.status === 403) && await piholeAnmelden()) {
    antwort = await piholeAnfrage('GET', '/api/stats/summary');
  }
  const d = antwort.daten;
  if (antwort.status !== 200 || !d || !d.queries) {
    if (antwort.status === 401) console.error('Pi-hole: Anmeldung fehlgeschlagen – Passwort in config.json prüfen');
    return { online: false };
  }
  const q = d.queries, g = d.gravity || {};
  return {
    online: true,
    anfragen: q.total ?? null,
    blockiert: q.blocked ?? null,
    prozent: typeof q.percent_blocked === 'number' ? Math.round(q.percent_blocked * 10) / 10 : null,
    domains: g.domains_being_blocked ?? null
  };
}

// ---------- Abfrage aller Server ----------
let stand = {
  stand: null,
  server: servers.map((s) => ({ id: s.id, karte: s.karte, online: false, spielerzahl: 0, spieler: [] }))
};

async function allesAbfragen() {
  const [system, strom, pihole] = await Promise.all([
    systemAbfragen().catch((e) => { console.error('System:', e.message); return null; }),
    stromAbfragen().catch((e) => { console.error('Strom:', e.message); return null; }),
    piholeAbfragen().catch((e) => { console.error('Pi-hole:', e.message); return { online: false }; })
  ]);
  const ergebnisse = await Promise.all(servers.map(async (s) => {
    const { online, antwort } = await rconBefehl(SERVER_IP, s.rconPort, RCON_PASSWORD, 'ListPlayers');
    const namen = online ? spielerAuslesen(antwort) : [];
    return {
      id: s.id,
      karte: s.karte,
      online,
      spielerzahl: namen ? namen.length : null,   // null = online, aber Spielerliste unbekannt
      spieler: SPIELERNAMEN_ZEIGEN && namen ? namen : []
    };
  }));
  stand = { stand: new Date().toISOString(), server: ergebnisse, system, strom, pihole };
  const on = ergebnisse.filter((e) => e.online).length;
  const sp = ergebnisse.reduce((n, e) => n + (e.spielerzahl || 0), 0);
  const extra = (system ? ` | CPU ${system.cpuProzent} % RAM ${system.ramProzent} % ${LAUFWERK} ${system.laufwerk.prozent} %` : '')
    + (strom ? ` | ${strom.watt} W${strom.gemessen ? '' : (SHELLY_IP ? ' (Shelly nicht erreichbar)' : ' (keine Shelly)')}` : '')
    + (pihole ? (pihole.online ? ` | Pi-hole ${pihole.prozent} % blockiert` : ' | Pi-hole nicht erreichbar') : '');
  console.log(`[${new Date().toLocaleTimeString('de-DE')}] ${on}/${ergebnisse.length} online, ${sp} Spieler${extra}`);
}

let laeuft = false;
async function zyklus() {
  if (laeuft) return;
  laeuft = true;
  try { await allesAbfragen(); } catch (e) { console.error('Abfragefehler:', e); }
  laeuft = false;
}

// ---------- Kleine Webschnittstelle (nur lesen) ----------
const webserver = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.writeHead(405); return res.end();
  }
  const pfad = req.url.split('?')[0];
  if (pfad === '/status' || pfad === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(stand));
  }
  res.writeHead(404); res.end();
});

webserver.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`ARK-Status läuft: http://127.0.0.1:${HTTP_PORT}/status`);
});

zyklus();
setInterval(zyklus, ABFRAGE_ALLE_SEKUNDEN * 1000);

process.on('unhandledRejection', (e) => console.error('Fehler:', e));
