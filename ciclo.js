// Ciclo da nuvem: cada execução fica ~4m45s em loop e repete o trabalho a cada 60 s.
// Cada volta: atualizar do GitHub -> comandos do bot -> ler canais públicos -> filtrar/avisar -> guardar estado.
//
// ATENÇÃO (causa de avisos repetidos já vista): o GitHub fixa o código/dados de uma execução no momento em que ela
// entra NA FILA, não quando começa. Como a próxima já nasce na fila durante a anterior, ela começa com o estado de
// minutos atrás e reenviaria o que a anterior acabou de avisar. Por isso toda volta começa trazendo o estado mais
// novo, e guardar o estado JUNTA (união) os dois lados em vez de depender de merge do Git (que corrompia o JSON).
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ARQ = ['estado/enviados-telegram.json', 'estado/fila-whatsapp.json'];
const IDENT = ['-c', 'user.name=ofertas-bot', '-c', 'user.email=ofertas-bot@users.noreply.github.com'];
const git = (a, dir) => spawnSync('git', a, { cwd: dir || process.cwd(), encoding: 'utf8' });
const lerJson = (txt) => { try { return JSON.parse(txt); } catch { return null; } };
const lerArq = (dir, f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return null; } };

// ---- união dos estados ----
function fundirEnviados(remoto, local) {
  const out = { ...remoto };
  for (const [k, v] of Object.entries(local)) { if (k === '_prod' || k === '_destino') continue; if (!out[k] || String(v) > String(out[k])) out[k] = v; }
  out._destino = local._destino || remoto._destino;
  const m = new Map();
  for (const p of [...(remoto._prod || []), ...(local._prod || [])]) m.set(p.pc + '|' + p.p + '|' + p.t, p);
  out._prod = [...m.values()].sort((a, b) => String(a.t).localeCompare(String(b.t))).slice(-200);
  return out;
}
function fundirFila(remoto, local) {
  const m = new Map(); for (const x of [...remoto, ...local]) m.set(x.id, x);
  const lim = Date.now() - 6 * 3600 * 1000;
  return [...m.values()].filter((x) => Date.parse(x.ts) > lim).sort((a, b) => a.ts.localeCompare(b.ts)).slice(-40);
}

// ---- trazer o estado mais novo (início de cada volta) ----
function atualizar(dir) {
  git(['fetch', '-q', 'origin', 'main'], dir);
  const adiante = Number((git(['rev-list', '--count', 'origin/main..HEAD'], dir).stdout || '0').trim());
  const sujo = (git(['status', '--porcelain', '--', ...ARQ], dir).stdout || '').trim();
  if (adiante === 0 && !sujo) git(['reset', '--hard', '-q', 'origin/main'], dir); // nada nosso pendente: pega tudo do remoto
}

// ---- guardar o estado: junta o nosso com o do remoto e envia (tenta de novo se alguém empurrou no meio) ----
function guardarEstado(dir) {
  for (let t = 0; t < 4; t++) {
    const local = ARQ.map((f) => lerArq(dir, f));
    git(['fetch', '-q', 'origin', 'main'], dir);
    const remoto = ARQ.map((f) => { const r = git(['show', 'origin/main:' + f], dir); return r.status === 0 ? r.stdout : null; });
    const fundido = ARQ.map((f, i) => {
      const L = lerJson(local[i] || ''), R = lerJson(remoto[i] || '');
      if (L == null) return remoto[i];                       // nada nosso: fica o remoto
      if (R == null) return JSON.stringify(L, null, 2);      // remoto vazio/ilegível: fica o nosso
      return JSON.stringify(f.includes('fila') ? fundirFila(R, L) : fundirEnviados(R, L), null, 2);
    });
    git(['reset', '--hard', '-q', 'origin/main'], dir);       // traz o resto (ex.: config do bot) e descarta o commit local
    ARQ.forEach((f, i) => { if (fundido[i] != null) fs.writeFileSync(path.join(dir, f), fundido[i]); });
    git(['add', ...ARQ], dir);
    if (git(['diff', '--cached', '--quiet'], dir).status === 0) return true; // nada novo
    git([...IDENT, 'commit', '-q', '-m', 'estado: ofertas enviadas'], dir);
    if (git(['push', '-q', 'origin', 'HEAD:main'], dir).status === 0) return true;
  }
  console.error('[ciclo] não consegui enviar o estado ao GitHub');
  return false;
}

