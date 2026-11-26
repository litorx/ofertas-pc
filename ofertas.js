// Filtra data/msgs.json (pesquisa global do Telegram): só mensagens com <= maxIdadeHoras que casam uma peça E têm
// preço dentro do teto (+ margem). Manda as promos no WhatsApp (config.whatsappDestino) sem repetir.
//   node ofertas.js          filtra e envia
//   node ofertas.js --dry    só mostra o que enviaria
//   node ofertas.js --teste  roda o filtro em mensagens de exemplo
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const cfg = require('./carregar-config.js')(process.env.CFG_FILE);
if (process.env.MAXH) cfg.maxIdadeHoras = Number(process.env.MAXH); // só para prévia/teste com janela maior
const D = path.join(__dirname, 'data');
const dry = process.argv.includes('--dry');
// CANAL=telegram (nuvem): avisa por um bot do Telegram. Padrão (PC): WhatsApp via wa-enviar.js.
const CANAL = process.env.CANAL || 'whatsapp';
// o destino vira um hash no estado, para o id do grupo não aparecer num repositório público
const hash = (s) => require('crypto').createHash('sha1').update(String(s)).digest('hex').slice(0, 10);
const DESTINO = CANAL === 'telegram' ? 'telegram:' + hash((process.env.TG_CHAT_ID || '').trim()) : cfg.whatsappDestino;
const LIMITE_MSG = CANAL === 'telegram' ? 2800 : 3200; // Telegram aceita 4096 com as tags HTML
const R = (s, f = 'i') => new RegExp(s, f);

const num = (s) => Number(s.replace(/\./g, '').replace(',', '.'));
function precos(t) {
  const limpo = t.replace(/\b\d{1,2}\s*x\s*(?:de|sem juros de)?\s*R?\$?\s*[\d.,]+/gi, ' '); // tira parcelas
  const out = []; let m;
  const re = /R\$\s*(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?)/gi;
  while ((m = re.exec(limpo))) out.push(num(m[1]));
  const re2 = /(\d{1,3}(?:\.\d{3})+|\d{3,4})(?:,\d{2})?\s*(?:reais|à vista|a vista|no pix|pix)/gi;
  while ((m = re2.exec(limpo))) out.push(num(m[1]));
  return out.filter((v) => v > 0);
}

// ---- cupom e condições ----
const NAO_CODIGO = new Set(['CUPOM', 'CUPONS', 'CLIENTE', 'MOEDAS', 'PIX', 'APP', 'LINK', 'PARA', 'COM', 'MELI', 'USE', 'ATE', 'ANUNCIO', 'SELECIONADOS', 'RESGATE', 'PAGINA', 'TODOS', 'DESTA', 'VALIDO', 'OFF', 'APLICADO', 'ATIVO', 'ATIVE', 'AQUI', 'ABAIXO', 'SITE', 'ANUNCIO']);

// Cada link do post com o RÓTULO escrito perto dele: na mesma linha ("Link PC: https://...") ou, se o link está sozinho
// na linha, na linha de cima ("Resgate todos os cupons desta página:" / "Link do produto:").
// tipo: 'cupom' (página/link para resgatar cupom), 'pc', 'app' ou 'neutro'.
const TEM_PALAVRA = /[a-zà-ú]{3}/i;
function linksDoPost(t) {
  const out = []; const re = /https?:\/\/[^\s)>\]"']+/g; let m; let fimAnterior = 0;
  while ((m = re.exec(t))) {
    const url = m[0].replace(/[.,;:!?]+$/, '');
    const ini = t.lastIndexOf('\n', m.index - 1) + 1;
    let rot = t.slice(Math.max(ini, fimAnterior), m.index); // só o texto desde o link anterior (dois links na mesma linha)
    fimAnterior = m.index + m[0].length;
    if (!TEM_PALAVRA.test(rot)) { // só emoji/nada antes do link: vale a linha de cima
      const acima = t.slice(0, Math.max(0, ini - 1)).split('\n').reverse().find((l) => TEM_PALAVRA.test(l));
      if (acima) rot = acima;
    }
    rot = rot.toLowerCase();
    const cupomPag = /(resgat\w*|ative|pegue|colet\w*|acesse|clique)[^\n]{0,40}(cupom|cupons)|(cupom|cupons)\s+(desta|dessa|da)\s+p[aá]gina|p[aá]gina\s+de\s+cupons?|resgate\s+aqui/.test(rot);
    const pc = /\bpc\b|computador|desktop|navegador|\bsite\b/.test(rot);
    const app = /\bapp\b|aplicativo|celular|mobile/.test(rot);
    out.push({ url, tipo: cupomPag ? 'cupom' : pc ? 'pc' : app ? 'app' : 'neutro' });
  }
  return out;
}

