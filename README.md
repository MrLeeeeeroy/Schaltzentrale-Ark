# Schaltzentrale-Ark

Wanddisplay fürs iPad: analoge Uhr, Wetter für Berlin-Spandau, Feiertage, animierter Himmel – plus Live-Status der 20 ARK-Server Pi-hole-Statistik und Zustand des Root-Servers (CPU, RAM, Datenträger E:, Stromverbrauch über Shelly Plug S Gen3).

- `index.html`, `icon.png` – die Webseite (GitHub Pages)
- `wow-logo.png` – Logo für den Countdown bis 05.11.2026 00:01 (blinkt danach einen Tag, ab 06.11. ausgeblendet)
- `server/` – Statusdienst für den Server-PC
  - `ark-status.js` – fragt die Server per RCON ab, liest CPU/RAM/Datenträger, den Pi-hole und die Shelly-Steckdose und stellt `/status` lokal bereit
  - `energie.json` – entsteht automatisch, zählt Tages- und Monatsverbrauch mit (wird nicht hochgeladen)
  - `config.example.json` – Vorlage; als `config.json` kopieren und ausfüllen (wird nicht hochgeladen)
  - `install-ark-status-service.js` / `uninstall-ark-status-service.js` – Windows-Dienst ein- und austragen

Die Adresse des Statusdienstes (Tailscale Funnel) steht in `index.html` unter `ARK_API`.
