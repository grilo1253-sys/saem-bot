const fs = require('fs');
let c = fs.readFileSync('index.js', 'utf8');
const adicionar = "- Valores de troca: NUNCA estime, calcule ou arredonde valores. Use EXATAMENTE o valor que esta na tabela de trocas. Se o aparelho do cliente tiver condicao que nao esta na tabela, diga que precisa avaliar presencialmente na loja.";
c = c.replace('REGRA GERAL', adicionar + '\n\nREGRA GERAL');
fs.writeFileSync('index.js', c);
console.log('OK');