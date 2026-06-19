const fs = require('fs');
let c = fs.readFileSync('index.js', 'utf8');
const adicionar = "- Quando enviar links NUNCA use asteriscos ou negrito. Links limpos sem formatacao.\n- Quando cliente pedir fotos envie: https://www.saemcelulares.net";
c = c.replace('REGRA GERAL', adicionar + '\n\nREGRA GERAL');
fs.writeFileSync('index.js', c);
console.log('OK');

