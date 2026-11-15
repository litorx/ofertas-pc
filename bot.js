// Bot de comandos do Telegram: muda tetos e produtos do config.json sem abrir arquivo nenhum.
// Roda no PC (long-polling), responde na hora e envia a mudança para o GitHub (a nuvem usa o mesmo config).
//   node bot.js            escuta o Telegram
//   node bot.js --teste    testa os comandos num config temporário (sem Telegram e sem git)
// Só obedece chats listados em telegram-bot.json > chats (o grupo e o seu privado). Qualquer outro é ignorado.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const AQUI = __dirname;
const TESTE = process.argv.includes('--teste');
const CFG = process.env.CFG_FILE ? path.resolve(process.env.CFG_FILE) : path.join(AQUI, 'config.json');
const D = path.join(AQUI, 'data');
const HIST = path.join(D, 'config-hist');
fs.mkdirSync(HIST, { recursive: true });

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const real = (n) => 'R$ ' + Number(n).toLocaleString('pt-BR', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2 });

function parseValor(s) {
  s = String(s || '').replace(/r\$|\s/gi, '');
  if (!s) return NaN;
  s = /^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(',', '.');
  const n = Number(s);
  return isFinite(n) && n > 0 ? n : NaN;
}
const ler = () => JSON.parse(fs.readFileSync(CFG, 'utf8'));
function salvar(c) {
  fs.copyFileSync(CFG, path.join(HIST, Date.now() + '.json')); // para o /desfazer
  const antigos = fs.readdirSync(HIST).sort(); antigos.slice(0, Math.max(0, antigos.length - 30)).forEach((f) => fs.unlinkSync(path.join(HIST, f)));
  const tmp = CFG + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(c, null, 2)); fs.renameSync(tmp, CFG); // gravação atômica
}

// ---- achar a peça por número da /lista ou por nome ----
function achar(c, ref) {
  ref = (ref || '').trim();
  if (!ref) return { erro: 'Diga qual peça (número da /lista ou parte do nome).' };
  if (/^\d{1,2}$/.test(ref)) { const i = Number(ref) - 1; return c.pecas[i] ? { p: c.pecas[i], i } : { erro: 'Não existe a peça nº ' + ref + '. Veja /lista.' }; }
  const toks = norm(ref).split(' ').filter(Boolean);
  const hit = c.pecas.map((p, i) => ({ p, i, t: norm(p.nome + ' ' + (p.rotulo || '')) })).filter((x) => toks.every((t) => x.t.includes(t)));
  const exato = hit.filter((x) => norm(x.p.nome) === norm(ref));
  if (exato.length === 1) return exato[0];
  if (hit.length === 1) return hit[0];
  if (!hit.length) return { erro: 'Não achei "' + esc(ref) + '". Veja /lista.' };
  return { erro: 'Mais de uma peça com "' + esc(ref) + '": ' + hit.map((x) => (x.i + 1) + ' ' + esc(x.p.nome)).join(' · ') + '. Use o número.' };
}
const splitUltimo = (a) => { const t = (a || '').replace(/r\$/gi, ' ').trim().split(/\s+/); return { ref: t.slice(0, -1).join(' '), val: t[t.length - 1] }; };

// ---- montar uma peça nova a partir do nome ----
function tokRx(t) {
  const um = (x) => { const m = /^(\d+)(gb|tb|mb|w|hz|mhz|ghz)$/i.exec(x); return m ? '\\b' + m[1] + '\\s*' + m[2] + '\\b' : '\\b' + rx(x) + '\\b'; };
  return t.includes('/') ? '(' + t.split('/').filter(Boolean).map(um).join('|') + ')' : um(t);
}
function novaPeca(nome, teto, termos) {
  const toks = (termos || nome).trim().split(/\s+/).filter(Boolean);
  return {
    nome, icone: '📦', rotulo: nome.toUpperCase(), teto, piso: Math.max(10, Math.round(teto * 0.25)),
    ancora: rx(toks[0]), tirar: [],
    incluir: [tokRx(toks[0])], exigir: toks.slice(1).map(tokRx),
    excluir: ['pc gamer', 'pc completo', 'computador', 'notebook', 'laptop', 'kit upgrade'],
  };
}

