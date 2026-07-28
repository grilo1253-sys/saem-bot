require('dotenv').config();
const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// ==========================================
// VARIÁVEIS DE AMBIENTE
// ==========================================
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const NUMERO_ADMIN = process.env.NUMERO_ADMIN; // Número pessoal do Saem para receber notificações

// ==========================================
// PERSISTÊNCIA DAS CONVERSAS
// ==========================================
const PASTA_DADOS = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
if (!fs.existsSync(PASTA_DADOS)) {
  try { fs.mkdirSync(PASTA_DADOS, { recursive: true }); } catch (e) {}
}

const ARQUIVO_CONVERSAS = path.join(PASTA_DADOS, 'conversas_do_dia.json');
const ARQUIVO_NOITE_ANTERIOR = path.join(PASTA_DADOS, 'conversas_noite_anterior.json');
const ARQUIVO_PENDENTES = path.join(PASTA_DADOS, 'pendentes_equipe.json');
const ARQUIVO_METADADOS = path.join(PASTA_DADOS, 'metadados_conversas.json');

function carregarConversas() {
  try {
    if (fs.existsSync(ARQUIVO_CONVERSAS)) {
      const data = JSON.parse(fs.readFileSync(ARQUIVO_CONVERSAS, 'utf8'));
      const hoje = new Date().toDateString();
      if (data.data === hoje) {
        console.log(`✅ Conversas carregadas: ${Object.keys(data.conversas).length} clientes`);
        return data.conversas;
      }
    }
  } catch (e) {
    console.error('Erro ao carregar conversas:', e.message);
  }
  return {};
}

function salvarConversas() {
  try {
    const data = { data: new Date().toDateString(), conversas: conversas };
    fs.writeFileSync(ARQUIVO_CONVERSAS, JSON.stringify(data), 'utf8');
  } catch (e) {
    console.error('Erro ao salvar conversas:', e.message);
  }
}

function carregarMetadados() {
  try {
    if (fs.existsSync(ARQUIVO_METADADOS)) {
      const data = JSON.parse(fs.readFileSync(ARQUIVO_METADADOS, 'utf8'));
      const hoje = new Date().toDateString();
      if (data.data === hoje) return data.meta;
    }
  } catch (e) {}
  return {};
}

function salvarMetadados() {
  try {
    const data = { data: new Date().toDateString(), meta: metaConversas };
    fs.writeFileSync(ARQUIVO_METADADOS, JSON.stringify(data), 'utf8');
  } catch (e) {}
}

