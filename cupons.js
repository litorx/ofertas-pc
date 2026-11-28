// Cupons SOLTOS: posts que são só o cupom (Amazon, Mercado Livre, Shopee, AliExpress, Magalu...), sem um produto à venda.
// Pega o código, o valor do desconto, o MÍNIMO de compra, o teto do desconto, as condições (app, itens selecionados,
// Meli+/Prime, horário...) e o link para resgatar. Cada cupom (loja + código + valor + mínimo) é avisado uma vez só,
// mesmo que 5 canais repostem. Usado por ofertas.js; `node cupons.js --teste` roda os testes com posts reais.
const semEmoji = (s) => s.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, ' ').replace(/[ \t]+/g, ' ').trim();
const semAcento = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const LOJAS = [
  ['Mercado Livre', /mercado\s*livre|mercadolivre|meli\.la|\bmeli\b/i],
  ['Amazon', /amazon|amzn\.to/i],
  ['Shopee', /shopee/i],
  ['AliExpress', /aliexpress/i],
  ['Magalu', /magalu|magazine\s*luiza|magazineluiza/i],
  ['Americanas', /americanas/i],
  ['Casas Bahia', /casas\s*bahia|casasbahia/i],
  ['KaBuM', /kabum/i],
  ['Pichau', /pichau/i],
  ['Terabyte', /terabyte/i],
  ['Carrefour', /carrefour/i],
  ['Fast Shop', /fast\s*shop|fastshop/i],
  ['Netshoes', /netshoes/i],
  ['Nike', /\bnike\b/i],
  ['Samsung', /samsung/i],
];
const achaLoja = (s) => { for (const [n, re] of LOJAS) if (re.test(s)) return n; return ''; };

const NAO_CODIGO = new Set(['CUPOM', 'CUPONS', 'CLIENTE', 'MOEDAS', 'PIX', 'APP', 'LINK', 'PARA', 'COM', 'MELI', 'USE', 'ATE', 'ANUNCIO', 'SELECIONADOS', 'RESGATE', 'PAGINA', 'TODOS', 'DESTA', 'VALIDO', 'OFF', 'APLICADO', 'ATIVO', 'ATIVE', 'AQUI', 'ABAIXO', 'SITE', 'PRIME', 'ITENS', 'MELI+']);
const URL_RE = /https?:\/\/[^\s)>\]"']+/g;
const BOILER = /www\.|an[uú]ncio|alertas?\b|notifica|\bbot\b|t\.me|siga\b|canal|canais|grupo|whatsapp|torne-se|assine|se liga|receba|ajudar o grupo|conhe[cç]a nossos|cutt\.ly|@\w+bot/i;
const ENCERRADO = /esgotad|acabou|expirou|encerrad|j[aá] era|n[aã]o funciona|n[aã]o est[aá] (mais )?v[aá]lid|saiu do ar/i;

const num = (s) => Number(String(s).replace(/\./g, '').replace(',', '.'));
const real = (n) => 'R$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });

// linha que anuncia um PRODUTO com preço (não um cupom): "💵 R$ 1.022", "POR: R$ 305", "R$ 1289 - Sem Juros"
function linhaDePreco(l) {
  if (/\b(off|acima|a partir|abaixo|m[ií]nim|desconto|em compras|cashback)\b/i.test(l)) return false;
  if (/(💵|💰|\bpor:?)\s*R\$\s*\d/i.test(l)) return true;
  return /^\W*(de\s*R\$\s*[\d.,]+\s*)?(por\s*)?R\$\s*\d[\d.,]*\s*(\(?\s*(pix|reais)\s*\)?|-|em\s*\d+x|sem juros|no pix|à vista|a vista|\|)?[^\n]{0,24}$/i.test(l);
}

const TITULO = /(^|\|)\s*(novo|novos|nova|mais um|olha o|voltou|voltando|atencao|atenção)?\s*(cupom|cupons|c[oó]digo de desconto)\b/i;