const AJUDA = [
  '🤖 <b>Comandos do bot de promoções</b>',
  '',
  '👀 <b>VER</b>',
  '/lista',
  'Mostra tudo que estou vigiando, com o número de cada peça.',
  '',
  '💰 <b>MUDAR O PREÇO MÁXIMO</b>',
  '<code>/teto 5700x 900</code>',
  'Ou pelo número da lista: <code>/teto 3 900</code>',
  '',
  '➕ <b>ADICIONAR OU TIRAR PRODUTO</b>',
  '<code>/add Mouse Logitech G203 | 150</code>',
  '(nome | preço máximo)',
  '<code>/remover 5 sim</code>',
  '<code>/pausar 5</code> — para de avisar, sem apagar',
  '<code>/ativar 5</code> — volta a avisar',
  '',
  '🚫 <b>IGNORAR UM TIPO DE PROMO</b>',
  '<code>/excluir 5 usado</code>',
  'Não avisa mais promo da peça 5 que tenha a palavra "usado".',
  '',
  '⚙️ <b>AJUSTES</b>',
  '<code>/janela 24</code> — só ofertas das últimas 24h (hoje: %JANELA%h)',
  '<code>/margem 8</code> — aceita até 8% acima do teto (hoje: %MARGEM%%)',
  '<code>/por 5</code> — até 5 ofertas por peça na mensagem',
  '',
  '🔧 <b>OUTROS</b>',
  '/agora — busca promoções agora',
  '/desfazer — volta a última mudança',
  '/canais — canais que a nuvem lê (<code>/canal_add nome</code> e <code>/canal_rem nome</code>)',
  '',
  '💡 Nas peças vale o <b>número da /lista</b> ou parte do nome (ex.: <code>5700x</code>).',
].join('\n');

