// Installiert ark-status.js als Windows-Dienst (startet automatisch mit Windows).
// Ausführen in einer Administrator-Eingabeaufforderung:  node install-ark-status-service.js
const path = require('path');
const { Service } = require('node-windows');

const svc = new Service({
  name: 'ARK Status Schaltzentrale',
  description: 'Stellt den Live-Status der ARK-Server für die Schaltzentrale bereit.',
  script: path.join(__dirname, 'ark-status.js')
});

svc.on('install', () => {
  console.log('Dienst installiert, starte ...');
  svc.start();
});
svc.on('start', () => console.log('Dienst läuft. Test: http://127.0.0.1:8787/status'));
svc.on('alreadyinstalled', () => console.log('Dienst ist bereits installiert.'));
svc.on('error', (e) => console.error('Fehler:', e));

svc.install();
