const fs = require('fs');
let c = fs.readFileSync('index.js', 'utf8');
const adicionar = `const isGroup = body.isGroup || body.phone?.includes('-group');
if (isGroup) {
const msgGrupo = body.text?.message || body.text || '';
const isImagem = body.image || body.mimetype?.includes('image');
if (isImagem) return res.sendStatus(200);
if (!msgGrupo) return res.sendStatus(200);
const assuntosPermitidos = ['troca', 'valor', 'preco', 'manutencao', 'conserto', 'cliente', 'venda', 'negoc', 'quanto', 'aparelho'];
const temAssunto = assuntosPermitidos.some(a => msgGrupo.toLowerCase().includes(a));
if (!temAssunto) return res.sendStatus(200);
}`;
c = c.replace('const phone = body.phone;', adicionar + '\nconst phone = body.phone;');
fs.writeFileSync('index.js', c);
console.log('OK');
