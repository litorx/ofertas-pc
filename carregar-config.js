// Carrega config.json (público: peças, tetos, canais) e junta privado.json (só no PC: destino do WhatsApp,
// ids de chats a ignorar). Na nuvem privado.json não existe e tudo funciona só com o config público.
const fs = require('fs');
const path = require('path');
const ler = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
module.exports = (arquivo) => {
  const cfg = ler(arquivo ? path.resolve(arquivo) : path.join(__dirname, 'config.json'));
  const priv = path.join(__dirname, 'privado.json');
  if (fs.existsSync(priv)) Object.assign(cfg, ler(priv));
  return cfg;
};
