// Entfernt den Dienst wieder.  node uninstall-ark-status-service.js  (als Administrator)
const path = require('path');
const { Service } = require('node-windows');

const svc = new Service({
  name: 'ARK Status Schaltzentrale',
  script: path.join(__dirname, 'ark-status.js')
});

svc.on('uninstall', () => console.log('Dienst entfernt.'));
svc.uninstall();
