const fs = require('fs');
let c = fs.readFileSync('index.js', 'utf8');
const adicionar = "- NUNCA invente produtos que não estão na tabela. Se o cliente pedir um modelo que não existe, diga claramente que não temos e ofereça o modelo mais próximo disponível. Exemplo: 'Não temos o iPhone 15 Pro Max no momento, mas temos o iPhone 15 Pro 256GB por R$3.999 que é muito similar!'";
c = c.replace('REGRA GERAL', adicionar + '\n\nREGRA GERAL');
fs.writeFileSync('index.js', c);
console.log('OK');