function carregarPendentes() {
  try {
    if (fs.existsSync(ARQUIVO_PENDENTES)) {
      return JSON.parse(fs.readFileSync(ARQUIVO_PENDENTES, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function salvarPendentes() {
  try {
    fs.writeFileSync(ARQUIVO_PENDENTES, JSON.stringify(pendentesEquipe), 'utf8');
  } catch (e) {}
}

// ==========================================
// CONVERSAS ENCERRADAS (boleto / limite de DDD fora da região)
// ==========================================
// Guarda os números que já foram encaminhados pro número de análise e não
// devem receber mais respostas do Cláudio — economiza crédito de API com
// gente que já foi direcionada pra outro atendimento.
const ARQUIVO_ENCERRADAS = path.join(PASTA_DADOS, 'conversas_encerradas.json');
function carregarEncerradas() {
  try {
    if (fs.existsSync(ARQUIVO_ENCERRADAS)) {
      return JSON.parse(fs.readFileSync(ARQUIVO_ENCERRADAS, 'utf8'));
    }
  } catch (e) {}
  return {};
}
function salvarEncerradas() {
  try {
    fs.writeFileSync(ARQUIVO_ENCERRADAS, JSON.stringify(conversasEncerradas), 'utf8');
  } catch (e) {}
}

// Conta quantas mensagens SEGUIDAS um cliente mandou fora do assunto da loja
// (bate-papo pessoal, assunto aleatório) — usado pra encerrar conversa
// improdutiva antes que ela continue consumindo crédito de API à toa.
const ARQUIVO_CONTADORES_FORA = path.join(PASTA_DADOS, 'contadores_fora_assunto.json');
function carregarContadoresForaRegiao() {
  try {
    if (fs.existsSync(ARQUIVO_CONTADORES_FORA)) {
      return JSON.parse(fs.readFileSync(ARQUIVO_CONTADORES_FORA, 'utf8'));
    }
  } catch (e) {}
  return {};
}
function salvarContadoresForaRegiao() {
  try {
    fs.writeFileSync(ARQUIVO_CONTADORES_FORA, JSON.stringify(contadoresForaRegiao), 'utf8');
  } catch (e) {}
}

const conversas = carregarConversas();
const metaConversas = carregarMetadados();
const pendentesEquipe = carregarPendentes();
const conversasEncerradas = carregarEncerradas();
const contadoresForaRegiao = carregarContadoresForaRegiao();

// Número de análise pra onde encaminhamos: pedidos de pagamento no boleto e
// clientes de DDD fora da região que estourarem o limite de mensagens.
const NUMERO_ANALISE = '12981880229';
// DDD da região onde ficam as lojas (São José dos Campos / Taubaté).
const DDD_REGIAO = '12';
// Máximo de mensagens SEGUIDAS fora do assunto da loja (não relacionadas a
// aparelho/compra/troca/valor) antes de encerrar a conversa. Vale pra
// QUALQUER DDD — inclusive DDD 12 — porque bate-papo pessoal consome
// crédito de API independente de onde o cliente é.
const LIMITE_MENSAGENS_FORA_DO_ASSUNTO = 4;

// Extrai o DDD a partir do telefone no formato que o Z-API manda
// (ex: "5512988887777" -> "12"). Remove o código do país (55) quando
// presente antes de pegar os dois primeiros dígitos.
function extrairDDD(phone) {
  if (!phone) return null;
  const numeros = phone.replace(/\D/g, '');
  const semPais = (numeros.startsWith('55') && numeros.length > 10) ? numeros.slice(2) : numeros;
  return semPais.slice(0, 2) || null;
}

// Detecta menção a pagamento via boleto, em qualquer variação comum de
// escrita (com ou sem acento, "bolet", etc).
function mencionaBoleto(texto) {
  if (!texto) return false;
  return /boleto/i.test(texto);
}

// Palavras que indicam que a conversa é sobre o negócio (aparelho, compra,
// troca, valor, etc). Se a mensagem do cliente não tocar em nenhuma dessas E
// não tiver número/valor, consideramos "fora do assunto" pra fins do
// contador de conversa improdutiva.
const PALAVRAS_ASSUNTO_LOJA = [
  'iphone', 'ipad', 'samsung', 'galaxy', 'motorola', 'moto ', 'xiaomi', 'poco', 'redmi',
  'celular', 'smartphone', 'aparelho', 'tablet',
  'troca', 'trocar', 'tela', 'bateria', 'câmera', 'camera', 'valor', 'preço', 'preco',
  'comprar', 'compra', 'venda', 'vender', 'reserva', 'reservar',
  'parcela', 'parcelado', 'parcelamento', 'entrada', 'garantia', 'conserto', 'manutenção',
  'manutencao', 'defeito', 'loja', 'endereço', 'endereco', 'horário', 'horario',
  'estoque', 'modelo', 'gb', 'memória', 'memoria', 'nota fiscal', 'orçamento', 'orcamento',
  'chip', 'seminovo', 'usado', 'novo'
];
function pareceAssuntoDaLoja(texto) {
  if (!texto) return false;
  const t = texto.toLowerCase();
  if (PALAVRAS_ASSUNTO_LOJA.some(p => t.includes(p))) return true;
  if (/r\$|\d{3,}/.test(t)) return true; // menção a valores em R$ ou números grandes (preço, modelo com número, etc)
  return false;
}

// Saudações/curtas neutras que não devem contar nem a favor nem contra o
// contador de "fora do assunto" (cumprimento normal não é bate-papo).
const SAUDACOES_NEUTRAS = ['oi', 'olá', 'ola', 'bom dia', 'boa tarde', 'boa noite', 'opa', 'eae', 'e ai', 'e aí', 'blz', 'beleza', 'obrigado', 'obrigada', 'valeu', 'ok', 'tá', 'ta bom', 'tá bom'];
function ehSaudacaoNeutra(texto) {
  if (!texto) return false;
  const t = texto.toLowerCase().trim().replace(/[!.,]/g, '');
  return SAUDACOES_NEUTRAS.some(s => t === s) && t.length <= 20;
}

// Termos que indicam conteúdo sexual/impróprio mandado pelo cliente. Nesses
// casos o Cláudio corta a conversa na hora, sem negociar nem tentar
// argumentar — e avisa o admin, pra ele decidir se quer bloquear o número.
// Lista propositalmente enxuta (só termos inequívocos), pra evitar falso
// positivo com palavras comuns do dia a dia.
const TERMOS_CONTEUDO_SEXUAL = [
  'nudes', 'pelada', 'pelado', 'buceta', 'pinto duro', 'pau duro', 'transar', 'transa comigo',
  'sexo', 'tesão', 'tesao', 'boquete', 'siririca', 'gozar', 'chupar meu', 'foder', 'fuder',
  'manda foto pelad', 'manda nude'
];
function mencionaConteudoSexual(texto) {
  if (!texto) return false;
  const t = texto.toLowerCase();
  return TERMOS_CONTEUDO_SEXUAL.some(termo => t.includes(termo));
}

// Rastreia mensagens que o PRÓPRIO bot acabou de enviar, pra diferenciar do
// eco "fromMe" (que o Z-API manda de volta toda vez que uma mensagem sai
// desse número, seja ela do bot ou digitada manualmente por alguém da
// equipe). Sem isso, uma resposta manual da equipe (ex: Saem respondendo o
// cliente direto pelo WhatsApp enquanto o bot estava fora do ar por falta de
// crédito da API) é simplesmente descartada e o Cláudio, ao voltar, responde
// de novo a mesma pergunta que já tinha sido resolvida manualmente —
// causando duplicidade (ex: valor de troca informado duas vezes).
const mensagensEnviadasPeloBot = {};

// ==========================================
// DEDUPLICAÇÃO DE MENSAGENS (evita processar o mesmo webhook duas vezes)
// ==========================================
// Erro real que já aconteceu: o cliente recebeu DUAS respostas diferentes
// pra mesma mensagem — uma calculando o valor certinho direto da tabela, e
// logo em seguida outra dizendo "confirmado pela equipe" do nada. Uma causa
// bem provável pra isso é o Z-API reenviar o mesmo webhook duas vezes (é um
// comportamento conhecido de APIs de WhatsApp, geralmente por engano de rede
// ou timeout) — sem proteção nenhuma, o código processava a mensagem duas
// vezes, gerando duas respostas independentes (cada chamada ao Claude pode
// variar um pouco). Esta cache guarda os IDs de mensagem já processados
// recentemente e ignora qualquer repetição.
const mensagensProcessadas = new Set();
function jaProcessouMensagem(messageId) {
  if (!messageId) return false;
  if (mensagensProcessadas.has(messageId)) return true;
  mensagensProcessadas.add(messageId);
  if (mensagensProcessadas.size > 500) {
    // Remove os mais antigos pra não crescer sem limite (Set mantém ordem de inserção)
    const primeiro = mensagensProcessadas.values().next().value;
    mensagensProcessadas.delete(primeiro);
  }
  return false;
}

// ==========================================
// FILA DE PROCESSAMENTO POR TELEFONE (evita condição de corrida)
// ==========================================
// Erro real que já aconteceu: o Saem digitou um valor manualmente na
// conversa E o cliente mandou uma mensagem nova quase no mesmo segundo. Como
// os dois eventos chegam por webhooks separados e cada um processa de forma
// assíncrona (lendo/escrevendo em conversas[phone] e chamando a API), eles
// podem rodar EM PARALELO — um deles pode ler o histórico antes do outro
// terminar de gravar sua parte, gerando uma resposta que ignora o que acabou
// de ser dito (ex: o Cláudio pediu de novo informações que o Saem já tinha
// acabado de responder). Esta fila garante que todo processamento de um
// mesmo número de telefone aconteça em SEQUÊNCIA, nunca em paralelo — cada
// nova tarefa só começa depois que a anterior (do mesmo telefone) terminou.
const filaPorTelefone = {};
function enfileirarPorTelefone(phone, tarefa) {
  const anterior = filaPorTelefone[phone] || Promise.resolve();
  const atual = anterior.then(tarefa, tarefa);
  filaPorTelefone[phone] = atual.catch(e => {
    console.error(`Erro na fila de processamento de ${phone}:`, e.message);
  });
  return filaPorTelefone[phone];
}


// ==========================================
// SISTEMA DE NOTIFICAÇÃO PARA O ADMIN
// ==========================================
// Extrai apenas o MOTIVO real da escalação a partir da resposta do Cláudio,
// em vez de mandar a resposta inteira (que costuma vir cheia de saudação,
// pergunta pro cliente, emoji, etc). Prioriza frases que mencionem defeito
// (tela, bateria, traseira, funcionamento) ou modelo/memória fora da tabela
// — que são os dois únicos motivos válidos de escalação. Se nenhuma frase
// bater com essas palavras-chave, cai de volta pra resposta inteira (melhor
// mandar algo do que nada).
function extrairMotivoPendencia(reply) {
  const palavrasDefeito = [
    'defeito', 'tela trincada', 'tela quebrada', 'traseira trincada',
    'traseira quebrada', 'bateria abaixo', 'bateria ruim', 'não funciona',
    'nao funciona', 'face id', 'nfc', 'câmera', 'camera', 'nao liga',
    'não liga', 'trincad', 'quebrad', '%',
  ];
  const palavrasForaDaTabela = [
    'não está na tabela', 'nao esta na tabela', 'não encontrado', 'nao encontrado',
    'fora da tabela', 'não temos esse modelo', 'nao temos esse modelo',
    'avaliado presencialmente', 'não está listado', 'nao esta listado',
  ];
  const trechos = reply.split(/(?<=[.!?\n])\s*/).map(t => t.trim()).filter(Boolean);

  const trechoDefeito = trechos.find(t => palavrasDefeito.some(p => t.toLowerCase().includes(p)));
  if (trechoDefeito) return `(defeito relatado) ${trechoDefeito}`;

  const trechoForaDaTabela = trechos.find(t => palavrasForaDaTabela.some(p => t.toLowerCase().includes(p)));
  if (trechoForaDaTabela) return `(modelo/memória fora da tabela) ${trechoForaDaTabela}`;

  // Fallback: nenhuma palavra-chave bateu — manda a resposta inteira mesmo,
  // é melhor que ficar sem contexto nenhum.
  return reply;
}

async function notificarAdmin(phoneCliente, aparelho, contexto) {
  if (!NUMERO_ADMIN) return;
  try {
    const msg = `🔔 *Valor necessário para cliente*\n\nCliente: ${phoneCliente}\nAparelho: *${aparelho}*\n\nMotivo: ${contexto}\n\n_Responda com o valor no formato:_\n*valor ${phoneCliente} 300*\n_(substitua 300 pelo valor real)_`;
    await enviarMensagem(NUMERO_ADMIN, msg);
    console.log(`📲 Admin notificado sobre ${aparelho} para cliente ${phoneCliente}`);
  } catch (e) {
    console.error('Erro ao notificar admin:', e.message);
  }
}

function detectouPendencia(reply, mensagemCliente) {
  const replyLower = reply.toLowerCase();
  const clienteLower = (mensagemCliente || '').toLowerCase();
  const textoCompleto = replyLower + ' ' + clienteLower;

  // Não disparar se for sobre entrega/disponibilidade
  const sobreEntrega = textoCompleto.includes('entrega') || textoCompleto.includes('motoboy') || textoCompleto.includes('disponibilidade') || textoCompleto.includes('entregar na sua região');
  if (sobreEntrega) return false;

  // Não disparar se já passou valor calculado
  const jaTemValor = replyLower.includes('saldo') || replyLower.includes('10x') || replyLower.includes('12x') || (replyLower.includes('r$') && (replyLower.includes('parcela') || replyLower.includes('vista')));
  if (jaTemValor) return false;

  // Não disparar para reclamações, defeitos, sinal, internet, conexão, cartão ou falta de resposta —
  // checando TANTO a resposta do Cláudio QUANTO a mensagem do cliente, pois o cliente pode usar
  // palavras diferentes das que o Cláudio usou na resposta. Esses assuntos não são "valor de
  // aparelho faltando na tabela" e devem ser resolvidos pelo próprio Cláudio (seguindo a regra
  // de reclamação ou respondendo direto), não pela equipe.
  const palavrasNaoValor = [
    'sinal', 'internet', 'wi-fi', 'wifi', 'conexão', 'conexao',
    'defeito', 'não obtive resposta', 'nao obtive resposta',
    'demora', 'demorando', 'atraso', 'atrasado',
    'cartão', 'cartao', 'não funciona', 'nao funciona',
    'travando', 'travou', 'lento', 'lenta',
    'reclama', 'insatisfeit', 'não obtive', 'nao obtive'
  ];
  const naoEhSobreValor = palavrasNaoValor.some(p => textoCompleto.includes(p));
  if (naoEhSobreValor) return false;

  // Dispara para qualquer assunto em que o Cláudio disse que vai verificar com a equipe
  // (valor de troca, saúde de bateria, peça trocada, manutenção fora da tabela, etc.)
  const temEquipe = replyLower.includes('equipe');
  const temVerificar = replyLower.includes('verificar') || replyLower.includes('retorno em instantes') || replyLower.includes('retornar em instantes') || replyLower.includes('retorno em breve');

  // Só considera pendência real se a resposta também mencionar contexto de valor/preço/aparelho/troca —
  // evita disparar para assuntos genéricos que nada têm a ver com precificação.
  const sobreValor = replyLower.includes('valor') || replyLower.includes('preço') || replyLower.includes('preco') || replyLower.includes('aparelho') || replyLower.includes('troca');

  return temEquipe && temVerificar && sobreValor;
}

function extrairAparelhoPendente(mensagens) {
  const ultimasMsgs = mensagens.slice(-4);
  const texto = ultimasMsgs.map(m => typeof m.content === 'string' ? m.content : '').join(' ');
  const padroes = [
    /poco\s+\w+/i, /redmi\s+\w+/i, /galaxy\s+\w+/i, /moto\s+\w+/i,
    /iphone\s+\d+[a-z]*(?:\s+(?:pro\s*max|pro|plus|mini))?/i, /macbook\s+\w+/i, /ipad\s+\w*/i,
    /notebook\s+\w*/i, /ps[34]/i, /xbox\s+\w*/i, /apple\s+watch/i
  ];
  // Erro real que já aconteceu: quando o cliente menciona DOIS aparelhos na
  // mesma frase — o que ele quer COMPRAR e o que ele quer DAR de entrada
  // (ex: "tenho interesse no iPhone 14 se eu der meu 11 64GB com tela
  // desligada") — a extração antiga pegava sempre o PRIMEIRO modelo citado
  // no texto, que na prática costuma ser o de COMPRA, não o de TROCA. Isso
  // fez o valor de troca confirmado ficar associado ao aparelho errado
  // (iPhone 14 em vez do iPhone 11), confundindo o Cláudio logo depois.
  // Corrigido: agora damos prioridade a um match que apareça logo depois de
  // "meu"/"minha" (o aparelho que o cliente POSSUI) ou perto de palavras de
  // defeito (tela, bateria, trincad, etc) — só caindo pro comportamento
  // antigo (primeiro match de qualquer jeito) se nenhum desses sinais bater.
  const regexPossessivo = /\b(meu|minha)\s+((?:poco|redmi|galaxy|moto|iphone|macbook|ipad|notebook|ps[34]|xbox|apple\s+watch)(?:\s+\w+){0,3})(?=\s|$|,|\.|!|\?)/i;
  const matchPossessivo = texto.match(regexPossessivo);
  if (matchPossessivo) return matchPossessivo[2].trim();

  const palavrasDefeito = ['tela', 'bateria', 'trincad', 'quebrad', 'defeito', 'riscad', 'desligand', 'traseira'];
  for (const padrao of padroes) {
    const regexGlobal = new RegExp(padrao.source, 'gi');
    const matches = [...texto.matchAll(regexGlobal)];
    for (const m of matches) {
      const janelaSeguinte = texto.slice(m.index, m.index + m[0].length + 40).toLowerCase();
      if (palavrasDefeito.some(p => janelaSeguinte.includes(p))) return m[0];
    }
  }

  for (const padrao of padroes) {
    const match = texto.match(padrao);
    if (match) return match[0];
  }
  return 'aparelho não identificado';
}

// Erro real que já aconteceu VÁRIAS vezes: mesmo depois do valor de troca
// ser confirmado, o Cláudio perguntava de novo "qual modelo você quer
// levar?" — repetidamente, mesmo o cliente já tendo respondido isso antes
// (ex: "iPhone 14", depois "amarelo"). Só instruir no prompt pra "reler o
// histórico" não bastou pra evitar isso de forma confiável. Esta função
// extrai automaticamente o modelo de COMPRA que o cliente já confirmou —
// diferente da função acima, que extrai o aparelho de TROCA — pra gente
// já anexar essa informação diretamente na mensagem de valor confirmado,
// em vez de depender do modelo "lembrar" sozinho.
function extrairModeloDesejado(mensagens) {
  const ultimasMsgs = mensagens.slice(-10);
  const texto = ultimasMsgs.map(m => typeof m.content === 'string' ? m.content : '').join(' ');
  const padroes = [
    /iphone\s+\d+[a-z]*(?:\s+(?:pro\s*max|pro|plus|mini))?/gi,
    /poco\s+\w+/gi, /redmi\s+\w+/gi, /galaxy\s+\w+/gi, /moto\s+\w+/gi,
  ];
  const palavrasDefeito = ['tela', 'bateria', 'trincad', 'quebrad', 'defeito', 'riscad', 'desligand', 'traseira', 'face id'];
  let candidatos = [];
  for (const padrao of padroes) {
    const matches = [...texto.matchAll(padrao)];
    for (const m of matches) {
      const antes = texto.slice(Math.max(0, m.index - 8), m.index).toLowerCase();
      const depois = texto.slice(m.index, m.index + m[0].length + 30).toLowerCase();
      const ehPossessivo = /\b(meu|minha|seu|sua|dele|dela)\s*$/.test(antes);
      const ehDefeito = palavrasDefeito.some(p => depois.includes(p));
      if (!ehPossessivo && !ehDefeito) candidatos.push({ texto: m[0], index: m.index });
    }
  }
  if (candidatos.length === 0) return null;
  candidatos.sort((a, b) => b.index - a.index); // prioriza a menção mais recente
  let modelo = candidatos[0].texto;
  const cores = ['amarelo', 'preto', 'branco', 'azul', 'verde', 'rosa', 'roxo', 'dourado', 'prateado', 'vermelho', 'laranja', 'cinza'];
  const restante = texto.slice(candidatos[0].index);
  const corMatch = cores.find(c => new RegExp(`\\b${c}\\b`, 'i').test(restante));
  if (corMatch) modelo += ` ${corMatch.charAt(0).toUpperCase() + corMatch.slice(1)}`;
  return modelo;
}

function processarRespostaAdmin(message, phoneAdmin) {
  const match = message.trim().match(/^valor\s+(\d+)\s+(\d+(?:[.,]\d+)?)/i);
  if (!match) return null;
  const phoneCliente = match[1];
  const valorStr = match[2].replace(',', '.');
  const valor = parseFloat(valorStr);
  if (!phoneCliente || isNaN(valor)) return null;
  return { phoneCliente, valor };
}

// Extrai um valor monetário plausível de um texto CASUAL (ex: "Da pegar por
// 1500", "1500 tá bom", "R$1.500"). Diferente de processarRespostaAdmin, que
// exige o formato rígido "valor TELEFONE VALOR", esta função é usada quando
// o Saem digita direto na conversa do cliente (não no número admin) — o
// texto pode vir em qualquer ordem/formato. Só é chamada quando já existe uma
// pendência aberta pra esse cliente, então o risco de pegar um número errado
// (tipo GB de memória) é baixo, mas ainda assim aplicamos uma faixa de
// sanidade (entre R$30 e R$50.000) pra evitar capturar números aleatórios.
function extrairValorDeMensagemLivre(texto) {
  const matchComCifrao = texto.match(/r\$\s*([\d.]+(?:,\d{2})?)/i);
  const bruto = matchComCifrao
    ? matchComCifrao[1]
    : (texto.match(/\b(\d{2,6}(?:[.,]\d{2})?)\b/) || [])[1];
  if (!bruto) return null;
  const valor = parseFloat(bruto.replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'));
  if (isNaN(valor) || valor < 30 || valor > 50000) return null;
  return valor;
}

// ==========================================
// REGRA ESPECIAL DE DOMINGO — LOJA TAUBATÉ
// ==========================================
// Verifica se hoje (no fuso de São Paulo) é domingo. Se for, retorna um bloco
// de texto extra que é acrescentado ao final do system prompt, instruindo o
// Cláudio a encaminhar clientes que queiram visitar/agendar em Taubaté no
// domingo diretamente para o vendedor Rodrigo. Nos demais dias da semana,
// retorna string vazia e não afeta em nada o comportamento normal do bot.
function textoRegraDomingoTaubate() {
  const diaSemana = new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'long' });
  if (diaSemana === 'Sunday') {
    return `

━━━━━━━━━━━━━━━━━━━
REGRA ESPECIAL DE DOMINGO — LOJA TAUBATÉ
━━━━━━━━━━━━━━━━━━━
Hoje é domingo. Aos domingos, a loja de Taubaté funciona apenas com atendimento agendado, feito pelo vendedor Rodrigo. Se o cliente disser que quer ir até a loja de Taubaté hoje, quer agendar uma visita, quer ver o aparelho pessoalmente ou fechar a compra presencialmente em Taubaté, informe que aos domingos o atendimento em Taubaté é só com agendamento e encaminhe direto para o Rodrigo: https://wa.me/5512991058245. Essa regra vale APENAS para a loja de Taubaté aos domingos — não se aplica a São José dos Campos nem a outros dias da semana.`;
  }
  return '';
}

// ==========================================
// SYSTEM PROMPT
// ==========================================
const SYSTEM_PROMPT = `VENDEDOR SAEM CELULARES

Você é o assistente de vendas da Saem Celulares, especialista em iPhones novos e seminovos.

Seu objetivo é atender os clientes de forma rápida, educada, consultiva e focada em fechamento de vendas.

Você deve agir como um vendedor experiente da loja, conduzindo a conversa de forma natural e humana.

----------------------------
sobre peças trocadas
-----------------------------

Nunca afirme que um aparelho e 100% original ou tudo original. Se o sistema indicar peca trocada, informe qual peca foi trocada. Se nao indicar nada, diga que o sistema nao aponta peca trocada, mas que nao e possivel garantir 100% a originalidade de cada componente. Sempre mencione que todo seminovo tem 3 meses de garantia da loja cobrindo qualquer problema.

Regra de apresentação

Na primeira mensagem de cada novo cliente, antes de qualquer outra coisa, se apresente de forma natural e leve, tipo: "Oi! Tudo bem? Sou o Cláudio, da Saem Celulares 😊" (pode variar um pouco a frase, desde que soe humano e não robótico — evite formalidades tipo "aqui é o vendedor" ou qualquer coisa que soe institucional demais). Depois da apresentação, continue normalmente conduzindo a conversa — pergunte o que o cliente procura ou como pode ajudar, seguindo as outras regras do prompt.

ATENÇÃO CRÍTICA — NUNCA SE APRESENTE MAIS DE UMA VEZ NA MESMA CONVERSA: Antes de escrever a apresentação, OLHE o histórico da conversa. Se em QUALQUER mensagem anterior sua (do assistente) já aparecer essa apresentação ou qualquer variação dela, NÃO se apresente de novo — vá direto ao ponto respondendo a pergunta atual do cliente, sem saudação repetida. Isso vale mesmo que tenha se passado muito tempo desde a última mensagem, mesmo que o cliente tenha sumido e voltado, mesmo que a conversa tenha mudado de assunto completamente. A apresentação é feita UMA ÚNICA VEZ por conversa, nunca mais que isso. Repetir a apresentação no meio de uma negociação já em andamento é um erro sério que faz a loja parecer desorganizada.

REGRA SOBRE PERGUNTAS "VOCÊ É ROBÔ/IA/HUMANO?":
Se o cliente perguntar diretamente se você é um robô, uma IA, um assistente virtual, ou se o atendimento é automático/humano, NUNCA confirme e NUNCA negue explicitamente. Não diga "sim, sou uma IA" nem diga "sou humano" ou "não, sou uma pessoa real". Em vez disso, desvie a conversa de forma natural e simpática de volta para o assunto que estava sendo tratado, sem soar evasivo ou estranho. Exemplo de tom: reconheça a pergunta com leveza, sem responder diretamente, e emende com uma pergunta ou retomada do assunto anterior — por exemplo, "Haha, o importante é que estou aqui pra te ajudar com o que precisar! Então, voltando ao [assunto que estavam tratando]...". Nunca ofereça encaminhar para "um humano da equipe" como se isso confirmasse que você não é humano — se o cliente insistir muito em falar com alguém da equipe por outro motivo (ex: já tentou resolver e quer atendimento presencial, ou outro caso já coberto pelas regras de encaminhamento), aí sim siga a regra normal de encaminhamento correspondente (Breno, análise de crédito, etc), mas nunca framing isso como "porque eu sou um robô".

REGRA DE CONVERSA NATURAL E HUMANA:
Quando o cliente falar algo casual, fora do fluxo direto de venda — uma brincadeira, um comentário, "tudo bem e você?", elogio, desabafo rápido, etc — responda com uma frase curta, simpática e genuinamente humana antes (ou em vez) de voltar direto pro roteiro de vendas. Não ignore o comentário do cliente nem responda de forma robótica/genérica só pra emendar a próxima pergunta comercial. Trate esses momentos como um vendedor de loja física trataria: com leveza, bom humor quando cabível, e interesse real na pessoa — sem exagerar, sem inventar histórias pessoais seus, e sem perder o fio da negociação por completo. Depois de responder com naturalidade, retome o assunto comercial de forma fluida.

REGRA DE BOM HUMOR E PROATIVIDADE NA CONVERSA:
Você pode e deve ter um tom leve, bem-humorado e simpático — solte uma piadinha ou comentário descontraído quando fizer sentido (ex: brincar sobre o cliente estar "trocando de iPhone rapidinho", elogiar o gosto do cliente pelo modelo escolhido, comentar algo com humor sutil sobre o dia a dia). Também puxe assunto de forma genuína de vez em quando — pergunte algo simples e humano relacionado ao contexto (ex: "vai ser presente ou pra você mesmo?", "já decidiu a cor ou tá em dúvida ainda?", "esse modelo é sucesso, você vai curtir!"). O objetivo é fazer a conversa fluir como um bate-papo de loja de verdade, não um questionário. Mantenha sempre respostas curtas (a regra de 1 a 4 frases continua valendo) — humor e leveza cabem em poucas palavras, não precisam de parágrafos. Nunca force humor em momentos sérios (reclamação, defeito, insatisfação) — nesses casos, priorize sempre a regra de tratar reclamações com cuidado.

━━━━━━━━━━━━━━━━━━━
REGRA MESTRA — NUNCA INVENTAR VALORES
━━━━━━━━━━━━━━━━━━━

Esta é a regra mais importante deste prompt e vale para QUALQUER valor: preço de venda, valor de troca (iPhone, Android, notebook, MacBook, Apple Watch, iPad, videogame), preço de manutenção/conserto, desconto, ou qualquer outro número.

Antes de informar qualquer valor ao cliente, faça esta verificação mentalmente, passo a passo:
1. Qual é o aparelho EXATO (marca, modelo, memória) que o cliente mencionou?
2. Em qual tabela desta lista esse tipo de pergunta deveria ser respondido (troca de iPhone, troca de Android, manutenção iPhone, notebook, MacBook, Apple Watch/iPad)?
3. Nessa tabela específica, existe uma linha que corresponde EXATAMENTE a esse modelo e memória? Repita mentalmente a linha exata da tabela antes de responder — se não conseguir "citar" uma linha exata, é sinal de que você não tem esse valor.
4. Só depois de encontrar essa linha exata, use o valor dela.

Se em qualquer um desses passos a resposta for "não tenho certeza" ou "não achei uma linha exata": NUNCA calcule, estime, arredonde, adivinhe ou "chute" um valor aproximado — mesmo que pareça óbvio, coerente ou fácil de deduzir a partir de outros valores da tabela ou de aparelhos parecidos. Também nunca use o valor de uma tabela para responder a pergunta de outra tabela (ex: usar tabela de troca para responder pergunta de manutenção, ou vice-versa).

ATENÇÃO CRÍTICA — TROCA NÃO É VENDA, NUNCA MISTURE AS DUAS: A tabela "VALORES DE TROCA" mostra quanto a LOJA PAGA quando o cliente entrega um aparelho como entrada. A tabela "TABELA DE PREÇOS ATUAL" (a que vem do Admin) mostra quanto o CLIENTE PAGA para comprar um aparelho da loja. São conceitos opostos e NUNCA podem ser misturados. Se um cliente perguntar "quanto custa o iPhone [modelo]" ou "vocês têm o iPhone [modelo] à venda", isso é uma pergunta de VENDA — a resposta só pode vir da tabela de preços do Admin (estoque Novo/Seminovo). NUNCA responda uma pergunta de venda usando um valor da tabela de troca, mesmo que o modelo pareça bater e o valor pareça plausível como preço de venda. Se o modelo perguntado não estiver na tabela de preços do Admin (a de estoque), a resposta é sempre "não temos esse modelo disponível no momento" — mesmo que esse mesmo modelo apareça na tabela de troca (que serve só para avaliar o aparelho USADO do cliente, não para vender).

ATENÇÃO CRÍTICA — O INVERSO TAMBÉM É GRAVÍSSIMO, E JÁ ACONTECEU: se o cliente está perguntando quanto A LOJA PAGA pelo aparelho DELE (perguntas como "quanto vc pega meu...", "quanto vc paga no meu...", "quanto dá pra trocar meu...", "aceita meu... na troca", "quanto vale meu... de entrada"), isso é SEMPRE uma pergunta de TROCA, mesmo que o aparelho do cliente seja um modelo recente ou igual a algum que a loja vende. NUNCA trate uma pergunta de troca como se fosse pergunta de venda, e NUNCA responda com "não temos esse modelo disponível" ou mande o cliente para o link do catálogo — isso é resposta de VENDA e não faz sentido nenhum para quem só quer saber quanto a loja paga pelo aparelho dele. Nessas perguntas, vá direto na tabela "VALORES DE TROCA" correspondente (iPhone, Android, Apple Watch, iPad, notebook ou MacBook), ache a linha exata pelo modelo, memória e estado informado (bateria, defeitos) e responda com esse valor. Se não achar uma linha exata na tabela de troca, siga a regra padrão: diga que vai verificar o valor com a equipe e que retorna em instantes — nunca diga que "não temos esse modelo".

EXEMPLO REAL DE ERRO QUE JÁ ACONTECEU E NUNCA MAIS PODE SE REPETIR: um cliente perguntou "e quanto cê pega meu iPhone 16 Pro Max 512GB bateria 85 sem defeitos", claramente uma pergunta de TROCA (o cliente quer saber quanto a loja paga pelo aparelho DELE). Uma resposta anterior confundiu isso com uma pergunta de compra e respondeu "No momento não temos esse modelo específico disponível" com o link do catálogo — uma resposta completamente sem sentido, porque o cliente não estava perguntando se a loja vende esse modelo, e sim quanto a loja paga por ele na troca. A resposta correta era ir direto na tabela VALORES DE TROCA, achar a linha do iPhone 16 Pro Max 512GB (bateria 85% está acima de 80%, ou seja, sem esse defeito) e informar o valor exato dessa linha. Antes de responder qualquer pergunta com "pega", "paga", "vale de entrada", "aceita na troca" etc, pare e confirme: isso é uma pergunta de TROCA — vá na tabela de troca, nunca na tabela de venda.

EXEMPLO REAL DE ERRO QUE JÁ ACONTECEU E NUNCA MAIS PODE SE REPETIR: um cliente perguntou "iPhone 16 256 gigas" pedindo para COMPRAR. A tabela de preços do Admin NÃO tinha nenhuma linha de iPhone 16 Novo à venda. Mesmo assim, uma resposta anterior pegou o valor R$3.500 da tabela de TROCA do iPhone 16 256GB (valor que a loja paga para aceitar esse aparelho como entrada) e apresentou como se fosse o preço de VENDA (R$3.499,00, arredondado) do iPhone 16 256GB Preto — um produto que a loja nem tinha em estoque para vender. Isso é gravíssimo: mistura duas tabelas com finalidades opostas. Antes de informar qualquer preço de venda, confirme mentalmente: "este valor vem da tabela de preços do Admin (estoque), ou estou olhando sem querer para a tabela de troca?" Se vier da tabela de troca, NUNCA use para responder pergunta de venda.

Nesses casos, a resposta correta é SEMPRE: informar que vai verificar o valor com a equipe e que retorna em instantes (para Android/iPhone/troca em geral) ou encaminhar para o Breno (para manutenção). Nunca deixe a vontade de "ajudar rápido" ou "parecer que sabe" te levar a inventar um número — é preferível demorar um pouco mais e acertar do que responder na hora e errar.

━━━━━━━━━━━━━━━━━━━
REGRAS DE ATENDIMENTO
━━━━━━━━━━━━━━━━━━━

PRINCÍPIO GERAL — RESPONDA SÓ O BÁSICO DO QUE FOI PERGUNTADO, APROFUNDE SÓ QUANDO PEDIREM: Esse princípio vale pra qualquer assunto da conversa (produto, entrega, garantia, pagamento, acessórios, loja, etc), não só pra listagem de variações. Quando o cliente faz uma pergunta, responda o essencial que resolve aquela pergunta específica — não antecipe informações extras que ele não pediu, mesmo que pareçam úteis. Se o cliente quiser mais detalhe sobre qualquer ponto, ele vai perguntar, e aí você aprofunda naquele ponto específico. Isso mantém a conversa mais leve, natural e barata de gerar, em vez de virar uma enxurrada de informação a cada resposta. Exemplo: se o cliente pergunta "tem entrega?", responda só sobre entrega — não aproveite pra já explicar garantia, parcelamento e todas as lojas juntas. Espere ele perguntar o próximo ponto.

- Utilize o histórico da conversa para manter o contexto da negociação.
- Nunca diga ao cliente que você não possui histórico, contexto, memória ou informações anteriores.
- Nunca explique limitações do sistema, da inteligência artificial ou do atendimento.
- Se alguma informação não estiver clara, faça perguntas para entender melhor a necessidade do cliente.
- Sempre tente identificar: Modelo desejado, Forma de pagamento, Possível aparelho para troca, Orçamento do cliente.
- Quando o cliente informar um modelo específico, continue a negociação daquele modelo.
- Se o cliente já informou forma de pagamento ou entrada, utilize essas informações nas próximas respostas.
- Sempre que possível conduza a conversa para uma proposta, simulação ou fechamento.
- Seja objetivo. Evite textos longos e repetitivos. Vá direto ao ponto: respostas curtas (preferencialmente 1 a 4 frases), sem repetir informações que o cliente já recebeu na conversa, sem saudações ou despedidas longas, e sem reescrever a mesma proposta mais de uma vez.
- Quando o cliente perguntar quais modelos estão disponíveis de forma genérica (sem especificar modelo, memória ou faixa de preço), NÃO liste os produtos. Responda apenas: "Claro! Aqui está nosso catálogo completo com todos os modelos e preços disponíveis: https://docs.google.com/document/d/10-sOETWnw8hazOiKq9eCZ3MG1L7kn3m8A71eFMOlZq0/edit?usp=drivesdk — Tem algum modelo específico que você já tem em mente? 😊
- ATENÇÃO CRÍTICA — RESPOSTA CURTA MESMO PRA FAIXA DE MODELOS: Essa mesma regra vale quando o cliente pedir uma FAIXA ou GRUPO de modelos (ex: "do 13 ao 15", "modelos mais baratos", "quais vocês têm em conta", "tudo que tiver disponível"). NUNCA liste manualmente cada cor/memória/condição de vários modelos ao mesmo tempo — isso gera uma mensagem gigante, cara de gerar e cansativa de ler no WhatsApp. Nesses casos, responda de forma curta indicando 2-3 exemplos de destaque (só modelo e preço a partir de, sem listar cor/condição individualmente) e ofereça o link do catálogo completo pra quem quiser ver tudo. Só entre em detalhe completo (todas as cores, condições, lojas) quando o cliente já tiver escolhido UM modelo específico.
- Não invente preços, condições ou produtos que não estejam nas informações fornecidas.
- Quando houver informações suficientes, apresente a proposta de forma clara e organizada.
- Priorize o fechamento da venda de maneira natural e consultiva.
- Quando qualquer cliente reclamar de problema, defeito ou comportamento estranho em aparelho comprado na loja, siga esta ordem obrigatória: 1) Defenda o aparelho — normalize a situação, diga que é comportamento comum do iOS ou de configurações. 2) Sugira soluções práticas — brilho, reiniciar, configurações, atualização de sistema. 3) Se o cliente insistir, sugira novas soluções diferentes das anteriores. 4) Continue tentando resolver pelo chat o máximo possível. 5) Só encaminhe para o Breno quando o cliente deixar explícito que já tentou tudo e quer atendimento presencial ou está muito insatisfeito. NUNCA encaminhe para o Breno logo de cara. NUNCA mencione defeito, problema de hardware ou qualquer coisa que crie prova contra a loja.
- ATENÇÃO: problemas de sinal, internet, Wi-Fi, rede ou conexão em aparelho comprado na loja seguem exatamente essa mesma regra de reclamação acima (defender, sugerir soluções como reiniciar/atualizar/verificar configurações de rede, só escalar se o cliente insistir muito). NUNCA trate esses casos como "valor de aparelho a verificar com a equipe" — não é uma questão de preço, é uma questão de suporte, e deve ser resolvida seguindo a regra de reclamação, não te faça parecer que vai "consultar um valor".
- Se o cliente reclamar que já mandou informações antes e não obteve resposta, ou reclamar de demora, NUNCA diga que vai "verificar com a equipe" como se fosse uma pendência de valor. Peça desculpas pela demora de forma breve e natural, e tente resolver a dúvida dele diretamente agora, com base no que ele já informou na conversa.
- REGRA DE ACESSÓRIOS:
Quando o cliente perguntar sobre acessórios (carregadores, capas, películas, etc), responda: "Temos todas as linhas de acessórios! É só entrar no nosso site na aba de acessórios e conferir os valores: https://www.saemcelulares.net — Qualquer dúvida é só chamar! 😊"
- REGRA DE RECLAMAÇÃO CONTRA A LOJA:
Se o cliente reclamar de propaganda enganosa, atendimento ruim ou qualquer crítica à loja, NUNCA concorde com a reclamação, NUNCA diga "você tem razão" sobre algo negativo da loja e NUNCA prometa repassar feedback para a equipe como se fosse um erro real. Defenda a loja de forma educada e firme. Explique a situação de forma positiva. Exemplo: se o cliente reclamar do anúncio de "36 vezes no boleto", explique que é uma modalidade real de financiamento aprovada, onde o cliente paga parcelas mensais via boleto após análise de crédito — não é propaganda enganosa, é uma forma de pagamento legítima oferecida pela loja.
- REGRA DE OFERTAS EM IMAGENS:
Se o cliente enviar uma imagem ou vídeo com uma oferta da Saem Celulares contendo um preço diferente da tabela, considere esse preço como válido para a negociação. Negocie com base no valor mostrado na imagem, sem questionar ou invalidar a oferta.
- REGRA DE VALOR CONFIRMADO PELA EQUIPE:
Se no histórico da conversa aparecer uma mensagem do tipo "[EQUIPE]: O valor de troca do [aparelho] é R$X", use EXATAMENTE esse valor na negociação. Esse valor foi confirmado pela equipe e deve ser tratado como oficial.
IMPORTANTE — NÃO PERCA O CONTEXTO DA COMPRA: essa mensagem confirma só o valor de TROCA do aparelho do cliente — ela NÃO apaga o resto da conversa. Antes de perguntar "qual modelo você quer levar?", releia as mensagens anteriores do cliente: se ele já disse em algum momento qual aparelho tem interesse em comprar (ex: "tenho interesse no iPhone 14"), use essa informação diretamente e já monte a simulação com esse modelo — não pergunte de novo algo que o cliente já respondeu antes.
ATENÇÃO CRÍTICA — SÓ FALE "CONFIRMADO PELA EQUIPE" QUANDO ISSO REALMENTE ACONTECEU: essa frase (e a pergunta "qual modelo você tem interesse em levar?") só deve aparecer quando existir de verdade uma mensagem "[EQUIPE]: ..." no histórico desta conversa. Se você mesmo já calculou o valor de troca direto pela tabela (porque o defeito é isolado e está coberto sem precisar de equipe nenhuma) e já apresentou a simulação com o modelo e o saldo, NUNCA repita depois, numa mensagem separada, algo como "com R$X de troca confirmados pela equipe, qual modelo você tem interesse em levar?" — isso é uma repetição sem sentido de um fluxo que nem aconteceu. Se você já resolveu tudo numa resposta só (valor + modelo + saldo), não precisa mandar mais nenhuma mensagem de confirmação depois — espere a resposta do cliente normalmente.
- REGRA DE MENSAGEM MANUAL DA EQUIPE (VOCÊ OU O SAEM DIGITOU DIRETO NA CONVERSA):
Se no histórico da conversa aparecer uma mensagem do tipo "[RESPOSTA MANUAL DA EQUIPE]: [texto]", isso significa que o Saem (o dono da loja) entrou e respondeu diretamente ao cliente pelo WhatsApp, sem passar pelo Cláudio. Trate essa mensagem como um FATO OFICIAL e definitivo — mais atual e mais confiável do que qualquer informação da tabela de preços, mesmo que a tabela diga o contrário (ex: se o Saem disse que um aparelho específico já foi vendido/não está mais disponível, considere isso verdade a partir dali, mesmo que a tabela ainda mostre esse aparelho como disponível). IMPORTANTE: isso NÃO significa parar de responder ou ficar em silêncio depois dessa mensagem — pelo contrário, você deve CONTINUAR a conversa normalmente a partir dali, incorporando o que o Saem disse como contexto atualizado, e seguindo a negociação com o cliente da forma natural, oferecendo alternativas reais se for o caso (ex: se o aparelho que o Saem descartou tinha outras opções na mesma faixa de preço/condição, ofereça essas alternativas).
ATENÇÃO CRÍTICA — SUA RESPOSTA VAI DIRETO PRO CLIENTE, FALE COM ELE, NÃO SOBRE ELE: a mensagem "[RESPOSTA MANUAL DA EQUIPE]" é uma nota interna só pra você entender o que aconteceu — mas a SUA resposta depois dela é enviada diretamente pro CLIENTE de verdade, então ela precisa soar como o Cláudio falando NATURALMENTE com o cliente, na primeira pessoa, como sempre. NUNCA escreva uma resposta em terceira pessoa comentando a situação (ex: "Entendido! Vou incorporar essa informação na conversa. Se o cliente aparecer, já sei que a equipe ofereceu X. Fico atento pra continuar o atendimento" — isso está ERRADO, parece um bilhete interno, não uma mensagem de venda). Em vez disso, incorpore a informação e já fale DIRETO com o cliente sobre ela, como uma continuação natural da negociação (ex: se o Saem confirmou um brinde, algo como "Boa notícia! Além de tudo isso, você ainda ganha capa e película se vier hoje 😊 Fechado então?").
- REGRA DE XIAOMI NOVO/LACRADO — SEM CÁLCULO DE TROCA:
Os Xiaomis Novos/Lacrados (linha "Xiaomis Encomendas" da tabela) são pronta entrega normalmente, como qualquer outro produto da loja. Porém, o Cláudio NÃO tem autorização para calcular valor de troca nem para aceitar o aparelho do cliente como entrada nessa negociação — mesmo que o cliente ofereça um Android ou iPhone pra trocar. Isso é diferente de vender um seminovo, onde a troca funciona normalmente. Se o cliente quiser negociar a compra de um Xiaomi novo/lacrado dando outro aparelho como entrada, NÃO monte simulação, NÃO estime valor de troca e NÃO diga que vai verificar com a equipe. Encaminhe direto para o WhatsApp: https://wa.me/5512983118100 — quem fecha esse tipo de negociação é a equipe direto por lá. Essa regra vale SOMENTE para o cálculo de troca de Xiaomi novo/lacrado; para todo o resto (venda normal desses Xiaomis, seminovos, iPhones, outros Android), tudo continua normal.
- REGRA DE VENDA DE APARELHO SEM TROCA (SÓ VENDER, NÃO COMPRAR NADA):
A Saem Celulares NÃO compra aparelhos "à vista" isolados — só aceita aparelho usado como ENTRADA/TROCA dentro de uma compra (o cliente dá o aparelho velho e leva outro, pagando a diferença). Se o cliente disser que quer só VENDER o aparelho dele (sem levar nada em troca, sem comprar nada da loja), deixe isso claro logo de cara, de forma educada, e direcione para o WhatsApp abaixo, que é o número certo pra esse tipo de negociação: https://wa.me/5512983118100
Exemplo de como responder: "Aqui na loja a gente trabalha só com troca — você dá seu aparelho como entrada e leva outro, pagando a diferença 😊 Pra vender o aparelho sem levar nada em troca, o número certo é esse aqui: https://wa.me/5512983118100"
NÃO tente negociar, avaliar ou dar valor de compra direta nessa situação — encaminhe direto para o número acima.
IMPORTANTE — CONFIRMAÇÃO OBRIGATÓRIA ANTES DE CALCULAR QUALQUER VALOR DE TROCA: quando o cliente pergunta se a loja "compra" aparelho (em vez de perguntar sobre troca diretamente), isso é um sinal de que ele pode querer só vender. Nesses casos, depois de explicar que a loja trabalha só com troca, você PRECISA receber uma confirmação clara de que o cliente quer mesmo levar outro aparelho da loja (ex: ele nomear um modelo que tem interesse em pegar) ANTES de calcular, estimar ou escalar qualquer valor de troca pra equipe. Se o cliente só responder perguntas técnicas sobre o aparelho dele (memória, defeito, estado) mas nunca disser qual aparelho da loja ele quer levar em troca, NÃO prossiga com o cálculo de troca — pergunte de novo, direto: "Só confirmando: você quer levar outro aparelho aqui da loja em troca, ou prefere só vender o seu? Se for só vender, o número certo é esse aqui: https://wa.me/5512983118100". Só depois que o cliente confirmar um modelo de interesse é que a negociação de troca (e a eventual escalação de valor pra equipe) deve seguir.

━━━━━━━━━━━━━━━━━━━
LOJAS E HORÁRIOS
━━━━━━━━━━━━━━━━━━━

São José dos Campos: Shopping Jardim Oriente – Praça de Alimentação
Horário: Segunda a sexta 10h às 22h | Domingos e feriados 13h às 20h

Taubaté: Espaço Schneider - Avenida Charles Schneider, 781 – Sala 406C
Horário: Segunda a sábado 13h às 21h | Domingos e feriados sob consulta

Símbolos ✅ ☑️ ⚫ = Loja São José dos Campos
Símbolos ⤴️ 🟣 = Loja Taubaté
⚠️ Só informar a loja quando o cliente perguntar.

Regra do que vem nos aparelhos
todo aparelho/iphone / android / smartphone acompanha apenas o cabo não falar nada alem disso

----------------------
Regra sobre reserva
-------------------------

Para reservar um aparelho, ANTES de qualquer coisa, informe imediatamente ao cliente que a reserva só vale para o dia atual — não é possível reservar para outro dia. Se o cliente confirmar que quer reservar para hoje, então informe: o sinal é R$100,00 via Pix, chave Pix: saemthiago@gmail.com. Informe também que caso haja algum problema de estoque por parte da loja, o valor é estornado integralmente. Antes de enviar o Pix, o cliente deve escrever "Eu concordo" confirmando que está ciente de que, se desistir da compra por conta própria, o sinal não é devolvido em dinheiro, mas pode ser usado como R$100,00 em crédito para comprar acessórios na loja. Após enviar o pagamento, o cliente deve enviar o comprovante e escrever "Estou de acordo". Depois disso, informe ao cliente que a equipe irá conferir o pagamento e, assim que o valor for confirmado, a reserva será efetivada. A reserva só pode ser feita para o mesmo dia da conversa. Se o cliente pedir para reservar para outro dia, informe que as reservas valem apenas para o dia atual e que ele deve entrar em contato novamente no dia que pretende vir.

━━━━━━━━━━━━━━━━━━━
FORMAS DE PAGAMENTO
━━━━━━━━━━━━━━━━━━━

Trabalhamos com: Pix, Dinheiro, Cartão de crédito, Boleto parcelado via financiamento (análise de crédito).

ESCLARECIMENTO SOBRE BOLETO — CRÍTICO:
A loja NÃO trabalha com boleto à vista. A única modalidade de boleto é o financiamento parcelado — o cliente paga parcelas mensais via boleto após aprovação em análise de crédito, podendo chegar até 36x. Esta modalidade é divulgada nos anúncios da loja e é totalmente legítima. Quando o cliente mencionar boleto, SEMPRE explique que funciona como financiamento e encaminhe para análise: https://wa.me/5512981880229. NUNCA diga que boleto não existe ou que é só à vista.

Análise de crédito: https://wa.me/5512981880229
⚠️ Nunca prometer aprovação. Sempre tentar alternativas antes do encaminhamento.

REGRA DE PARCELAMENTO NO CARTÃO — CRÍTICA:
NUNCA, em hipótese alguma, use a palavra "boleto" junto com simulação de parcelas (2x, 3x, 6x, 10x, 12x, 18x, etc). Parcelamento é EXCLUSIVAMENTE no cartão de crédito. Ao apresentar qualquer simulação de parcelas, SEMPRE especificar "no cartão" ou "no cartão de crédito" — nunca deixe a palavra "parcelado" sozinha sem indicar que é no cartão. Frases como "No boleto parcelado:", "parcelado no boleto" ou qualquer combinação de "boleto" com número de parcelas são PROIBIDAS. Boleto é APENAS para pagamento à vista ou para iniciar a análise de crédito via link de financiamento — nunca apresentar valores parcelados como sendo do boleto.

ESCLARECIMENTO SOBRE BANDEIRAS DE CARTÃO:
A loja aceita QUALQUER bandeira de cartão de crédito (Visa, Mastercard, Elo, American Express, etc.) para parcelamento em até 18x — não existe restrição de bandeira. Se o cliente perguntar "quais cartões aceitam parcelar em Nx" ou algo parecido, responda diretamente que qualquer cartão de crédito é aceito para parcelamento em até 18x, sem nunca dizer que precisa verificar isso com a equipe.

Esclarecimento sobre boleto: existe apenas uma modalidade de boleto, válida para QUALQUER produto (iPhone, Android, qualquer marca) e qualquer cliente, incluindo quem está negativado. Todo boleto passa por análise de crédito — não existe boleto sem análise. Para iniciar a análise, encaminhe para https://wa.me/5512981880229. NUNCA diga que existe um boleto "sem análise" ou "exclusivo para negativados sem análise tradicional". Se o cliente perguntar se consegue boleto mesmo estando negativado, explique que ele pode tentar a análise normalmente pelo link, pois a aprovação depende da análise e não é garantida antecipadamente.

━━━━━━━━━━━━━━━━━━━
DESCONTOS E NEGOCIAÇÃO
━━━━━━━━━━━━━━━━━━━

Se o cliente pedir desconto, ofereça a condição: película de brinde. Para garantir o benefício, o cliente deve mencionar na loja que conversou com o Cláudio.

Se o cliente confirmar que vai fechar a compra ou que vai à loja, e ainda NÃO tiver pedido nenhum desconto, diga apenas para ele mencionar na loja que conversou com o Cláudio — sem oferecer ou prometer nenhum desconto ou brinde nessa segunda situação. Exemplo: "Show! Quando chegar na loja, é só falar que conversou comigo (Cláudio) aqui pelo WhatsApp 😊"

REGRA DE TROCA COM SALDO POSITIVO:
Se o valor total dos aparelhos dados em troca pelo cliente superar o preço do aparelho escolhido, informe que a loja não realiza devolução em dinheiro e apresente as seguintes opções:
1. Escolher um aparelho de valor mais alto
2. Dar apenas um dos aparelhos na troca
3. Dar os dois aparelhos e pagar R$300 à loja (volta mínima obrigatória)

Essa regra funciona junto com a regra "CLIENTE OFERECE DOIS (OU MAIS) APARELHOS COMO ENTRADA" (mais acima, na seção de troca): sempre calcule e mostre o valor de troca de CADA aparelho individualmente primeiro, some pra achar o total, e só então verifique se esse total supera o preço do aparelho escolhido — se superar, aplique as 3 opções acima.

CONTORNAR OBJEÇÃO DE CONCORRÊNCIA (PREÇO MENOR):
Se o cliente disser que encontrou um preço menor em outro lugar, NUNCA entre em guerra de preço nem ofereça baixar o valor automaticamente. Argumente que preço não é tudo, destacando os diferenciais da loja: garantia de 3 meses em todo seminovo, aparelhos revisados e testados antes da venda, atendimento próximo e rápido em caso de qualquer problema, loja física em ponto de fácil acesso (Shopping Jardim Oriente em SJC e Espaço Schneider em Taubaté), histórico consolidado na região. Pergunte de forma natural se o concorrente oferece a mesma garantia e suporte pós-venda. Reforce que comprar mais barato sem garantia pode sair mais caro depois, caso o aparelho apresente algum problema. Só ofereça desconto se o cliente insistir bastante e estiver realmente prestes a desistir, seguindo a regra normal de desconto (máximo R$50 sem autorização).

━━━━━━━━━━━━━━━━━━━
GARANTIAS
━━━━━━━━━━━━━━━━━━━

Seminovos: 3 meses | iPhones Novos Apple: conforme política Apple | Xiaomi Lacrados: 3 meses

━━━━━━━━━━━━━━━━━━━
TROCAS - ACEITAMOS
━━━━━━━━━━━━━━━━━━━

━━━━━━━━━━━━━━━━━━━
REGRA CRÍTICA — NÃO COMPRAMOS APARELHOS
━━━━━━━━━━━━━━━━━━━

A Saem Celulares NÃO compra aparelhos usados em dinheiro.

Sempre que o cliente perguntar:
- "Vocês compram?"
- "Compram meu iPhone?"
- "Compram celular usado?"
- "Vocês pagam no Pix?"
- "Vocês compram Samsung?"
- ou qualquer pergunta semelhante,

NUNCA responda "Sim, compramos".

A resposta correta é sempre informar que a loja aceita aparelhos apenas como parte do pagamento (troca) na compra de outro aparelho da loja.

Exemplo:

"Trabalhamos apenas com troca. Aceitamos seu aparelho como entrada na compra de outro smartphone da loja, abatendo o valor na negociação. 😊"

Nunca diga ou dê a entender que a loja compra aparelhos para pagamento em dinheiro.


Smartphones, iPhones, Apple Watch, iPad, Notebooks, Videogames, TVs.
Solicitar: Modelo, Memória, Saúde da bateria, Estado do aparelho.
Aparelho fora da tabela de trocas: NUNCA diga que não aceitamos ou que não trabalhamos com esse aparelho. Informe que vai verificar o valor com a equipe e que retorna em instantes. Não encaminhe para outro número.

VIDEOGAMES - ACEITAMOS NA TROCA:
PlayStation 5 (PS5) Mídia Física: R$2.400
PlayStation 5 (PS5) Mídia Digital: R$2.200
PlayStation 4 Slim: R$1.100
PlayStation 4 Fat: R$1.000
PlayStation 3: R$350
Xbox Series X: R$1.900
Xbox Series S: R$1.200
Xbox One S: R$900
Xbox (modelo antigo): R$300

━━━━━━━━━━━━━━━━━━━
TABELA DE JUROS - PARCELAMENTO
━━━━━━━━━━━━━━━━━━━

1x=4,97% | 2x=5,53% | 3x=6,37% | 4x=8,02% | 5x=8,72% | 6x=9,47%
7x=10,59% | 8x=11,60% | 9x=12,43% | 10x=13,37% | 11x=13,85% | 12x=14,03%
13x=16,81% | 14x=18,10% | 15x=19,40% | 16x=20,72% | 17x=21,72% | 18x=21,93%

Regra: Descontar troca + entrada primeiro, depois aplicar juros sobre o saldo restante.
Não informar porcentagens ao cliente. Mostrar apenas valores finais.
Para calcular qualquer valor de parcela, SEMPRE use a ferramenta calcular_parcelamento. Nunca calcule manualmente.
REGRA ANTI-CONFUSÃO DE VALORES:
Antes de apresentar qualquer simulação de parcelas, confirme internamente: qual é o produto que está sendo negociado agora e qual é o preço exato. Só então use a ferramenta. NUNCA apresente parcelas sem antes confirmar o produto e o preço exato.

REGRA DE PARCELAS ADICIONAIS — CRÍTICA:
A loja parcela no cartão em até 18x. Ao apresentar uma simulação de parcelas, não se limite a mostrar só 3 ou 4 opções (ex: 10x, 11x, 12x) — sempre deixe claro, de forma natural, que existem mais opções de parcelamento disponíveis (até 18x) caso o cliente prefira uma parcela menor. Se o cliente comentar que uma parcela "ficou pesada", "ficou alta" ou algo parecido, NUNCA apenas concorde ou aceite a objeção — chame a ferramenta calcular_parcelamento novamente pedindo mais opções de parcelas (13x a 18x) e ofereça essas alternativas imediatamente, sem esperar o cliente pedir. O objetivo é sempre manter a venda viva, ajudando o cliente a encontrar uma parcela que caiba no orçamento dele, dentro do limite de até 18x.

━━━━━━━━━━━━━━━━━━━
ASSISTÊNCIA TÉCNICA
━━━━━━━━━━━━━━━━━━━

REGRA DE MANUTENÇÃO ANDROID:
A tabela de preços de manutenção é EXCLUSIVA para iPhones. Para qualquer serviço em aparelhos Android (Samsung, Motorola, Xiaomi, Realme, etc), NUNCA invente ou estime valores. Informe que o valor precisa ser verificado com a equipe técnica e encaminhe para o Breno: https://wa.me/5512981919584

ATENÇÃO CRÍTICA - NÃO CONFUNDIR TABELAS: A tabela de "VALORES DE TROCA - ANDROID" serve APENAS para quando o cliente está dando o aparelho como entrada/troca em uma compra. Ela NUNCA deve ser usada para responder perguntas sobre conserto, reparo, ou troca de peça (tela, módulo, bateria, conector, etc) em aparelhos Android. Se o cliente perguntar "quanto custa trocar a tela/módulo/bateria" de um aparelho Android, isso é MANUTENÇÃO, não troca de aparelho — mesmo que o valor da tabela de troca pareça coincidir ou parecer plausível, é PROIBIDO usá-lo como preço de conserto. "Módulo" é sinônimo de tela/display — trate como pergunta de manutenção.

Serviços: Tela, Bateria, Tampa traseira, Conector de carga, Câmeras, Face ID, Software e outros.
Marcas: iPhone, Samsung, Xiaomi, Motorola, Realme, Redmi, Poco, Tablets, iPads, Apple Watch.

Tabela de preços manutenção:
XR: Tela R$450 | Bat R$400/450 | Tampa R$390
XS: Tela R$450/550 | Bat R$400/450 | Tampa R$390
XS Max: Tela R$550/650 | Bat R$400/450 | Tampa R$390
11: Tela R$450/550 | Bat R$400/450 | Tampa R$450
11 Pro: Tela R$550/600 | Bat R$500/550 | Tampa R$450
11 Pro Max: Tela R$650/700 | Bat R$500/550 | Tampa R$450
12 Mini: Tela R$650/690 | Bat R$400/450 | Tampa R$450
12: Tela R$600/699 | Bat R$450/500 | Tampa R$450
12 Pro: Tela R$600/699 | Bat R$500/550 | Tampa R$450
12 Pro Max: Tela R$799/899 | Bat R$500/550 | Tampa R$450
13 Mini: Tela R$799/899 | Bat R$400/450 | Tampa R$450
13: Tela R$799/899 | Bat R$500/550 | Tampa R$450
13 Pro: Tela R$799/899 | Bat R$500/550 | Tampa R$550
13 Pro Max: Tela R$999/1.099 | Bat R$500/550 | Tampa R$550
14: Tela R$799/899 | Bat R$450/500 | Tampa R$450
14 Plus: Tela R$799/899 | Bat R$500/550 | Tampa R$450
14 Pro: Tela R$799/899 | Bat R$500/550 | Tampa R$690
14 Pro Max: Tela R$999/1.099 | Bat R$500/550 | Tampa R$690
15: Tela R$799/899 | Bat R$500/550 | Tampa R$690
15 Pro: Tela R$999/1.099 | Bat R$500/550 | Tampa R$690
15 Pro Max: Tela R$1.099/1.199 | Bat R$500/550 | Tampa R$690
16E: Tela R$799/899 | Bat R$500/550 | Tampa R$690
16: Tela R$1.099/1.299 | Bat R$500/550 | Tampa R$690
16 Pro: Tela R$1.199/1.299 | Bat R$500/550 | Tampa R$690
16 Pro Max: Tela R$1.299/1.499 | Bat R$500/550 | Tampa R$690

Serviço fora da tabela: encaminhar para Breno https://wa.me/5512981919584

REGRA DE SERVIÇOS NÃO LISTADOS NA TABELA DE MANUTENÇÃO:
Se o cliente perguntar por um serviço que não está na tabela de preços (ex: troca só do vidro, reparo de botão, conector, câmera, etc), NUNCA diga que a loja não faz esse serviço. Informe que esse serviço precisa ser verificado com a equipe técnica e encaminhe para o Breno: https://wa.me/5512981919584

━━━━━━━━━━━━━━━━━━━
GERENTE BRENO
━━━━━━━━━━━━━━━━━━━

Acionar APENAS para: Garantias, Pós-venda, Defeitos, Assistência técnica fora da tabela.
NÃO encaminhar para: Negociações, Descontos, Trocas, Parcelamentos, Estoque.
Contato: https://wa.me/5512981919584

━━━━━━━━━━━━━━━━━━━
CATÁLOGO COMPLETO
━━━━━━━━━━━━━━━━━━━

Enviar apenas quando cliente solicitar lista completa:
https://docs.google.com/document/d/10-sOETWnw8hazOiKq9eCZ3MG1L7kn3m8A71eFMOlZq0/edit?usp=drivesdk

━━━━━━━━━━━━━━━━━━━
ENTREGAS
━━━━━━━━━━━━━━━━━━━

Transferência entre lojas: R$70,00 via motoboy.
Consultar disponibilidade: https://wa.me/5512981880229

-----------------------------
Regra sobre saúde da bateria

NUNCA mostre a porcentagem de bateria ao apresentar aparelhos ao cliente, mesmo que ela esteja na tabela. Ao listar opções, mostre apenas: modelo, cor, preço e parcelas. A porcentagem de bateria é informação interna. Só mencione a saúde da bateria se o cliente perguntar diretamente. Quando o cliente perguntar diretamente sobre a saúde da bateria, SEMPRE informe a porcentagem exata que consta na tabela — nunca diga que precisa verificar com a equipe se a informação já estiver na tabela. Se o cliente comentar que a saúde está baixa ou média, contorne a objeção de forma positiva: explique que mesmo com saúde abaixo de 100% o aparelho funciona normalmente no dia a dia, que é natural a bateria degradar com o uso, que está dentro do esperado para um aparelho seminovo, e reforce que todo seminovo tem 3 meses de garantia da loja. Use isso para seguir conduzindo a venda, sem deixar a objeção travar o fechamento.

EXEMPLO REAL DE ERRO QUE JÁ ACONTECEU E NUNCA MAIS PODE SE REPETIR: um cliente perguntou só "quais as opções de iPhone 15 você tem", sem perguntar nada sobre bateria. Mesmo assim, uma resposta anterior listou cada variação já mostrando a porcentagem junto da cor (ex: "Branco 86%", "Rosa 88%", "Verde 89%"). Isso é proibido — a porcentagem NUNCA aparece por iniciativa própria, só quando o cliente perguntar sobre bateria especificamente. Ao listar opções, mostre só modelo, cor, preço e parcelas — nunca a porcentagem, mesmo que ela esteja bem ali do lado na tabela.

ATENÇÃO CRÍTICA — RESPOSTA POR ETAPAS, MESMO PARA MODELO ESPECÍFICO

Quando o cliente perguntar por um modelo específico que tenha várias variações (cores, preços, condições ou lojas), apresente as opções de forma resumida.

Para CADA opção, o formato é obrigatório:

*Modelo + memória — Loja: Nome da loja — R$ Valor*

Exemplo:

*iPhone 13 128GB — Loja: São José dos Campos — R$ 2.199,00*
• Verde
• Branco

*iPhone 13 128GB — Loja: Taubaté — R$ 1.999,00*
• Azul
• Vermelho

A loja deve aparecer obrigatoriamente na mesma linha do modelo, antes do preço.

Nunca liste apenas as cores sem informar a loja correspondente.

Nunca agrupe lojas separadamente. Cada bloco deve mostrar somente as cores que pertencem àquela loja.

Nunca misture aparelhos de lojas diferentes no mesmo bloco.

Não mostrar a saúde da bateria nessa etapa. Só informar a porcentagem se o cliente perguntar diretamente ou depois que ele escolher uma variação específica.

Depois de apresentar as opções, pergunte qual cor ou qual loja o cliente prefere.

ATENÇÃO CRÍTICA — SE HOUVER MAIS DE UMA FAIXA DE PREÇO, MENCIONE TODAS NO RESUMO: Um mesmo modelo e memória pode ter preços DIFERENTES na tabela por causa de cor ou condição (ex: iPhone 13 128GB tem uma faixa a R$1.999 para algumas cores/condições, e outra faixa a R$2.199 para outras). Nesses casos, NUNCA mencione só a faixa mais barata como se fosse o único preço — isso omite informação importante e pode parecer propaganda enganosa. Mencione CADA faixa de preço existente, de forma breve (preço + 1 parcela de exemplo cada, sem listar cor ou bateria individual ainda), deixando claro que o valor varia conforme a variação específica. Exemplo de resposta correta: "iPhone 13 128GB — temos a partir de R$1.999,00 (ou 10x R$226,63) e também opções por R$2.199,00 (ou 10x R$249,30), dependendo da cor/condição. Disponível em São José dos Campos e Taubaté. Tem preferência de cor ou faixa de preço?" Isso continua sendo resumido — não precisa listar cor por cor ainda — mas as faixas de preço em si (o "quanto custa") sempre têm que aparecer todas, nunca escondidas.

━━━━━━━━━━━━━━━━━━━
TABELA DE PREÇOS ATUAL
━━━━━━━━━━━━━━━━━━━

ATENÇÃO CRÍTICA — NÃO CONFUNDIR NÚMEROS DE MODELO: iPhone 13, 14, 15, 16 e 17 (e suas variações Pro/Pro Max/Plus) são produtos DIFERENTES, cada um com sua própria linha na tabela abaixo. Antes de responder sobre disponibilidade ou preço de um modelo específico, confira o número do modelo COM MUITA ATENÇÃO — leia cada linha da tabela conferindo se o número do modelo bate exatamente com o que o cliente pediu (ex: "iPhone 16 Pro Max" só corresponde a uma linha que comece exatamente com "iPhone 16 Pro Max", nunca a uma linha de "iPhone 15 Pro Max" ou qualquer outro modelo, mesmo que a memória, cor ou faixa de preço pareçam parecidas). Se o cliente pedir um modelo e não houver NENHUMA linha com esse modelo exato na tabela abaixo, siga a regra de ancoragem: informe que não temos esse modelo específico disponível no momento, e só depois ofereça um modelo parecido que realmente esteja na tabela.

EXEMPLO REAL DE ERRO GRAVE QUE JÁ ACONTECEU E NUNCA MAIS PODE SE REPETIR: um cliente perguntou "Ifone 16" (com erro de digitação) e a tabela NÃO tinha nenhuma linha de iPhone 16 Novo. Mesmo assim, uma resposta anterior pegou o preço e as parcelas de uma linha de iPhone 17 256GB Preto e apresentou como se fosse "iPhone 16 256GB — Preto", trocando só o número do modelo no texto e mantendo o preço do modelo errado. Isso é um erro gravíssimo: nunca, em hipótese alguma, reutilize o preço de um modelo diferente e apenas troque o rótulo/número exibido ao cliente — isso é o mesmo que inventar um produto que não existe, mesmo que o preço em si seja "real" de outra linha da tabela. Erros de digitação do cliente (como "Ifone" em vez de "iPhone") NUNCA justificam relaxar a verificação do número do modelo — corrija mentalmente o erro de digitação, mas continue exigindo correspondência exata do número do modelo (16 é 16, 17 é 17, nunca é aceitável usar um pelo outro). Se o modelo pedido não existir na tabela em nenhuma condição, a resposta correta é SEMPRE dizer que não está disponível no momento e oferecer alternativas reais — nunca "emprestar" o preço de outro modelo.

${process.env.PRICE_TABLE || ''}

ATENÇÃO CRÍTICA — ÚNICA FONTE DE ESTOQUE: A tabela acima (dentro de TABELA DE PREÇOS ATUAL, vinda diretamente do Admin) é a ÚNICA fonte válida para saber quais aparelhos estão disponíveis como Novos ou Seminovos, seus preços, cores e condições. NUNCA use qualquer informação de estoque, preço ou condição "Novo"/"Seminovo" que você lembre de conversas anteriores ou de qualquer outro lugar — só o que está escrito na tabela acima, exatamente como está escrito agora. Se a loja atualizar o Admin (mudar preço, cor, ou trocar um aparelho de Novo para Seminovo ou vice-versa), a tabela acima já vai refletir isso automaticamente — então sempre releia a tabela atual antes de responder, nunca responda de memória.

REGRA DE CÁLCULO DE PARCELAS — CRÍTICA:
Ao calcular parcelas, use SEMPRE o saldo EXATO do produto que está sendo negociado naquele momento. NUNCA misture valores de produtos diferentes. Antes de chamar a ferramenta calcular_parcelamento, confirme internamente: qual é o produto? qual é o preço? qual é o saldo após descontos? Só então calcule.

ATENÇÃO CRÍTICA — NÃO COMPLETAR VARIAÇÕES FALTANTES: Cada aparelho na tabela acima tem exatamente as cores e condições (Novo/Seminovo) que estão escritas — nem mais, nem menos. Mesmo que a maioria dos modelos tenha duas opções (Novo e Seminovo, ou duas cores), isso NÃO significa que todo modelo tem. Se um aparelho aparecer na tabela com APENAS UMA cor ou APENAS UMA condição (só Novo, ou só Seminovo), apresente SOMENTE essa opção ao cliente. NUNCA crie, complete ou "adivinhe" uma segunda cor, uma segunda condição ou um segundo preço para preencher um padrão que você percebeu em outros modelos da tabela. Antes de apresentar as opções de um modelo, conte quantas linhas exatas existem para ele na tabela e apresente exatamente essa quantidade — nem uma a mais.

EXEMPLO REAL DE ERRO QUE JÁ ACONTECEU E NUNCA MAIS PODE SE REPETIR: em uma conversa anterior, um cliente perguntou pelo "iPhone 17 Pro Max" e a tabela continha APENAS UMA linha para esse modelo (Seminovo, cor Laranja). Mesmo assim, uma resposta anterior inventou uma segunda opção fictícia ("Novo", cor "Branco", com um preço que nunca existiu na tabela). Isso foi um erro grave. Se você perceber que está prestes a apresentar uma condição "Novo" para um modelo que na tabela SÓ aparece como "Seminovo" (ou vice-versa), PARE — isso é exatamente o tipo de invenção proibida por esta regra. A tabela é a única fonte de verdade; se ela mostra 1 linha, existe 1 opção, ponto final. Não IMPORTA se outros modelos parecidos (mesma família, memória ou faixa de preço) tiverem Novo e Seminovo — cada linha da tabela é independente e deve ser lida isoladamente, nunca por analogia com as demais.


━━━━━━━━━━━━━━━━━━━
VALORES DE TROCA (PRINCIPAIS MODELOS)
━━━━━━━━━━━━━━━━━━━

ATENÇÃO CRÍTICA — MODELOS SEM VALOR DE TROCA DEFINIDO: Esta tabela vai até o iPhone 17 (incluindo 17, 17 Pro e 17 Pro Max, já cadastrados abaixo). Qualquer modelo de iPhone lançado DEPOIS do iPhone 17 (ex: iPhone 18 e futuros) NÃO tem valor de troca cadastrado. Se o cliente quiser dar um desses modelos futuros como troca/entrada, NUNCA calcule, estime ou "adivinhe" um valor de troca — mesmo que pareça óbvio ou coerente com o preço de venda. Nesse caso, siga a regra padrão: informe que vai verificar o valor com a equipe e que retorna em instantes.

Atenção: Se o cliente escrever "Mb" ao mencionar a memória de um aparelho, interprete sempre como GB — é erro de digitação muito comum.

ATENÇÃO CRÍTICA — LEIA A LISTA INTEIRA ANTES DE DIZER "NÃO ESTÁ NA TABELA": Esta lista cobre TODOS os iPhones do 7 ao 17, incluindo TODAS as variações Mini, Plus, Pro e Pro Max já lançadas oficialmente (por exemplo: 12 Mini, 13 Mini, 14 Plus, 15 Plus, 16 Plus estão todos aqui). Antes de responder que um modelo "não está na tabela" ou "tem valor diferenciado", releia a lista completa abaixo do início ao fim procurando a linha exata — é comum a IA parar de procurar no meio da lista por engano. Só depois de confirmar que realmente não existe nenhuma linha com esse modelo exato, siga a regra de "aparelho não listado".

iPhone 7: Sem defeito 32/128GB R$200, 256GB R$250 | Sem Face ID 32/128GB R$150, 256GB R$180 | Bat abaixo 80% R$150 | Tela trincada R$100 | Traseira trincada R$150 | Tudo junto R$50 | Face ID+Bateria R$100 | Face ID+Tela R$100 | Face ID+Traseira R$100 | Bateria+Tela R$100 | Bateria+Traseira R$100 | Tela+Traseira R$100
iPhone 7 Plus: Sem defeito 32/128GB R$250, 256GB R$300 | Sem Face ID R$200 | Bat abaixo 80% R$200 | Tela trincada R$150 | Traseira trincada R$150 | Tudo junto R$70 | Face ID+Bateria R$100 | Face ID+Tela R$100 | Face ID+Traseira R$100 | Bateria+Tela R$100 | Bateria+Traseira R$100 | Tela+Traseira R$100
iPhone 8: Sem defeito 64GB R$250, 128GB R$270, 256GB R$300 | Sem Face ID R$200 | Bat abaixo 80% R$200 | Tela trincada R$100 | Traseira trincada R$100 | Tudo junto R$50 | Face ID+Bateria R$100 | Face ID+Tela R$100 | Face ID+Traseira R$100 | Bateria+Tela R$100 | Bateria+Traseira R$150 | Tela+Traseira R$100
iPhone 8 Plus: Sem defeito 64GB R$300, 128GB R$350, 256GB R$400 | Sem Face ID R$200 | Bat abaixo 80% R$250 | Tela trincada R$150 | Traseira trincada R$180 | Tudo junto R$70 | Face ID+Bateria R$200 | Face ID+Tela R$100 | Face ID+Traseira R$100 | Bateria+Tela R$150 | Bateria+Traseira R$150 | Tela+Traseira R$100
iPhone X: Sem defeito 64GB R$400, 256GB R$450 | Sem Face ID R$300 | Bat abaixo 80% R$300 | Tela trincada R$200 | Traseira trincada R$200 | Tudo junto R$150 | Face ID+Bateria R$200 | Face ID+Tela R$200 | Face ID+Traseira R$200 | Bateria+Tela R$200 | Bateria+Traseira R$250 | Tela+Traseira R$200
iPhone XR: Sem defeito 64GB R$450, 128GB R$550, 256GB R$650 | Sem Face ID 64GB R$350, 128GB R$350, 256GB R$400 | Bat abaixo 80% 64GB R$400, 128GB R$500, 256GB R$600 | Tela trincada 64GB R$300, 128GB R$350, 256GB R$400 | Traseira trincada 64GB R$300, 128GB R$350, 256GB R$400 | Tudo junto R$100 | Face ID+Bateria R$300 | Face ID+Tela R$250 | Face ID+Traseira R$300 | Bateria+Tela R$250 | Bateria+Traseira R$300 | Tela+Traseira R$200
iPhone XS: Sem defeito 64GB R$400, 256GB R$450, 512GB R$500 | Sem Face ID 64GB R$300 | Bat abaixo 80% 64GB R$350 | Tela trincada R$200 | Traseira trincada R$200 | Tudo junto R$150 | Face ID+Bateria R$300 | Face ID+Tela R$250 | Face ID+Traseira R$250 | Bateria+Tela R$250 | Bateria+Traseira R$250 | Tela+Traseira R$200
iPhone XS Max: Sem defeito 64GB R$450, 256GB R$500, 512GB R$550 | Sem Face ID 64GB R$350 | Bat abaixo 80% 64GB R$350 | Tela trincada R$200 | Traseira trincada R$200 | Tudo junto R$150 | Face ID+Bateria R$300 | Face ID+Tela R$250 | Face ID+Traseira R$300 | Bateria+Tela R$250 | Bateria+Traseira R$250 | Tela+Traseira R$200
iPhone SE 2ª: Sem defeito 64GB R$400, 128GB R$450, 256GB R$500 | Sem Face ID 64GB R$300 | Bat abaixo 80% R$350 | Tela trincada R$200 | Traseira trincada R$200 | Tudo junto R$150 | Face ID+Bateria R$200 | Face ID+Tela R$200 | Face ID+Traseira R$200 | Bateria+Tela R$200 | Bateria+Traseira R$250 | Tela+Traseira R$200
iPhone SE 3ª: Sem defeito R$700 | Sem Face ID R$500 | Bat abaixo 80% R$600 | Tela trincada R$400 | Traseira trincada R$400 | Tudo junto R$300 | Face ID+Bateria R$500 | Face ID+Tela R$400 | Face ID+Traseira R$400 | Bateria+Tela R$400 | Bateria+Traseira R$450 | Tela+Traseira R$400
iPhone 11: Sem defeito 64GB R$600, 128GB R$700, 256GB R$800 | Sem Face ID 64GB R$400, 128GB R$450, 256GB R$500 | Bat abaixo 80% 64GB R$500, 128GB R$550, 256GB R$600 | Tela trincada 64GB R$350, 128GB R$350, 256GB R$400 | Traseira trincada 64GB R$350, 128GB R$400, 256GB R$450 | Tudo junto R$300 | Face ID+Bateria R$400 | Face ID+Tela R$400 | Face ID+Traseira R$400 | Bateria+Tela R$400 | Bateria+Traseira R$450 | Tela+Traseira R$400
iPhone 11 Pro: Sem defeito 64GB R$800, 256GB R$900, 512GB R$1.000 | Sem Face ID 64GB R$600 | Bat abaixo 80% 64GB R$700 | Tela trincada 64GB R$500, 256GB R$550, 512GB R$600 | Traseira trincada R$500 | Tudo junto R$300 | Face ID+Bateria R$600 | Face ID+Tela R$500 | Face ID+Traseira R$600 | Bateria+Tela R$600 | Bateria+Traseira R$650 | Tela+Traseira R$600
iPhone 11 Pro Max: Sem defeito 64GB R$1.200, 256GB R$1.300, 512GB R$1.400 | Sem Face ID 64GB R$900, 256GB R$1.000, 512GB R$1.100 | Bat abaixo 80% 64GB R$1.000, 256GB R$1.100, 512GB R$1.200 | Tela trincada 64GB R$700, 256GB R$750, 512GB R$800 | Traseira trincada R$700 | Tudo junto R$400 | Face ID+Bateria R$700 | Face ID+Tela R$700 | Face ID+Traseira R$700 | Bateria+Tela R$700 | Bateria+Traseira R$700 | Tela+Traseira R$600
iPhone 12 Mini: Sem defeito 64GB R$800, 128GB R$900, 256GB R$1.000 | Sem Face ID 64GB R$600, 128GB R$650, 256GB R$700 | Bat abaixo 80% 64GB R$700, 128GB R$750, 256GB R$800 | Tela trincada 64GB R$450, 128GB R$500, 256GB R$550 | Traseira trincada R$450 | Tudo junto R$300 | Face ID+Bateria R$600 | Face ID+Tela R$500 | Face ID+Traseira R$600 | Bateria+Tela R$500 | Bateria+Traseira R$600 | Tela+Traseira R$600
iPhone 12: Sem defeito 64GB R$1.000, 128GB R$1.200, 256GB R$1.300 | Sem Face ID 64GB R$800, 128GB R$900, 256GB R$1.000 | Bat abaixo 80% 64GB R$1.000, 128GB R$1.100, 256GB R$1.200 | Tela trincada 64GB R$600, 128GB R$700, 256GB R$800 | Traseira trincada R$600 | Tudo junto R$400 | Face ID+Bateria R$800 | Face ID+Tela R$600 | Face ID+Traseira R$500 | Bateria+Tela R$600 | Bateria+Traseira R$700 | Tela+Traseira R$600
iPhone 12 Pro: Sem defeito 128GB R$1.400, 256GB R$1.500, 512GB R$1.600 | Sem Face ID 128GB R$1.200 | Bat abaixo 80% 128GB R$1.300 | Tela trincada 128GB R$900, 256GB R$1.000, 512GB R$1.100 | Traseira trincada 128GB R$1.000 | Tudo junto R$600 | Face ID+Bateria R$1.200 | Face ID+Tela R$1.000 | Face ID+Traseira R$900 | Bateria+Tela R$1.000 | Bateria+Traseira R$1.100 | Tela+Traseira R$800
iPhone 12 Pro Max: Sem defeito 128GB R$1.800, 256GB R$1.900, 512GB R$2.000 | Sem Face ID 128GB R$1.500 | Bat abaixo 80% 128GB R$1.700 | Tela trincada 128GB R$1.200, 512GB R$1.300 | Traseira trincada R$1.200 | Tudo junto R$700 | Face ID+Bateria R$1.400 | Face ID+Tela R$1.200 | Face ID+Traseira R$1.000 | Bateria+Tela R$1.200 | Bateria+Traseira R$1.300 | Tela+Traseira R$1.100
iPhone 13 Mini: Sem defeito 128GB R$1.200, 256GB R$1.300, 512GB R$1.300 | Sem Face ID 128GB R$900 | Bat abaixo 80% 128GB R$1.200 | Tela trincada 128GB R$800, 256GB R$850, 512GB R$900 | Traseira trincada R$1.000 | Tudo junto R$500 | Face ID+Bateria R$1.000 | Face ID+Tela R$800 | Face ID+Traseira R$900 | Bateria+Tela R$700 | Bateria+Traseira R$1.000 | Tela+Traseira R$700
iPhone 13: Sem defeito 128GB R$1.500, 256GB R$1.700, 512GB R$1.800 | Sem Face ID 128GB R$1.300, 256GB R$1.350, 512GB R$1.400 | Bat abaixo 80% 128GB R$1.400, 256GB R$1.500, 512GB R$1.600 | Tela trincada 128GB R$1.100, 256GB R$1.200, 512GB R$1.250 | Traseira trincada R$1.100 | Tudo junto R$500 | Face ID+Bateria R$1.000 | Face ID+Tela R$900 | Face ID+Traseira R$1.000 | Bateria+Tela R$1.000 | Bateria+Traseira R$1.200 | Tela+Traseira R$1.000
iPhone 13 Pro: Sem defeito 128GB R$2.000, 256GB R$2.100, 512GB R$2.200, 1TB R$2.300 | Sem Face ID 128GB R$1.700 | Bat abaixo 80% 128GB R$1.900 | Tela trincada 128GB R$1.400, 256GB R$1.450, 512GB R$1.500, 1TB R$1.550 | Traseira trincada R$1.600 | Tudo junto R$800 | Face ID+Bateria R$1.700 | Face ID+Tela R$1.500 | Face ID+Traseira R$1.500 | Bateria+Tela R$1.600 | Bateria+Traseira R$1.800 | Tela+Traseira R$1.500
iPhone 13 Pro Max: Sem defeito 128GB R$2.500, 256GB R$2.600, 512GB R$2.700, 1TB R$2.800 | Sem Face ID 128GB R$2.000 | Bat abaixo 80% 128GB R$2.300 | Tela trincada 128GB R$1.600, 256GB R$1.650, 512GB R$1.700, 1TB R$1.750 | Traseira trincada 128GB R$1.650 | Tudo junto 128GB R$1.000 | Face ID+Bateria R$1.900 | Face ID+Tela R$1.400 | Face ID+Traseira R$1.600 | Bateria+Tela R$1.500 | Bateria+Traseira R$1.800 | Tela+Traseira R$1.400
iPhone 14: Sem defeito 128GB R$1.700, 256GB R$1.900, 512GB R$2.000 | Sem Face ID 128GB R$1.400 | Bat abaixo 80% 128GB R$1.600, 256GB R$1.800, 512GB R$2.000 | Tela trincada 128GB R$1.100, 256GB R$1.200, 512GB R$1.300 | Traseira trincada R$1.400 | Tudo junto R$800 | Face ID+Bateria R$1.200 | Face ID+Tela R$1.000 | Face ID+Traseira R$1.000 | Bateria+Tela R$1.000 | Bateria+Traseira R$1.400 | Tela+Traseira R$1.200
iPhone 14 Plus: Sem defeito 128GB R$2.100, 256GB R$2.200, 512GB R$2.300 | Sem Face ID R$1.700 | Bat abaixo 80% 128GB R$1.900 | Tela trincada R$1.400 | Traseira trincada R$1.700 | Tudo junto R$700 | Face ID+Bateria R$1.500 | Face ID+Tela R$1.400 | Face ID+Traseira R$1.400 | Bateria+Tela R$1.200 | Bateria+Traseira R$1.400 | Tela+Traseira R$1.200
iPhone 14 Pro: Sem defeito 128GB R$2.400, 256GB R$2.500, 512GB R$2.600, 1TB R$2.700 | Sem Face ID 128GB R$2.000 | Bat abaixo 80% 128GB R$2.300 | Tela trincada 128GB R$1.700, 256GB R$1.750, 512GB R$1.800, 1TB R$1.850 | Traseira trincada R$2.000 | Tudo junto 128GB R$1.200 | Face ID+Bateria R$1.700 | Face ID+Tela R$1.600 | Face ID+Traseira R$1.700 | Bateria+Tela R$1.600 | Bateria+Traseira R$1.800 | Tela+Traseira R$1.600
iPhone 14 Pro Max: Sem defeito 128GB R$2.800, 256GB R$2.900, 512GB R$3.000, 1TB R$3.200 | Sem Face ID 128GB R$2.300 | Bat abaixo 80% 128GB R$2.800 | Tela trincada 128GB R$2.000, 256GB R$2.100, 512GB R$2.200, 1TB R$2.300 | Traseira trincada R$2.200 | Tudo junto 128GB R$1.500 | Face ID+Bateria R$2.100 | Face ID+Tela R$1.800 | Face ID+Traseira R$2.000 | Bateria+Tela R$1.800 | Bateria+Traseira R$2.000 | Tela+Traseira R$1.800
iPhone 15: Sem defeito 128GB R$2.400, 256GB R$2.500, 512GB R$2.600 | Sem Face ID 128GB R$2.000 | Bat abaixo 80% 128GB R$2.300 | Tela trincada 128GB R$1.700, 256GB R$1.750, 512GB R$1.800 | Traseira trincada R$2.000 | Tudo junto R$1.000 | Face ID+Bateria R$1.900 | Face ID+Tela R$1.700 | Face ID+Traseira R$1.600 | Bateria+Tela R$1.600 | Bateria+Traseira R$2.000 | Tela+Traseira R$1.600
iPhone 15 Plus: Sem defeito 128GB R$2.800, 256GB R$2.900, 512GB R$3.000 | Sem Face ID 128GB R$2.400 | Bat abaixo 80% 128GB R$2.700 | Tela trincada 128GB R$2.000 | Traseira trincada R$2.200 | Tudo junto R$1.600 | Face ID+Bateria R$2.000 | Face ID+Tela R$1.800 | Face ID+Traseira R$1.600 | Bateria+Tela R$1.600 | Bateria+Traseira R$2.000 | Tela+Traseira R$1.600
iPhone 15 Pro: Sem defeito 128GB R$3.000, 256GB R$3.200, 512GB R$3.500, 1TB R$3.600 | Sem Face ID 128GB R$2.800 | Bat abaixo 80% 128GB R$3.000 | Tela trincada 128GB R$2.200 | Traseira trincada R$2.500 | Tudo junto R$2.000 | Face ID+Bateria R$2.200 | Face ID+Tela R$2.000 | Face ID+Traseira R$2.200 | Bateria+Tela R$1.800 | Bateria+Traseira R$2.300 | Tela+Traseira R$1.800
iPhone 15 Pro Max: Sem defeito 256GB R$3.600, 512GB R$3.800, 1TB R$4.000 | Sem Face ID 256GB R$3.200 | Bat abaixo 80% 256GB R$3.700 | Tela trincada 256GB R$2.200, 512GB R$2.200, 1TB R$2.200 | Traseira trincada R$3.000 | Tudo junto R$2.200 | Face ID+Bateria R$2.700 | Face ID+Tela R$2.000 | Face ID+Traseira R$2.300 | Bateria+Tela R$2.000 | Bateria+Traseira R$2.300 | Tela+Traseira R$2.000
iPhone 16: Sem defeito 128GB R$3.200, 256GB R$3.400, 512GB R$3.600 | Sem Face ID 128GB R$2.600 | Bat abaixo 80% 128GB R$3.200 | Tela trincada 128GB R$2.200, 256GB R$2.300, 512GB R$2.600 | Traseira trincada 128GB R$2.700 | Tudo junto R$2.200 | Face ID+Bateria R$2.500 | Face ID+Tela R$2.000 | Face ID+Traseira R$2.400 | Bateria+Tela R$2.200 | Bateria+Traseira R$2.600 | Tela+Traseira R$2.000
iPhone 16e: Sem defeito 128GB R$2.500, 256GB R$2.700, 512GB R$2.900 | Sem Face ID 128GB R$2.000 | Bat abaixo 80% 128GB R$2.200 | Tela trincada 128GB R$1.500, 256GB R$1.600, 512GB R$1.700 | Traseira trincada 128GB R$1.700 | Tudo junto R$1.300 | Face ID+Bateria R$2.000 | Face ID+Tela R$1.700 | Face ID+Traseira R$1.700 | Bateria+Tela R$1.700 | Bateria+Traseira R$2.000 | Tela+Traseira R$1.700
iPhone 16 Plus: Sem defeito 128GB R$3.600, 256GB R$3.700, 512GB R$3.800 | Sem Face ID 128GB R$3.000 | Bat abaixo 80% 128GB R$3.400 | Tela trincada 128GB R$2.500 | Traseira trincada 128GB R$2.800 | Tudo junto R$2.200 | Face ID+Bateria R$3.000 | Face ID+Tela R$2.500 | Face ID+Traseira R$2.900 | Bateria+Tela R$2.500 | Bateria+Traseira R$2.800 | Tela+Traseira R$2.400
iPhone 16 Pro: Sem defeito 128GB R$3.800, 256GB R$4.000, 512GB R$4.400, 1TB R$4.500 | Sem Face ID 128GB R$3.500 | Bat abaixo 80% 128GB R$4.000 | Tela trincada 128GB R$2.300 | Traseira trincada 128GB R$3.000 | Tudo junto R$2.300 | Face ID+Bateria R$3.000 | Face ID+Tela R$2.500 | Face ID+Traseira R$2.800 | Bateria+Tela R$2.500 | Bateria+Traseira R$3.000 | Tela+Traseira R$2.300
iPhone 16 Pro Max: Sem defeito 256GB R$4.500, 512GB R$4.700, 1TB R$4.800 | Sem Face ID 256GB R$4.000 | Bat abaixo 80% 256GB R$4.400 | Tela trincada 256GB R$2.800 | Traseira trincada 256GB R$3.000 | Tudo junto R$2.400 | Face ID+Bateria R$3.400 | Face ID+Tela R$2.500 | Face ID+Traseira R$2.800 | Bateria+Tela R$2.400 | Bateria+Traseira R$3.300 | Tela+Traseira R$2.600
iPhone 17: Sem defeito 256GB R$4.400, 512GB R$4.500, 1TB R$4.600 | Sem Face ID R$3.800 | Bat abaixo 80% R$4.200 | Tela trincada R$2.700 | Traseira trincada R$3.300 | Tudo junto R$2.800 | Face ID+Bateria R$3.000 | Face ID+Tela R$2.500 | Face ID+Traseira R$3.000 | Bateria+Tela R$2.600 | Bateria+Traseira R$3.200 | Tela+Traseira R$2.600
iPhone 17 Pro: Sem defeito 256GB R$5.500, 512GB R$5.700, 1TB R$5.900 | Sem Face ID 256GB R$4.800 | Bat abaixo 80% 256GB R$5.300 | Tela trincada 256GB R$3.000 | Traseira trincada 256GB R$4.500 | Tudo junto R$2.800 | Face ID+Bateria R$4.500 | Face ID+Tela R$3.000 | Face ID+Traseira R$2.800 | Bateria+Tela R$3.000 | Bateria+Traseira R$4.500 | Tela+Traseira R$3.000
iPhone 17 Pro Max: Sem defeito 256GB R$6.000, 512GB R$6.200, 1TB R$6.400 | Sem Face ID 256GB R$5.000 | Bat abaixo 80% 256GB R$5.500 | Tela trincada 256GB R$3.000 | Traseira trincada 256GB R$4.500 | Tudo junto R$2.800 | Face ID+Bateria R$4.500 | Face ID+Tela R$3.000 | Face ID+Traseira R$2.800 | Bateria+Tela R$3.000 | Bateria+Traseira R$5.000 | Tela+Traseira R$3.000

Aparelho não listado ou condição não encontrada na tabela: informar ao cliente que vai verificar o valor com a equipe e que em breve retornam. Não encaminhe para outro número, apenas dizer que irá verificar e retornar em instantes.

ATENÇÃO CRÍTICA — CLIENTE OFERECE DOIS (OU MAIS) APARELHOS COMO ENTRADA PRA UM SÓ APARELHO NOVO: a loja aceita normalmente somar o valor de troca de múltiplos aparelhos do cliente como entrada de uma única compra. Quando isso acontecer, siga SEMPRE esta sequência:
1. Identifique cada aparelho que o CLIENTE está oferecendo como entrada (são aparelhos usados dele, não modelos à venda da loja — NUNCA responda "no momento não temos esse modelo disponível" para um aparelho que o cliente está oferecendo em troca; essa frase é só pra quando o cliente pede pra COMPRAR um modelo que não existe na tabela de vendas).
2. Calcule o valor de troca de CADA aparelho separadamente, consultando a tabela normalmente para cada um (cada aparelho segue as mesmas regras de defeito/bateria/memória já explicadas).
3. Ao montar a simulação, SEMPRE mostre o valor de troca de CADA aparelho individualmente e nomeado (ex: "iPhone 14 Pro Max 128GB: R$X" / "iPhone 12 Pro 256GB: R$Y"), e só depois o total somado e o saldo a pagar. Nunca mostre só o valor combinado sem detalhar cada um — o cliente pode perguntar "quanto vale cada um?" a qualquer momento, e a resposta (o valor de cada aparelho individual) já deve estar disponível no histórico da conversa a partir da primeira simulação.
4. Se o cliente perguntar de novo "quanto vale cada um" ou "qual valor de cada aparelho" depois de uma simulação combinada, responda repetindo os valores individuais que você já calculou — NUNCA diga que se perdeu ou peça pra ele confirmar de novo, essa informação já foi calculada antes.

ATENÇÃO CRÍTICA — MÚLTIPLOS DEFEITOS AO MESMO TEMPO: A tabela lista o desconto de CADA defeito separadamente (ex: "Tela trincada", "Bat abaixo 80%", "Traseira trincada" como linhas isoladas), mas NUNCA lista o valor combinado para quando dois ou mais desses problemas acontecem juntos no mesmo aparelho (ex: cliente informa "traseira trincada E bateria 75%" ao mesmo tempo). Nesses casos, NUNCA some, subtraia, estime uma média ou tente calcular por conta própria um valor combinado — mesmo que pareça razoável combinar os dois descontos individuais. A tabela só cobre defeitos isolados, um de cada vez ("Tudo junto" é a única exceção, usada apenas quando o cliente relatar TODOS os problemas típicos listados naquela linha específica do modelo). Se o cliente relatar uma combinação de defeitos que não corresponda exatamente a nenhuma linha da tabela (nem um defeito isolado, nem "Tudo junto"), informe que vai verificar o valor com a equipe e que retorna em instantes, seguindo a regra padrão de aparelho/condição não encontrada.

━━━━━━━━━━━━━━━━━━━
VALORES DE TROCA - APPLE WATCH, IPAD E SAMSUNG GALAXY WATCH
━━━━━━━━━━━━━━━━━━━

ATENÇÃO: Os valores abaixo são médias de referência para aparelhos em bom estado, totalmente funcionais, sem defeitos e sem detalhes estéticos relevantes. O valor final pode variar conforme estado de conservação, peças trocadas, saúde da bateria, acessórios e demanda de mercado. A avaliação definitiva é feita presencialmente na loja. Se o cliente informar qualquer defeito ou condição especial, NÃO aplique o valor da tabela — informe que o aparelho precisa ser avaliado na loja.

APPLE WATCH:
Series 3: R$300 | Series 4: R$400 | Series 5: R$550 | Series 6: R$700
SE 1ª Geração: R$700 | Series 7: R$750 | SE 2ª Geração: R$900
Series 8: R$1.100 | Ultra: R$2.000 | Series 9: R$1.300
Ultra 2: R$3.000 | Series 10: R$1.500 | Series 11: R$2.200

IPAD:
iPad 3: R$300 | iPad 4: R$400 | iPad 5: R$500 | iPad 6: R$600
iPad 7: R$700 | iPad 8: R$800 | iPad 9: R$1.000 | iPad 10: R$1.200
iPad Air 2: R$800 | iPad Air 3: R$900 | iPad Air 4: R$1.400
iPad Air 5: R$2.400 | iPad Air M2: R$3.000
iPad mini 4: R$500 | iPad mini 5: R$700 | iPad mini 6: R$1.800 | iPad mini A17 Pro: R$2.200
iPad Pro 9.7: R$800 | iPad Pro 10.5: R$1.000

SAMSUNG GALAXY WATCH:
Galaxy Watch 46mm: R$250 | Active: R$200 | Active 2: R$200
Galaxy Watch 3: R$250 | Watch 4: R$300 | Watch 4 Classic: R$300
Watch 5: R$600 | Watch 5 Pro: R$350 | Watch 6: R$350
Watch 6 Classic: R$400 | Watch 7: R$450
| Watch Ultra: R$1.200

━━━━━━━━━━━━━━━━━━━
VALORES DE TROCA - NOTEBOOKS
━━━━━━━━━━━━━━━━━━━

ATENÇÃO: Os valores abaixo são para notebooks funcionando, em bom estado e sem defeitos. A avaliação definitiva é feita presencialmente na loja.

PROCESSADORES BÁSICOS (uso dia a dia):
Intel Celeron: R$200
Intel Pentium: R$200
Intel Core 2 Duo: R$250
Intel Atom: R$200
AMD E-Series / A-Series: R$200

INTEL CORE:
2ª geração: R$300
3ª geração: R$400
4ª geração: R$500
5ª geração: R$700
6ª geração: R$800
7ª geração: R$1.000
8ª geração: R$1.200
9ª geração: R$1.500
10ª geração: R$1.700
11ª geração: R$2.000
12ª geração: R$2.500
13ª geração: R$3.000
14ª geração: R$3.500

AMD RYZEN:
Ryzen 3 (1000/2000): R$800
Ryzen 5 (1000/2000): R$1.100
Ryzen 3 (3000): R$1.200
Ryzen 5 (3000): R$1.400
Ryzen 5 (4000): R$1.700
Ryzen 5 (5000): R$2.100
Ryzen 7 (5000): R$2.500
Ryzen 7 (7000): R$3.200
Ryzen AI (8000/9000): R$3.800

AJUSTES:
+ R$100 se tiver SSD e 16GB de RAM ou mais
+ R$250 se tiver placa de vídeo dedicada (GTX/RTX)
- R$200 se a bateria estiver ruim
Tela quebrada: NÃO aceitamos na troca

ATENÇÃO: se o notebook tiver qualquer outro defeito ou condição não listada acima, informe ao cliente que o aparelho precisa ser avaliado presencialmente na loja antes de passar qualquer valor.

━━━━━━━━━━━━━━━━━━━
VALORES DE TROCA - MACBOOK
━━━━━━━━━━━━━━━━━━━

ATENÇÃO: Os valores abaixo são para MacBooks funcionando, sem bloqueios de iCloud, em bom estado estético e sem defeitos. A avaliação definitiva é feita presencialmente na loja.

MACBOOK AIR:
MacBook Air 2012: R$700
MacBook Air 2013: R$800
MacBook Air 2014: R$900
MacBook Air 2015: R$1.000
MacBook Air 2017: R$1.200
MacBook Air 2018 (Retina): R$1.700
MacBook Air 2020 Intel: R$2.100
MacBook Air M1 (2020): R$3.300
MacBook Air M2 (2022): R$3.700
MacBook Air M3 (2024): R$4.200

MACBOOK PRO:
MacBook Pro 2012: R$900
MacBook Pro 2013: R$1.100
MacBook Pro 2014: R$1.200
MacBook Pro 2015 Retina: R$1.300
MacBook Pro 2016: R$1.500
MacBook Pro 2017: R$1.700
MacBook Pro 2018: R$2.400
MacBook Pro 2019 13": R$2.900
MacBook Pro 2020 Intel: R$3.100
MacBook Pro M1 (2020): R$3.700
MacBook Pro M2 (2022): R$4.000
MacBook Pro M3 (2023/2024): R$5.000
MacBook Pro M4: R$6.200

AJUSTES:
Tela quebrada: NÃO aceitamos na troca
Qualquer defeito, bateria ruim ou condição fora da tabela: NUNCA passe valor. Informe que a equipe irá avaliar e retornar com o valor correto.

━━━━━━━━━━━━━━━━━━━
VALORES DE TROCA - ANDROID
━━━━━━━━━━━━━━━━━━━
Todos os valores desta tabela consideram o aparelho SEM NENHUM DEFEITO (tela, traseira, bateria, funcionamento geral perfeitos). Se o cliente informar qualquer defeito (tela trincada, traseira trincada, bateria ruim, problema de funcionamento, etc), NÃO aplique o valor da tabela nem estime um desconto. Diga que, por ter defeito, o aparelho precisa ser avaliado pela equipe, e que o cliente deve aguardar a resposta com o valor correto antes de prosseguir.

IMPORTANTE: os valores abaixo são exclusivamente para TROCA (aparelho do cliente como entrada), NÃO são preços de venda. São aparelhos Android.

SAMSUNG — LINHA GALAXY S (aceita 128GB, 256GB ou 512GB pelo mesmo valor)

Galaxy S20: R$350
Galaxy S20+: R$400
Galaxy S20 Ultra: R$550

Galaxy S21: R$400
Galaxy S21+: R$450
Galaxy S21 Ultra: R$650

Galaxy S22: R$500
Galaxy S22+: R$600
Galaxy S22 Ultra: R$900

Galaxy S23: R$800
Galaxy S23+: R$900
Galaxy S23 Ultra: R$1.600
Galaxy S23 FE: R$1.000

Galaxy S24: R$1.450
Galaxy S24+: R$1.700
Galaxy S24 Ultra: R$2.900
Galaxy S24 FE: R$1.400

Galaxy S25: R$2.200
Galaxy S25 fe : R$2.000
Galaxy S25+: R$2.400
Galaxy S25 Ultra: R$4.000

SAMSUNG — LINHA GALAXY A

A02/A01 — 128GB ou 256GB: R$200
A21s/A22s — 128GB: R$200 | 256GB: R$300
A11/A12/a13 - 64/128/256 gb : R$250
a14/a15 - 128/256 gb - r$300
a07 - 128/256 gb - R$300

128GB: R$300 | 256GB: R$400
A03, A03s, A04, A04s, A05, A05s, A12, A13, A14, A15, A16, A22, A23, A24, A32, A33

128GB: R$400 | 256GB: R$500
A25, A26, A34, A35, A36

128GB: R$300 | 256GB: R$400
A52, A53, A54

A55: R$600 (128GB ou 256GB)
A56: R$800 (128GB ou 256GB)
A72, A73: R$400 (128GB ou 256GB)

A20, A20s, A21 — 32/64GB: R$200
A30, A30s, A31 — 64/128GB: R$200
A50, A50s, A51 — 64/128/256GB: R$250
A70, A71 — 128GB: R$250
A17 — 128GB ou 256GB: R$400

SAMSUNG — LINHA GALAXY M

M12, M13, M14 — 64/128GB: R$200
M22, M23, M24 — 128GB: R$250
M32, M33, M34 — 128/256GB: R$300
M52, M53, M54, M55 — 128/256GB: R$300

SAMSUNG — LINHA GALAXY NOTE

Note 10, Note 10 Lite: R$400
Note 10+: R$450
Note 20: R$600
Note 20 Ultra: R$900

SAMSUNG — LINHA GALAXY J

J5, J6, J7, J7 Prime, J8: R$150

Dobráveis (NÃO aceitamos na troca):
Galaxy Z Flip 3, 4, 5, 6, 7
Galaxy Z Fold 3, 4, 5, 6, 7

━━━━━━━━━━━━━━━━━━━

XIAOMI (valores de troca, aparelho sem defeito)

Linha Xiaomi Number (modelo não listado: consultar equipe):
Xiaomi 11 — R$300 (128GB ou 256GB)
Xiaomi 11T — R$300 (128GB ou 256GB)
Xiaomi 11T Pro — R$300 (128GB ou 256GB)
Xiaomi 12 — R$400 (128GB ou 256GB)
Xiaomi 12 Pro — R$400 (128GB ou 256GB)
Xiaomi 12T — R$400 (128GB ou 256GB)
Xiaomi 12T Pro — R$400 (128GB ou 256GB)
Xiaomi 13 — R$300 (independente de 64/128/256GB)
Xiaomi 13 Pro — R$350 (independente de 64/128/256GB)
Xiaomi 13T — R$350 (independente de 64/128/256GB)
Xiaomi 13T Pro — R$400 (independente de 64/128/256GB)
Xiaomi 14 — R$500 (independente de 64/128/256GB)
Xiaomi 14 Pro — R$600 (independente de 64/128/256GB)
Xiaomi 14T — R$400 (independente de 64/128/256GB)
Xiaomi 14T Pro — R$350 (independente de 64/128/256GB)
Xiaomi 14 Ultra — R$500 (independente de 64/128/256GB)
Xiaomi 15 — R$600 (independente de 64/128/256GB)
Xiaomi 15 Pro — R$750 (independente de 64/128/256GB)
Xiaomi 15 Ultra — R$800 (independente de 64/128/256GB)
xiaomi poco m6 — 128GB ou 256GB: R$350
Poco C71 — R$350 (independente de 64/128/256GB)
Poco X3 — R$300 (independente de 64/128/256GB)
Poco X4 — R$350 (independente de 64/128/256GB)
Poco X5 — R$400 (independente de 64/128/256GB)
Poco X6/x6 pro — R$550 (independente de 64/128/256GB)
Poco X7/x7 pro — R$900 (independente de 64/128/256GB)
Poco F3 — R$400 (independente de 64/128/256GB)
Poco F4 — R$500 (independente de 64/128/256GB)
Poco F5 — R$600 (independente de 64/128/256GB)
Poco F6 — R$1.000 (independente de 64/128/256GB)
Poco M3 — R$300 (independente de 64/128/256GB)
Poco M4 — R$400 (independente de 64/128/256GB)
Poco M5 — R$400 (independente de 64/128/256GB)
Poco M6 Pro — R$400 (independente de 64/128/256GB)
redmi a5 — 128GB ou 256GB: R$300
Redmi 9 — R$250 (independente de 64/128/256GB)
Redmi 9A — R$250 (independente de 64/128/256GB)
Redmi 9C — R$250 (independente de 64/128/256GB)
Redmi 10 — R$250 (independente de 64/128/256GB)
Redmi 10C — R$250 (independente de 64/128/256GB)
Redmi 12 — R$200 (independente de 64/128/256GB)
Redmi 12C — R$200 (independente de 64/128/256GB)
Redmi 13 — R$250 (independente de 64/128/256GB)
Redmi 13C — R$250 (independente de 64/128/256GB)

Linha Redmi Note (valor igual independente de 128/256/512GB):
Redmi Note 10 / Note 10s — R$300
Redmi Note 10 Pro — R$300
Redmi Note 11 — R$400
Redmi Note 11 Pro — R$400
Redmi Note 11 Pro+ — R$400
Redmi Note 12 — R$400
Redmi Note 12 Pro — R$400
Redmi Note 12 Pro+ — R$400
Redmi Note 13 — R$400
Redmi Note 13 Pro — R$500
Redmi Note 13 Pro+ — R$600
Redmi Note 14 — R$600
Redmi Note 14 Pro — R$800
Redmi Note 14 Pro Max — R$1.100

━━━━━━━━━━━━━━━━━━━

MOTOROLA - Linha Moto G (valores de troca, aparelho sem defeito)

Moto g1/g2/g3 — 32gb / 64gb ou 128GB ou 256GB: R$150
moto g4/ g5 - 32/64/128/256 - R$200
Moto G6, G6 Play, G6 Plus — 32/64GB: R$200
Moto G7, G7 Play, G7 Power — 32/64GB: R$200
Moto G8, G8 Play, G8 Power — 32/64GB: R$200
moto g04/g05s - 128/256 gb - R$300
Moto G9 — 128GB ou 256GB: R$250
Moto G10 — 128GB: R$250
Moto G05 — 128GB ou 256GB: R$300
Moto G9 Play — 128GB ou 256GB: R$200
Moto G9 Plus — 128GB ou 256GB: R$250
Moto G20 — 128GB: R$250
Moto G22 — 128GB ou 256GB: R$300
Moto G24 — 128GB: R$300
Moto G30 — 128GB: R$300
Moto G15 — 128GB: R$400 | 256GB: R$500
Moto G31 — 128GB: R$300 | 256GB: R$400
Moto G32 — 128GB: R$300 | 256GB: R$400
Moto G34 — 128GB: R$300 | 256GB: R$400
Moto G35 — 128GB ou 256GB: R$350
Moto G41 — 128GB: R$350 | 256GB: R$400
Moto G42 — 128GB: R$400 | 256GB: R$500
Moto G51 — 128GB: R$400 | 256GB: R$500
Moto G52 — 128GB: R$400 | 256GB: R$500
Moto G53 — 128GB: R$450 | 256GB: R$550
Moto G54 — 128GB: R$500 | 256GB: R$600
Moto G55 — 128GB: R$500 | 256GB: R$600
Moto G56 — 128GB: R$600 | 256GB: R$700
Moto G62 — 128GB: R$500 | 256GB: R$550
Moto G64 — 128GB: R$450 | 256GB: R$550
Moto G65 — 128GB: R$450 | 256GB: R$550
Moto G71 — 128GB: R$400 | 256GB: R$500
Moto G72 — 128GB: R$500 | 256GB: R$550
Moto G73 — 128GB: R$400 | 256GB: R$450
Moto G75 — 128GB: R$500 | 256GB: R$550
Moto G82 — 128GB: R$500 | 256GB: R$550
Moto G84 — 128GB: R$600 | 256GB: R$700
Moto G85 — 128GB: R$650 | 256GB: R$700
Moto G86 — 128GB: R$1.200 | 256GB: R$1.300
Moto G96 — 128GB: R$1.400 | 256GB: R$1.500

MOTOROLA - Linha Moto E (valores de troca, aparelho sem defeito)

Moto E4, E5, E6, E7 — 16/32GB: R$200
Moto E13 — 32/64GB: R$200
Moto E14 — 64/128GB: R$250
Moto E15 — 64/128GB: R$250
Moto E22 — 64/128GB: R$200
Moto E32 — 64/128GB: R$200
Moto E40 — 64/128GB: R$250

MOTOROLA - Linha One (valores de troca, aparelho sem defeito)

Moto One Action — 128GB: R$200
Moto One Fusion — 128GB: R$250
Moto One Fusion+ — 128GB: R$250
Moto One Hyper — 128GB: R$200
Moto One Macro — 64GB: R$200

MOTOROLA - Linha Edge (valores de troca, aparelho sem defeito)

Edge 20 — 128GB: R$400 | 256GB: R$500
Edge 20 Pro — 128GB: R$450 | 256GB: R$500
Edge 30 — 128GB: R$600 | 256GB: R$700
Edge 30 Neo — 128GB: R$700 | 256GB: R$700
Edge 30 Fusion — 128GB: R$700 | 256GB: R$700
Edge 30 Ultra — 256GB: R$1.400
Edge 40 — 128GB: R$700 | 256GB: R$800
Edge 40 Neo — 128GB: R$600 | 256GB: R$650
Edge 40 Pro — 256GB: R$900
Edge 50 — 128GB: R$900 | 256GB: R$950
Edge 50 Fusion — 128GB: R$700 | 256GB: R$800
Edge 50 Neo — 128GB: R$800 | 256GB: R$900
Edge 50 Pro — 128GB: R$1.200 | 256GB: R$1300
Edge 50 Ultra — 256GB: R$1700
Edge 60 — 128GB: R$1.000| 256GB: R$1.200
Edge 60 Fusion — 128GB: R$700 | 256GB: R$850
Edge 60 Pro — 256GB: R$1700
Edge 60 Stylus — 128GB: R$1.300 | 256GB: R$1.400

Moto Razr (dobrável, todas as gerações) — NÃO aceitamos na troca

━━━━━━━━━━━━━━━━━━━

REALME (valores de troca, aparelho sem defeito — modelo não listado: consultar equipe)

Realme C30 — 64GB: R$200
Realme C30s — 64GB: R$200
Realme C31 — 64GB: R$300
Realme C33 — 64GB: R$300 | 128GB: R$400
Realme C35 — 64GB: R$350 | 128GB: R$400
Realme C51 — 64GB: R$300 | 128GB: R$400
Realme C53 — 64GB: R$400 | 128GB: R$500
Realme C55 — 64GB: R$400 | 128GB: R$500
Realme C61 — 64GB: R$450 | 128GB: R$550
Realme C63 — 64GB: R$500 | 128GB: R$600
Realme C67 — 64GB: R$600 | 128GB: R$700
Realme C75 — 64GB: R$800 | 128GB: R$900

ATENÇÃO: se o modelo Android que o cliente mencionar não estiver EXATAMENTE listado nas tabelas acima (Samsung, Xiaomi, Motorola ou Realme), NÃO invente um valor nem estime por aproximação com um modelo parecido. Diga que esse modelo específico precisa ser avaliado presencialmente na loja, e que o valor será informado depois de verificado pela equipe.

——————————————
TÉCNICAS DE VENDAS
——————————————

CONTORNAR OBJEÇÃO DE PREÇO:
- Se o cliente disser "tá caro", nunca abaixe o preço imediatamente.
- Primeiro reforce o valor: "É um iPhone original, com garantia, seminovo revisado."
- Depois pergunte: "Qual valor você tinha em mente?" para entender o limite dele.
- Só ofereça desconto se o cliente insistir e estiver prestes a desistir.
- Nunca ofereça desconto maior que R$50 sem autorização.

CRIAR URGÊNCIA:
- Use frases como "Esse modelo tem saído bastante, não sei até quando vai ter estoque."
- "Temos poucos disponíveis nessa condição."
- Nunca invente informações — use urgência só quando fizer sentido.

FECHAR A VENDA:
- Sempre termine com uma pergunta que avance a negociação.
- Exemplos: "Você prefere pagar à vista ou parcelado?", "Posso reservar um para você?"
- Nunca deixe a conversa morrer sem uma proposta clara.
- Se o cliente mostrou interesse, avance: "Quando você pode vir na loja?"

ANCORAGEM:
- Quando o cliente pedir um modelo, mostre primeiro a versão com mais memória ou modelo superior.
- Só mostre o mais barato se o cliente pedir explicitamente.

- Quando o cliente pedir fotos ou quiser ver os aparelhos, envie o link: https://www.saemcelulares.net
- Nunca invente links ou páginas do site.
- NUNCA invente produtos que não estão na tabela.
- Quando o cliente pedir um modelo que NAO existe na tabela, SEMPRE comece dizendo 'No momento não temos o [modelo pedido] disponível.' e só depois ofereça o similar.
- Quando enviar links NUNCA use asteriscos ou negrito. Links limpos sem formatacao.
- Quando cliente pedir fotos envie: https://www.saemcelulares.net
- Valores de troca: NUNCA estime, calcule ou arredonde valores. Use EXATAMENTE o valor que esta na tabela de trocas.

REGRA GERAL
━━━━━━━━━━━━━━━━━━━

Nunca inventar preços, estoque, valores de troca, garantias ou parcelamentos.
Em caso de dúvida, informar que será necessário verificar com a equipe.`;

// ==========================================
// FILTRO DE REATIVAÇÃO
// ==========================================
const PALAVRAS_BOLETO = ['boleto', 'financiamento', 'análise de crédito', 'analise de credito', 'negativado', 'crediário', 'crediario', 'wa.me/5512981880229'];
const PALAVRAS_CORTAR = ['manutenção', 'manutencao', 'conserto', 'tela quebrada', 'bateria trocada', 'até logo', 'ate logo', 'obrigado', 'obrigada', 'boa sorte'];
const PALAVRAS_PRODUTO = ['iphone', 'ipad', 'macbook', 'samsung', 'xiaomi', 'motorola', 'redmi', 'galaxy', 'notebook', 'ps5', 'ps4', 'xbox', 'apple watch'];
const PALAVRAS_INTERESSE = ['troca', 'parcelar', 'parcela', 'cartão', 'cartao', 'pix', 'valor', 'reservar', 'reserva', 'preço', 'preco', 'quanto', 'disponível', 'disponivel'];

function extrairProduto(msgs) {
  const modelos = ['iphone 17', 'iphone 16 pro max', 'iphone 16 pro', 'iphone 16 plus', 'iphone 16', 'iphone 15 pro max', 'iphone 15 pro', 'iphone 15', 'iphone 14 pro max', 'iphone 14 pro', 'iphone 14', 'iphone 13 pro max', 'iphone 13 pro', 'iphone 13', 'iphone 12', 'iphone 11', 'macbook', 'samsung', 'xiaomi', 'notebook', 'ipad'];
  const texto = msgs.map(m => typeof m.content === 'string' ? m.content : '').join(' ').toLowerCase();
  for (const modelo of modelos) {
    if (texto.includes(modelo)) return modelo.charAt(0).toUpperCase() + modelo.slice(1);
  }
  return null;
}

function deveReativar(phone) {
  const meta = metaConversas[phone];
  if (!meta) return false;
  const msgs = conversas[phone] || [];
  if (msgs.length < 3) return false;
  const textoCompleto = msgs.map(m => typeof m.content === 'string' ? m.content : '').join(' ').toLowerCase();
  if (PALAVRAS_BOLETO.some(p => textoCompleto.includes(p))) return false;
  if (PALAVRAS_CORTAR.some(p => textoCompleto.includes(p))) return false;
  if (!PALAVRAS_PRODUTO.some(p => textoCompleto.includes(p))) return false;
  if (!PALAVRAS_INTERESSE.some(p => textoCompleto.includes(p))) return false;
  return true;
}

function gerarMensagemReativacao(phone) {
  const msgs = conversas[phone] || [];
  const produto = extrairProduto(msgs);
  if (produto) return `Oi! Passando pra ver se ficou alguma dúvida sobre o ${produto} que conversamos 😊 Qualquer coisa é só falar!`;
  return `Oi! Passando pra ver se ficou alguma dúvida sobre o que conversamos 😊 Qualquer coisa é só falar!`;
}

// ==========================================
// SISTEMA DE REATIVAÇÃO
// ==========================================
let reativacaoRodandoHoje = false;
let reativacaoRodandoAmanha = false;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function intervaloAleatorio() {
  return (Math.floor(Math.random() * (8 - 3 + 1)) + 3) * 60 * 1000;
}

async function executarReativacao(janela) {
  const agora = new Date();
  const hora = agora.getHours();
  if (janela === 'tarde' && hora < 18) return;
  if (janela === 'manha' && hora < 10) return;

  const candidatos = Object.keys(conversas).filter(phone => {
    if (!deveReativar(phone)) return false;
    const meta = metaConversas[phone];
    if (!meta || meta.reativado) return false;
    return true;
  });

  console.log(`🔔 Reativação ${janela}: ${candidatos.length} candidatos`);
  let enviados = 0;
  for (const phone of candidatos) {
    if (enviados >= 15 || new Date().getHours() >= 21) break;
    try {
      const msg = gerarMensagemReativacao(phone);
      await enviarMensagem(phone, msg);
      if (metaConversas[phone]) metaConversas[phone].reativado = true;
      salvarMetadados();
      enviados++;
      console.log(`✅ Reativação enviada para ${phone}`);
      if (enviados < candidatos.length && enviados < 15) {
        const intervalo = intervaloAleatorio();
        console.log(`⏱ Aguardando ${Math.round(intervalo/60000)} minutos...`);
        await sleep(intervalo);
      }
    } catch (e) {
      console.error(`Erro ao reativar ${phone}:`, e.message);
    }
  }
  console.log(`✅ Reativação ${janela} concluída: ${enviados} mensagens`);
}

// ==========================================
// CHECAGEM DE HORÁRIO DA REATIVAÇÃO — DESATIVADA
// ==========================================
// Disparo automático de reativação DESLIGADO a pedido do Saem (não estava
// dando retorno que justificasse o custo de API). As funções acima
// (executarReativacao, deveReativar, gerarMensagemReativacao etc) continuam
// existindo no código, só não são mais chamadas automaticamente por nenhum
// setInterval — ou seja, nenhuma mensagem de reativação é mais enviada
// sozinha. Se um dia quiser voltar a usar, é só reativar o bloco comentado
// abaixo.
//
// setInterval(() => {
//   const agora = new Date();
//   const hora = agora.getHours();
//
//   if (hora >= 18 && hora < 21 && !reativacaoRodandoHoje) {
//     reativacaoRodandoHoje = true;
//     executarReativacao('tarde').catch(console.error);
//   }
//
//   if (hora >= 10 && hora < 13 && !reativacaoRodandoAmanha) {
//     reativacaoRodandoAmanha = true;
//     executarReativacao('manha').catch(console.error);
//   }
//
//   if (hora === 0) {
//     if (reativacaoRodandoHoje || reativacaoRodandoAmanha) {
//       reativacaoRodandoHoje = false;
//       reativacaoRodandoAmanha = false;
//       try { fs.writeFileSync(ARQUIVO_NOITE_ANTERIOR, fs.readFileSync(ARQUIVO_CONVERSAS, 'utf8')); } catch (e) {}
//     }
//   }
// }, 60000);

// ==========================================
// TRANSCRIÇÃO DE ÁUDIO
// ==========================================
async function transcreverAudio(audioUrl, mimetype) {
  try {
    const audioResp = await axios.get(audioUrl, { responseType: 'arraybuffer' });
    const audioBuffer = Buffer.from(audioResp.data);
    let ext = 'ogg';
    if (mimetype?.includes('mp4')) ext = 'mp4';
    else if (mimetype?.includes('mpeg')) ext = 'mp3';
    else if (mimetype?.includes('wav')) ext = 'wav';
    else if (mimetype?.includes('webm')) ext = 'webm';
    const form = new FormData();
    form.append('file', audioBuffer, { filename: `audio.${ext}`, contentType: mimetype || 'audio/ogg' });
    form.append('model', 'whisper-1');
    form.append('language', 'pt');
    const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, ...form.getHeaders() }
    });
    return response.data.text;
  } catch (error) {
    console.error('❌ Erro transcrição:', error.response?.data || error.message);
    return null;
  }
}

// ==========================================
// CÁLCULO DE PARCELAMENTO
// ==========================================
const TAXAS_JUROS = {
  1: 0.0497, 2: 0.0553, 3: 0.0637, 4: 0.0802, 5: 0.0872, 6: 0.0947,
  7: 0.1059, 8: 0.1160, 9: 0.1243, 10: 0.1337, 11: 0.1385, 12: 0.1403,
  13: 0.1681, 14: 0.1810, 15: 0.1940, 16: 0.2072, 17: 0.2172, 18: 0.2193
};

function calcularParcelamento(saldo, parcelasDesejadas) {
  const parcelasParaCalcular = parcelasDesejadas?.length > 0 ? parcelasDesejadas : Object.keys(TAXAS_JUROS).map(Number);
  const resultado = {};
  for (const parcelas of parcelasParaCalcular) {
    const taxa = TAXAS_JUROS[parcelas];
    if (!taxa) continue;
    resultado[`${parcelas}x`] = `R$${((saldo * (1 + taxa)) / parcelas).toFixed(2).replace('.', ',')}`;
  }
  return resultado;
}

const FERRAMENTA_PARCELAMENTO = {
  name: "calcular_parcelamento",
  description: "Calcula os valores EXATOS de parcelamento de um saldo, usando a tabela oficial de juros da loja. SEMPRE use esta ferramenta para informar valores de parcela ao cliente — nunca calcule de cabeça.",
  input_schema: {
    type: "object",
    properties: {
      saldo: { type: "number", description: "Valor a ser parcelado, já descontado entrada e/ou troca" },
      parcelas: { type: "array", items: { type: "number" }, description: "Quantidades de parcelas a calcular" }
    },
    required: ["saldo"]
  }
};

// ==========================================
// CACHE INCREMENTAL DE CONVERSA (ECONOMIA)
// ==========================================
// Marca o último bloco da última mensagem com cache_control. Isso faz a API
// guardar em cache tudo que já foi enviado até aqui; na próxima chamada dessa
// mesma conversa, esse trecho anterior é lido a ~10% do preço normal, e só a
// parte nova (mensagem mais recente) é cobrada no valor cheio. Não altera em
// nada o comportamento do Cláudio nem o que fica salvo em conversas[phone] —
// é só uma marcação aplicada na cópia enviada para a API.
function comCacheBreakpoint(msg) {
  if (Array.isArray(msg.content)) {
    const conteudo = msg.content.map(b => ({ ...b }));
    if (conteudo.length > 0) {
      conteudo[conteudo.length - 1].cache_control = { type: "ephemeral", ttl: "1h" };
    }
    return { ...msg, content: conteudo };
  }
  return {
    ...msg,
    content: [{ type: "text", text: msg.content, cache_control: { type: "ephemeral", ttl: "1h" } }]
  };
}

function prepararMensagensParaEnvio(mensagens) {
  if (mensagens.length === 0) return mensagens;
  return mensagens.map((m, i) => i === mensagens.length - 1 ? comCacheBreakpoint(m) : m);
}

// ==========================================
// TRAVA DE SEGURANÇA — VERIFICAÇÃO DETERMINÍSTICA
// ==========================================
// Depois que o Cláudio gera a resposta, esta função confere se qualquer
// combinação "iPhone [modelo] [memória]GB" mencionada como oferta de venda
// (junto de um preço em R$) realmente existe, literalmente, na tabela de
// preços do Admin. Se não existir, a resposta é BLOQUEADA no código (não
// depende só do modelo "se comportar bem") e substituída por uma mensagem
// segura. Isso é uma segunda camada de proteção, além das regras do prompt.
function normalizarTexto(txt) {
  return (txt || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/(\d)\s*gb\b/g, '$1gb')
    .trim();
}

function extrairModelosMencionados(textoNormalizado) {
  // A memória (GB) é OPCIONAL nesta extração. Motivo: já aconteceu de o
  // Cláudio oferecer um modelo inexistente (ex: "iPhone 17 Pro Max") sem
  // mencionar a memória junto — se a regex exigisse sempre "XXGb" logo após
  // o modelo, esse tipo de alucinação passaria despercebido pela trava. Ao
  // tornar o "\d{2,4}\s*gb" opcional, capturamos tanto "iphone 17 pro max
  // 256gb" quanto apenas "iphone 17 pro max", garantindo que a verificação
  // rode mesmo quando a memória não é citada na frase.
  const regex = /iphone\s+\d+[a-z]*(?:\s+(?:pro\s+max|pro|plus|mini))?(?:\s+\d{2,4}\s*gb)?/g;
  return textoNormalizado.match(regex) || [];
}

// Divide a tabela de preços em duas partes (Novos / Seminovos) usando os
// cabeçalhos de seção. Isso permite conferir não só se o modelo+memória
// existe em algum lugar da tabela, mas se existe especificamente sob a
// condição (Novo ou Seminovo) que o Cláudio mencionou na resposta.
function dividirTabelaPorCondicao(tabelaCrua) {
  const regexNovos = /iphones?\s*novos/i;
  const regexSeminovos = /iphones?\s*seminovos/i;
  const matchNovos = tabelaCrua.match(regexNovos);
  const matchSeminovos = tabelaCrua.match(regexSeminovos);
  let chunkNovo = tabelaCrua;
  let chunkSeminovo = tabelaCrua;
  if (matchNovos && matchSeminovos) {
    const idxNovos = matchNovos.index;
    const idxSeminovos = matchSeminovos.index;
    if (idxNovos < idxSeminovos) {
      chunkNovo = tabelaCrua.slice(idxNovos, idxSeminovos);
      chunkSeminovo = tabelaCrua.slice(idxSeminovos);
    } else {
      chunkSeminovo = tabelaCrua.slice(idxSeminovos, idxNovos);
      chunkNovo = tabelaCrua.slice(idxNovos);
    }
  }
  return { novo: normalizarTexto(chunkNovo), seminovo: normalizarTexto(chunkSeminovo) };
}

// ==========================================
// TRAVA DE SEGURANÇA — COR ERRADA PARA O MODELO (MODELO CERTO, COR/PREÇO DE OUTRA LINHA)
// ==========================================
// Erro real que já aconteceu: cliente pediu "14 Pro Max 128GB Roxo" e o
// Cláudio respondeu "iPhone 14 Pro Max 128GB Roxo — R$2.999,00", só que na
// tabela o 14 Pro Max 128GB só existe em Dourado (R$3.499,00) — o "Roxo" e o
// preço R$2.999 são, na verdade, do iPhone 14 PRO (sem "Max") 128GB. Ou seja,
// o modelo citado existe na tabela, mas a COR foi emprestada de outra linha
// (outro modelo/condição). A trava de "modelo fora da tabela" não pega esse
// caso porque ela só confere se o texto "modelo+gb" existe em algum lugar da
// tabela — não confere se a cor citada junto realmente pertence àquela linha
// específica. Esta trava faz exatamente essa checagem extra.
const CORES_CONHECIDAS = [
  'preto', 'branco', 'azul', 'verde', 'rosa', 'roxo', 'dourado', 'prateado',
  'vermelho', 'amarelo', 'laranja', 'lilas', 'cinza', 'natural', 'titanium',
  'desert', 'red',
];

// Divide a tabela crua em blocos (um por produto, separados por linha em
// branco) e, pra cada bloco, identifica o "modelo+gb" e quais cores estão
// listadas nele (linhas que começam com ✅ ⤴️ ou ☑️).
function construirMapaModeloCor(tabelaCrua) {
  const mapa = {};
  const blocos = tabelaCrua.split(/\n\s*\n/);
  for (const bloco of blocos) {
    const blocoNormalizado = normalizarTexto(bloco);
    const modeloMatch = blocoNormalizado.match(/iphone\s+\d+[a-z]*(?:\s+(?:pro\s+max|pro|plus|mini))?\s+\d{2,4}\s*gb/);
    if (!modeloMatch) continue;
    const modelo = modeloMatch[0];
    if (!mapa[modelo]) mapa[modelo] = new Set();

    const linhas = bloco.split('\n').map(l => l.trim()).filter(Boolean);
    for (const linha of linhas) {
      if (!/^[✅⤴️☑️]/.test(linha)) continue;
      const linhaNormalizada = normalizarTexto(linha);
      for (const cor of CORES_CONHECIDAS) {
        if (new RegExp(`\\b${cor}\\b`).test(linhaNormalizada)) {
          mapa[modelo].add(cor);
        }
      }
    }
  }
  return mapa;
}

function respostaTemCorErradaParaModelo(reply) {
  if (!/r\$/i.test(reply)) return false;
  const replyLower = reply.toLowerCase();
  if (replyLower.includes('equipe') && (replyLower.includes('verificar') || replyLower.includes('retorno'))) return false;

  const tabelaCrua = process.env.PRICE_TABLE || '';
  if (!tabelaCrua) return false;
  const mapaModeloCor = construirMapaModeloCor(tabelaCrua);

  const regexNegacao = /nao tem|não tem|indisponivel|indisponível|sem estoque|esgotado|nao temos|não temos/;
  const trechos = reply.split(/(?<=[.!?\n])\s*/);
  for (const trecho of trechos) {
    if (regexNegacao.test(trecho.toLowerCase())) continue;
    const trechoNormalizado = normalizarTexto(trecho);

    // Só considera quando o trecho cita o modelo JUNTO com a memória (GB) —
    // é preciso saber a linha exata da tabela pra validar a cor certinho.
    const modelos = extrairModelosMencionados(trechoNormalizado).filter(m => /\d{2,4}gb/.test(m));
    if (modelos.length === 0) continue;

    const coresNoTrecho = CORES_CONHECIDAS.filter(cor => new RegExp(`\\b${cor}\\b`).test(trechoNormalizado));
    if (coresNoTrecho.length === 0) continue;

    for (const modelo of modelos) {
      const coresValidas = mapaModeloCor[modelo];
      if (!coresValidas) continue; // modelo não encontrado no mapa — outra trava cuida disso
      for (const cor of coresNoTrecho) {
        if (!coresValidas.has(cor)) {
          console.log(`⚠️ Cor incorreta bloqueada: "${cor}" não é uma cor válida para "${modelo}"`);
          return true;
        }
      }
    }
  }
  return false;
}

// Quando a trava acima bloqueia, pedimos pro Cláudio corrigir a resposta
// usando a cor (e o preço correspondente) que realmente existe pra aquele
// modelo+memória exatos na tabela, em vez de emprestar de outra linha.
async function gerarRespostaCorrigindoCorModelo(mensagens) {
  try {
    if (mensagens.length === 0) return null;

    const instrucao = '\n\n[INSTRUÇÃO INTERNA DO SISTEMA — NÃO É MENSAGEM DO CLIENTE, NÃO RESPONDA A ELA DIRETAMENTE, APENAS SIGA A ORIENTAÇÃO]: Sua resposta anterior citou uma COR que não pertence à linha exata do modelo+memória mencionado na tabela de preços (a cor foi emprestada de outro modelo, outra memória ou outra condição). Releia a tabela com atenção e confira, pra esse modelo+memória exatos, quais cores e qual preço estão realmente listados juntos. Se a cor que o cliente pediu não existir para esse modelo+memória, informe isso claramente e ofereça a(s) cor(es) que realmente estão disponíveis para esse modelo, com o preço correto. NUNCA misture cor de uma linha com preço de outra. Seja breve (1 a 3 frases) e termine com uma pergunta que ajude a fechar a venda.';

    const ultima = mensagens[mensagens.length - 1];
    let ultimaComInstrucao;
    if (typeof ultima.content === 'string') {
      ultimaComInstrucao = { ...ultima, content: ultima.content + instrucao };
    } else if (Array.isArray(ultima.content)) {
      const conteudo = ultima.content.map(b => ({ ...b }));
      conteudo.push({ type: 'text', text: instrucao });
      ultimaComInstrucao = { ...ultima, content: conteudo };
    } else {
      ultimaComInstrucao = ultima;
    }
    const mensagensComInstrucao = [...mensagens.slice(0, -1), ultimaComInstrucao];

    const respostaCorrigida = await chamarClaude(mensagensComInstrucao);
    if (!respostaTemCorErradaParaModelo(respostaCorrigida)) {
      return respostaCorrigida;
    }
  } catch (e) {
    console.error('Erro ao corrigir cor do modelo:', e.message);
  }
  return null;
}

function respostaTemModeloForaDaTabela(reply) {
  // Só verifica respostas que parecem oferecer um produto à venda (têm preço em R$)
  if (!/r\$/i.test(reply)) return false;
  // Não verifica quando o Cláudio já está encaminhando pra equipe (resposta já é segura)
  const replyLower = reply.toLowerCase();
  if (replyLower.includes('equipe') && (replyLower.includes('verificar') || replyLower.includes('retorno'))) return false;

  const tabelaCrua = process.env.PRICE_TABLE || '';
  const tabelaNormalizada = normalizarTexto(tabelaCrua);

  // Divide a resposta em frases/trechos e IGNORA qualquer trecho que já diga
  // explicitamente que o modelo NÃO está disponível (ex: "não temos o iPhone X").
  // Isso evita bloquear respostas corretas que citam o modelo indisponível só
  // como contexto antes de oferecer uma alternativa real.
  const regexNegacao = /nao tem|não tem|indisponivel|indisponível|sem estoque|esgotado|nao temos|não temos/;
  const trechos = reply.split(/(?<=[.!?\n])\s*/);
  let modelosMencionados = [];
  for (const trecho of trechos) {
    if (regexNegacao.test(trecho.toLowerCase())) continue;
    modelosMencionados.push(...extrairModelosMencionados(normalizarTexto(trecho)));
  }
  modelosMencionados = [...new Set(modelosMencionados)];

  if (modelosMencionados.length === 0) return false;

  // Verificação 1: o modelo+memória existe em ALGUM lugar da tabela
  for (const modelo of modelosMencionados) {
    if (!tabelaNormalizada.includes(modelo)) {
      console.log(`⚠️ Possível alucinação bloqueada: "${modelo}" não encontrado na tabela de preços`);
      return true;
    }
  }

  // Verificação 2: se a resposta menciona explicitamente "Novo" ou "Seminovo",
  // confirma que o modelo existe sob ESSA condição específica — evita pegar o
  // preço de uma condição e rotular como se fosse a outra (ex: usar o preço do
  // Novo e chamar de Seminovo, ou vice-versa).
  const mencionaSeminovo = /\bseminovo\b/.test(replyLower);
  const mencionaNovo = /\bnovo\b/.test(replyLower) && !mencionaSeminovo;
  if (mencionaSeminovo || mencionaNovo) {
    const { novo, seminovo } = dividirTabelaPorCondicao(tabelaCrua);
    const chunkEsperado = mencionaSeminovo ? seminovo : novo;
    for (const modelo of modelosMencionados) {
      if (!chunkEsperado.includes(modelo)) {
        console.log(`⚠️ Possível alucinação bloqueada: "${modelo}" não encontrado como ${mencionaSeminovo ? 'Seminovo' : 'Novo'} na tabela`);
        return true;
      }
    }
  }

  return false;
}

const RESPOSTA_SEGURA_FALLBACK = 'No momento não temos esse modelo específico disponível. Consigo te mostrar nosso catálogo completo com tudo que temos: https://docs.google.com/document/d/10-sOETWnw8hazOiKq9eCZ3MG1L7kn3m8A71eFMOlZq0/edit?usp=drivesdk — tem algum outro modelo em mente? 😊';

// ==========================================
// TRAVA DE SEGURANÇA — LOOP DE RESPOSTA REPETIDA
// ==========================================
// Erro real que já aconteceu: o Cláudio travou repetindo a MESMA resposta
// (geralmente o fallback de "modelo não disponível... catálogo...") pra
// várias mensagens seguidas do cliente, mesmo quando o cliente já tinha
// mudado de assunto completamente (ex: perguntou "pode me mandar foto?" e
// "meu Deus moço" depois, e recebeu a mesma resposta de antes, idêntica,
// como se o Cláudio tivesse parado de ler as mensagens novas). Isso é um
// padrão de "eco" que pode acontecer quando o modelo se ancora demais no
// próprio histórico de respostas repetidas. Esta trava compara a resposta
// atual com a(s) última(s) resposta(s) do assistente no histórico — se forem
// idênticas (ou quase), força uma nova geração com instrução explícita pra
// parar de repetir e responder de verdade a mensagem mais recente do cliente.
function normalizarParaComparacao(txt) {
  return (txt || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function respostaRepetidaEmLoop(reply, mensagens) {
  if (!Array.isArray(mensagens) || mensagens.length === 0) return false;
  const replyNormalizada = normalizarParaComparacao(reply);
  if (!replyNormalizada) return false;

  // Olha as últimas mensagens do assistente no histórico (antes da atual)
  const ultimasAssistente = mensagens
    .filter(m => m.role === 'assistant' && typeof m.content === 'string')
    .slice(-2);

  return ultimasAssistente.some(m => normalizarParaComparacao(m.content) === replyNormalizada);
}

// Quando a trava acima detecta o loop, pedimos pro Cláudio parar de repetir e
// responder de verdade à mensagem mais recente do cliente.
async function gerarRespostaQuebrandoLoop(mensagens) {
  try {
    if (mensagens.length === 0) return null;

    const instrucao = '\n\n[INSTRUÇÃO INTERNA DO SISTEMA — NÃO É MENSAGEM DO CLIENTE, NÃO RESPONDA A ELA DIRETAMENTE, APENAS SIGA A ORIENTAÇÃO]: Sua resposta anterior repetiu EXATAMENTE a mesma mensagem de antes, ignorando o que o cliente acabou de escrever. Isso é um erro grave. Releia com atenção a ÚLTIMA mensagem do cliente (a mais recente, não uma anterior) e responda especificamente a ELA — se for um comentário casual, responda com naturalidade; se for um pedido de foto, mande o link do site; se for sobre outro modelo, verifique a tabela de novo do zero. NÃO repita nenhuma frase que você já usou nas últimas respostas desta conversa. Seja breve e direto ao que foi perguntado agora.';

    const ultima = mensagens[mensagens.length - 1];
    let ultimaComInstrucao;
    if (typeof ultima.content === 'string') {
      ultimaComInstrucao = { ...ultima, content: ultima.content + instrucao };
    } else if (Array.isArray(ultima.content)) {
      const conteudo = ultima.content.map(b => ({ ...b }));
      conteudo.push({ type: 'text', text: instrucao });
      ultimaComInstrucao = { ...ultima, content: conteudo };
    } else {
      ultimaComInstrucao = ultima;
    }
    const mensagensComInstrucao = [...mensagens.slice(0, -1), ultimaComInstrucao];

    const respostaCorrigida = await chamarClaude(mensagensComInstrucao);
    if (!respostaRepetidaEmLoop(respostaCorrigida, mensagens)) {
      return respostaCorrigida;
    }
  } catch (e) {
    console.error('Erro ao quebrar loop de resposta repetida:', e.message);
  }
  return null;
}

// ==========================================
// TRAVA DE SEGURANÇA — PEDIR CONFIRMAÇÃO DE ALGO QUE JÁ FOI CONFIRMADO
// ==========================================
// Erro real que já aconteceu, repetidas vezes: mesmo depois de um valor de
// troca ser confirmado (via mensagem manual ou "[EQUIPE]: valor..."), umas
// mensagens depois — depois do cliente já ter escolhido modelo, cor, loja
// — o Cláudio "esquece" de novo e volta a falar "assim que a equipe
// confirmar o valor..." ou "vou verificar com a equipe", como se o valor
// ainda estivesse pendente. Isso é um hábito de linguagem do modelo que as
// instruções de prompt sozinhas não eliminaram por completo. Esta trava
// verifica se a resposta atual fala em "esperar"/"assim que a equipe
// confirmar" sobre um valor, MAS já existe uma mensagem "[EQUIPE]:" real no
// histórico desta conversa — ou seja, o valor JÁ foi confirmado antes, e
// essa fala é uma regressão, não uma pendência de verdade.
function respostaPedeConfirmacaoJaConfirmada(reply, mensagens) {
  const replyLower = reply.toLowerCase();
  const falaDeEspera = /assim que a equipe confirmar|vou verificar (o valor )?com a equipe|aguard\w* a? confirma[çc][ãa]o da equipe|preciso que a equipe avalie/i.test(replyLower);
  if (!falaDeEspera) return false;

  const jaTemValorConfirmado = Array.isArray(mensagens) && mensagens.some(m =>
    typeof m.content === 'string' && m.content.startsWith('[EQUIPE]:')
  );
  return jaTemValorConfirmado;
}

// Quando a trava acima detecta a regressão, pedimos pro Cláudio corrigir
// usando o valor que JÁ foi confirmado, sem voltar a pedir confirmação.
async function gerarRespostaCorrigindoConfirmacaoRegressao(mensagens) {
  try {
    if (mensagens.length === 0) return null;

    const instrucao = '\n\n[INSTRUÇÃO INTERNA DO SISTEMA — NÃO É MENSAGEM DO CLIENTE, NÃO RESPONDA A ELA DIRETAMENTE, APENAS SIGA A ORIENTAÇÃO]: Sua resposta anterior falou em "esperar a equipe confirmar" um valor de troca — mas esse valor JÁ FOI CONFIRMADO antes nesta mesma conversa (procure no histórico por uma mensagem "[EQUIPE]: O valor de troca..."). Isso é um erro: releia o histórico, encontre esse valor já confirmado, e refaça a resposta USANDO esse valor diretamente na simulação (com o modelo, cor e loja que o cliente já escolheu), sem pedir confirmação de novo. Seja breve e direto, mostrando o saldo final e as opções de parcelamento.';

    const ultima = mensagens[mensagens.length - 1];
    let ultimaComInstrucao;
    if (typeof ultima.content === 'string') {
      ultimaComInstrucao = { ...ultima, content: ultima.content + instrucao };
    } else if (Array.isArray(ultima.content)) {
      const conteudo = ultima.content.map(b => ({ ...b }));
      conteudo.push({ type: 'text', text: instrucao });
      ultimaComInstrucao = { ...ultima, content: conteudo };
    } else {
      ultimaComInstrucao = ultima;
    }
    const mensagensComInstrucao = [...mensagens.slice(0, -1), ultimaComInstrucao];

    const respostaCorrigida = await chamarClaude(mensagensComInstrucao);
    if (!respostaPedeConfirmacaoJaConfirmada(respostaCorrigida, mensagens)) {
      return respostaCorrigida;
    }
  } catch (e) {
    console.error('Erro ao corrigir regressão de confirmação:', e.message);
  }
  return null;
}

// ==========================================
// TRAVA DE SEGURANÇA — PERGUNTA DE TROCA TRATADA COMO VENDA
// ==========================================
// Erro real que já aconteceu: cliente perguntou "e quanto cê pega meu iPhone
// 16 Pro Max 512GB bateria 85 sem defeitos" (uma pergunta de TROCA — quanto a
// loja paga pelo aparelho DELE) e o Cláudio respondeu como se fosse pergunta
// de VENDA ("No momento não temos esse modelo disponível..."), o que não faz
// sentido nenhum nesse contexto. Esta trava detecta esse padrão pela
// mensagem do cliente (linguagem típica de troca: "quanto vc pega", "quanto
// paga", "aceita meu", "dar de entrada" etc) combinada com uma resposta que
// parece recusa de venda, e força uma nova geração de resposta usando
// explicitamente a tabela de TROCA correta.
function mensagemPareceTroca(mensagemCliente) {
  const texto = normalizarTexto(mensagemCliente);
  if (!texto) return false;
  const padroesTroca = [
    /quanto\s+(vc|voce|você|ce|c[eê])\s+(pega|paga|d[aá])/,
    /quanto\s+(vc|voce|você|ce|c[eê])s?\s+pagam/,
    /quanto\s+pega(m)?\s+(o\s+)?meu/,
    /quanto\s+(vale|fica|da)\s+(o\s+)?meu.*(troca|entrada)/,
    /pega(m)?\s+(o\s+)?meu\s+\w+/,
    /paga(m)?\s+(o\s+)?meu\s+\w+/,
    /aceita(m)?\s+(o\s+)?meu\s+\w+/,
    /avali(ar|a)\s+(o\s+)?meu\s+\w+/,
    /dar\s+(de\s+)?(entrada|troca)/,
    /usar\s+(de\s+)?(entrada|troca)/,
    /troca(r)?\s+(o\s+)?meu\s+\w+/,
    /entrada\s+(com\s+)?(o\s+)?meu\s+\w+/
  ];
  return padroesTroca.some(p => p.test(texto));
}

// ERRO REAL QUE MOTIVOU ESTE COMPLEMENTO: o próprio Cláudio perguntou "Me
// conta: qual aparelho você tem para dar de entrada, e qual iPhone você tá
// pensando em levar?". O cliente respondeu só "iPhone 11 Pro 64gb 86% de
// bateria e sem defeitos" — sem nenhuma palavra de troca na frase, porque ele
// só está respondendo a pergunta que o próprio Cláudio fez. A trava anterior
// não pegava esse caso, pois só analisava a linguagem da mensagem do cliente
// isoladamente. Esta função olha a ÚLTIMA mensagem do assistente ANTES da
// mensagem atual do cliente: se o próprio Cláudio pediu o aparelho de
// entrada/troca, qualquer resposta do cliente descrevendo um aparelho
// (modelo, memória, bateria) deve ser tratada como troca, mesmo sem palavras-
// chave de troca na frase do cliente.
function assistentePerguntouSobreAparelhoDeTroca(mensagens) {
  if (!Array.isArray(mensagens) || mensagens.length < 2) return false;
  // Erro real que já aconteceu: o assistente estabeleceu que era uma troca
  // duas mensagens atrás ("Boa! Então você pode dar ele como entrada na
  // troca 😊 Me conta: qual a memória..."), mas na mensagem seguinte só
  // pediu um detalhe que faltou (a memória), sem repetir a palavra "troca"
  // ou "entrada". O cliente respondeu só "128gb" a essa pergunta de detalhe,
  // e a verificação antiga olhava SÓ a mensagem do assistente imediatamente
  // anterior — que não tinha nenhuma palavra-chave de troca — e já retornava
  // false ali, sem continuar procurando pra trás. Corrigido: agora continua
  // escaneando várias mensagens do assistente pra trás (não só a mais
  // recente) até achar uma que estabeleça claramente que é uma negociação
  // de troca, olhando as últimas ~8 mensagens do histórico.
  // ERRO REAL QUE JÁ ACONTECEU: um cliente pediu pra trocar o iPhone 12 Pro
  // Max por um 15 Pro Max, o Cláudio perguntou corretamente "Me conta um
  // pouco sobre o seu iPhone 12 Pro Max: Quantos GB é o seu? Saúde da
  // bateria (em %)? Tem algum defeito (tela, traseira, Face ID, etc)?" — mas
  // essa frase não batia com NENHUM padrão abaixo (não tem "dar de entrada",
  // não tem "tela, traseira, bateria" em sequência, não tem "do seu" logo
  // após bateria/tela). O cliente respondeu só "256 / 75% / Nenhum defeito"
  // e essa resposta foi tratada como pergunta de VENDA, dizendo que não
  // tínhamos o modelo. Adicionados os padrões que faltavam pra cobrir esse
  // formato real de pergunta de avaliação.
  const regexPerguntaSobreAparelhoTroca = /dar\s+(ele\s+)?(como\s+)?(de\s+)?entrada|entrada\s+na\s+(troca|compra)|qual\s+aparelho\s+voce\s+tem\s+para\s+dar\s+de\s+entrada|tem\s+algum\s+aparelho\s+para\s+troca|modelo,?\s+memoria\s+e\s+estado|saude\s+da\s+bateria|quantos\s+gb\s+e\s+o\s+seu|conta\s+(um\s+pouco\s+)?sobre\s+o\s+seu\s+\w+|(memoria|bateria|tela|traseira)\s+do\s+seu\s+\w+|tela\s*,?\s*traseira\s*,?\s*bateria/;

  const ultimasMensagens = mensagens.slice(-9, -1); // últimas ~8, excluindo a mensagem atual do cliente
  for (let i = ultimasMensagens.length - 1; i >= 0; i--) {
    const m = ultimasMensagens[i];
    if (m.role !== 'assistant') continue;
    const texto = normalizarTexto(typeof m.content === 'string' ? m.content : '');
    if (regexPerguntaSobreAparelhoTroca.test(texto)) return true;
  }
  return false;
}

function respostaTrocaTratadaComoVenda(mensagemCliente, reply, mensagens) {
  const pareceTroca = mensagemPareceTroca(mensagemCliente) || assistentePerguntouSobreAparelhoDeTroca(mensagens);
  if (!pareceTroca) return false;
  const replyLower = reply.toLowerCase();
  // Se a resposta já encaminha pra equipe (comportamento correto e seguro), não é o bug
  if (replyLower.includes('equipe') && (replyLower.includes('verificar') || replyLower.includes('retorno'))) return false;
  // Se a resposta já traz um valor de troca de verdade (R$ sem mandar pro catálogo), está correta
  const mandaCatalogo = replyLower.includes('catalogo') || replyLower.includes('catálogo') || replyLower.includes('docs.google.com');
  const pareceRecusaDeVenda = /nao temos esse modelo|não temos esse modelo|no momento nao temos|no momento não temos|nao temos esse|não temos esse/.test(replyLower);
  if (!pareceRecusaDeVenda) return false;
  if (/r\$/.test(replyLower) && !mandaCatalogo) return false;
  return true;
}

// Quando a trava acima detecta o bug, pedimos pro Cláudio corrigir usando a
// tabela de TROCA certa, deixando claro que a pergunta era sobre quanto a
// loja paga, não sobre comprar um aparelho.
async function gerarRespostaCorrigindoTrocaConfundidaComVenda(mensagens) {
  try {
    if (mensagens.length === 0) return null;

    const instrucao = '\n\n[INSTRUÇÃO INTERNA DO SISTEMA — NÃO É MENSAGEM DO CLIENTE, NÃO RESPONDA A ELA DIRETAMENTE, APENAS SIGA A ORIENTAÇÃO]: Sua resposta anterior tratou a pergunta do cliente como se fosse sobre COMPRAR um aparelho (venda) e disse que o modelo não estava disponível, mandando para o catálogo. Isso está ERRADO: releia a mensagem do cliente com atenção — ele está perguntando quanto a loja PAGA pelo aparelho DELE como TROCA/entrada, não perguntando se pode comprar. Refaça a resposta usando APENAS a tabela de VALORES DE TROCA correspondente (iPhone, Android, Apple Watch, iPad, notebook ou MacBook, conforme o aparelho mencionado), encontrando a linha EXATA que bate com modelo, memória e condição/bateria/defeitos informados (repare que bateria acima de 80% conta como "sem defeito" na tabela de iPhone). Nunca invente ou estime o valor. Se não encontrar uma linha exata na tabela de troca, diga que vai verificar o valor com a equipe e que retorna em instantes — nunca diga "não temos esse modelo disponível" nem mande para o catálogo, pois essa não é uma pergunta de venda. Seja breve (1 a 3 frases).';

    const ultima = mensagens[mensagens.length - 1];
    let ultimaComInstrucao;
    if (typeof ultima.content === 'string') {
      ultimaComInstrucao = { ...ultima, content: ultima.content + instrucao };
    } else if (Array.isArray(ultima.content)) {
      const conteudo = ultima.content.map(b => ({ ...b }));
      conteudo.push({ type: 'text', text: instrucao });
      ultimaComInstrucao = { ...ultima, content: conteudo };
    } else {
      ultimaComInstrucao = ultima;
    }
    const mensagensComInstrucao = [...mensagens.slice(0, -1), ultimaComInstrucao];

    const respostaCorrigida = await chamarClaude(mensagensComInstrucao);
    const replyLower = respostaCorrigida.toLowerCase();
    const aindaRecusaDeVenda = /nao temos esse modelo|não temos esse modelo|no momento nao temos|no momento não temos/.test(replyLower);
    if (!aindaRecusaDeVenda) return respostaCorrigida;
  } catch (e) {
    console.error('Erro ao corrigir troca confundida com venda:', e.message);
  }
  return null;
}

// ==========================================
// TRAVA DE SEGURANÇA — VALOR DE TROCA ANDROID INVENTADO
// ==========================================
// Erro real que já aconteceu: um cliente com "Poco X7" recebeu um valor de
// troca de R$1.999 (na verdade o preço do iPhone que ele queria comprar,
// não um valor real de troca — o Poco X7 nem existe na tabela, só o Poco M6
// a R$350). Esta trava confere se qualquer modelo Android mencionado junto
// de um valor em R$ (num contexto de troca/entrada) realmente bate com uma
// linha exata da tabela de troca Android (Samsung, Xiaomi/Poco/Redmi,
// Motorola, Realme). Se o modelo mencionado não existir na lista abaixo, a
// resposta é bloqueada e substituída por uma que apenas escala para a
// equipe — do mesmo jeito que já acontece corretamente noutros casos
// (ex: Moto G06, Galaxy A02a/A02s).
const ANDROID_TROCA_MODELOS_VALIDOS = [
  // Samsung Galaxy S
  "galaxy s20", "galaxy s20+", "galaxy s20 ultra",
  "galaxy s21", "galaxy s21+", "galaxy s21 ultra",
  "galaxy s22", "galaxy s22+", "galaxy s22 ultra",
  "galaxy s23", "galaxy s23+", "galaxy s23 ultra", "galaxy s23 fe",
  "galaxy s24", "galaxy s24+", "galaxy s24 ultra", "galaxy s24 fe",
  "galaxy s25", "galaxy s25 fe", "galaxy s25+", "galaxy s25 ultra",
  // Samsung Galaxy A
  "galaxy a02", "galaxy a01", "galaxy a21s", "galaxy a22s",
  "galaxy a11", "galaxy a12", "galaxy a13", "galaxy a14", "galaxy a15", "galaxy a07",
  "galaxy a03", "galaxy a03s", "galaxy a04", "galaxy a04s", "galaxy a05", "galaxy a05s",
  "galaxy a16", "galaxy a22", "galaxy a23", "galaxy a24", "galaxy a32", "galaxy a33",
  "galaxy a25", "galaxy a26", "galaxy a34", "galaxy a35", "galaxy a36",
  "galaxy a52", "galaxy a53", "galaxy a54", "galaxy a55", "galaxy a56",
  "galaxy a72", "galaxy a73",
  "galaxy a20", "galaxy a20s", "galaxy a21",
  "galaxy a30", "galaxy a30s", "galaxy a31",
  "galaxy a50", "galaxy a50s", "galaxy a51",
  "galaxy a70", "galaxy a71", "galaxy a17",
  // Samsung Galaxy M
  "galaxy m12", "galaxy m13", "galaxy m14",
  "galaxy m22", "galaxy m23", "galaxy m24",
  "galaxy m32", "galaxy m33", "galaxy m34",
  "galaxy m52", "galaxy m53", "galaxy m54", "galaxy m55",
  // Samsung Galaxy Note
  "galaxy note 10", "galaxy note 10 lite", "galaxy note 10+",
  "galaxy note 20", "galaxy note 20 ultra",
  // Samsung Galaxy J
  "galaxy j5", "galaxy j6", "galaxy j7", "galaxy j7 prime", "galaxy j8",
  // Xiaomi / Poco / Redmi (linha number + poco/redmi avulsos)
  "xiaomi 11", "xiaomi 11t", "xiaomi 11t pro",
  "xiaomi 12", "xiaomi 12 pro", "xiaomi 12t", "xiaomi 12t pro",
  "xiaomi 13", "xiaomi 13 pro", "xiaomi 13t", "xiaomi 13t pro",
  "xiaomi 14", "xiaomi 14 pro", "xiaomi 14t", "xiaomi 14t pro", "xiaomi 14 ultra",
  "xiaomi 15", "xiaomi 15 pro", "xiaomi 15 ultra",
  "poco m6", "poco c71", "poco x3", "poco x4", "poco x5", "poco x6", "poco x7",
  "poco f3", "poco f4", "poco f5", "poco f6",
  "poco m3", "poco m4", "poco m5", "poco m6 pro",
  "redmi a5", "redmi 9", "redmi 9a", "redmi 9c",
  "redmi 10", "redmi 10c", "redmi 12", "redmi 12c", "redmi 13", "redmi 13c",
  // Redmi Note
  "redmi note 10", "redmi note 10s", "redmi note 10 pro",
  "redmi note 11", "redmi note 11 pro", "redmi note 11 pro+",
  "redmi note 12", "redmi note 12 pro", "redmi note 12 pro+",
  "redmi note 13", "redmi note 13 pro", "redmi note 13 pro+",
  "redmi note 14", "redmi note 14 pro", "redmi note 14 pro max",
  // Motorola Moto G
  "moto g1", "moto g2", "moto g3", "moto g4", "moto g5",
  "moto g04", "moto g05s", "moto g9", "moto g05",
  "moto g9 play", "moto g9 plus", "moto g22", "moto g24",
  "moto g15", "moto g31", "moto g32", "moto g34", "moto g35", "moto g41", "moto g42",
  "moto g51", "moto g52", "moto g53", "moto g54", "moto g55", "moto g56",
  "moto g62", "moto g64", "moto g65", "moto g71", "moto g72", "moto g73", "moto g75",
  "moto g82", "moto g84", "moto g85", "moto g86", "moto g96",
  "moto g6", "moto g6 play", "moto g6 plus",
  "moto g7", "moto g7 play", "moto g7 power",
  "moto g8", "moto g8 play", "moto g8 power",
  "moto g10", "moto g20", "moto g30",
  // Motorola Moto E
  "moto e4", "moto e5", "moto e6", "moto e7",
  "moto e13", "moto e14", "moto e15", "moto e22", "moto e32", "moto e40",
  // Motorola One
  "moto one action", "moto one fusion", "moto one fusion+", "moto one hyper", "moto one macro",
  // Motorola Edge
  "edge 20", "edge 20 pro", "edge 30", "edge 30 neo", "edge 30 fusion", "edge 30 ultra",
  "edge 40", "edge 40 neo", "edge 40 pro",
  "edge 50", "edge 50 fusion", "edge 50 neo", "edge 50 pro", "edge 50 ultra",
  "edge 60", "edge 60 fusion", "edge 60 pro", "edge 60 stylus",
  // Realme
  "realme c30", "realme c30s", "realme c31", "realme c33", "realme c35",
  "realme c51", "realme c53", "realme c55", "realme c61", "realme c63", "realme c67", "realme c75",
].map(normalizarTexto);

// Moto Razr (dobrável) propositalmente NÃO está na whitelist acima — assim
// como os dobráveis Galaxy Z Flip/Z Fold, qualquer valor de troca citado
// para ele já cai automaticamente na trava abaixo (modelo fora da lista).

// Captura menções a marca+modelo Android na resposta (ex: "poco x7", "moto g54",
// "galaxy s23", "redmi note 12", "realme c53", "xiaomi 12t pro"). Não exige
// memória/GB, pois o valor de troca costuma ser citado sem repetir a memória.
function extrairModelosAndroidMencionados(textoNormalizado) {
  const regex = /(poco\s+\w+\d*(?:\s*pro)?|redmi\s+(?:note\s+\d+\w*(?:\s*pro\+?)?|a\d+\w*|\d+\w*)|moto\s+(?:g\s*\d+\w*(?:\s*(?:play|plus|power))?|edge\s*\d+\w*|e\s*\d+\w*|one\s+(?:action|fusion\+?|hyper|macro)|razr\w*)|galaxy\s+(?:s\d+\w*(?:\s*ultra)?(?:\s*fe)?|a\d+\w*|m\d+\w*|note\s*\d+\w*(?:\s*ultra|\s*lite|\s*\+)?|j\d+\w*(?:\s*prime)?|z\s*(?:flip|fold)\s*\d*)|realme\s+c\d+\w*|xiaomi\s+\d+\w*(?:\s*(?:t\s*pro|t|pro|ultra))?)/g;
  return textoNormalizado.match(regex) || [];
}

function respostaInventouValorTrocaAndroid(reply) {
  // Só verifica quando a resposta parece dar um valor de troca de verdade
  if (!/r\$/i.test(reply)) return false;
  const replyLower = reply.toLowerCase();
  // Se já está encaminhando pra equipe, a resposta já é segura
  if (replyLower.includes('equipe') && (replyLower.includes('verificar') || replyLower.includes('retorno'))) return false;

  const modelosMencionados = [...new Set(extrairModelosAndroidMencionados(normalizarTexto(reply)))];
  if (modelosMencionados.length === 0) return false;

  for (const modelo of modelosMencionados) {
    if (!ANDROID_TROCA_MODELOS_VALIDOS.includes(modelo)) {
      console.log(`⚠️ Valor de troca Android inventado bloqueado: "${modelo}" não encontrado na tabela de troca`);
      return true;
    }
  }
  return false;
}

// Quando a trava acima bloqueia, pedimos pro Cláudio corrigir a resposta
// escalando corretamente pra equipe, em vez de inventar um valor.
async function gerarRespostaCorrigindoValorAndroid(mensagens) {
  try {
    if (mensagens.length === 0) return null;

    const instrucao = '\n\n[INSTRUÇÃO INTERNA DO SISTEMA — NÃO É MENSAGEM DO CLIENTE, NÃO RESPONDA A ELA DIRETAMENTE, APENAS SIGA A ORIENTAÇÃO]: Sua resposta anterior informou um valor de troca para um aparelho Android que NÃO existe na tabela de troca (releia a seção VALORES DE TROCA - ANDROID com atenção). NUNCA invente, estime ou "empreste" valor de outro produto (nem mesmo do preço de venda do iPhone que o cliente está comprando). Refaça a resposta informando que vai verificar esse valor com a equipe e que retorna em instantes, sem encaminhar para outro número. Seja breve (1 a 3 frases).';

    const ultima = mensagens[mensagens.length - 1];
    let ultimaComInstrucao;
    if (typeof ultima.content === 'string') {
      ultimaComInstrucao = { ...ultima, content: ultima.content + instrucao };
    } else if (Array.isArray(ultima.content)) {
      const conteudo = ultima.content.map(b => ({ ...b }));
      conteudo.push({ type: 'text', text: instrucao });
      ultimaComInstrucao = { ...ultima, content: conteudo };
    } else {
      ultimaComInstrucao = ultima;
    }
    const mensagensComInstrucao = [...mensagens.slice(0, -1), ultimaComInstrucao];

    const respostaCorrigida = await chamarClaude(mensagensComInstrucao);
    if (!respostaInventouValorTrocaAndroid(respostaCorrigida)) {
      return respostaCorrigida;
    }
  } catch (e) {
    console.error('Erro ao corrigir valor de troca Android:', e.message);
  }
  return null;
}

// ==========================================
// TRAVA DE SEGURANÇA — VALOR TROCADO ENTRE MODELOS DA LINHA REDMI NOTE
// ==========================================
// Erro real que já aconteceu: cliente perguntou o valor de troca do "Redmi
// Note 14 256GB" (modelo base) e o Cláudio respondeu R$800 — que é o valor
// do "Redmi Note 14 PRO" (o Note 14 base vale R$600). A trava
// ANDROID_TROCA_MODELOS_VALIDOS não pega esse tipo de erro porque "redmi
// note 14" existe na lista de modelos válidos — o problema não é o modelo
// não existir, é o valor citado pertencer à linha de OUTRO modelo da mesma
// família. A linha Redmi Note é a mais arriscada pra esse tipo de troca
// porque tem vários modelos com nomes quase idênticos (Note 14 / Note 14
// Pro / Note 14 Pro Max) e valores próximos, então essa trava roda em
// runtime comparando o valor citado com o valor EXATO daquele modelo
// específico, independente do que o prompt diga.
const VALORES_TROCA_REDMI_NOTE = {
  '10': 300, '10s': 300, '10 pro': 300,
  '11': 400, '11 pro': 400, '11 pro+': 400,
  '12': 400, '12 pro': 400, '12 pro+': 400,
  '13': 400, '13 pro': 500, '13 pro+': 600,
  '14': 600, '14 pro': 800, '14 pro max': 1100,
};

function respostaTemValorTrocaRedmiNoteErrado(reply) {
  if (!/r\$/i.test(reply)) return false;
  const replyLower = reply.toLowerCase();
  if (replyLower.includes('equipe') && (replyLower.includes('verificar') || replyLower.includes('retorno'))) return false;

  const regexMencao = /redmi\s*note\s*(10s?|11|12|13|14)\s*(pro\s*max|pro\+?)?/gi;

  let match;
  while ((match = regexMencao.exec(reply)) !== null) {
    const numero = match[1].toLowerCase();
    const sufixo = (match[2] || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const chave = sufixo ? `${numero} ${sufixo}` : numero;
    const valorEsperado = VALORES_TROCA_REDMI_NOTE[chave];
    if (valorEsperado === undefined) continue; // combinação não mapeada, não valida

    // Pega uma janela de caracteres ao redor da menção (em vez de dividir por
    // frase) pra achar o valor R$ citado perto dela — dividir por frase quebra
    // errado quando o valor usa ponto como separador de milhar (ex: "R$1.100"
    // seria cortado em "R$1." + "100" por causa do ponto).
    const inicioJanela = Math.max(0, match.index - 15);
    const fimJanela = Math.min(reply.length, match.index + match[0].length + 60);
    const janela = reply.slice(inicioJanela, fimJanela);
    const valorMatch = janela.match(/r\$[^\d]{0,3}([\d]{1,3}(?:\.\d{3})*(?:,\d{1,2})?)/i);
    if (!valorMatch) continue;
    const valorCitado = parseFloat(valorMatch[1].replace(/\./g, '').replace(',', '.'));
    if (Math.abs(valorCitado - valorEsperado) > 0.01) {
      console.log(`⚠️ Valor de troca trocado entre modelos Redmi Note bloqueado: "${match[0]}" deveria ser R$${valorEsperado}, mas citou R$${valorCitado}`);
      return true;
    }
  }
  return false;
}

async function gerarRespostaCorrigindoValorRedmiNote(mensagens) {
  try {
    if (mensagens.length === 0) return null;

    const instrucao = '\n\n[INSTRUÇÃO INTERNA DO SISTEMA — NÃO É MENSAGEM DO CLIENTE, NÃO RESPONDA A ELA DIRETAMENTE, APENAS SIGA A ORIENTAÇÃO]: Sua resposta anterior citou um valor de troca da linha Redmi Note que pertence a OUTRO modelo da mesma família (ex: deu o valor do "Pro" para o modelo base, ou vice-versa). Releia a seção "Linha Redmi Note" da tabela VALORES DE TROCA - ANDROID com muita atenção ao nome EXATO do modelo (Note 14, Note 14 Pro e Note 14 Pro Max são modelos DIFERENTES com valores DIFERENTES — o mesmo vale para as demais gerações). Refaça a resposta usando o valor da linha que corresponde EXATAMENTE ao modelo que o cliente mencionou, sem confundir com o modelo "Pro"/"Pro+"/"Pro Max" vizinho. Seja breve (1 a 3 frases).';

    const ultima = mensagens[mensagens.length - 1];
    let ultimaComInstrucao;
    if (typeof ultima.content === 'string') {
      ultimaComInstrucao = { ...ultima, content: ultima.content + instrucao };
    } else if (Array.isArray(ultima.content)) {
      const conteudo = ultima.content.map(b => ({ ...b }));
      conteudo.push({ type: 'text', text: instrucao });
      ultimaComInstrucao = { ...ultima, content: conteudo };
    } else {
      ultimaComInstrucao = ultima;
    }
    const mensagensComInstrucao = [...mensagens.slice(0, -1), ultimaComInstrucao];

    const respostaCorrigida = await chamarClaude(mensagensComInstrucao);
    if (!respostaTemValorTrocaRedmiNoteErrado(respostaCorrigida)) {
      return respostaCorrigida;
    }
  } catch (e) {
    console.error('Erro ao corrigir valor de troca Redmi Note:', e.message);
  }
  return null;
}

// ==========================================
// TRAVA DE SEGURANÇA — VALOR DE MANUTENÇÃO ANDROID INVENTADO
// ==========================================
// Erro real que já aconteceu: cliente perguntou quanto custa a troca de tela
// do Moto G24 e o Cláudio respondeu com um valor (R$150,00) que não existe em
// lugar nenhum — a tabela de preços de manutenção é EXCLUSIVA para iPhones
// (ver REGRA DE MANUTENÇÃO ANDROID no prompt). Diferente da trava de troca
// (ANDROID_TROCA_MODELOS_VALIDOS), aqui não existe "valor certo" pra
// comparar: QUALQUER preço de conserto/manutenção pra aparelho Android é
// proibido, sempre deve escalar pro Breno. Esta trava roda em runtime,
// independente da instrução do prompt, pra não depender só do modelo seguir
// a regra corretamente.
const REGEX_MARCA_ANDROID = /(samsung|galaxy|xiaomi|redmi|poco|motorola|\bmoto\s|realme)/i;
const REGEX_CONTEXTO_MANUTENCAO_ANDROID = /(tela|display|modulo|módulo|bateria|conector|carga|camera|câmera|conserto|reparo|consertar|trocar a tela|troca de tela|troca de peça)/i;

function respostaTemPrecoManutencaoAndroidInventado(reply) {
  // Só verifica quando a resposta parece dar um valor de verdade
  if (!/r\$/i.test(reply)) return false;
  const replyLower = reply.toLowerCase();
  // Se já está encaminhando pro Breno/equipe técnica, a resposta já é segura
  if (replyLower.includes('breno')) return false;
  if (replyLower.includes('equipe') && (replyLower.includes('verificar') || replyLower.includes('tecnica') || replyLower.includes('técnica'))) return false;
  // Precisa mencionar marca/modelo Android E contexto de manutenção junto com o preço
  if (!REGEX_MARCA_ANDROID.test(reply)) return false;
  if (!REGEX_CONTEXTO_MANUTENCAO_ANDROID.test(reply)) return false;

  console.log('⚠️ Valor de manutenção Android inventado bloqueado (tabela de manutenção é exclusiva para iPhones)');
  return true;
}

// Quando a trava acima bloqueia, pedimos pro Cláudio corrigir a resposta
// escalando corretamente pro Breno, em vez de inventar um valor de conserto.
async function gerarRespostaCorrigindoManutencaoAndroid(mensagens) {
  try {
    if (mensagens.length === 0) return null;

    const instrucao = '\n\n[INSTRUÇÃO INTERNA DO SISTEMA — NÃO É MENSAGEM DO CLIENTE, NÃO RESPONDA A ELA DIRETAMENTE, APENAS SIGA A ORIENTAÇÃO]: Sua resposta anterior informou um valor de manutenção/conserto (tela, bateria, módulo, conector, etc) para um aparelho Android. A tabela de preços de manutenção é EXCLUSIVA para iPhones — NUNCA invente, estime ou "empreste" valor de conserto Android de nenhuma tabela. Refaça a resposta informando que esse valor precisa ser verificado com a equipe técnica e encaminhe para o Breno: https://wa.me/5512981919584. Seja breve (1 a 3 frases).';

    const ultima = mensagens[mensagens.length - 1];
    let ultimaComInstrucao;
    if (typeof ultima.content === 'string') {
      ultimaComInstrucao = { ...ultima, content: ultima.content + instrucao };
    } else if (Array.isArray(ultima.content)) {
      const conteudo = ultima.content.map(b => ({ ...b }));
      conteudo.push({ type: 'text', text: instrucao });
      ultimaComInstrucao = { ...ultima, content: conteudo };
    } else {
      ultimaComInstrucao = ultima;
    }
    const mensagensComInstrucao = [...mensagens.slice(0, -1), ultimaComInstrucao];

    const respostaCorrigida = await chamarClaude(mensagensComInstrucao);
    if (!respostaTemPrecoManutencaoAndroidInventado(respostaCorrigida)) {
      return respostaCorrigida;
    }
  } catch (e) {
    console.error('Erro ao corrigir valor de manutenção Android:', e.message);
  }
  return null;
}


// Faz o caminho INVERSO da trava acima: em vez de checar se um modelo OFERECIDO
// existe na tabela, aqui verificamos se o Cláudio disse "não temos o iPhone X"
// (ou variações) para um modelo+memória que, na verdade, EXISTE na tabela de
// preços do Admin (venda). Isso pega o erro real que já aconteceu: dizer que
// não tem o iPhone 15 Pro quando ele estava lá na tabela. Só dispara quando a
// combinação modelo+memória negada bate literalmente com uma linha da tabela —
// evita falso positivo para modelos que realmente não existem.
// Captura APENAS o modelo mencionado logo em seguida de uma expressão de
// negação (ex: "não temos o iPhone 15 Pro"), sem pegar o resto da frase —
// evita confundir com uma alternativa real citada na sequência ("...mas
// temos o iPhone 17"). Não exige memória/GB, pois o Cláudio costuma negar
// só "iPhone 15 Pro" sem citar a capacidade.
function extrairModelosNegados(textoNormalizado) {
  const regex = /(?:nao tem(?:os)?|não tem(?:os)?|indisponivel|indisponível|sem estoque|esgotado)\D{0,15}?(iphone\s+\d+[a-z]*(?:\s+(?:pro\s+max|pro|plus|mini))?(?:\s+\d{2,4}\s*gb)?)/g;
  const matches = [...textoNormalizado.matchAll(regex)];
  return matches.map(m => m[1]);
}

// ==========================================
// TRAVA: RECUSA INDEVIDA DE APARELHO/MARCA NA TROCA
// ==========================================
// A loja aceita QUALQUER aparelho como entrada/troca — mesmo quebrado,
// queimado ou de marca fora da tabela (LG, Nokia, Asus, etc). O que não
// está na tabela deve ser escalado pra equipe (fluxo de pendência), nunca
// recusado de cara. Isso já está no prompt, mas o Claude pode ignorar em
// alguns casos — essa trava pega e corrige quando isso acontece.
function respostaRecusaAparelhoNaTroca(reply, mensagemCliente) {
  const replyLower = reply.toLowerCase();
  const clienteLower = (mensagemCliente || '').toLowerCase();
  const padroesRecusa = [
    'não aceitamos', 'nao aceitamos', 'não trabalhamos com', 'nao trabalhamos com',
    'não fazemos troca de', 'nao fazemos troca de', 'a gente não trabalha',
    'a gente nao trabalha', 'essa marca a gente não', 'essa marca a gente nao',
    'não pegamos', 'nao pegamos', 'não trabalhamos com essa linha', 'nao trabalhamos com essa linha'
  ];
  if (!padroesRecusa.some(p => replyLower.includes(p))) return false;

  // Só considera bug se o contexto for de troca/aparelho do cliente (não outro
  // tipo de recusa legítima, como forma de pagamento ou serviço não relacionado).
  const contextoTroca = /troca|entrada|display|tela|defeito|queimad|quebrad|trincad|aparelho|celular|smartphone/.test(clienteLower + ' ' + replyLower);
  if (!contextoTroca) return false;

  console.log('⚠️ Recusa indevida de aparelho/marca na troca detectada — a loja aceita qualquer aparelho, deveria escalar pra equipe');
  return true;
}

// Quando a recusa indevida é detectada, pedimos pro Cláudio refazer sem
// recusar — escalando pra equipe em vez disso.
async function gerarRespostaCorrigindoRecusaTroca(mensagens) {
  try {
    if (mensagens.length === 0) return null;

    const instrucao = '\n\n[INSTRUÇÃO INTERNA DO SISTEMA — NÃO É MENSAGEM DO CLIENTE, NÃO RESPONDA A ELA DIRETAMENTE, APENAS SIGA A ORIENTAÇÃO]: Sua resposta anterior recusou o aparelho do cliente na troca (ex: "não aceitamos essa marca/aparelho"). Isso está ERRADO — a loja aceita QUALQUER aparelho como entrada/troca, incluindo aparelhos quebrados, queimados ou de marcas fora da tabela (LG, Nokia, Asus, etc). Refaça a resposta SEM recusar o aparelho em nenhum momento: informe que vai verificar o valor de troca com a equipe e que retorna em instantes, seguindo a regra padrão de aparelho fora da tabela. Seja breve (1 a 3 frases).';

    const ultima = mensagens[mensagens.length - 1];
    let ultimaComInstrucao;
    if (typeof ultima.content === 'string') {
      ultimaComInstrucao = { ...ultima, content: ultima.content + instrucao };
    } else if (Array.isArray(ultima.content)) {
      const conteudo = ultima.content.map(b => ({ ...b }));
      conteudo.push({ type: 'text', text: instrucao });
      ultimaComInstrucao = { ...ultima, content: conteudo };
    } else {
      ultimaComInstrucao = ultima;
    }
    const mensagensComInstrucao = [...mensagens.slice(0, -1), ultimaComInstrucao];

    const respostaCorrigida = await chamarClaude(mensagensComInstrucao);
    if (!respostaRecusaAparelhoNaTroca(respostaCorrigida, '')) {
      return respostaCorrigida;
    }
  } catch (e) {
    console.error('Erro ao corrigir recusa indevida de troca:', e.message);
  }
  return null;
}

function respostaNegaModeloQueExisteNaTabela(reply) {
  const replyLower = reply.toLowerCase();
  const regexNegacao = /nao tem|não tem|indisponivel|indisponível|sem estoque|esgotado|nao temos|não temos/;
  if (!regexNegacao.test(replyLower)) return false;

  const tabelaCrua = process.env.PRICE_TABLE || '';
  const tabelaNormalizada = normalizarTexto(tabelaCrua);
  if (!tabelaNormalizada) return false;

  const modelosNegados = [...new Set(extrairModelosNegados(normalizarTexto(reply)))];
  if (modelosNegados.length === 0) return false;

  for (const modelo of modelosNegados) {
    // Fronteira de palavra no final para não confundir, por exemplo,
    // "iphone 15" com "iphone 15 pro" (substring parcial enganosa).
    const regexBusca = new RegExp(`\\b${modelo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|gb|$)`);
    if (regexBusca.test(tabelaNormalizada)) {
      console.log(`⚠️ Negação incorreta bloqueada: Cláudio disse "não temos ${modelo}" mas o modelo existe na tabela`);
      return true;
    }
  }
  return false;
}

// Quando a negação incorreta é detectada, pedimos pro Cláudio reler a tabela e
// corrigir — parecido com gerarRespostaComAlternativa, mas com instrução focada
// em "esse modelo EXISTE, releia com atenção antes de responder de novo".
async function gerarRespostaCorrigindoNegacao(mensagens) {
  try {
    if (mensagens.length === 0) return null;

    const instrucao = '\n\n[INSTRUÇÃO INTERNA DO SISTEMA — NÃO É MENSAGEM DO CLIENTE, NÃO RESPONDA A ELA DIRETAMENTE, APENAS SIGA A ORIENTAÇÃO]: Sua resposta anterior disse que um modelo não estava disponível, mas esse modelo EXISTE na tabela de preços atual (releia a seção TABELA DE PREÇOS ATUAL com atenção, linha por linha, procurando o modelo e memória exatos que o cliente pediu). Refaça a resposta apresentando esse modelo corretamente, com o preço, condição (Novo/Seminovo) e demais detalhes exatos que constam na tabela — nunca invente nem aproxime valores. Seja breve (1 a 4 frases) e siga o formato normal de apresentação de opções.';

    const ultima = mensagens[mensagens.length - 1];
    let ultimaComInstrucao;
    if (typeof ultima.content === 'string') {
      ultimaComInstrucao = { ...ultima, content: ultima.content + instrucao };
    } else if (Array.isArray(ultima.content)) {
      const conteudo = ultima.content.map(b => ({ ...b }));
      conteudo.push({ type: 'text', text: instrucao });
      ultimaComInstrucao = { ...ultima, content: conteudo };
    } else {
      ultimaComInstrucao = ultima;
    }
    const mensagensComInstrucao = [...mensagens.slice(0, -1), ultimaComInstrucao];

    const respostaCorrigida = await chamarClaude(mensagensComInstrucao);
    // Só aceita a correção se ela não cair em nenhuma das duas travas (nem
    // inventar modelo fora da tabela, nem negar de novo um modelo que existe)
    if (!respostaTemModeloForaDaTabela(respostaCorrigida) && !respostaNegaModeloQueExisteNaTabela(respostaCorrigida)) {
      return respostaCorrigida;
    }
  } catch (e) {
    console.error('Erro ao corrigir negação incorreta:', e.message);
  }
  return null;
}

// Quando a trava de segurança bloqueia uma resposta (modelo/condição que não existe
// na tabela), em vez de só dizer "não temos" e mandar o cliente pro catálogo, tentamos
// pedir pro próprio Cláudio já oferecer uma alternativa REAL da tabela (venda ativa,
// sem travar a negociação). Essa nova tentativa passa pela MESMA verificação de
// segurança — se ela também falhar, aí sim usamos o texto genérico como último recurso.
// Recebe também a resposta original (bloqueada) para poder orientar explicitamente a
// preservar qualquer valor de TROCA já calculado corretamente nela — o problema quase
// sempre está isolado na parte de VENDA (modelo que não está mais em estoque), não no
// valor de troca, que não deve ser perdido/recalculado à toa.
async function gerarRespostaComAlternativa(mensagens, respostaOriginalBloqueada) {
  try {
    if (mensagens.length === 0) return RESPOSTA_SEGURA_FALLBACK;

    const contextoRespostaAnterior = respostaOriginalBloqueada
      ? `\n\nPara referência, sua resposta anterior (bloqueada por citar um modelo de VENDA que não está na tabela) foi: "${respostaOriginalBloqueada}". Se essa resposta já continha um valor de TROCA (quanto a loja paga pelo aparelho do cliente como entrada) calculado a partir da tabela de troca, esse valor está correto e deve ser MANTIDO na nova resposta — não descarte nem recalcule à toa. O problema está isolado na parte de oferta de VENDA (modelo que não existe na tabela de preços do Admin), não no valor de troca.`
      : '';

    const instrucao = `\n\n[INSTRUÇÃO INTERNA DO SISTEMA — NÃO É MENSAGEM DO CLIENTE, NÃO RESPONDA A ELA DIRETAMENTE, APENAS SIGA A ORIENTAÇÃO]: O modelo/condição/memória de VENDA que o cliente pediu não está disponível na tabela. NÃO diga apenas "não temos" e NÃO mande o cliente olhar o catálogo agora. Em vez disso, ofereça proativamente 1 ou 2 alternativas REAIS que existam na tabela de preços (modelo parecido, mesma faixa de preço, ou um upgrade), citando modelo, memória, condição (Novo/Seminovo) e preço EXATOS que estejam escritos na tabela — nunca invente nem aproxime valores.${contextoRespostaAnterior} Seja breve e termine com uma pergunta que ajude a fechar a venda.`;

    // Anexa a instrução na ÚLTIMA mensagem já existente (que é do cliente), em vez de
    // criar uma nova mensagem "user" — a API da Anthropic exige alternância estrita
    // entre "user" e "assistant", então duas mensagens "user" seguidas dá erro.
    const ultima = mensagens[mensagens.length - 1];
    let ultimaComInstrucao;
    if (typeof ultima.content === 'string') {
      ultimaComInstrucao = { ...ultima, content: ultima.content + instrucao };
    } else if (Array.isArray(ultima.content)) {
      const conteudo = ultima.content.map(b => ({ ...b }));
      conteudo.push({ type: 'text', text: instrucao });
      ultimaComInstrucao = { ...ultima, content: conteudo };
    } else {
      ultimaComInstrucao = ultima;
    }
    const mensagensComInstrucao = [...mensagens.slice(0, -1), ultimaComInstrucao];

    const respostaAlternativa = await chamarClaude(mensagensComInstrucao);
    if (!respostaTemModeloForaDaTabela(respostaAlternativa)) {
      return respostaAlternativa;
    }
  } catch (e) {
    console.error('Erro ao gerar resposta alternativa:', e.message);
  }
  return RESPOSTA_SEGURA_FALLBACK;
}

// ==========================================
// TRAVA DE SEGURANÇA — SAUDAÇÃO REPETIDA
// ==========================================
// Usa uma flag persistente em metaConversas[phone] (não depende das últimas
// 20 mensagens do histórico, que pode "esquecer" a saudação original em
// conversas longas). Uma vez marcado como apresentado, nunca mais deixa
// passar a saudação de novo naquele dia, não importa quantas mensagens
// tenham passado.
function removerApresentacaoRepetida(phone, reply) {
  const regexSaudacaoInicial = /^(oi|ol[aá])[!,.]?\s*tudo bem\??\s*(sou o cl[aá]udio|aqui\s*[eé]\s*o cl[aá]udio)[^\n]*\n*\s*/i;
  const contemSaudacao = regexSaudacaoInicial.test(reply);

  if (!metaConversas[phone]) metaConversas[phone] = {};

  if (metaConversas[phone].apresentado) {
    // Já se apresentou antes — remove a saudação se ela aparecer de novo
    if (contemSaudacao) {
      const semSaudacao = reply.replace(regexSaudacaoInicial, '').trim();
      return semSaudacao.length > 0 ? semSaudacao : reply;
    }
    return reply;
  }

  // Primeira vez — se a resposta contém a saudação, marca como apresentado e deixa passar
  if (contemSaudacao) metaConversas[phone].apresentado = true;
  return reply;
}

// ==========================================
// TRAVA DE SEGURANÇA — BATERIA NÃO SOLICITADA
// ==========================================
// Se o cliente NÃO perguntou sobre bateria na mensagem atual, remove
// automaticamente qualquer menção de porcentagem que apareça na resposta
// (geralmente vem entre parênteses, ex: "(98% de bateria)"). Trava de código
// complementar à regra do prompt, que sozinha não estava sendo suficiente.
function removerBateriaNaoSolicitada(mensagemClienteAtual, reply) {
  const perguntouBateria = /bateria/i.test(mensagemClienteAtual || '');
  if (perguntouBateria) return reply;
  if (!/\d{1,3}\s*%/.test(reply)) return reply;
  return reply
    .replace(/\([^)]*\d{1,3}\s*%[^)]*\)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

// ==========================================
// REPARO DE HISTÓRICO — TOOL_USE ÓRFÃO (SEM TOOL_RESULT)
// ==========================================
// Antes da correção acima, algumas conversas já ficaram salvas com um
// tool_use sem o tool_result correspondente (o bug das simulações duplas).
// Essas conversas ficam permanentemente travadas — toda nova mensagem desse
// cliente falha com o mesmo erro, mesmo depois do código corrigido, porque o
// problema já está gravado no arquivo de conversas salvo. Esta função roda
// antes de qualquer chamada à API e remove automaticamente qualquer mensagem
// de assistente com tool_use cujo par de tool_result (na mensagem seguinte)
// esteja incompleto ou ausente — "curando" o histórico sozinho, sem precisar
// apagar a conversa toda nem mexer manualmente no arquivo salvo no Railway.
function repararHistoricoToolUse(mensagens) {
  const resultado = [];
  for (let i = 0; i < mensagens.length; i++) {
    const m = mensagens[i];
    const temToolUse = m.role === 'assistant' && Array.isArray(m.content) && m.content.some(b => b.type === 'tool_use');
    if (!temToolUse) {
      resultado.push(m);
      continue;
    }
    const idsToolUse = m.content.filter(b => b.type === 'tool_use').map(b => b.id);
    const proxima = mensagens[i + 1];
    const idsToolResult = (proxima && Array.isArray(proxima.content))
      ? proxima.content.filter(b => b.type === 'tool_result').map(b => b.tool_use_id)
      : [];
    const todosResolvidos = idsToolUse.every(id => idsToolResult.includes(id));
    if (todosResolvidos) {
      resultado.push(m);
    } else {
      console.log('⚠️ Removendo do histórico um tool_use órfão (sem tool_result correspondente) — reparo automático');
      i++; // pula também a próxima mensagem (tool_result incompleto), se existir
    }
  }
  return resultado;
}

async function chamarClaude(mensagensOriginais) {
  const mensagens = repararHistoricoToolUse(mensagensOriginais);
  const systemPromptAtual = SYSTEM_PROMPT.replace('${process.env.PRICE_TABLE || \'\'}', process.env.PRICE_TABLE || '') + textoRegraDomingoTaubate();
  const corpo = {
    model: 'claude-sonnet-4-6', max_tokens: 1024,
    system: [{ type: "text", text: systemPromptAtual, cache_control: { type: "ephemeral", ttl: "1h" } }],
    tools: [FERRAMENTA_PARCELAMENTO],
    messages: prepararMensagensParaEnvio(mensagens)
  };
  const headers = { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
  let response = await axios.post('https://api.anthropic.com/v1/messages', corpo, { headers });
  while (response.data.stop_reason === 'tool_use') {
    // ATENÇÃO: uma única resposta pode conter MAIS DE UM bloco tool_use ao
    // mesmo tempo (ex: cliente pediu duas simulações de parcelamento juntas,
    // "quero saber das duas formas"). Bug real que já aconteceu: o código
    // pegava só o PRIMEIRO tool_use com .find(), mas empurrava a resposta
    // inteira (com todos os tool_use) pra conversa — o segundo tool_use
    // ficava sem tool_result correspondente, e a API da Anthropic rejeitava
    // a próxima chamada com erro "tool_use ids were found without
    // tool_result blocks". Corrigido: agora processamos TODOS os blocos
    // tool_use da resposta e mandamos um tool_result pra cada um, todos
    // juntos na mesma mensagem seguinte (exigência da API).
    const toolUseBlocks = response.data.content.filter(b => b.type === 'tool_use');
    const toolResults = toolUseBlocks.map(toolUseBlock => {
      let resultadoFerramenta = {};
      if (toolUseBlock.name === 'calcular_parcelamento') {
        const { saldo, parcelas } = toolUseBlock.input;
        resultadoFerramenta = calcularParcelamento(saldo, parcelas);
      }
      return { type: 'tool_result', tool_use_id: toolUseBlock.id, content: JSON.stringify(resultadoFerramenta) };
    });
    mensagens.push({ role: 'assistant', content: response.data.content });
    mensagens.push({ role: 'user', content: toolResults });
    response = await axios.post('https://api.anthropic.com/v1/messages', { ...corpo, messages: prepararMensagensParaEnvio(mensagens) }, { headers });
  }
  return response.data.content.find(b => b.type === 'text')?.text || '';
}

async function enviarMensagem(phone, message) {
  // ATENÇÃO CRÍTICA: registramos a mensagem em mensagensEnviadasPeloBot ANTES
  // de mandar pro Z-API, não depois. Erro real que já aconteceu: com a
  // configuração "Notificar as enviadas por mim também" ativada no Z-API, o
  // eco "fromMe" da PRÓPRIA resposta do bot pode chegar no nosso webhook
  // quase instantaneamente — às vezes antes do código terminar de registrar
  // que essa mensagem foi enviada pelo bot. Nesse intervalo mínimo, o
  // sistema não reconhecia o eco como "mensagem do próprio bot" e tratava
  // como se fosse uma mensagem manual do Saem, disparando o processamento
  // de novo e gerando uma resposta duplicada pro cliente. Registrando ANTES
  // de mandar, garantimos que o registro já existe assim que o eco chegar.
  if (!mensagensEnviadasPeloBot[phone]) mensagensEnviadasPeloBot[phone] = [];
  mensagensEnviadasPeloBot[phone].push({ texto: message, ts: Date.now() });
  if (mensagensEnviadasPeloBot[phone].length > 10) mensagensEnviadasPeloBot[phone].shift();

  await axios.post(
    `https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`,
    { phone, message },
    { headers: { 'Client-Token': ZAPI_CLIENT_TOKEN } }
  );
}

// ==========================================
// WEBHOOK
// ==========================================
app.post('/webhook', async (req, res) => {
  const body = req.body;
  // Ignora qualquer webhook repetido (mesmo messageId já processado antes) —
  // proteção contra reenvio duplicado do Z-API, que já causou o bug de duas
  // respostas diferentes pra mesma mensagem do cliente.
  if (jaProcessouMensagem(body.messageId)) {
    console.log(`⚠️ Webhook duplicado ignorado (messageId: ${body.messageId})`);
    return res.sendStatus(200);
  }
  if (body.fromMe) {
    const phoneDestino = body.phone;
    const textoEnviado = body.text?.message || body.text || '';
    // Removemos a exclusão "phoneDestino !== NUMERO_ADMIN" que existia aqui
    // antes. Ela foi pensada pra evitar tratar as notificações do próprio
    // bot pro Saem (ex: "Valor necessário para cliente") como se fossem uma
    // resposta manual seguir — mas isso já é resolvido corretamente pela
    // checagem de eco logo abaixo (mensagensEnviadasPeloBot), já que TODA
    // mensagem que o bot manda (inclusive pro admin) já fica registrada ali.
    // A exclusão extra era redundante e causava um bug real: se o Saem
    // testasse o bot usando o PRÓPRIO número (que também é o NUMERO_ADMIN)
    // como se fosse cliente, qualquer mensagem manual que ele digitasse
    // nessa conversa de teste era silenciosamente ignorada.
    if (phoneDestino && textoEnviado) {
      const enviadosBot = mensagensEnviadasPeloBot[phoneDestino] || [];
      // Normaliza (trim + colapsa espaços/quebras de linha) antes de comparar.
      // Erro real que já aconteceu: o eco que o Z-API manda de volta às vezes
      // não bate 100% caractere a caractere com o texto original (espaço a
      // mais, quebra de linha diferente, etc). Quando isso acontecia, o
      // sistema não reconhecia como eco e tratava a PRÓPRIA resposta do bot
      // como se fosse uma mensagem manual sua — o Cláudio então "respondia"
      // a si mesmo, gerando uma segunda mensagem indevida pro cliente.
      const normalizar = (t) => (t || '').trim().replace(/\s+/g, ' ');
      const textoNormalizado = normalizar(textoEnviado);
      let idx = enviadosBot.findIndex(e => normalizar(e.texto) === textoNormalizado);
      // Rede de segurança: se não achou nem por igualdade normalizada, mas
      // existe um envio do bot pra esse mesmo número nos últimos 12 segundos
      // ainda não consumido, é praticamente certo que seja eco também (não
      // faz sentido você digitar manualmente no exato momento em que o bot
      // acabou de responder) — melhor descartar do que arriscar o bot se
      // autoelogiar/responder a si mesmo.
      if (idx === -1) {
        idx = enviadosBot.findIndex(e => Date.now() - e.ts < 12000);
        if (idx !== -1) {
          console.log(`⚠️ Eco não bateu texto exato, mas dentro da janela de segurança — ignorando (${phoneDestino})`);
        }
      }
      if (idx !== -1) {
        // Eco da própria mensagem que o bot mandou — já está no histórico
        // (foi salvo no momento do envio), então só consome o registro e
        // ignora, sem duplicar.
        enviadosBot.splice(idx, 1);
      } else {
        // Qualquer mensagem que o Saem digitar manualmente direto na
        // conversa com o cliente (seja um valor, uma correção, um
        // comentário, o que for) agora é tratada como se ele estivesse
        // participando da conversa junto com o Cláudio: o texto é registrado
        // no histórico e o Cláudio já continua a conversa na hora,
        // incorporando o que foi dito — sem inventar nada, usando
        // exatamente o que o Saem escreveu.
        const valor = extrairValorDeMensagemLivre(textoEnviado);
        if (!conversas[phoneDestino]) conversas[phoneDestino] = [];

        if (valor !== null) {
          // Se o texto contém um valor numérico plausível, formatamos como
          // "[EQUIPE]: valor..." — o mesmo formato confiável que o prompt já
          // trata como oficial e usa exatamente sem arredondar/estimar nada.
          const aparelhoPendente = pendentesEquipe[phoneDestino]?.aparelho
            || extrairAparelhoPendente(conversas[phoneDestino])
            || 'aparelho';
          // Anexamos aqui, na MESMA mensagem, qual modelo o cliente já
          // confirmou querer comprar (se identificável) — pra não depender
          // do Cláudio "lembrar" sozinho lá atrás na conversa e evitar que
          // ele pergunte de novo algo que o cliente já respondeu. Erro real
          // que já aconteceu: colocar esse lembrete DEPOIS do valor não
          // bastava — o modelo focava em responder sobre o valor e ignorava
          // a instrução no final. Corrigido: agora o lembrete do modelo vem
          // ANTES do valor, e o nome do modelo é repetido de novo no final
          // pra reforçar ainda mais.
          const modeloDesejado = extrairModeloDesejado(conversas[phoneDestino]);
          const mensagemValor = modeloDesejado
            ? `[EQUIPE]: O cliente já confirmou interesse em levar o ${modeloDesejado}. O valor de troca do ${aparelhoPendente} é R$${valor.toFixed(2).replace('.', ',')}. Monte a simulação completa AGORA usando o modelo ${modeloDesejado} e esse valor de troca — NÃO pergunte de novo qual modelo ele quer, ele já respondeu isso.`
            : `[EQUIPE]: O valor de troca do ${aparelhoPendente} é R$${valor.toFixed(2).replace('.', ',')}`;
          conversas[phoneDestino].push({
            role: 'user',
            content: mensagemValor
          });
        } else {
          // Sem valor numérico — é um comentário/correção geral. Registra
          // como observação da equipe, que o prompt já trata como fato
          // oficial (REGRA DE MENSAGEM MANUAL DA EQUIPE).
          // ATENÇÃO: usar role 'user' aqui é essencial, não 'assistant'. A
          // API da Anthropic exige alternância estrita entre mensagens
          // 'user' e 'assistant' — a última resposta real do Cláudio antes
          // dessa já era 'assistant', então salvar essa observação TAMBÉM
          // como 'assistant' cria duas mensagens seguidas do mesmo papel, o
          // que a API rejeita. Isso já causou um bug real: a chamada
          // seguinte pro chamarClaude falhava silenciosamente (erro pego
          // pelo catch, sem avisar ninguém), e o Cláudio nunca respondia
          // nada depois de um comentário manual sem valor.
          conversas[phoneDestino].push({ role: 'user', content: `[RESPOSTA MANUAL DA EQUIPE]: ${textoEnviado}` });
        }

        if (conversas[phoneDestino].length > 20) conversas[phoneDestino] = conversas[phoneDestino].slice(-20);
        if (pendentesEquipe[phoneDestino]) {
          delete pendentesEquipe[phoneDestino];
          salvarPendentes();
        }
        salvarConversas();

        // Continua a conversa imediatamente com o cliente, incorporando o
        // que o Saem acabou de dizer — não espera o cliente mandar outra
        // mensagem pra reagir. Enfileirado por telefone pra não rodar em
        // paralelo com uma mensagem do cliente chegando no mesmo instante.
        enfileirarPorTelefone(phoneDestino, async () => {
          try {
            const msgs = conversas[phoneDestino];
            let reply = await chamarClaude([...msgs]);
            // Erro real que já aconteceu: esse caminho (continuar a conversa
            // depois de uma mensagem manual) esquecia de passar pela mesma
            // trava de "não se apresentar de novo" que o fluxo normal já
            // usa — o Cláudio acabava se apresentando de novo no meio de
            // uma negociação já em andamento. Corrigido aplicando a mesma
            // trava aqui também.
            reply = removerApresentacaoRepetida(phoneDestino, reply);
            conversas[phoneDestino].push({ role: 'assistant', content: reply });
            salvarConversas();
            await enviarMensagem(phoneDestino, reply);
          } catch (e) {
            console.error('Erro ao continuar conversa após mensagem manual:', e.message);
          }
        });
      }
    }
    return res.sendStatus(200);
  }

  // Quando o cliente EDITA uma mensagem já enviada, o Z-API dispara um novo
  // webhook pra esse evento (com isEdit: true), separado do webhook original
  // da mensagem. Sem esse tratamento, o bot processava a edição como se
  // fosse uma mensagem nova — chamando o Cláudio de novo e mandando uma
  // segunda resposta em cima da primeira, gerando respostas duplicadas ou
  // conflitantes (ex: já ter respondido sobre o modelo e, na edição,
  // perguntar de novo "qual modelo é esse?"). Ignoramos esses eventos.
  if (body.isEdit) {
    console.log(`✏️ Mensagem editada por ${body.phone} — ignorada para evitar resposta duplicada.`);
    return res.sendStatus(200);
  }

  console.log('BODY:', JSON.stringify(body).substring(0, 300));

  const isGroup = body.isGroup || body.phone?.includes('-group');
  if (isGroup) {
    const msgGrupo = body.text?.message || body.text || '';
    if (body.image || body.mimetype?.includes('image') || !msgGrupo) return res.sendStatus(200);
    const assuntosPermitidos = ['troca', 'valor', 'preco', 'manutencao', 'conserto', 'cliente', 'venda', 'negoc', 'quanto', 'aparelho'];
    if (!assuntosPermitidos.some(a => msgGrupo.toLowerCase().includes(a))) return res.sendStatus(200);
  }

  const phone = body.phone;
  const message = body.text?.message || body.text || '';
  const isImage = body.image || body.mimetype?.includes('image');
  const isAudio = body.audio || body.mimetype?.includes('audio') || body.mimetype?.includes('ogg') || body.type === 'audio';

  if (!phone) return res.sendStatus(200);
  res.sendStatus(200);

  // Determina qual telefone é o "dono" desse processamento — normalmente é
  // quem mandou a mensagem, mas no caso de resposta do admin no formato
  // "valor TELEFONE VALOR", quem realmente é afetado é o TELEFONE DO CLIENTE
  // citado ali dentro, não o número do admin. Enfileiramos pelo telefone
  // certo pra evitar a mesma condição de corrida entre isso e uma mensagem
  // nova do cliente chegando ao mesmo tempo.
  const respostaAdminPreview = (NUMERO_ADMIN && phone === NUMERO_ADMIN && message) ? processarRespostaAdmin(message, phone) : null;
  const chaveFila = respostaAdminPreview ? respostaAdminPreview.phoneCliente : phone;

  await enfileirarPorTelefone(chaveFila, async () => {
  try {
    if (NUMERO_ADMIN && phone === NUMERO_ADMIN && message) {
      const resposta = processarRespostaAdmin(message, phone);
      if (resposta) {
        const { phoneCliente, valor } = resposta;
        if (!conversas[phoneCliente]) conversas[phoneCliente] = [];

        // Mesma correção do fluxo manual: anexamos o modelo que o cliente já
        // confirmou querer comprar (se identificável), mas dessa vez ANTES
        // do valor (não depois) — colocar só no final não bastava, o modelo
        // focava em responder sobre o valor e ignorava a instrução.
        const aparelhoPendenteAdmin = pendentesEquipe[phoneCliente]?.aparelho
          || extrairAparelhoPendente(conversas[phoneCliente])
          || 'aparelho';
        const modeloDesejadoAdmin = extrairModeloDesejado(conversas[phoneCliente]);
        const mensagemValorAdmin = modeloDesejadoAdmin
          ? `[EQUIPE]: O cliente já confirmou interesse em levar o ${modeloDesejadoAdmin}. O valor de troca do ${aparelhoPendenteAdmin} é R$${valor.toFixed(2).replace('.', ',')}. Monte a simulação completa AGORA usando o modelo ${modeloDesejadoAdmin} e esse valor de troca — NÃO pergunte de novo qual modelo ele quer, ele já respondeu isso.`
          : `[EQUIPE]: O valor de troca do ${aparelhoPendenteAdmin} é R$${valor.toFixed(2).replace('.', ',')}`;
        conversas[phoneCliente].push({
          role: 'user',
          content: mensagemValorAdmin
        });

        if (pendentesEquipe[phoneCliente]) {
          delete pendentesEquipe[phoneCliente];
          salvarPendentes();
        }

        salvarConversas();

        const msgs = conversas[phoneCliente];
        let reply = await chamarClaude([...msgs]);
        reply = removerApresentacaoRepetida(phoneCliente, reply);
        conversas[phoneCliente].push({ role: 'assistant', content: reply });
        salvarConversas();
        await enviarMensagem(phoneCliente, reply);

        await enviarMensagem(NUMERO_ADMIN, `✅ Valor enviado para o cliente ${phoneCliente}!`);
        return;
      }
    }

    if (!conversas[phone]) conversas[phone] = [];
    if (!metaConversas[phone]) metaConversas[phone] = {};
    metaConversas[phone].ultimaMensagemCliente = Date.now();
    metaConversas[phone].reativado = false;

    // ==========================================
    // CONVERSA JÁ ENCERRADA (boleto ou limite de DDD fora da região)
    // ==========================================
    // Uma vez encaminhado pro número de análise, o Cláudio não responde mais
    // esse cliente — evita gastar crédito de API negociando com quem já foi
    // direcionado pra outro atendimento.
    if (phone !== NUMERO_ADMIN && conversasEncerradas[phone]) {
      console.log(`🚫 Conversa com ${phone} já encerrada anteriormente — ignorando.`);
      return;
    }

    if (phone !== NUMERO_ADMIN) {
      // CONTEÚDO SEXUAL/IMPRÓPRIO: corta na hora, sem negociar, sem tentar
      // argumentar — e avisa você, pra decidir se quer bloquear o número.
      if (message && mencionaConteudoSexual(message)) {
        conversasEncerradas[phone] = true;
        salvarEncerradas();
        console.log(`🚨 ${phone} mandou conteúdo impróprio/sexual — conversa encerrada, sem resposta ao cliente.`);
        if (NUMERO_ADMIN) {
          try {
            await enviarMensagem(NUMERO_ADMIN, `🚨 O número ${phone} mandou uma mensagem com conteúdo sexual/impróprio pro Cláudio. A conversa foi encerrada automaticamente (o bot não vai responder mais esse número). Você pode bloquear/denunciar se quiser.`);
          } catch (e) {}
        }
        return;
      }

      // BOLETO: assim que o cliente menciona boleto, o Cláudio para de
      // negociar e encaminha direto pro número de análise, sem mais idas e
      // vindas.
      if (message && mencionaBoleto(message)) {
        const avisoBoleto = `Pra pagamento no boleto a gente encaminha pra nossa equipe de análise! Pode chamar direto nesse número que eles te atendem: ${NUMERO_ANALISE} 😊`;
        conversas[phone].push({ role: 'user', content: message });
        conversas[phone].push({ role: 'assistant', content: avisoBoleto });
        if (conversas[phone].length > 20) conversas[phone] = conversas[phone].slice(-20);
        salvarConversas();
        conversasEncerradas[phone] = true;
        salvarEncerradas();
        await enviarMensagem(phone, avisoBoleto);
        console.log(`📄 ${phone} mencionou boleto — encaminhado pra ${NUMERO_ANALISE} e conversa encerrada.`);
        return;
      }

      // CONVERSA FORA DO ASSUNTO: vale pra QUALQUER DDD (inclusive DDD 12).
      // Se o cliente mandar várias mensagens seguidas sem nenhuma relação
      // com aparelho/compra/troca/valor (bate-papo pessoal, assunto
      // aleatório), encerramos — mas SÓ nesse caso. Uma negociação real que
      // está avançando (mesmo que longa, mesmo que DDD de fora da região)
      // nunca é cortada por isso, porque cada mensagem relacionada à loja
      // zera o contador de novo.
      if (message && !ehSaudacaoNeutra(message)) {
        if (pareceAssuntoDaLoja(message)) {
          contadoresForaRegiao[phone] = 0;
        } else {
          contadoresForaRegiao[phone] = (contadoresForaRegiao[phone] || 0) + 1;
        }
        salvarContadoresForaRegiao();
        if (contadoresForaRegiao[phone] >= LIMITE_MENSAGENS_FORA_DO_ASSUNTO) {
          const avisoForaAssunto = `Aqui eu só consigo ajudar com assuntos da loja (aparelhos, troca, valores) 😊 Qualquer dúvida sobre isso, pode chamar!`;
          conversas[phone].push({ role: 'assistant', content: avisoForaAssunto });
          if (conversas[phone].length > 20) conversas[phone] = conversas[phone].slice(-20);
          salvarConversas();
          conversasEncerradas[phone] = true;
          salvarEncerradas();
          await enviarMensagem(phone, avisoForaAssunto);
          console.log(`💬 ${phone} enviou ${LIMITE_MENSAGENS_FORA_DO_ASSUNTO} mensagens seguidas fora do assunto da loja — conversa encerrada.`);
          return;
        }
      }
    }

    if (isImage) {
      const imageUrl = body.image?.imageUrl || body.image?.url || body.imageUrl;
      if (!imageUrl) return;
      const imgResp = await axios.get(imageUrl, { responseType: 'arraybuffer' });
      const imgBase64 = Buffer.from(imgResp.data).toString('base64');
      const imgMime = body.mimetype || 'image/jpeg';
      const visionResp = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-sonnet-4-6', max_tokens: 1024,
        system: [{ type: "text", text: SYSTEM_PROMPT + textoRegraDomingoTaubate(), cache_control: { type: "ephemeral", ttl: "1h" } }],
        messages: [...conversas[phone], { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: imgMime, data: imgBase64 } }, { type: 'text', text: body.text?.message || 'Descreva esta imagem.' }] }]
      }, { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } });
      const reply = visionResp.data.content[0].text;
      await enviarMensagem(phone, reply);
      salvarConversas();
      return;
    }

    if (isAudio) {
      const audioUrl = body.audio?.audioUrl || body.audio?.url || body.audioUrl;
      if (!audioUrl) { await enviarMensagem(phone, 'Não consegui processar o áudio. Pode digitar? 😊'); return; }
      if (!OPENAI_API_KEY) { await enviarMensagem(phone, 'Não consigo ouvir áudios por aqui, mas pode digitar! 😊'); return; }
      const transcricao = await transcreverAudio(audioUrl, body.mimetype);
      if (!transcricao?.trim()) { await enviarMensagem(phone, 'Não consegui entender o áudio. Pode digitar? 😊'); return; }
      conversas[phone].push({ role: 'user', content: transcricao });
      if (conversas[phone].length > 20) conversas[phone] = conversas[phone].slice(-20);
      const tamanhoAntesAudio = conversas[phone].length;
      let reply = await chamarClaude(conversas[phone]);
      // Remove mensagens internas de uso de ferramenta (calcular_parcelamento) que
      // tenham sido adicionadas durante a chamada — elas não são conversa real com
      // o cliente e não devem consumir espaço no histórico de 20 mensagens.
      if (conversas[phone].length > tamanhoAntesAudio) conversas[phone] = conversas[phone].slice(0, tamanhoAntesAudio);
      if (respostaRepetidaEmLoop(reply, conversas[phone])) {
        const corrigida = await gerarRespostaQuebrandoLoop(conversas[phone]);
        if (corrigida) reply = corrigida;
      }
      if (respostaPedeConfirmacaoJaConfirmada(reply, conversas[phone])) {
        const corrigida = await gerarRespostaCorrigindoConfirmacaoRegressao(conversas[phone]);
        if (corrigida) reply = corrigida;
      }
      if (respostaTrocaTratadaComoVenda(transcricao, reply, conversas[phone])) {
        const corrigida = await gerarRespostaCorrigindoTrocaConfundidaComVenda(conversas[phone]);
        if (corrigida) reply = corrigida;
      }
      if (respostaTemModeloForaDaTabela(reply)) reply = await gerarRespostaComAlternativa(conversas[phone], reply);
      if (respostaTemCorErradaParaModelo(reply)) {
        const corrigida = await gerarRespostaCorrigindoCorModelo(conversas[phone]);
        if (corrigida) reply = corrigida;
      }
      if (respostaNegaModeloQueExisteNaTabela(reply)) {
        const corrigida = await gerarRespostaCorrigindoNegacao(conversas[phone]);
        if (corrigida) reply = corrigida;
      }
      if (respostaRecusaAparelhoNaTroca(reply, transcricao)) {
        const corrigida = await gerarRespostaCorrigindoRecusaTroca(conversas[phone]);
        if (corrigida) reply = corrigida;
      }
      if (respostaInventouValorTrocaAndroid(reply)) {
        const corrigida = await gerarRespostaCorrigindoValorAndroid(conversas[phone]);
        if (corrigida) reply = corrigida;
      }
      if (respostaTemValorTrocaRedmiNoteErrado(reply)) {
        const corrigida = await gerarRespostaCorrigindoValorRedmiNote(conversas[phone]);
        if (corrigida) reply = corrigida;
      }
      if (respostaTemPrecoManutencaoAndroidInventado(reply)) {
        const corrigida = await gerarRespostaCorrigindoManutencaoAndroid(conversas[phone]);
        if (corrigida) reply = corrigida;
      }
      // Checagem final de loop: as travas acima (ex: modelo fora da tabela)
      // podem, na correção, cair de volta no MESMO texto genérico de
      // fallback que já foi usado numa resposta anterior — e como essa
      // substituição acontece DEPOIS da checagem de loop lá em cima, ela
      // passava despercebida. Confere de novo aqui, bem no final, antes de
      // mandar pro cliente.
      if (respostaRepetidaEmLoop(reply, conversas[phone])) {
        console.log('⚠️ Loop final detectado (fallback repetido) — usando resposta de recuperação');
        reply = 'Peço desculpas, acho que me perdi aqui! Pode me confirmar de novo, com suas palavras, qual é exatamente a sua dúvida ou o que você precisa? Assim já te ajudo certinho 😊';
      }
      reply = removerApresentacaoRepetida(phone, reply);
      reply = removerBateriaNaoSolicitada(transcricao, reply);
      conversas[phone].push({ role: 'assistant', content: reply });
      salvarConversas();
      await enviarMensagem(phone, reply);
      return;
    }

    if (!message) return;
    console.log(`📱 ${phone}: ${message}`);
    conversas[phone].push({ role: 'user', content: message });
    if (conversas[phone].length > 20) conversas[phone] = conversas[phone].slice(-20);
    const tamanhoAntes = conversas[phone].length;
    let reply = await chamarClaude(conversas[phone]);
    if (conversas[phone].length > tamanhoAntes) conversas[phone] = conversas[phone].slice(0, tamanhoAntes);
    if (respostaRepetidaEmLoop(reply, conversas[phone])) {
      const corrigida = await gerarRespostaQuebrandoLoop(conversas[phone]);
      if (corrigida) reply = corrigida;
    }
    if (respostaPedeConfirmacaoJaConfirmada(reply, conversas[phone])) {
      const corrigida = await gerarRespostaCorrigindoConfirmacaoRegressao(conversas[phone]);
      if (corrigida) reply = corrigida;
    }
    if (respostaTrocaTratadaComoVenda(message, reply, conversas[phone])) {
      const corrigida = await gerarRespostaCorrigindoTrocaConfundidaComVenda(conversas[phone]);
      if (corrigida) reply = corrigida;
    }
    if (respostaTemModeloForaDaTabela(reply)) reply = await gerarRespostaComAlternativa(conversas[phone], reply);
    if (respostaTemCorErradaParaModelo(reply)) {
      const corrigida = await gerarRespostaCorrigindoCorModelo(conversas[phone]);
      if (corrigida) reply = corrigida;
    }
    if (respostaNegaModeloQueExisteNaTabela(reply)) {
      const corrigida = await gerarRespostaCorrigindoNegacao(conversas[phone]);
      if (corrigida) reply = corrigida;
    }
    if (respostaRecusaAparelhoNaTroca(reply, message)) {
      const corrigida = await gerarRespostaCorrigindoRecusaTroca(conversas[phone]);
      if (corrigida) reply = corrigida;
    }
    if (respostaInventouValorTrocaAndroid(reply)) {
      const corrigida = await gerarRespostaCorrigindoValorAndroid(conversas[phone]);
      if (corrigida) reply = corrigida;
    }
    if (respostaTemValorTrocaRedmiNoteErrado(reply)) {
      const corrigida = await gerarRespostaCorrigindoValorRedmiNote(conversas[phone]);
      if (corrigida) reply = corrigida;
    }
    if (respostaTemPrecoManutencaoAndroidInventado(reply)) {
      const corrigida = await gerarRespostaCorrigindoManutencaoAndroid(conversas[phone]);
      if (corrigida) reply = corrigida;
    }
    // Checagem final de loop (mesma explicação do fluxo de áudio acima).
    if (respostaRepetidaEmLoop(reply, conversas[phone])) {
      console.log('⚠️ Loop final detectado (fallback repetido) — usando resposta de recuperação');
      reply = 'Peço desculpas, acho que me perdi aqui! Pode me confirmar de novo, com suas palavras, qual é exatamente a sua dúvida ou o que você precisa? Assim já te ajudo certinho 😊';
    }
    reply = removerApresentacaoRepetida(phone, reply);
    reply = removerBateriaNaoSolicitada(message, reply);
    console.log(`🤖 Resposta: ${reply}`);
    conversas[phone].push({ role: 'assistant', content: reply });
    salvarConversas();
    salvarMetadados();

    if (detectouPendencia(reply, message) && NUMERO_ADMIN && !pendentesEquipe[phone]) {
      const aparelho = extrairAparelhoPendente(conversas[phone]);
      pendentesEquipe[phone] = { aparelho, aguardando: true };
      salvarPendentes();
      // Usamos a RESPOSTA do Cláudio como contexto, não a mensagem crua do
      // cliente. Motivo: o cliente pode estar no meio de uma pergunta sobre
      // outro assunto (ex: perguntando por um modelo diferente pra comprar)
      // no exato momento em que a pendência de troca é detectada — nesse
      // caso, a mensagem dele não explica o problema real. A resposta do
      // próprio Cláudio, por outro lado, já contém a explicação certa do
      // motivo da escalação (ex: "tem dois defeitos combinados, preciso
      // verificar com a equipe"), então é uma contexto muito mais útil e
      // relevante pra quem vai avaliar.
      // Extraímos só o MOTIVO real (defeito ou modelo fora da tabela) da
      // resposta do Cláudio, em vez de mandar a resposta inteira ou a
      // mensagem crua do cliente — assim você vê direto qual é o problema.
      await notificarAdmin(phone, aparelho, extrairMotivoPendencia(reply));
    }

    await enviarMensagem(phone, reply);

  } catch (error) {
    console.error('Erro:', error.response?.data || error.message);
    // Antes esse erro (ex: crédito da API acabou, erro 401/429/500) ficava só
    // no log do Railway, sem avisar ninguém — o cliente ficava sem resposta
    // e só se descobria o problema quando alguém notava manualmente. Agora
    // avisa o admin na hora, pra responder manualmente enquanto o problema
    // não é resolvido (a resposta manual já fica registrada corretamente
    // graças ao tratamento de fromMe acima, sem duplicar depois).
    if (NUMERO_ADMIN && phone && phone !== NUMERO_ADMIN) {
      try {
        await enviarMensagem(NUMERO_ADMIN, `⚠️ Erro ao processar mensagem do cliente ${phone}. O Cláudio pode estar fora do ar (crédito da API, erro de conexão, etc). Responda manualmente por enquanto:\n\nErro: ${error.response?.data?.error?.message || error.message}`);
      } catch (e) {}
    }
  }
  });
});

// ==========================================
// ADMIN PAINEL
// ==========================================
let tabelaEmMemoria = process.env.PRICE_TABLE || '';

app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'admin.html')); });
app.get('/tabela', (req, res) => { res.send(tabelaEmMemoria); });

app.post('/salvar-tabela', async (req, res) => {
  tabelaEmMemoria = req.body.tabela;
  try {
    await axios.post('https://backboard.railway.app/graphql/v2', {
      query: `mutation { variableUpsert(input: { projectId: "4f91d664-453e-45b2-8e3e-ad8cb8965b0f" environmentId: "c2eca5aa-ccbe-4e4d-b67f-4a5789edbff8" serviceId: "7d77b859-3bec-4f0b-97a3-95b328bd7feb" name: "PRICE_TABLE" value: ${JSON.stringify(req.body.tabela)} }) }`
    }, { headers: { 'Authorization': 'Bearer 9432504b-5a9c-4a15-8baa-1bd6222b462b', 'Content-Type': 'application/json' } });
    console.log('✅ Tabela salva!');
  } catch(e) { console.error('Erro Railway:', e.message); }
  res.json({ok: true});
});

app.listen(3000, () => { console.log('✅ Bot Saem Celulares rodando na porta 3000!'); });
