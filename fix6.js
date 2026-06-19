const fs = require('fs');
let c = fs.readFileSync('index.js', 'utf8');
const adicionar = "- Quando o cliente pedir um modelo que NAO existe na tabela, SEMPRE comece dizendo 'No momento não temos o [modelo pedido] disponível.' e só depois ofereça o similar. NUNCA diga 'temos sim' para um produto que não está na tabela.";
c = c.replace('REGRA GERAL', adicionar + '\n\nREGRA GERAL');
fs.writeFileSync('index.js', c);
console.log('OK');