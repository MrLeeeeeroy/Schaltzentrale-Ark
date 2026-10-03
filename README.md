# Schaltzentrale-Ark

Wanddisplay fürs iPad: analoge Uhr, Wetter für Berlin-Spandau, Feiertage, animierter Himmel – plus Live-Status der 20 ARK-Server.

- `index.html`, `icon.png` – die Webseite (GitHub Pages)
- `server/` – Statusdienst für den Server-PC
  - `ark-status.js` – fragt die Server per RCON ab und stellt `/status` lokal bereit
  - `config.example.json` – Vorlage; als `config.json` kopieren und ausfüllen (wird nicht hochgeladen)
  - `install-ark-status-service.js` / `uninstall-ark-status-service.js` – Windows-Dienst ein- und austragen

Die Adresse des Statusdienstes (Tailscale Funnel) steht in `index.html` unter `ARK_API`.