// ---- os comandos: cada um devolve { texto, mudou } ----
const CMD = {
  start: (c) => ({ texto: AJUDA.replace('%JANELA%', c.maxIdadeHoras).replace('%MARGEM%', Math.round(c.margem * 100)) }),
  ajuda: (c) => CMD.start(c),
  lista: (c) => {
    const L = ['📋 <b>Peças monitoradas</b>'];
    c.pecas.forEach((p, i) => L.push((i + 1) + '. ' + p.icone + ' ' + esc(p.nome) + ' — <b>' + real(p.teto) + '</b>' + (p.ativa === false ? ' ⏸ pausada' : '')));
    L.push('', '⚙️ Janela: ' + c.maxIdadeHoras + 'h · Margem: ' + Math.round(c.margem * 100) + '% · Máx. ' + (c.porPeca || 3) + ' por peça');
    L.push('📡 Canais (nuvem): ' + (c.canaisPublicos || []).map(esc).join(', '));
    return { texto: L.join('\n') };
  },
  teto: (c, a) => {
    const { ref, val } = splitUltimo(a); const v = parseValor(val);
    if (!ref || isNaN(v)) return { texto: 'Use: <code>/teto peça valor</code> — ex.: <code>/teto 5700x 900</code>' };
    const r = achar(c, ref); if (r.erro) return { texto: r.erro };
    const antes = r.p.teto; r.p.teto = v;
    if (r.p.piso && v <= r.p.piso * 1.1) r.p.piso = Math.round(v * 0.4); // piso de plausibilidade nunca fica colado no teto
    return { texto: '✅ ' + r.p.icone + ' <b>' + esc(r.p.nome) + '</b>: ' + real(antes) + ' → <b>' + real(v) + '</b>', mudou: 'teto ' + r.p.nome + ' ' + v };
  },
  add: (c, a) => {
    let nome, valor, termos;
    if ((a || '').includes('|')) { const p = a.split('|').map((x) => x.trim()); nome = p[0]; valor = parseValor(p[1]); termos = p[2]; }
    else { const s = splitUltimo(a); nome = s.ref; valor = parseValor(s.val); }
    if (!nome || isNaN(valor)) return { texto: 'Use: <code>/add nome | teto</code> — ex.: <code>/add Mouse Logitech G203 | 150</code>' };
    if (c.pecas.some((p) => norm(p.nome) === norm(nome))) return { texto: 'Já existe "' + esc(nome) + '". Use /teto para mudar o valor.' };
    const p = novaPeca(nome, valor, termos); c.pecas.push(p);
    const q = (termos || nome).trim(); c.buscas = c.buscas || []; if (!c.buscas.includes(q)) c.buscas.push(q); // busca global do PC
    return { texto: '➕ <b>' + esc(nome) + '</b> adicionada (nº ' + c.pecas.length + ') com teto <b>' + real(valor) + '</b>.\nVai avisar promo que tenha: ' + esc((termos || nome)) + '.\nSe vier coisa errada, use <code>/excluir ' + c.pecas.length + ' termo</code>.', mudou: 'add ' + nome };
  },
  remover: (c, a) => {
    const m = /^(.*?)(?:\s+sim)?$/i.exec((a || '').trim()); const confirmou = /\ssim$/i.test((a || '').trim());
    const r = achar(c, m[1]); if (r.erro) return { texto: r.erro };
    if (!confirmou) return { texto: '⚠️ Apagar <b>' + esc(r.p.nome) + '</b>? Confirme com <code>/remover ' + (r.i + 1) + ' sim</code> (dá para voltar com /desfazer).' };
    c.pecas.splice(r.i, 1);
    return { texto: '🗑️ <b>' + esc(r.p.nome) + '</b> removida.', mudou: 'remover ' + r.p.nome };
  },
  pausar: (c, a) => { const r = achar(c, a); if (r.erro) return { texto: r.erro }; r.p.ativa = false; return { texto: '⏸ <b>' + esc(r.p.nome) + '</b> pausada.', mudou: 'pausar ' + r.p.nome }; },
  ativar: (c, a) => { const r = achar(c, a); if (r.erro) return { texto: r.erro }; delete r.p.ativa; return { texto: '▶️ <b>' + esc(r.p.nome) + '</b> ativa.', mudou: 'ativar ' + r.p.nome }; },
  excluir: (c, a) => {
    const t = (a || '').trim().split(/\s+/); const termo = t.slice(-1)[0]; const ref = t.slice(0, -1).join(' ');
    if (!ref || !termo) return { texto: 'Use: <code>/excluir peça termo</code> — ex.: <code>/excluir 1 usado</code>' };
    const r = achar(c, ref); if (r.erro) return { texto: r.erro };
    (r.p.excluir = r.p.excluir || []).push(rx(termo));
    return { texto: '🚫 <b>' + esc(r.p.nome) + '</b>: promo com "' + esc(termo) + '" será ignorada.', mudou: 'excluir ' + r.p.nome + ' ' + termo };
  },
  janela: (c, a) => { const v = parseInt(a, 10); if (!(v >= 1 && v <= 168)) return { texto: 'Use: <code>/janela horas</code> (1 a 168)' }; const antes = c.maxIdadeHoras; c.maxIdadeHoras = v; return { texto: '🕒 Janela: ' + antes + 'h → <b>' + v + 'h</b>', mudou: 'janela ' + v }; },
  margem: (c, a) => { const v = parseValor(String(a).replace('%', '')); if (isNaN(v) || v > 30) return { texto: 'Use: <code>/margem %</code> (0 a 30), ex.: <code>/margem 5</code>' }; const antes = Math.round(c.margem * 100); c.margem = v / 100; return { texto: '📐 Margem: ' + antes + '% → <b>' + v + '%</b>', mudou: 'margem ' + v }; },
  por: (c, a) => { const v = parseInt(a, 10); if (!(v >= 1 && v <= 10)) return { texto: 'Use: <code>/por n</code> (1 a 10)' }; c.porPeca = v; return { texto: '🔢 Agora mostro até <b>' + v + '</b> ofertas por peça.', mudou: 'por ' + v }; },
  canais: (c) => ({ texto: '📡 <b>Canais públicos lidos pela nuvem</b>\n' + (c.canaisPublicos || []).map((x) => '• ' + esc(x)).join('\n') }),
  canal_add: async (c, a) => {
    const n = (a || '').trim().replace(/^@|^https?:\/\/t\.me\/(s\/)?/i, '').replace(/\/.*$/, '');
    if (!/^[A-Za-z0-9_]{4,}$/.test(n)) return { texto: 'Use: <code>/canal_add nomedocanal</code> (o nome que aparece em t.me/<i>nome</i>)' };
    if ((c.canaisPublicos || []).some((x) => x.toLowerCase() === n.toLowerCase())) return { texto: 'Esse canal já está na lista.' };
    try { const r = await fetch('https://t.me/s/' + n, { headers: { 'user-agent': 'Mozilla/5.0' } }); const h = await r.text(); if (!r.ok || !/data-post=/.test(h)) return { texto: '⚠️ "' + esc(n) + '" não é um canal público com posts (a nuvem só lê canais públicos).' }; }
    catch { return { texto: '⚠️ Não consegui verificar o canal agora. Tente de novo.' }; }
    (c.canaisPublicos = c.canaisPublicos || []).push(n);
    return { texto: '📡 Canal <b>' + esc(n) + '</b> adicionado.', mudou: 'canal+ ' + n };
  },
  canal_rem: (c, a) => {
    const n = (a || '').trim().replace(/^@/, ''); const i = (c.canaisPublicos || []).findIndex((x) => x.toLowerCase() === n.toLowerCase());
    if (i < 0) return { texto: 'Esse canal não está na lista. Veja /canais.' };
    c.canaisPublicos.splice(i, 1); return { texto: '📡 Canal <b>' + esc(n) + '</b> removido.', mudou: 'canal- ' + n };
  },
};

