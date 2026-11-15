// Lê os canais PÚBLICOS de promoção pela página web do Telegram (t.me/s/<canal>), SEM login e sem nenhuma
// chave da sua conta. Grava data/msgs.json no mesmo formato do tg-ler.py. Usado na nuvem.
const fs = require('fs');
const path = require('path');
const cfg = require('./config.json');

const horas = Number(process.env.MAXH || cfg.maxIdadeHoras);
const corte = Date.now() - horas * 3600 * 1000;
const D = path.join(__dirname, 'data');
fs.mkdirSync(D, { recursive: true });

const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|nbsp|#39);/g, (m) => ENT[m]).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
const paraTexto = (h) => decode(h.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div)>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/[ \t]+\n/g, '\n').trim();

function parse(html, canal) {
  const titulo = decode((/<meta property="og:title" content="([^"]*)"/.exec(html) || [])[1] || canal);
  const blocos = html.split('tgme_widget_message_wrap').slice(1);
  const out = [];
  for (const b of blocos) {
    const post = /data-post="([^"]+)"/.exec(b); if (!post) continue;
    const id = Number(post[1].split('/')[1]);
    const dt = /<time[^>]*datetime="([^"]+)"/.exec(b); if (!dt) continue;
    const t = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(b);
    const texto = t ? paraTexto(t[1]) : '';
    if (!texto) continue;
    const links = new Set();
    const re = /<a [^>]*href="(https?:\/\/[^"]+)"/g; let m;
    while ((m = re.exec(t ? t[1] : ''))) links.add(decode(m[1]));
    const bt = /tgme_widget_message_inline_button[^>]*href="(https?:\/\/[^"]+)"/g;
    while ((m = bt.exec(b))) links.add(decode(m[1]));
    out.push({ id, data: new Date(dt[1]).toISOString(), texto, canal: titulo, url: 'https://t.me/' + canal + '/' + id, links: [...links], busca: 'web:' + canal });
  }
  return out;
}

async function pagina(canal, antes) {
  const r = await fetch('https://t.me/s/' + canal + (antes ? '?before=' + antes : ''), { headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36', 'accept-language': 'pt-BR,pt;q=0.9' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return parse(await r.text(), canal);
}

(async () => {
  const todas = [];
  for (const canal of cfg.canaisPublicos) {
    try {
      let antes = null, n = 0;
      for (let p = 0; p < 4; p++) { // cada página traz ~20 posts; sobe até passar do corte
        const msgs = await pagina(canal, antes);
        if (!msgs.length) break;
        const novas = msgs.filter((m) => Date.parse(m.data) >= corte);
        todas.push(...novas); n += novas.length;
        const maisVelho = Math.min(...msgs.map((m) => m.id));
        if (novas.length < msgs.length || !isFinite(maisVelho)) break; // já chegou em posts mais velhos que o corte
        antes = maisVelho;
        await new Promise((r) => setTimeout(r, 400));
      }
      console.log('canal', canal, n);
    } catch (e) { console.error('falha em', canal, e.message); }
    await new Promise((r) => setTimeout(r, 400));
  }
  todas.sort((a, b) => b.data.localeCompare(a.data));
  fs.writeFileSync(path.join(D, 'msgs.json'), JSON.stringify({ lidoEm: new Date().toISOString(), msgs: todas }, null, 1));
  console.log('TOTAL ' + todas.length + ' mensagens (<= ' + horas + 'h)');
  if (!todas.length) { console.error('AVISO: nenhuma mensagem lida (pode ser bloqueio ou todos os canais fora do ar)'); }
})();
