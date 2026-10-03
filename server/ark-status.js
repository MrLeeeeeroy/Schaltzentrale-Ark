// ─────────────────────────────────────────────────────────────────────────────
// ARK Status für die Schaltzentrale
// Fragt alle ASA-Server per RCON ab (online/offline + Spieler) und stellt das
// Ergebnis als kleine JSON-Schnittstelle bereit: http://127.0.0.1:8787/status
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
const ABFRAGE_ALLE_SEKUNDEN = config.abfrageAlleSekunden || 60;  // wie oft alle Server abgefragt werden
const ZEITLIMIT_MS = 4000;                                       // Wartezeit pro Server
const SPIELERNAMEN_ZEIGEN = config.spielernamenZeigen !== false; // false = nur Anzahl
const ERSTER_RCON_PORT = config.ersterRconPort || 27071;         // ASA01; ASA02 = +1 usw.
const ANZAHL_SERVER = config.anzahlServer || 20;
const KARTEN = config.karten || {};                              // { "1": "New Island", ... }
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

// ---------- Abfrage aller Server ----------
let stand = {
  stand: null,
  server: servers.map((s) => ({ id: s.id, karte: s.karte, online: false, spielerzahl: 0, spieler: [] }))
};

async function allesAbfragen() {
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
  stand = { stand: new Date().toISOString(), server: ergebnisse };
  const on = ergebnisse.filter((e) => e.online).length;
  const sp = ergebnisse.reduce((n, e) => n + (e.spielerzahl || 0), 0);
  console.log(`[${new Date().toLocaleTimeString('de-DE')}] ${on}/${ergebnisse.length} online, ${sp} Spieler`);
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