// ---- sincroniza com o GitHub para a nuvem usar o mesmo config ----
function sincronizar(msg) {
  if (TESTE || process.env.CFG_FILE) return '';
  const g = (a) => spawnSync('git', a, { cwd: AQUI, encoding: 'utf8' });
  if (!fs.existsSync(path.join(AQUI, '.git'))) return '';
  g(['add', 'config.json']);
  const c = g(['-c', 'user.name=pc-ofertas-bot', '-c', 'user.email=pc-ofertas-bot@users.noreply.github.com', 'commit', '-m', 'config (bot): ' + msg]);
  if (c.status !== 0) return '';
  g(['pull', '--rebase', '--autostash']);
  const p = g(['push']);
  return p.status === 0 ? '\n✅ Salvo. Vale na próxima busca (até 1 minuto).' : '\n⚠️ Não consegui salvar agora. Tente de novo em instantes.';
}

let ultimoAgora = 0;
async function executar(texto, quem) {
  const m = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec((texto || '').trim());
  if (!m) return null;
  const cmd = m[1].toLowerCase(), args = (m[2] || '').trim();
  if (cmd === 'desfazer') {
    const h = fs.readdirSync(HIST).sort(); if (!h.length) return { texto: 'Nada para desfazer.' };
    const f = path.join(HIST, h[h.length - 1]); fs.copyFileSync(f, CFG); fs.unlinkSync(f);
    return { texto: '↩️ Última mudança desfeita.' + sincronizar('desfazer por ' + quem) };
  }
  if (cmd === 'agora') {
    if (TESTE) return { texto: '(teste)' };
    if (process.env.GITHUB_ACTIONS) return { texto: '🔎 A busca já roda sozinha a cada minuto. Se houver promo nova, o aviso chega em instantes.' };
    if (Date.now() - ultimoAgora < 120000) return { texto: 'Já rodei há pouco. Espere 2 minutos.' };
    ultimoAgora = Date.now();
    spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', path.join(AQUI, 'rodar.ps1')], { detached: true, stdio: 'ignore' }).unref();
    return { texto: '🔎 Rodando a busca agora. Se achar algo novo, o aviso chega no WhatsApp/Telegram em instantes.' };
  }
  if (!CMD[cmd]) return { texto: 'Não conheço /' + esc(cmd) + '. Veja /ajuda.' };
  const c = ler();
  const r = await CMD[cmd](c, args);
  if (r.mudou) { salvar(c); r.texto += sincronizar(r.mudou + ' por ' + quem); }
  return r;
}