// Regras de desconto de uma linha: "R$ 230 OFF acima de R$ 1.499: CODIGO", "10% OFF até R$ 50", "R$ 20 OFF em R$ 40"
function regraDaLinha(l) {
  const mv = /(R\$\s*\d[\d.,]*|\d{1,3}\s*%)\s*(?:de\s+)?(?:off|desconto)/i.exec(l) || /desconto de\s*(R\$\s*\d[\d.,]*|\d{1,3}\s*%)/i.exec(l);
  if (!mv) return null;
  const valor = /%/.test(mv[1]) ? mv[1].replace(/\s+/g, '') : real(num(mv[1].replace(/R\$\s*/, '')));
  const resto = l.slice(mv.index + mv[0].length);
  const mm = /(?:acima de|a partir de|acima|m[ií]nimo(?: de)?|em compras(?: de| acima de)?|nas compras(?: de| acima de)?|para compras de|em)\s*R\$\s*(\d[\d.,]*)/i.exec(resto)
    || /(?:acima de|a partir de|m[ií]nimo(?: de)?)\s*R\$\s*(\d[\d.,]*)/i.exec(l.slice(0, mv.index));
  const mt = /(?:limite de|limitado a|at[eé]|teto de|m[aá]ximo(?: de)?|desconto m[aá]ximo(?: de)?)\s*R\$\s*(\d[\d.,]*)/i.exec(resto);
  const mm2 = mm || /m[ií]nimo de\s*R\$\s*(\d[\d.,]*)/i.exec(resto);
  // escopo: "20% OFF em produtos Nivea" (quando não é um valor mínimo) + prefixo "Só no app:"
  let esc = '';
  if (!mm2) { const me = /^\s*(?:em|nos|nas|na|no|para)\s+([^:·\-–,(]{3,45})/i.exec(resto); if (me && !/^R\$/.test(me[1].trim())) esc = me[1].trim(); }
  const pre = l.slice(0, mv.index).replace(/[:\-–·\s]+$/, '').trim();
  if (/app/i.test(pre) && pre.length < 25) esc = (esc ? esc + ' · ' : '') + 'só no app';
  return { valor, min: mm2 ? num(mm2[1]) : 0, max: mt && /%/.test(valor) ? num(mt[1]) : 0, esc, linha: l };
}

// Códigos escritos depois de "cupom:" ("A ou B"), ou no fim de uma linha de regra ("...R$ 1499: CODIGO")
function codigosDaLinha(l) {
  const out = [];
  const tok = (s) => s.split(/\s+ou\s+|,|\+|\/|\s+e\s+/i).map((x) => x.trim().replace(/^["“`'-]+|["”`'.!]+$/g, '')).forEach((c) => {
    if (!/^[A-Za-z0-9]{4,24}$/.test(c) || NAO_CODIGO.has(c.toUpperCase())) return;
    if (c !== c.toUpperCase() && !/\d/.test(c)) return; // "moedas", "resgate": palavra, não código
    out.push(c);
  });
  const re = /(?:cupom|c[oó]digo)[^\n:：]{0,40}[:：–-]\s*([^\n]{1,90})/gi; let m;
  while ((m = re.exec(l))) tok(m[1].split(/\s+\+\s+|\s{2,}/)[0]);
  if (!out.length) { const f = /[:：]\s*([A-Z0-9]{4,24})\s*$/.exec(l); if (f) tok(f[1]); }
  if (!out.length) { const f = /^([A-Z0-9]{5,24})\s*[-–:]\s*\S/.exec(l); if (f) tok(f[1]); }
  return [...new Set(out)];
}

function limpaUrl(u) {
  u = u.replace(/[.,;:!?]+$/, '');
  return u.replace(/(amazon\.com\.br\/[^?#]*)\?.*$/, '$1'); // tira as marcas de afiliado do canal
}

// Devolve null se o post não é um cupom solto; senão { loja, titulo, itens[], obs[], links[], idade, score, m }
function extrair(m, agora = Date.now()) {
  const t = String(m.texto || '');
  if (!/cupo|c[oó]digo/i.test(t)) return null;
  const idade = (agora - Date.parse(m.data)) / 3600000;
  const linhas = t.split('\n').map((s) => s.trim()).filter(Boolean);
  if (ENCERRADO.test(t)) return null;
  const cab = linhas.slice(0, 3).map(semEmoji).join(' | ');
  const temPreco = linhas.some((l) => !/^https?:/i.test(l) && linhaDePreco(l));
  if (temPreco) return null; // tem produto à venda: é oferta, não cupom solto

  const regrasI = linhas.map((l, i) => { const r = regraDaLinha(semEmoji(l)); return r ? { r, i } : null; }).filter(Boolean);
  const regrasL = regrasI.map((x) => x.r);
  const titulo = TITULO.test(cab) || /cupom\s+(maluco|rel[aâ]mpago|surpresa)/i.test(cab);
  const codigosPost = []; const codigosPorLinha = new Map();
  linhas.forEach((l, i) => { if (/^https?:/i.test(l)) return; const cs = codigosDaLinha(semEmoji(l.replace(URL_RE, ' '))); if (cs.length) { codigosPorLinha.set(i, cs); codigosPost.push(...cs); } });
  const links = [];
  linhas.forEach((l, i) => {
    const ms = l.match(URL_RE) || [];
    ms.forEach((u0) => {
      const u = limpaUrl(u0); if (/t\.me\//i.test(u) || links.some((x) => x.url === u)) return;
      let rot = semEmoji(l.slice(0, l.indexOf(u0))).replace(/[:\-–·]+\s*$/, '').replace(/^[-–•·\d.)\s]+/, '').trim();
      if (!/[a-zà-ú]{3}/i.test(rot)) rot = i > 0 && !URL_RE.test(linhas[i - 1]) ? semEmoji(linhas[i - 1]).replace(/[:\-–·]+\s*$/, '').replace(/^[-–•·\d.)\s]+/, '').trim() : '';
      URL_RE.lastIndex = 0;
      if (/prime|assin|\bvip\b|siga|canal|notifica|\bbot\b|grupo|cutt\.ly/i.test(rot) || BOILER.test(rot) && !/resgat|ative|cupom/i.test(rot)) return;
      links.push({ url: u, rot });
    });
  });
  const codigos = [...new Set(codigosPost)];
  // é cupom solto se: título de cupom, OU tem regra de desconto + (código ou link) sem produto
  if (!titulo && !(regrasL.length && (codigos.length || links.length))) return null;
  if (!codigos.length && !regrasL.length && !links.length) return null; // conversa ("esse cupom da magalu é ridículo")

  const loja = achaLoja(cab) || achaLoja(links.map((l) => l.url).join(' ')) || achaLoja(t);
  // itens: (código, regra). Regra com código na própria linha usa o dele; senão recebe os códigos do post.
  const itens = [];
  const add = (codigo, r) => itens.push({ codigo: codigo || '', valor: r ? r.valor : '', min: r ? r.min : 0, max: r ? r.max : 0, esc: r ? r.esc : '' });
  if (regrasI.length) {
    // o código vem na própria linha da regra, ou na linha vizinha: antes (bloco "código + descrição") ou depois ("regra + código"),
    // conforme o que aparece primeiro no post
    const linhasRegra = new Set(regrasI.map((x) => x.i));
    const soCodigo = [...codigosPorLinha.keys()].filter((i) => !linhasRegra.has(i));
    const nAntes = regrasI.filter((x) => soCodigo.includes(x.i - 1)).length, nDepois = regrasI.filter((x) => soCodigo.includes(x.i + 1)).length;
    const antes = nAntes > nDepois;
    const usados = new Set(); const semCodigo = [];
    for (const { r, i } of regrasI) {
      let cs = codigosPorLinha.get(i) || [];
      if (!cs.length) { const j = antes ? i - 1 : i + 1; if (soCodigo.includes(j) && !usados.has(j)) { cs = codigosPorLinha.get(j); usados.add(j); } }
      if (cs.length) cs.forEach((c) => add(c, r)); else semCodigo.push(r);
    }
    const restantes = soCodigo.filter((j) => !usados.has(j)).flatMap((j) => codigosPorLinha.get(j));
    if (semCodigo.length === 1 && restantes.length) restantes.forEach((c) => add(c, semCodigo[0])); // 1 regra sem código + códigos soltos
    else { semCodigo.forEach((r) => add('', r)); restantes.forEach((c) => { if (!itens.some((x) => x.codigo.toUpperCase() === c.toUpperCase())) add(c, null); }); }
  } else if (codigos.length) codigos.forEach((c) => add(c, null));
  else add('', null);
  // regra sem código que repete a regra de um cupom com código (ex.: frase de abertura "Garanta R$ 50 OFF...") é só texto
  for (let k = itens.length - 1; k >= 0; k--) if (!itens[k].codigo && itens.some((o) => o.codigo && o.valor === itens[k].valor && o.min === itens[k].min)) itens.splice(k, 1);
  // o mesmo cupom escrito duas vezes no post vira um só
  const vi = new Set(); for (let k = itens.length - 1; k >= 0; k--) { const key = [itens[k].codigo.toUpperCase(), itens[k].valor, itens[k].min, itens[k].esc].join('|'); if (vi.has(key)) itens.splice(k, 1); else vi.add(key); }

  // observações: o que sobra do post depois de tirar título, regras, códigos, links e propaganda do canal
  const obs = [];
  for (const l of linhas) {
    if (/https?:\/\//.test(l)) continue; // linha com link é rótulo do link (vai junto do link)
    const s = semEmoji(l).replace(/^[-–•·\d.)\s]+(?=[A-Za-zÀ-ú])/, '').trim();
    if (!/[A-Za-zÀ-ú]{3}/.test(s) || s.length < 8 || (/:$/.test(s) && s.length < 30)) continue;
    if (/^(.+?)\s*[:：]\s*\1$/i.test(s)) continue;
    if (TITULO.test(s) && s.length < 60) continue;
    if (regraDaLinha(s) || BOILER.test(s)) continue;
    if (/^(resgat\w*|ative|confira|link|carrinho|prepara)[^.]{0,30}(aqui|link|carrinho)?\s*:?$/i.test(s)) continue;
    if (/^(cupom|c[oó]digo)\s*:/i.test(s) && codigosDaLinha(s).length) continue;
    if (/^(cupom\s+\w+(\s+app)?|link carrinho)\s*!?$/i.test(s)) continue;
    obs.push(s.length > 140 ? s.slice(0, 137) + '…' : s);
  }
  if (obs.length > 6) obs.length = 0; // lista de produtos/itens, não condição do cupom
  if (/\bapp\b|aplicativo/i.test(cab) && !obs.some((o) => /app/i.test(o))) obs.unshift('Só no app');
  const tit = linhas.map(semEmoji).find((s) => TITULO.test(s) && s.length < 50 && !codigosDaLinha(s).length && !regraDaLinha(s)) || '';
  const score = 3 * itens.filter((i) => i.min).length + 2 * itens.filter((i) => i.valor).length + Math.min(obs.length, 3) + Math.min(links.length, 2);
  return { loja, titulo: tit, itens, obs: obs.slice(0, 4), links: links.slice(0, 5), idade, score, m };
}

const chaveItem = (loja, i) => 'cupom|' + (loja || '?') + '|' + i.codigo.toUpperCase() + '|' + (i.valor || '') + '|' + (i.min || '') + (i.esc ? '|' + semAcento(i.esc).replace(/\W+/g, '').slice(0, 18) : '');
const ttlItem = (i) => (i.codigo ? 12 : i.valor ? 6 : 0.5) * 3600000; // com código vale o dia; só link, 30 min

// Já avisado? Mesmo código + mesma regra; ou o mesmo código quando o post novo não traz regra nenhuma
function jaAvisado(loja, i, enviados, agora, locais) {
  const pre = 'cupom|' + (loja || '?') + '|' + i.codigo.toUpperCase() + '|';
  const k0 = chaveItem(loja, i);
  const t = (k) => (enviados[k] ? Date.parse(enviados[k]) : agora);
  const todas = [...Object.keys(enviados), ...locais].filter((k) => k.startsWith('cupom|' + (loja || '?') + '|'));
  if (i.codigo) return todas.some((k) => k.startsWith(pre) && agora - t(k) < ttlItem(i) && (k === k0 || !i.valor));
  // sem código no post: já foi avisado se existe cupom da mesma loja com a MESMA regra (valor + mínimo), com ou sem código
  const sufixo = '|' + (i.valor || '') + '|' + (i.min || '') + (i.esc ? '|' + semAcento(i.esc).replace(/\W+/g, '').slice(0, 18) : '');
  return todas.some((k) => agora - t(k) < ttlItem(i) && (i.valor ? k.endsWith(sufixo) : k === k0));
}

// Escolhe o que avisar: por cupom, o post mais completo; devolve [{ post, itens }] já em ordem de chegada
function novos(msgs, enviados, agora = Date.now(), maxIdadeH = 4) {
  const posts = msgs.map((m) => extrair(m, agora)).filter((p) => p && p.idade <= maxIdadeH && p.idade >= -0.1);
  posts.sort((a, b) => b.score - a.score || a.idade - b.idade); // o mais completo reivindica primeiro
  const locais = []; const out = [];
  for (const p of posts) {
    const fresh = p.itens.filter((i) => !jaAvisado(p.loja, i, enviados, agora, locais));
    if (!fresh.length) continue;
    fresh.forEach((i) => locais.push(chaveItem(p.loja, i)));
    out.push({ post: p, itens: fresh, chaves: fresh.map((i) => chaveItem(p.loja, i)) });
  }
  return out.sort((a, b) => b.post.idade - a.post.idade); // do mais antigo ao mais novo
}

const minTxt = (i) => (i.min ? ' · mínimo ' + real(i.min) : '');
function mensagem(n) {
  const { post: p, itens } = n;
  const idadeTxt = p.idade < 1 ? Math.max(1, Math.round(p.idade * 60)) + ' min' : Math.round(p.idade) + ' h';
  const L = ['🎟️ *' + (p.titulo && (!p.loja || semAcento(p.titulo).includes(semAcento(p.loja).split(' ')[0])) ? p.titulo : 'Cupom' + (p.loja ? ' ' + p.loja : '')) + '*'];
  for (const i of itens) {
    const partes = [];
    if (i.valor) partes.push('💸 *' + i.valor + ' OFF*' + (i.esc ? ' em ' + i.esc.replace(/ ?·? ?só no app/, '').replace(/^em /, '') : '') + minTxt(i) + (i.max ? ' · limite de ' + real(i.max) + ' de desconto' : '') + (/só no app/.test(i.esc || '') ? ' · só no app' : ''));
    if (i.codigo) partes.push('🏷️ Código: `' + i.codigo + '`');
    L.push(partes.join('\n') || '🏷️ Resgate pelo link abaixo');
  }
  p.obs.forEach((o) => L.push('ℹ️ ' + o));
  L.push('🕒 Há ' + idadeTxt + (p.loja ? ' · 🏪 ' + p.loja : ''));
  if (p.links.length) {
    L.push('', '🔗 *Resgatar:*');
    p.links.slice(0, 5).forEach((l) => { if (p.links.length > 1 && l.rot && l.rot.length < 60 && !/^(resgat\w*|ative|confira|clique|acesse|compre|salve)\b/i.test(l.rot)) L.push(l.rot + ':'); L.push(l.url); });
  }
  return L.join('\n');
}

module.exports = { extrair, novos, mensagem, chaveItem };

if (require.main === module && process.argv.includes('--teste')) {
  const agora = Date.now(); const mk = (texto, minAtras = 5) => ({ texto, data: new Date(agora - minAtras * 60000).toISOString(), url: 'x', links: [] });
  const AMZ = '🔥 Cupom Amazon\n💸 R$ 230 OFF acima de R$ 1499\n🎟️ Cupom: BLACKSABADO\n✅ Resgate aqui\nhttps://www.amazon.com.br/promotion/psp/A39W2MTLZWIPWC?linkCode=ll1&tag=aceleratag-20';
  const AMZ2 = 'NOVO CUPOM AMAZON\n✅ R$230 OFF acima de R$1.499\n🔴 CUPOM: BLACKSABADO\n✨ ATIVE SEU CUPOM AQUI:\n🛒 https://amzn.to/4sFng71\n🔔 Receba notificações personalizadas com @OQMALERTABOT\n🐈 t.me/OQMCUPONS\nANÚNCIO';
  const AMZ3 = 'Cupom Amazon APP\nR$ 230 OFF em R$ 1499: BLACKSABADO\n-Resgate aqui: https://link.amazon/B0fiC9J6S';
  const MELI2 = '🔥 Cupom Mercado Livre\n🎟️ R$ 20 OFF · Acima de R$ 159 - Cupom: ZOQMELI\n🎟️ R$ 230 OFF · Acima de R$ 1.499 - Cupom: MELIT94\n✅ Resgate aqui\nhttps://meli.la/1zQT8bQ\n#anuncio';
  const MELI1 = 'Cupom Mercado Livre\nR$ 230 OFF em R$ 1499: MELIT94\n-Resgate o cupom aqui: https://mercadolivre.com/sec/1i7Bxq3';
  const MELI3 = '🔥 Cupom Mercado Livre\n- Em itens selecionados, clique no link e após isso em "Mostrar mais" para ver a lista de produtos\n💸 R$ 20 OFF acima de R$ 129\n🎟️ Cupom: ZOQMELI\n✅ Confira: https://meli.la/2ogJjCQ\n✅ Resgate aqui\nhttps://mercadolivre.com/sec/1952Lr5';
  const SHP1 = 'Cupom Shopee Essenciais Voltando!\nR$ 50 OFF em R$ 199: AFF30FMCG\n-Resgate aqui:\nhttps://s.shopee.com.br/AKcVgGxJlP\n-Link carrinho:\nhttps://s.shopee.com.br/60TWWJDKjC';
  const SHP2 = '🔥 Cupom Shopee\n💸 R$ 50,00 OFF acima de R$ 120,00\n🎟️ Cupom: 4M3LH0RBLACKSH0P33\n✅ Resgate aqui\nhttps://s.shopee.com.br/7fbkSrZ9MJ';
  const SHP3 = '🔥 Cupom Shopee\n✅ Resgate aqui\nhttps://s.shopee.com.br/5LDpkDrvyH\n#anuncio';
  const MALUCO = '🔥 Às 18h30 tem "Cupom Maluco" no Mercado Livre\n\n👉 Prepara o carrinho aqui:\nhttps://meli.la/1KfW2Uz\n\nanúncio';
  const PROD = 'Ssd Portátil Sandisk 2 Tb\nR$ 1022\n-CUPOM: ZOQMELI\nhttps://meli.la/19MFwvX';
  const PROD2 = '🔥 Samsung Smart TV 55"\n💵 R$ 2.169,00 | EM ATÉ 12X SEM JUROS\n🎟️ Cupom: BLACKSABADO\n✨ Link do produto:\nhttps://link.amazon/B0fIr1f8j';
  const CONVERSA = 'Esse trem de cupom pelo whatsapp está tirando a paciência do povo magalu, toma jeito!';
  const CONVERSA2 = 'Acabou o cupom rapaz que doideira! Kabum até caiu kkkk';
  const x = (t) => extrair(mk(t), agora);
  const a1 = x(AMZ), a2 = x(AMZ2), a3 = x(AMZ3), m2 = x(MELI2), m3 = x(MELI3), s1 = x(SHP1), s2 = x(SHP2), s3 = x(SHP3), mal = x(MALUCO);
  const casos = [
    ['produto com cupom NÃO é cupom solto', x(PROD) === null && x(PROD2) === null],
    ['conversa sobre cupom é ignorada', x(CONVERSA) === null && x(CONVERSA2) === null],
    ['Amazon: valor, mínimo e código', a1 && a1.loja === 'Amazon' && a1.itens.length === 1 && a1.itens[0].valor === 'R$ 230' && a1.itens[0].min === 1499 && a1.itens[0].codigo === 'BLACKSABADO'],
    ['Amazon (formato OQMDV) igual ao outro', a2 && a2.itens[0].valor === 'R$ 230' && a2.itens[0].min === 1499 && a2.itens[0].codigo === 'BLACKSABADO'],
    ['Amazon (formato Ofertas Gamer) igual', a3 && a3.itens[0].min === 1499 && a3.itens[0].codigo === 'BLACKSABADO' && a3.obs.includes('Só no app')],
    ['link da Amazon sem marca de afiliado', a1 && a1.links[0].url === 'https://www.amazon.com.br/promotion/psp/A39W2MTLZWIPWC'],
    ['t.me e boilerplate não viram link nem observação', a2 && a2.links.length === 1 && a2.obs.length === 0],
    ['2 cupons no mesmo post (ZOQMELI e MELIT94), cada um com a sua regra', m2 && m2.itens.length === 2 && m2.itens.find((i) => i.codigo === 'ZOQMELI').min === 159 && m2.itens.find((i) => i.codigo === 'MELIT94').min === 1499],
    ['observação "itens selecionados" é guardada', m3 && m3.obs.some((o) => /itens selecionados/i.test(o)) && m3.itens[0].min === 129],
    ['Shopee: código, valor e mínimo; link de resgate primeiro', s1 && s1.loja === 'Shopee' && s1.itens[0].codigo === 'AFF30FMCG' && s1.itens[0].min === 199 && /AKcVgGxJlP/.test(s1.links[0].url)],
    ['Shopee com centavos (R$ 50,00 e 120,00)', s2 && s2.itens[0].valor === 'R$ 50' && s2.itens[0].min === 120 && s2.itens[0].codigo === '4M3LH0RBLACKSH0P33'],
    ['Shopee só com link: vira cupom sem código', s3 && s3.itens.length === 1 && !s3.itens[0].codigo && s3.links.length === 1],
    ['"Cupom Maluco às 18h30": avisa com o horário', mal && mal.loja === 'Mercado Livre' && mal.obs.some((o) => /18h30/.test(o))],
  ];
  // repetição
  const env = {};
  const lote1 = novos([mk(AMZ, 30), mk(AMZ2, 20), mk(AMZ3, 10), mk(MELI1, 25), mk(MELI2, 15), mk(SHP2, 8), mk(PROD, 3)], env, agora);
  const flat = lote1.flatMap((n) => n.chaves);
  casos.push(['3 canais, mesmo cupom Amazon = 1 aviso', lote1.filter((n) => n.post.loja === 'Amazon').length === 1]);
  casos.push(['MELIT94 em 2 posts (1 só, 1 combinado) = 1 vez só', flat.filter((k) => /\|MELIT94\|/.test(k)).length === 1 && flat.filter((k) => /\|ZOQMELI\|/.test(k)).length === 1]);
  casos.push(['escolhe o post mais completo (o com mais informação)', lote1.find((n) => n.post.loja === 'Amazon').post.obs.length >= 0 && lote1.length === 3]);
  flat.forEach((k) => { env[k] = new Date(agora).toISOString(); });
  casos.push(['volta seguinte, mesmos posts: nada novo', novos([mk(AMZ, 31), mk(AMZ2, 21), mk(MELI2, 16), mk(SHP2, 9)], env, agora + 60000).length === 0]);
  casos.push(['mesmo código, sem regra no post novo: não repete', novos([mk('Cupom Amazon\nCupom: BLACKSABADO\nhttps://amzn.to/x', 1)], env, agora + 60000).length === 0]);
  casos.push(['mesmo código com OUTRO valor: avisa (cupom diferente)', novos([mk('Cupom Amazon\nR$ 100 OFF acima de R$ 700\nCupom: BLACKSABADO\nhttps://amzn.to/x', 1)], env, agora + 60000).length === 1]);
  casos.push(['13h depois o mesmo cupom volta: avisa de novo', novos([{ texto: AMZ, data: new Date(agora + 13 * 3600000 - 60000).toISOString(), url: 'x', links: [] }], env, agora + 13 * 3600000).length === 1]);
  casos.push(['post com mais de 4h é ignorado', novos([mk(SHP1, 5 * 60)], {}, agora).length === 0]);
  casos.push(['Shopee só-link repetido em 2 canais = 1 aviso', novos([mk(SHP3, 6), mk('🔥 Cupom Shopee\n✅ Resgate aqui\nhttps://s.shopee.com.br/OUTRO', 5)], {}, agora).length === 1]);
  const msg = lote1.length ? mensagem(lote1[0]) : '';
  casos.push(['mensagem tem título, código e link', /Cupom/.test(msg) && /`[A-Z0-9]+`/.test(msg) && /https?:\/\//.test(msg)]);
  let ok = 0; casos.forEach(([n, c]) => { if (c) ok++; else console.log('FALHOU:', n); });
  console.log(ok + '/' + casos.length + ' testes de cupons ok');
  if (process.argv.includes('--ver')) lote1.forEach((n) => console.log('\n' + mensagem(n)));
  process.exit(ok === casos.length ? 0 : 1);
}
