const fs = require('fs');
let c = fs.readFileSync('index.js', 'utf8');
const antigo = `const isGroup = body.isGroup || body.phone?.includes('-group');
if (isGroup) {
const msgGrupo = body.text?.message || body.text || '';
const isImagem = body.image || body.mimetype?.includes('image');
if (isImagem) return res.sendStatus(200);
if (!msgGrupo) return res.sendStatus(200);
const assuntosPermitidos = ['quanto pega', 'valor de troca', 'troca do cliente', 'manutencao', 'conserto', 'problema com cliente', 'reclamacao', 'reembolso'];
const temAssunto = assuntosPermitidos.some(a => msgGrupo.toLowerCase().includes(a));
if (!temAssunto) return res.sendStatus(200);
}`;
const novo = `const isGroup = body.isGroup || body.phone?.includes('-group');
if (isGroup) {
const msgGrupo = body.text?.message || body.text || '';
const isImagem = body.image || body.mimetype?.includes('image');
if (isImagem) return res.sendStatus(200);
if (!msgGrupo) return res.sendStatus(200);
const msgLower = msgGrupo.toLowerCase();
const foiChamado = msgLower.includes('claudio') || msgLower.includes('cláudio') || msgLower.includes('@saem') || msgLower.includes('@claudio') || msgLower.includes('@cláudio');
if (!foiChamado) return res.sendStatus(200);
}`;
c = c.replace(antigo, novo);
fs.writeFileSync('index.js', c);
console.log('OK');

