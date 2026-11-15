// Ciclo da nuvem: o GitHub só agenda de 5 em 5 min, então cada execução fica ~4m45s em loop e repete o
// trabalho a cada 60 s. Cada volta: comandos do bot -> ler canais públicos -> filtrar/avisar -> guardar estado.
const { spawnSync } = require('child_process');

const INI = Date.now();
const DURACAO = Number(process.env.CICLO_SEG || 285) * 1000;
const PASSO = 60 * 1000;
const dorme = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const rodar = (cmd, args) => { const r = spawnSync(cmd, args, { stdio: 'inherit', env: process.env }); if (r.status !== 0) console.error('[ciclo] falhou:', cmd, args.join(' '), '->', r.status); return r.status === 0; };
const git = (a) => spawnSync('git', a, { encoding: 'utf8' });

function guardarEstado() {
  git(['add', 'estado']);
  if (git(['diff', '--cached', '--quiet']).status === 0) return; // nada novo
  git(['-c', 'user.name=ofertas-bot', '-c', 'user.email=ofertas-bot@users.noreply.github.com', 'commit', '-q', '-m', 'estado: ofertas enviadas']);
  for (let t = 0; t < 3; t++) { // o bot de comandos também faz push: atualiza e tenta de novo se precisar
    git(['pull', '--rebase', '--autostash', '-q']);
    if (git(['push', '-q']).status === 0) return;
  }
  console.error('[ciclo] não consegui enviar o estado ao GitHub');
}

let volta = 0;
for (;;) {
  const t0 = Date.now(); volta++;
  console.log('[ciclo] volta', volta, new Date().toISOString());
  rodar('node', ['bot.js', '--uma-vez']);  // comandos pendentes (/teto, /add ...) aplicam antes de ler as promos
  if (rodar('node', ['web-ler.js'])) rodar('node', ['ofertas.js']);
  guardarEstado();
  const resto = PASSO - (Date.now() - t0);
  if (Date.now() + Math.max(resto, 0) - INI > DURACAO) break;
  dorme(Math.max(resto, 0));
}
console.log('[ciclo] fim após', volta, 'volta(s)');
