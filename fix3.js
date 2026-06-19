const fs = require('fs');
let c = fs.readFileSync('index.js', 'utf8');
c = c.replace('saemcelulares.net/pagina-inicial', 'www.saemcelulares.net');
c = c + '\n// site correto';
fs.writeFileSync('index.js', c);
console.log('OK');