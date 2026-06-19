const fs = require('fs');
let c = fs.readFileSync('index.js', 'utf8');
const adicionar = "console.log('BODY:', JSON.stringify(body).substring(0, 300));";
c = c.replace('const phone = body.phone;', adicionar + '\nconst phone = body.phone;');
fs.writeFileSync('index.js', c);
console.log('OK');