// ---- teste sem Telegram ----
async function teste() {
  const tmp = path.join(AQUI, 'data', 'config-teste.json');
  fs.copyFileSync(path.join(AQUI, 'config.json'), tmp);
  const bot = spawnSync(process.execPath, [__filename, '--teste-interno'], { env: { ...process.env, CFG_FILE: tmp }, encoding: 'utf8' });
  process.stdout.write(bot.stdout); process.stderr.write(bot.stderr); fs.unlinkSync(tmp); process.exit(bot.status);
}
async function testeInterno() {
  let ok = 0, tot = 0; const cheque = (nome, cond) => { tot++; if (cond) ok++; else console.log('FALHOU:', nome); };
  const run = async (t) => (await executar(t, 'teste')).texto;
  let x = await run('/teto 5700x 900'); cheque('teto por nome', /→ <b>R\$ 900/.test(x) && ler().pecas.find((p) => p.nome === 'Ryzen 7 5700X').teto === 900);
  x = await run('/teto 1 3.100'); cheque('teto por número c/ ponto', ler().pecas[0].teto === 3100);
  x = await run('/teto 1 R$ 3250,50'); cheque('teto com R$ e vírgula', ler().pecas[0].teto === 3250.5);
  x = await run('/teto nvme 700'); cheque('ambíguo pede número', /Mais de uma/.test(x));
  x = await run('/teto xyz 10'); cheque('não achou', /Não achei/.test(x));
  x = await run('/teto 5700x abc'); cheque('valor inválido', /Use:/.test(x));
  x = await run('/teto@qualquerbot 5600x 650'); cheque('comando com @bot', ler().pecas.find((p) => p.nome === 'Ryzen 5 5600X').teto === 650);
  x = await run('/add Mouse Logitech G203 | 150'); const n = ler().pecas.find((p) => p.nome === 'Mouse Logitech G203');
  cheque('add cria peça', !!n && n.teto === 150);
  const casa = (p, t) => p.incluir.some((r) => new RegExp(r, 'i').test(t)) && p.exigir.every((r) => new RegExp(r, 'i').test(t)) && !p.excluir.some((r) => new RegExp(r, 'i').test(t));
  cheque('add casa promo certa', casa(n, 'Mouse Gamer Logitech G203 Lightsync R$ 129'));
  cheque('add não casa outro mouse', !casa(n, 'Mouse Logitech G502 R$ 129'));
  x = await run('/add SSD 2TB/4TB NVMe | 1500'); const m2 = ler().pecas.find((p) => p.nome === 'SSD 2TB/4TB NVMe');
  cheque('add com alternativa', !!m2 && casa(m2, 'SSD NVMe 4TB R$ 1400') && casa(m2, 'ssd nvme 2tb R$ 1400') && !casa(m2, 'SSD NVMe 1TB'));
  x = await run('/add Mouse Logitech G203 | 150'); cheque('add duplicada', /Já existe/.test(x));
  x = await run('/excluir ' + ler().pecas.length + ' usado'); cheque('excluir', ler().pecas.find((p) => p.nome === 'SSD 2TB/4TB NVMe').excluir.includes('usado'));
  x = await run('/pausar mouse'); cheque('pausar', ler().pecas.find((p) => p.nome === 'Mouse Logitech G203').ativa === false);
  x = await run('/lista'); cheque('lista mostra pausada', /pausada/.test(x));
  x = await run('/ativar mouse'); cheque('ativar', ler().pecas.find((p) => p.nome === 'Mouse Logitech G203').ativa === undefined);
  const antes = ler().pecas.length;
  x = await run('/remover mouse'); cheque('remover pede confirmação', /Confirme/.test(x) && ler().pecas.length === antes);
  x = await run('/remover mouse sim'); cheque('remover confirmado', ler().pecas.length === antes - 1);
  x = await run('/desfazer'); cheque('desfazer volta a peça', ler().pecas.length === antes);
  x = await run('/janela 24'); cheque('janela', ler().maxIdadeHoras === 24);
  x = await run('/janela 0'); cheque('janela inválida', ler().maxIdadeHoras === 24);
  x = await run('/margem 8'); cheque('margem', Math.abs(ler().margem - 0.08) < 1e-9);
  x = await run('/por 5'); cheque('por peça', ler().porPeca === 5);
  x = await run('/canal_rem tecnoarthardware'); cheque('canal_rem', !ler().canaisPublicos.includes('tecnoarthardware'));
  x = await run('/canais'); cheque('canais lista', /mmpromo/.test(x));
  x = await run('/ajuda'); cheque('ajuda', /Comandos/.test(x));
  x = await run('/xpto'); cheque('comando desconhecido', /Não conheço/.test(x));
  cheque('texto sem / ignorado', (await executar('oi pessoal', 't')) === null);
  console.log(ok + '/' + tot + ' testes do bot ok'); process.exit(ok === tot ? 0 : 1);
}