// ---- teste: simula a execução "atrasada" que gerava avisos repetidos ----
function teste() {
  const os = require('os');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ciclo-teste-'));
  const sh = (a, d) => { const r = git(a, d); if (r.status !== 0) throw new Error('git ' + a.join(' ') + ': ' + r.stderr); return r.stdout; };
  sh(['init', '-q', '--bare', '-b', 'main', 'remoto.git'], base);
  const clonar = (n) => { sh(['clone', '-q', path.join(base, 'remoto.git'), n], base); return path.join(base, n); };
  const sem = clonar('semente'); fs.mkdirSync(path.join(sem, 'estado'));
  fs.writeFileSync(path.join(sem, ARQ[0]), JSON.stringify({ _destino: 'x', 'A|1': '2026-01-01T00:00:00Z', _prod: [] }));
  fs.writeFileSync(path.join(sem, ARQ[1]), '[]');
  sh(['add', '.'], sem); sh([...IDENT, 'commit', '-q', '-m', 'inicio'], sem); sh(['push', '-q', 'origin', 'HEAD:main'], sem);
  const A = clonar('a'), B = clonar('b'); // B nasce ANTES de A guardar: é a execução "da fila", com estado velho
  const agora = new Date().toISOString();
  // A avisa a oferta "Fonte|229" e guarda
  fs.writeFileSync(path.join(A, ARQ[0]), JSON.stringify({ _destino: 'x', 'A|1': '2026-01-01T00:00:00Z', 'Fonte|229': agora, _prod: [{ pc: 'Fonte', p: 229, tk: ['mach1'], t: agora }] }));
  fs.writeFileSync(path.join(A, ARQ[1]), JSON.stringify([{ id: 'a1', ts: agora, textos: ['fonte'] }]));
  const okA = guardarEstado(A);
  // B (velho) avisa OUTRA oferta e guarda: com merge do Git daria conflito no JSON
  fs.writeFileSync(path.join(B, ARQ[0]), JSON.stringify({ _destino: 'x', 'A|1': '2026-01-01T00:00:00Z', 'Placa|599': agora, _prod: [{ pc: 'Placa', p: 599, tk: ['asrock'], t: agora }] }));
  fs.writeFileSync(path.join(B, ARQ[1]), JSON.stringify([{ id: 'b1', ts: agora, textos: ['placa'] }]));
  const okB = guardarEstado(B);
  // um terceiro clone vê o resultado final
  const C = clonar('c');
  const env = lerJson(lerArq(C, ARQ[0])), fila = lerJson(lerArq(C, ARQ[1]));
  const bruto = lerArq(C, ARQ[0]) + lerArq(C, ARQ[1]);
  // atualizar(): clone velho (B antes) deve pegar o estado novo
  const D = clonar('d'); fs.writeFileSync(path.join(D, ARQ[0]), '{"x":1}'); sh(['checkout', '-q', '--', '.'], D); // limpo
  const casos = [
    ['guardar A ok', okA === true], ['guardar B (velho) ok, sem conflito', okB === true],
    ['mantém a oferta de A', !!env && !!env['Fonte|229']], ['junta a oferta de B', !!env && !!env['Placa|599']],
    ['_prod com as duas', !!env && env._prod.length === 2], ['fila com as duas', !!fila && fila.length === 2],
    ['sem marca de conflito no JSON', !/<<<<<<<|>>>>>>>|=======/.test(bruto)],
    ['atualizar() traz o estado novo', (() => { atualizar(D); return !!(lerJson(lerArq(D, ARQ[0])) || {})['Fonte|229']; })()],
  ];
  let ok = 0; casos.forEach(([n, c]) => { if (c) ok++; else console.log('FALHOU:', n); });
  console.log(ok + '/' + casos.length + ' testes do ciclo ok');
  try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
  process.exit(ok === casos.length ? 0 : 1);
}

if (process.argv.includes('--teste')) teste();
else {
  const INI = Date.now();
  const DURACAO = Number(process.env.CICLO_SEG || 285) * 1000;
  const PASSO = 60 * 1000;
  const dorme = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const rodar = (cmd, args) => { const r = spawnSync(cmd, args, { stdio: 'inherit', env: process.env }); if (r.status !== 0) console.error('[ciclo] falhou:', cmd, args.join(' '), '->', r.status); return r.status === 0; };
  let volta = 0;
  for (;;) {
    const t0 = Date.now(); volta++;
    console.log('[ciclo] volta', volta, new Date().toISOString());
    atualizar();                              // estado e config mais novos (a execução pode ter nascido na fila há minutos)
    rodar('node', ['bot.js', '--uma-vez']);   // comandos pendentes (/teto, /add ...) aplicam antes de ler as promos
    if (rodar('node', ['web-ler.js'])) rodar('node', ['ofertas.js']);
    guardarEstado();
    const resto = PASSO - (Date.now() - t0);
    if (Date.now() + Math.max(resto, 0) - INI > DURACAO) break;
    dorme(Math.max(resto, 0));
  }
  console.log('[ciclo] fim após', volta, 'volta(s)');
}
