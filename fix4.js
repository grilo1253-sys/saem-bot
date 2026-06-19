const fs = require('fs');
let c = fs.readFileSync('index.js', 'utf8');
const adicionar = "- Quando o cliente pedir fotos ou quiser ver os aparelhos, envie o link: https://www.saemcelulares.net\n- Nunca invente links ou páginas do site.";
c = c.replace('REGRA GERAL', adicionar + '\n\nREGRA GERAL');
fs.writeFileSync('index.js', c);
console.log('OK');