function cupom(t) {
  const codigos = new Set();
  const semUrl = t.replace(/https?:\/\/\S+/g, ' '); // não procurar "código" dentro de link
  const pegar = (s) => (s.match(/\b(?=[A-Z0-9]*[A-Z])[A-Z0-9]{5,24}\b/g) || []).forEach((c) => { if (!NAO_CODIGO.has(c)) codigos.add(c); });
  const re = /cupom[^\n]{0,120}/gi; let m;
  while ((m = re.exec(semUrl))) {
    pegar(m[0]);
    if (/[:：]\s*$/.test(m[0])) { const prox = semUrl.slice(re.lastIndex).match(/^\n[ \t]*([^\n]{0,60})/); if (prox) pegar(prox[1]); } // "Use o cupom:\nABC123"
  }
  // Código logo depois de "cupom:" (ou "-CUPOM: X"), qualquer caixa e a partir de 3 caracteres: "GOTY", "doze600k".
  // Palavra comum só em minúsculas e sem número ("cupom: aplicado") não é código.
  const dir = /cupom[^\n:：–-]{0,30}[:：–-]\s*["“`']?([A-Za-z0-9]{3,24})\b/gi; let d;
  while ((d = dir.exec(semUrl))) {
    const c = d[1];
    if (NAO_CODIGO.has(c.toUpperCase())) continue;
    if (c === c.toLowerCase() && !/\d/.test(c)) continue;
    codigos.add(c);
  }
  // Linha do cupom sem a palavra "cupom": "🎟 R$ 150 OFF em R$ 1499: ACHADINHO"
  const emoji = /^[ \t]*[🎟🏷][^\n]*?:\s*["“`']?([A-Z0-9]{4,24})["”`']?[ \t]*$/gmu; let e;
  while ((e = emoji.exec(semUrl))) if (!NAO_CODIGO.has(e[1])) codigos.add(e[1]);
  const temPalavra = /cupom|c[oó]digo promocional/i.test(t);
  const link = (linksDoPost(t).find((l) => l.tipo === 'cupom') || {}).url || '';
  const noAnuncio = /cupom[^\n]{0,40}\ban[uú]ncio|an[uú]ncio[^\n]{0,30}cupom/i.test(t);
  let valor = ''; // "R$ 100 OFF", "15% off"...
  for (const l of t.split('\n')) { if (!/cupom|resgat/i.test(l)) continue; const v = /(R\$\s?\d[\d.,]*\s*off|\d+\s*%\s*off|\d+\s*off)/i.exec(l); if (v) { valor = v[1].replace(/\s+/g, ' ').toUpperCase(); break; } }
  const notas = [];
  if (/meli\s*\+|meli\s*mais/i.test(t)) notas.push('exclusivo Meli+');
  if (/moedas/i.test(t)) notas.push('usa moedas do app');
  if (/no app|link app|pelo app|só no app|somente no app/i.test(t) && !/link pc/i.test(t)) notas.push('preço no app');
  if (/pix/i.test(t)) notas.push('preço no Pix');
  if (/primeira compra|novo usu[aá]rio|novos usu[aá]rios/i.test(t)) notas.push('só para 1ª compra');
  return { codigos: [...codigos], temPalavra, notas, link, noAnuncio, valor };
}
// Como USAR o cupom: o código, o link para resgatar (em linha própria) ou o aviso de que está no anúncio.
function linhaCupom(c, linkDeCompra) {
  const L = [];
  if (c.codigos.length) L.push('🎟️ *Cupom:* ' + c.codigos.map((x) => '`' + x + '`').join(' ou '));
  if (c.link && c.link === linkDeCompra) { // ex.: Shopee Live: o mesmo link resgata o cupom e compra
    L.push('🎟️ *Cupom' + (c.valor ? ' de ' + c.valor : '') + ':* ' + (c.codigos.length ? 'também vale' : 'vale') + ' pelo link de compra abaixo');
  } else if (c.link) { L.push('🎟️ *' + (c.codigos.length ? 'Resgatar o cupom' : 'Cupom' + (c.valor ? ' de ' + c.valor : '')) + ':* resgate neste link'); L.push(c.link); }
  else if (!c.codigos.length && c.noAnuncio) L.push('🎟️ *Cupom no anúncio*' + (c.valor ? ' (' + c.valor + ')' : '') + ': ative na página do produto');
  else if (!c.codigos.length && c.temPalavra) L.push('🎟️ *Precisa de cupom* (o código não veio no post, confira na página do produto)');
  return L.join('\n'); // sem cupom: vazio, não fala nada
}
// Quanto abaixo do teto está o preço: 🟢 pouco · 🟡 médio · 🔴 muito (limites em config.faixasTeto, % )
function faixaTeto(preco, teto) {
  const f = cfg.faixasTeto || {}; const amarelo = f.amarelo ?? 10, vermelho = f.vermelho ?? 20;
  const pct = Math.round(((teto - preco) / teto) * 100);
  if (pct <= 0) return '🟢 no teto';
  return (pct < amarelo ? '🟢' : pct < vermelho ? '🟡' : '🔴') + ' ' + pct + '% abaixo do teto';
}

function loja(o) {
  const s = (o.m.links.join(' ') + ' ' + o.m.texto).toLowerCase();
  if (/meli\.la|mercadolivre|mercadolibre/.test(s)) return 'Mercado Livre';
  if (/amazon|amzn\.to/.test(s)) return 'Amazon';
  if (/terabyte/.test(s)) return 'Terabyte';
  if (/kabum/.test(s)) return 'KaBuM';
  if (/pichau/.test(s)) return 'Pichau';
  if (/shopee/.test(s)) return 'Shopee';
  if (/aliexpress/.test(s)) return 'AliExpress';
  return '';
}

// Link de compra: SEMPRE o que funciona no PC. Muitos posts trazem dois ("Link APP: ..." e "Link PC: ..."); o do app só
// abre no celular, o do PC abre nos dois. Lê o rótulo escrito antes de cada link e escolhe: PC > sem rótulo > APP.
// Nunca escolhe o link de CUPONS (Shopee: "Resgate todos os cupons desta página") como link de compra.
function linkCompra(o) {
  const achados = linksDoPost(o.m.texto || '');
  for (const u of o.m.links || []) if (!achados.some((a) => a.url === u)) achados.push({ url: u, tipo: 'neutro' }); // só vieram no botão/atributo
  const util = achados.filter((a) => !/t\.me\//i.test(a.url) && a.tipo !== 'cupom'); // t.me = bot/canal; 'cupom' = página de cupons
  const por = (tipo) => util.find((a) => a.tipo === tipo);
  return (por('pc') || por('neutro') || por('app') || {}).url || o.m.url || '';
}

// nome curto do produto: tira emoji, link, preço, a palavra genérica da categoria e corta em ~48 caracteres
function nomeCurto(p, texto) {
  let t = texto.replace(/https?:\S+/g, ' ').replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, ' ').replace(/\s+/g, ' ');
  t = t.split(/R\$|Por:|POR:|A partir de/)[0];
  const a = p.ancora && R(p.ancora).exec(t);
  if (a) t = t.slice(a.index);
  for (const x of p.tirar || []) t = t.replace(R('^\\s*(' + x + ')\\b[\\s,:\\-]*'), '');
  t = t.replace(/^[\s,:\-]+/, '');
  t = t.replace(/\([^)]*\)/g, ' ').replace(/\b(amd|intel)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  const partes = t.split(/\s*[,|]\s*|\s+-\s+/).filter(Boolean);
  let s = '';
  for (const x of partes) { if ((s + ' ' + x).trim().length > 48 && s) break; s = (s ? s + ' · ' : '') + x.trim(); }
  s = s || t;
  if (s.length > 52) s = s.slice(0, 52).replace(/\s+\S*$/, '') + '…'; // corta em palavra inteira
  return s.replace(/[\s\-–]+$/, '');
}

function avaliar(m, agora) {
  const t = m.texto || '';
  const idade = (agora - Date.parse(m.data)) / 3600000;
  if (!m.data || idade > cfg.maxIdadeHoras || idade < -1 || t.length < 8) return null;
  if (/esgotad|acabou|expirou|encerrad|sem estoque|indispon[ií]vel|cupom esgotado|oferta acabou/i.test(t)) return null;
  // textos NOSSOS (avisos e respostas do bot) nunca são promoção: por chat, por assinatura e por emoji de comando
  if ((cfg.ignorarChats || []).some((id) => (m.url || '').includes('/c/' + Math.abs(id) + '/'))) return null;
  if (/PROMOS PARA O PC|━━━━━|Comandos do bot|Peças monitoradas|Meu teto|\/(teto|add|lista|remover|pausar|ativar|excluir|janela|margem|desfazer|agora|ajuda)\b/.test(t)) return null;
  if (/^\s*(✅|➕|🗑️|⏸|▶️|🚫|🕒 Janela|📐|🔢|↩️|📡|🤖|📋|⚠️ Apagar)/.test(t)) return null;
  // combos/kits ("placa-mãe + processador + cooler"): o preço é do conjunto, não da peça
  const PECA = '(placa[- ]?m[aã]e|processador|ryzen|water\\s*cooler|watercooler|cooler|ssd|nvme|mem[oó]ria|fonte|rtx|radeon|rx\\s?\\d{4}|gabinete|b550)';
  if (/\bcombo\b|casadinh|kit\s+upgrade|upgrade\s+kit|\bbundle\b/i.test(t) || R(PECA + '[^+\\n]{0,90}\\+[^+\\n]{0,90}' + PECA).test(t.split('\n').slice(0, 3).join(' '))) return null;
  for (const p of cfg.pecas) {
    if (p.ativa === false) continue; // pausada pelo bot (/pausar)
    if (!p.incluir.some((r) => R(r).test(t))) continue;
    if (!(p.exigir || []).every((r) => R(r).test(t))) continue;
    if ((p.excluir || []).some((r) => R(r).test(t))) continue;
    const vs = precos(t).filter((v) => v >= p.piso && v <= p.teto * 3);
    if (!vs.length) continue;
    const preco = Math.min(...vs);
    if (preco > p.teto * (1 + cfg.margem)) continue;
    let cor = '';
    if (p.cor) {
      if (/preto|black|\bbk\b/i.test(t) && !/branc|white|\bwh\b/i.test(t)) continue;
      cor = /branc|white|\bwh\b|-rw\b/i.test(t) ? '⚪ Branco' : ''; // cor não informada: aceita e não comenta
    }
    const extra = [];
    if (/b550/i.test(t)) {
      if (/wi-?fi/i.test(t)) extra.push('📶 Com WiFi');
      if (!/b550\s*-?\s*m|m-?atx|micro/i.test(t)) extra.push('⚠️ Confira se é mATX (cabe no gabinete?)');
    }
    return { peca: p.nome, p, preco, teto: p.teto, dentro: preco <= p.teto, idade, cor, extra, cupom: cupom(t), nome: nomeCurto(p, t), m: t && m };
  }
  return null;
}

const real = (n) => 'R$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2 });
const idadeTxt = (h) => h < 1 ? Math.max(1, Math.round(h * 60)) + ' min' : h < 24 ? Math.round(h) + ' h' : (h / 24).toFixed(1).replace('.', ',') + ' dias';

function secao(p, lista) {
  const L = ['━━━━━━━━━━━━━━', p.icone + ' *' + p.rotulo + '*', '━━━━━━━━━━━━━━', ''];
  lista.forEach((o, i) => {
    const link = linkCompra(o);
    const l = loja(o);
    L.push('*' + (i + 1) + ')* 💰 *' + real(o.preco) + '*  ' + faixaTeto(o.preco, o.teto));
    L.push('📦 ' + o.nome);
    if (o.cor) L.push(o.cor);
    o.extra.forEach((e) => L.push(e));
    const lc = linhaCupom(o.cupom, link); if (lc) L.push(lc);
    if (o.cupom.notas.length) L.push('ℹ️ ' + o.cupom.notas.join(' · '));
    L.push('🕒 Há ' + idadeTxt(o.idade) + (l ? ' · 🏪 ' + l : ''));
    L.push('');
    L.push('🔗 *Comprar:*');
    L.push(link);
    L.push('');
  });
  return L.join('\n');
}
// agrupa as seções em mensagens de até ~3200 caracteres
function mensagens(lista) {
  const sec = cfg.pecas.filter((p) => p.ativa !== false).map((p) => ({ p, g: lista.filter((o) => o.peca === p.nome).slice(0, cfg.porPeca || 3) })).filter((x) => x.g.length).map((x) => secao(x.p, x.g));
  const d = new Date(), z = (n) => String(n).padStart(2, '0');
  const cab = '🖥️ *PROMOS PARA O PC*\n_Últimas ' + cfg.maxIdadeHoras + 'h · ' + z(d.getDate()) + '/' + z(d.getMonth() + 1) + ' ' + z(d.getHours()) + ':' + z(d.getMinutes()) + '_\n\n';
  const out = []; let atual = cab;
  for (const s of sec) { if (atual.length + s.length > LIMITE_MSG && atual !== cab) { out.push(atual.trim()); atual = ''; } atual += s + '\n'; }
  if (atual.trim()) out.push(atual.trim());
  return out;
}

// ---- promo repetida: mesmo produto (nome parecido) na mesma peça, com preço quase igual (±5%) ----
// Os canais repostam uns dos outros com centavos de diferença (R$ 268 / 269 / 271): isso é UMA promo, não três.
const semAcento = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const GENERICAS = new Set(['de', 'da', 'do', 'dos', 'das', 'com', 'para', 'por', 'sem', 'em', 'um', 'uma', 'amd', 'intel', 'gamer', 'gaming', 'preto', 'branco', 'black', 'white', 'am4', 'ddr4', 'mini', 'micro', 'atx', 'matx', 'kit', 'novo', 'nova']);
const tokensProduto = (nome) => [...new Set(semAcento(nome).replace(/[^a-z0-9]+/g, ' ').split(' ').filter((t) => t.length > 1 && !GENERICAS.has(t)))];
const jaccard = (a, b) => { const B = new Set(b); const i = a.filter((x) => B.has(x)).length; return i / ((a.length + b.length - i) || 1); };
// Um aviso antigo só bloqueia se (a) o post é ANTERIOR ao aviso (é o mesmo post de antes) ou (b) o aviso foi há menos de ONDA horas
// (canais repostando a mesma promo; 8h). Post NOVO depois disso = a promo voltou (estoque/cupom novo): avisa de novo.
const ONDA_H = 8;
const bloqueia = (t, o) => { if (!t) return true; const tv = Date.parse(t), post = Date.now() - o.idade * 3600000; return post <= tv || Date.now() - tv < ONDA_H * 3600000; };
const repetida = (o, vistos) => { const tk = tokensProduto(o.nome); return vistos.some((v) => v.pc === o.peca && Math.abs(v.p - o.preco) / v.p <= 0.05 && jaccard(v.tk, tk) >= 0.6 && bloqueia(v.t, o) && !(o.preco <= v.p * MAIS_BARATO)); };
// Repetida mas MAIS BARATA (pelo menos 2% abaixo do que já foi avisado) é avisada mesmo assim; centavos de diferença entre canais não contam.
const MAIS_BARATO = 0.98;
const registro = (o, t) => ({ pc: o.peca, p: o.preco, tk: tokensProduto(o.nome), t });
// da lista (já ordenada do mais barato ao mais caro) fica só uma por produto, e nenhuma que já foi avisada
function unicos(lista, jaAvisados) {
  const aceitos = [];
  for (const o of lista) { if (repetida(o, jaAvisados) || repetida(o, aceitos.map((x) => registro(x)))) continue; aceitos.push(o); }
  return aceitos;
}

if (process.argv.includes('--teste')) {
  // os testes usam tetos fixos, para não quebrarem quando você muda um teto pelo bot
  const FIXOS = { 'RX 9060 XT 16GB': 3250, 'RTX 4060 Ti 16GB': 3000, 'Ryzen 7 5700X': 950, 'Ryzen 5 5600X': 700, 'Placa-mãe B550 / B550M': 600, 'Water cooler 360 branco': 290, 'Fonte 750W': 220, 'SSD NVMe 2TB': 1700, 'SSD NVMe 1TB': 700, 'SSD NVMe 512GB': 340, 'SSD SATA 1TB': 550, 'SSD SATA 512GB': 280, 'RAM DDR4 16GB': 350 };
  cfg.margem = 0.05; cfg.pecas.forEach((p) => { p.ativa = true; if (FIXOS[p.nome]) p.teto = FIXOS[p.nome]; });
  const agora = Date.now(), h = (n) => new Date(agora - n * 3600000).toISOString();
  const T = [
    ['RX 9060 XT 16GB Asus Prime R$ 3.199 no pix', 5, true],
    ['RX 9060 XT 16GB por R$ 3.400', 5, true],
    ['RX 9060 XT 16GB por R$ 3.500', 5, false],
    ['Placa de vídeo RX9060XT 16 GB R$ 3.100', 5, true],
    ['RX 9060 XT 8GB por R$ 2.500', 5, false],
    ['RX 9060 XT 16GB por R$ 3.100', 20, false],
    ['RX 9060 XT 16GB por R$ 3.100 ESGOTADO', 5, false],
    ['Placa de Vídeo Gigabyte RTX 4060 Ti 16GB R$ 2.899', 5, true],
    ['RTX 4060 Ti 8GB R$ 2.000', 5, false],
    ['RTX 4060Ti 16GB por R$ 3.100', 5, true],
    ['RTX 4060 Ti 16GB por R$ 3.300', 5, false],
    ['Ryzen 7 5700X por R$ 899', 10, true],
    ['Ryzen 7 5700X3D por R$ 899', 10, true],
    ['Ryzen 5 5600X R$ 649,90', 10, true],
    ['Ryzen 5 5600 R$ 599,90', 10, true],
    ['Placa-mãe MSI B550M Gaming Plus WiFi6E R$ 589', 3, true],
    ['Placa mãe B550 M-Pro R$ 520', 3, true],
    ['Water Cooler 360mm ARGB Branco R$ 279,99', 3, true],
    ['Watercooler Cooler Master Elite Liquid 360 R$ 289', 3, true],
    ['Water Cooler 360mm ARGB Branco R$ 329,99', 3, false],
    ['Water Cooler 360mm ARGB Branco R$ 300', 3, true],
    ['Water Cooler 360mm ARGB Preto R$ 269,99', 3, false],
    ['Water Cooler 240mm Branco R$ 199', 3, false],
    ['Fonte MACH1 750W 80 Plus Bronze R$ 199', 3, true],
    ['Fonte Corsair CX750 750 W R$ 229', 3, true],
    ['Fonte 750W 80 Plus Gold R$ 260', 3, false],
    ['Fonte 650W 80 Plus Bronze R$ 189', 3, false],
    ['Fonte 750W 12x R$ 25', 3, false],
    ['SSD NVMe Kingston NV3 1TB R$ 649', 3, true],
    ['SSD NVMe 1TB R$ 760', 3, false],
    ['SSD M.2 NVMe 512GB WD Green R$ 329', 3, true],
    ['SSD NVMe 512GB R$ 380', 3, false],
    ['SSD Kingston A400 480GB SATA R$ 259', 3, true],
    ['SSD 480GB R$ 300', 3, false],
    ['SSD SATA 1TB Crucial BX500 R$ 529', 3, true],
    ['SSD Externo Portátil 1TB R$ 500', 3, false],
    ['SSD NVMe 2TB R$ 649', 3, true],
    ['SSD NVMe Kingston 2TB R$ 1.599', 3, true],
    ['SSD NVMe 2TB R$ 1.750', 3, true],
    ['SSD NVMe 2TB R$ 1.900', 3, false],
    ['SSD Externo 2TB NVMe R$ 1.200', 3, false],
    ['SSD SATA 2TB R$ 1.200', 3, false],
    ['Memória RAM DDR4 16GB 3200MHz Kingston Fury R$ 329', 3, true],
    ['Kit Memória DDR4 16GB (2x8GB) 3200MHz R$ 299', 3, true],
    ['Memória DDR5 16GB R$ 300', 3, false],
    ['Memória DDR4 16GB SODIMM notebook R$ 250', 3, false],
    ['Memória DDR4 32GB R$ 340', 3, false],
    ['Memória DDR4 8GB R$ 150', 3, false],
    ['PC Gamer Ryzen 5 5600X RX 9060 XT 16GB R$ 5.999', 3, false],
    ['Placa-Mãe MSI B550M Gaming Plus WiFi6E + Processador AMD Ryzen 7 5700X + Water Cooler MACH1 Logic, RGB, 240mm\n\nPOR: R$ 1471', 1, false],
    ['Kit Upgrade Ryzen 5 5600X + B550M R$ 1.200', 1, false],
    ['Placa Mãe Husky Nexus B550, M.2 NVMe, DDR4 3200MHz R$ 344', 1, true],
    ['Ryzen 7 5700X 3.4GHz 8 núcleos R$ 899 + frete grátis', 1, true],
    // eco: textos do próprio bot/avisos nunca podem virar promoção
    ['✅ 🎮 RX 9060 XT 16GB: R$ 3.250 → R$ 3.000', 1, false],
    ['🖥️ PROMOS PARA O PC\n━━━━━━━━━━━━━━\n🧠 PROCESSADOR · Ryzen 7 5700X\n1) 💰 R$ 630', 1, false],
    ['/teto 5700x 900 Ryzen 7 5700X R$ 900', 1, false],
    ['➕ Ryzen 7 5700X adicionada com teto R$ 900', 1, false],
    ['📋 Peças monitoradas 3. Ryzen 7 5700X — R$ 950', 1, false],
  ];
  let ok = 0;
  T.forEach(([txt, hrs, esp]) => { const r = !!avaliar({ data: h(hrs), texto: txt, links: [] }, agora); if (r === esp) ok++; else console.log('FALHOU:', txt, '| esperado', esp); });
  // cupom
  const c1 = cupom('Placa Mae R$ 574 com cupom: C0RR1D411D011 ✅ Link'), c2 = cupom('Fonte R$ 297 🎟️ Cupom para cliente Meli+: MELIMAIS1411'), c3 = cupom('SSD 1TB R$ 599 no PIX'), c4 = cupom('R$ 99 use o cupom no app');
  const cg = (x) => cupom(x).codigos.join(',');
  const okcx = cg('💵 R$ 305 com cupom: GOTY\n\n✅ Link') === 'GOTY' && cg('💵 R$ 1.062,00 com cupom: doze600k\n') === 'doze600k' && cg('R$ 305\n-CUPOM: GOTY\n\nhttps://x.com') === 'GOTY'
    && cg('🔥 Cupom Mercado Livre\n\n🎟 R$ 150 OFF em R$ 1499: ACHADINHO\n\nanúncio') === 'ACHADINHO' && cg('R$ 819 com cupom: VALIDO no app') === '' && cg('Cupom: aplicado no carrinho') === '' && cg('Acabou o cupom rapaz') === '';
  if (!okcx) console.log('FALHOU: códigos curtos / minúsculos / linha 🎟 sem a palavra cupom');
  const okc = okcx && c1.codigos[0] === 'C0RR1D411D011' && c2.codigos[0] === 'MELIMAIS1411' && c2.notas.includes('exclusivo Meli+') && !c3.temPalavra && c4.temPalavra && !c4.codigos.length;
  // links: sempre o do PC (o do app só abre no celular)
  const L = (texto, links, url) => linkCompra({ m: { texto, links: links || [], url: url || '' } });
  const lk = [
    ['PC depois do APP (TecnoArt)', L('🔥 Ryzen 5 5600x R$ 745 🔗 Link APP: https://a.aliexpress.com/_AAA 🔗 Link PC: https://a.aliexpress.com/_BBB ⚡SE LIGA', ['https://a.aliexpress.com/_AAA', 'https://a.aliexpress.com/_BBB']) === 'https://a.aliexpress.com/_BBB'],
    ['PC antes do APP', L('Link PC: https://a.aliexpress.com/_PC\nLink APP: https://a.aliexpress.com/_APP') === 'https://a.aliexpress.com/_PC'],
    ['PC em linhas separadas', L('SSD 1TB R$ 599\n📱 Link APP: https://s.click.aliexpress.com/e/_app\n💻 Link PC: https://s.click.aliexpress.com/e/_pc\n') === 'https://s.click.aliexpress.com/e/_pc'],
    ['link único sem rótulo', L('Fonte R$ 229 Link do produto: https://www.amazon.com.br/dp/B0H635249V') === 'https://www.amazon.com.br/dp/B0H635249V'],
    ['só APP: usa o que tem', L('Oferta Link APP: https://a.aliexpress.com/_so') === 'https://a.aliexpress.com/_so'],
    ['ignora o bot do t.me', L('Link do produto: https://meli.la/abc 🔔 BOT: https://t.me/alertadaspromobot') === 'https://meli.la/abc'],
    ['sem rótulo vence o APP', L('Link APP: https://a.aliexpress.com/_app Comprar: https://www.kabum.com.br/produto/1') === 'https://www.kabum.com.br/produto/1'],
    ['link só no botão (sem texto)', L('Produto sem link no texto', ['https://meli.la/botao']) === 'https://meli.la/botao'],
    ['pontuação no fim do link', L('Link PC: https://a.aliexpress.com/_pc.') === 'https://a.aliexpress.com/_pc'],
  ];
  // Shopee/AliExpress: o link de CUPONS nunca pode ser o de compra; o cupom aparece com o jeito de usar
  const SH = 'Monitor LG UltraGear 32"\n\n💵 R$ 910\n\n🏷️ Resgate todos os cupons desta página:\nhttps://s.shopee.com.br/CUPONS\n\n✅ Link do produto:\nhttps://s.shopee.com.br/PRODUTO\n\n🔔 BOT: https://t.me/alertadaspromobot';
  const W3 = '🔥 Samsung Galaxy Watch8\n💵 R$ 1.655 no PIX\n🎟️ Resgate o cupom de R$ 100 OFF aqui:\nhttps://meli.la/CUP\n🔗 LINK: https://meli.la/PROD\nConheça nossos grupos';
  const W8 = '🔥 Zelda Switch 2\n💵 R$ 408,48 no pix\nResgate cupom 60 off\nhttps://meli.la/CUP8\n✨ Link do produto:\nhttps://meli.la/PROD8\n(anuncio)';
  lk.push(
    ['Shopee: compra = produto, não a página de cupons', L(SH) === 'https://s.shopee.com.br/PRODUTO'],
    ['Shopee: cupom aparece como link a resgatar', cupom(SH).link === 'https://s.shopee.com.br/CUPONS' && /resgate neste link\n+https:\/\/s\.shopee\.com\.br\/CUPONS/.test(linhaCupom(cupom(SH)))],
    ['cupom por link com valor (R$ 100 OFF)', L(W3) === 'https://meli.la/PROD' && cupom(W3).link === 'https://meli.la/CUP' && cupom(W3).valor === 'R$ 100 OFF'],
    ['"Resgate cupom 60 off" + link na linha de baixo', L(W8) === 'https://meli.la/PROD8' && cupom(W8).link === 'https://meli.la/CUP8'],
    ['cupom "no anúncio" avisa onde ativar', /ative na página do produto/.test(linhaCupom(cupom('Monitor R$ 2.899 no pix\nCupom de 15% off no anúncio\n✨ Link do produto:\nhttps://x.com/p')))],
    ['"Use cupom: no anuncio!" não inventa código', cupom('R$ 1109\nUse cupom: no anuncio!\nLink: https://x.com/p').codigos.length === 0 && cupom('R$ 1109\nUse cupom: no anuncio!').noAnuncio],
    ['código na linha de baixo', cupom('Fonte R$ 229\nUse o cupom:\nPROMO2026X\nLink: https://x.com/p').codigos[0] === 'PROMO2026X'],
    ['código no link não vira cupom', cupom('Placa R$ 500 cupom: ABCDE123 https://aoferta.net/AAAAAAAAAA').codigos.join() === 'ABCDE123'],
    ['Shopee Live: link do cupom = link de compra, não repete', (() => { const tx = '🔥 ( APENAS PELO APLICATIVO ) Placa-Mãe Msi B550m\n💵 R$ 528 REAIS (PIX)\n🎟️Resgate o cupom de 15% OFF na Live no APP aqui:\nhttps://s.shopee.com.br/LIVE\n\nADICIONE PELA SACOLA LARANJA AQUI 74° PRODUTO:\nhttps://s.shopee.com.br/LIVE'; const c = cupom(tx); const compra = L(tx); const l = linhaCupom(c, compra); return compra === 'https://s.shopee.com.br/LIVE' && /vale pelo link de compra/.test(l) && !/https:/.test(l); })()],
    ['sem cupom: nada a dizer', linhaCupom(cupom('SSD 1TB R$ 599 no PIX https://x.com/p')) === ''],
    ['código + link: mostra os dois', (() => { const l = linhaCupom(cupom('SSD R$ 599\nCupom: ABCDE12\nResgate o cupom aqui:\nhttps://x.com/c\nLink do produto:\nhttps://x.com/p')); return /ABCDE12/.test(l) && /Resgatar o cupom/.test(l) && /https:\/\/x\.com\/c/.test(l); })()],
  );
  // faixa de cor em relação ao teto: 🟢 pouco · 🟡 médio · 🔴 muito abaixo
  lk.push(
    ['faixa: 5% abaixo = 🟢', faixaTeto(950, 1000) === '🟢 5% abaixo do teto'],
    ['faixa: 15% abaixo = 🟡', faixaTeto(850, 1000) === '🟡 15% abaixo do teto'],
    ['faixa: 30% abaixo = 🔴', faixaTeto(700, 1000) === '🔴 30% abaixo do teto'],
    ['faixa: 10% já é 🟡 e 20% já é 🔴', faixaTeto(900, 1000).startsWith('🟡') && faixaTeto(800, 1000).startsWith('🔴')],
    ['faixa: na margem (acima do teto) = 🟢 no teto', faixaTeto(1030, 1000) === '🟢 no teto' && faixaTeto(1000, 1000) === '🟢 no teto'],
  );
  let okl = 0; lk.forEach(([n, c]) => { if (c) okl++; else console.log('FALHOU (link/cupom/faixa):', n); });
  // repetição: mesma promo repostada com centavos de diferença = 1 aviso; produto diferente ou queda grande = avisa
  const O = (peca, nome, preco) => ({ peca, nome, preco });
  const ja = [registro(O('SSD SATA 512GB', '3 Netac 512GB', 271))];
  const rep = [
    ['mesmo produto, preço -1%', unicos([O('SSD SATA 512GB', '3 Netac 512GB', 268)], ja).length === 0],
    ['mesmo produto, preço +1%', unicos([O('SSD SATA 512GB', '3 Netac 512GB', 273)], ja).length === 0],
    ['mesmo produto, queda de 15%', unicos([O('SSD SATA 512GB', '3 Netac 512GB', 230)], ja).length === 1],
    ['produto diferente, mesmo preço', unicos([O('SSD SATA 512GB', 'Kingston A400 480GB', 270)], ja).length === 1],
    ['outra peça, mesmo nome', unicos([O('SSD NVMe 512GB', '3 Netac 512GB', 271)], ja).length === 1],
    ['3 repostagens na mesma rodada viram 1', unicos([O('Ryzen 7 5700X', 'Ryzen 7 5700x Oem Sem Cooler', 884), O('Ryzen 7 5700X', 'Ryzen 7 5700x Oem', 888), O('Ryzen 7 5700X', 'Processador Ryzen 7 5700X OEM', 890)], []).length === 1],
    ['nomes diferentes na mesma rodada ficam', unicos([O('Placa-mãe B550 / B550M', 'MSI B550M Gaming Plus WiFi6E', 572), O('Placa-mãe B550 / B550M', 'Pichau Chronos B550M-CR', 574)], []).length === 2],
    ['mesma onda, mas 4% mais barata: avisa', unicos([{ ...O('SSD SATA 512GB', '3 Netac 512GB', 260), idade: 0.1 }], [registro(O('SSD SATA 512GB', '3 Netac 512GB', 271), h(0.3))]).length === 1],
    ['mesma onda, 1% mais barata (centavos): não avisa', unicos([{ ...O('SSD SATA 512GB', '3 Netac 512GB', 268.5), idade: 0.1 }], [registro(O('SSD SATA 512GB', '3 Netac 512GB', 271), h(0.3))]).length === 0],
    ['mesma onda, mais cara: não avisa', unicos([{ ...O('SSD SATA 512GB', '3 Netac 512GB', 275), idade: 0.1 }], [registro(O('SSD SATA 512GB', '3 Netac 512GB', 271), h(0.3))]).length === 0],
    // a promo que VOLTA (post novo, aviso antigo) é avisada de novo; o post antigo e as repostagens da mesma onda não
    ['voltou no dia seguinte (post novo, aviso de 26h atrás)', unicos([{ ...O('SSD SATA 512GB', '3 Netac 512GB', 266), idade: 0.1 }], [registro(O('SSD SATA 512GB', '3 Netac 512GB', 271), h(26))]).length === 1],
    ['repostagem 20 min depois do aviso (mesma onda)', unicos([{ ...O('SSD SATA 512GB', '3 Netac 512GB', 266), idade: 0.1 }], [registro(O('SSD SATA 512GB', '3 Netac 512GB', 271), h(0.3))]).length === 0],
    ['post antigo (anterior ao aviso) não volta', unicos([{ ...O('SSD SATA 512GB', '3 Netac 512GB', 266), idade: 5 }], [registro(O('SSD SATA 512GB', '3 Netac 512GB', 271), h(4))]).length === 0],
    ['post novo mas aviso há menos de 8h (mesma onda)', unicos([{ ...O('SSD SATA 512GB', '3 Netac 512GB', 266), idade: 0.1 }], [registro(O('SSD SATA 512GB', '3 Netac 512GB', 271), h(7))]).length === 0],
    ['post novo 9h depois do aviso: avisa', unicos([{ ...O('SSD SATA 512GB', '3 Netac 512GB', 266), idade: 0.1 }], [registro(O('SSD SATA 512GB', '3 Netac 512GB', 271), h(9))]).length === 1],
  ];
  let okr = 0; rep.forEach(([n, c]) => { if (c) okr++; else console.log('FALHOU (repetição):', n); });
  console.log(ok + '/' + T.length + ' casos de filtro ok · cupom ' + (okc ? 'ok' : 'FALHOU') + ' · repetição ' + okr + '/' + rep.length + ' · links ' + okl + '/' + lk.length);
  process.exit(ok === T.length && okc && okr === rep.length && okl === lk.length ? 0 : 1);
}

const f = path.join(D, 'msgs.json');
if (!fs.existsSync(f)) { console.error('sem data/msgs.json: rode python tg-ler.py antes'); process.exit(2); }
const { msgs } = JSON.parse(fs.readFileSync(f, 'utf8'));
const fe = process.env.ESTADO_FILE ? path.resolve(process.env.ESTADO_FILE) : path.join(D, 'enviados.json');
fs.mkdirSync(path.dirname(fe), { recursive: true });
let enviados = {};
if (fs.existsSync(fe)) {
  try { enviados = JSON.parse(fs.readFileSync(fe, 'utf8').replace(/^﻿/, '')); }
  catch (e) { console.error('ERRO: estado ilegível (' + e.message + '). Não envio nada nesta volta, para não repetir avisos.'); process.exit(1); }
}
const gravarAtomico = (arq, txt) => { const tmp = arq + '.tmp'; fs.writeFileSync(tmp, txt); fs.renameSync(tmp, arq); };
if (enviados._destino !== DESTINO) enviados = { _destino: DESTINO }; // destino novo: começa do zero
const agora = Date.now();
const chave = (o) => o.peca + '|' + o.preco; // mesma peça + mesmo preço = mesma oferta (grupos repostam)
const vistos = new Set();
const prodAvisados = (enviados._prod || []).filter((v) => agora - Date.parse(v.t) < 48 * 3600 * 1000); // produtos avisados nas últimas 48h
const candidatos = msgs.map((m) => avaliar(m, agora)).filter(Boolean)
  .sort((a, b) => a.idade - b.idade)
  .filter((o) => { const k = chave(o); if ((enviados[k] && bloqueia(enviados[k], o)) || vistos.has(k)) return false; vistos.add(k); return true; })
  .sort((a, b) => a.preco - b.preco);
const achados = unicos(candidatos, prodAvisados); // tira repostagens do mesmo produto com centavos de diferença
console.log(msgs.length + ' mensagens lidas, ' + achados.length + ' ofertas novas únicas (<= ' + cfg.maxIdadeHoras + 'h)');
const msgsWa = achados.length ? mensagens(achados) : [];
if (dry) { console.log(msgsWa.length ? '\n' + msgsWa.join('\n\n======== (próxima mensagem) ========\n\n') : '(nada novo)'); process.exit(0); }
// WhatsApp usa *negrito*; o Telegram (HTML) usa <b>. Links com "_" não são afetados (só linhas inteiras _..._ viram itálico).
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const paraHtml = (t) => esc(t).replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/^_(.+)_$/gm, '<i>$1</i>').replace(/`([^`\n]+)`/g, '<code>$1</code>');

async function enviarTelegram(textos) {
  const tok = (process.env.TG_BOT_TOKEN || '').trim(), chat = (process.env.TG_CHAT_ID || '').trim();
  if (!tok || !chat) throw new Error('faltam TG_BOT_TOKEN / TG_CHAT_ID');
  for (const t of textos) {
    const r = await fetch('https://api.telegram.org/bot' + tok + '/sendMessage', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: paraHtml(t), parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error('Telegram recusou: ' + (j.description || r.status));
    await new Promise((res) => setTimeout(res, 800));
  }
  console.log('ENVIADO ' + textos.length + ' mensagem(ns) pelo bot do Telegram');
}

(async () => {
  if (msgsWa.length) {
    if (CANAL === 'telegram') {
      await enviarTelegram(msgsWa);
      // fila para o WhatsApp: o PC (que tem a sessão do WhatsApp) busca e entrega; a nuvem nunca fala com o WhatsApp
      if (process.env.FILA_FILE) {
        const ff = path.resolve(process.env.FILA_FILE); fs.mkdirSync(path.dirname(ff), { recursive: true });
        let fila = []; try { fila = JSON.parse(fs.readFileSync(ff, 'utf8').replace(/^﻿/, '')); } catch {}
        fila.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: new Date().toISOString(), textos: msgsWa });
        fila = fila.filter((x) => Date.now() - Date.parse(x.ts) < 6 * 3600 * 1000).slice(-40);
        gravarAtomico(ff, JSON.stringify(fila));
      }
    } else {
      const arq = path.join(D, 'envio.json');
      fs.writeFileSync(arq, JSON.stringify(msgsWa));
      const r = spawnSync('node', ['wa-enviar.js', arq], { cwd: __dirname, encoding: 'utf8' });
      console.log(r.stdout.trim()); if (r.status !== 0) { console.error(r.stderr); process.exit(r.status || 1); }
    }
    const ts = new Date().toISOString();
    achados.forEach((o) => { enviados[chave(o)] = ts; }); // só marca como enviado depois do envio dar certo
    prodAvisados.push(...achados.map((o) => registro(o, ts)));
  }
  for (const k of Object.keys(enviados)) if (k !== '_destino' && agora - Date.parse(enviados[k]) > 7 * 86400000) delete enviados[k];
  enviados._prod = prodAvisados.slice(-200);
  gravarAtomico(fe, JSON.stringify(enviados, null, 2));
})().catch((e) => { console.error('ERRO', e.message || e); process.exit(1); });
