# ofertas-pc

Monitor de promoções de hardware. A cada minuto lê canais públicos de promoção do Telegram, filtra pelas peças e
tetos de `config.json` e avisa quando aparece uma oferta nova (sem repetir). Roda de graça no GitHub Actions.

- `config.json`: peças, tetos, janela de tempo e canais públicos lidos.
- Os comandos do bot (`/teto`, `/add`, `/lista`...) editam o `config.json` por aqui.
- Nenhum segredo fica neste repositório: tokens ficam nos *secrets* do GitHub.
