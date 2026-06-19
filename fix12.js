const fs = require('fs');
let c = fs.readFileSync('index.js', 'utf8');
const antigo = "const assuntosPermitidos = ['troca', 'valor', 'preco', 'manutencao', 'conserto', 'cliente', 'venda', 'negoc', 'quanto', 'aparelho'];\n const temAssunto = assuntosPermitidos.some(a => msgGrupo.toLowerCase().includes(a));";
const novo = "const assuntosPermitidos = ['quanto pega', 'valor de troca', 'troca do cliente', 'manutencao', 'conserto', 'problema com cliente', 'reclamacao', 'reembolso'];\n const temAssunto = assuntosPermitidos.some(a => msgGrupo.toLowerCase().includes(a));";
c = c.replace(antigo, novo);
fs.writeFileSync('index.js', c);
console.log('OK');