// ---- Telegram (long-polling) ----
async function main() {
  const cfgBot = JSON.parse(fs.readFileSync(path.join(AQUI, 'telegram-bot.json'), 'utf8').replace(/^﻿/, ''));
  const TOKEN = (cfgBot.bot_token || '').trim(); const PERMITIDOS = (cfgBot.chats || []).map(Number);
  if (!TOKEN || !PERMITIDOS.length) { console.error('telegram-bot.json precisa de bot_token e chats'); process.exit(2); }
  const api = async (metodo, body) => (await fetch('https://api.telegram.org/bot' + TOKEN + '/' + metodo, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  const arqOff = path.join(D, 'bot-offset.json');
  let off = fs.existsSync(arqOff) ? JSON.parse(fs.readFileSync(arqOff, 'utf8')).off : 0;
  await api('setMyCommands', { commands: [
    ['ajuda', 'Como usar (exemplos prontos)'], ['lista', 'Ver o que está sendo vigiado'], ['teto', 'Mudar o preço máximo de uma peça'],
    ['add', 'Adicionar um produto'], ['remover', 'Apagar um produto'], ['pausar', 'Parar de avisar uma peça'], ['ativar', 'Voltar a avisar uma peça'],
    ['excluir', 'Ignorar promos com uma palavra'], ['janela', 'Só ofertas das últimas X horas'], ['margem', 'Aceitar X% acima do teto'],
    ['por', 'Quantas ofertas por peça'], ['agora', 'Buscar promoções agora'], ['desfazer', 'Voltar a última mudança'],
    ['canais', 'Canais que a nuvem lê'], ['canal_add', 'Adicionar canal'], ['canal_rem', 'Remover canal'],
  ].map(([command, description]) => ({ command, description })) });
  console.log(new Date().toISOString(), 'bot no ar; chats permitidos:', PERMITIDOS.join(','));
  for (;;) {
    try {
      const j = await api('getUpdates', { offset: off, timeout: 50, allowed_updates: ['message'] });
      if (!j.ok) { console.error('getUpdates:', j.description); await new Promise((r) => setTimeout(r, 10000)); continue; }
      for (const u of j.result) {
        off = u.update_id + 1; fs.writeFileSync(arqOff, JSON.stringify({ off }));
        const msg = u.message; if (!msg || !msg.text || !msg.text.startsWith('/')) continue;
        if (!PERMITIDOS.includes(msg.chat.id)) { console.log('ignorado: chat', msg.chat.id); continue; } // só o grupo e o seu privado
        const quem = (msg.from && (msg.from.first_name || msg.from.username)) || 'alguém';
        let r; try { r = await executar(msg.text, quem); } catch (e) { console.error(e); r = { texto: '❌ Deu erro: ' + esc(e.message || e) }; }
        if (r) { console.log(new Date().toISOString(), quem + ':', msg.text.slice(0, 80)); await api('sendMessage', { chat_id: msg.chat.id, text: r.texto, parse_mode: 'HTML', disable_web_page_preview: true, reply_to_message_id: msg.message_id, allow_sending_without_reply: true }); }
      }
    } catch (e) { console.error('erro no loop:', e.message || e); await new Promise((r) => setTimeout(r, 8000)); }
  }
}

// ---- modo nuvem: processa os comandos pendentes UMA vez e sai (o ciclo da nuvem chama isso a cada minuto) ----
async function umaVez() {
  const TOKEN = (process.env.TG_BOT_TOKEN || '').trim();
  const PERMITIDOS = (process.env.TG_CHATS || '').split(',').map((s) => Number(s.trim())).filter(Boolean);
  if (!TOKEN || !PERMITIDOS.length) { console.error('bot: faltam TG_BOT_TOKEN/TG_CHATS (pulando)'); return; }
  const api = async (metodo, body) => (await fetch('https://api.telegram.org/bot' + TOKEN + '/' + metodo, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  const j = await api('getUpdates', { timeout: 0, allowed_updates: ['message'] });
  if (!j.ok) { console.error('bot getUpdates:', j.description); return; }
  if (!j.result.length) return;
  const ultimo = j.result[j.result.length - 1].update_id;
  await api('getUpdates', { offset: ultimo + 1, limit: 1, timeout: 0 }); // confirma antes de executar: nunca repete um comando
  for (const u of j.result) {
    const msg = u.message; if (!msg || !msg.text || !msg.text.startsWith('/')) continue;
    if (!PERMITIDOS.includes(msg.chat.id)) { console.log('bot: ignorado chat', msg.chat.id); continue; }
    const quem = (msg.from && (msg.from.first_name || msg.from.username)) || 'alguém';
    let r; try { r = await executar(msg.text, quem); } catch (e) { console.error(e); r = { texto: '❌ Deu erro: ' + esc(e.message || e) }; }
    if (r) { console.log('bot:', quem, msg.text.slice(0, 60)); await api('sendMessage', { chat_id: msg.chat.id, text: r.texto, parse_mode: 'HTML', disable_web_page_preview: true, reply_to_message_id: msg.message_id, allow_sending_without_reply: true }); }
  }
}

if (process.argv.includes('--teste-interno')) testeInterno();
else if (TESTE) teste();
else if (process.argv.includes('--uma-vez')) umaVez().catch((e) => { console.error('bot:', e.message || e); }).finally(() => process.exit(0));
else main();
