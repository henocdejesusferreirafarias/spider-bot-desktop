# Speed Time PP com delta do engine UHT

## Objetivo

Adicionar suporte de Speed Time aos jogos Pragmatic Play sem acelerar carregamento, relógios globais ou comunicação de rede.

## Detecção

O documento real do jogo é reconhecido pelo pathname estável `/gs2c/html5Game.do`, independente do host e dos parâmetros sensíveis da query. O wrapper `/gs2c/playGame.do` não recebe o patch.

## Estratégia

Adicionar `uht-delta-time` ao registro de estratégias. No documento PP, o runtime aguarda `globalThis.Time` expor uma propriedade configurável `deltaTime`. O patch preserva o delta bruto escrito pelo loop `globalDoFrame` e expõe `deltaTime * speedRate` para os consumidores do engine.

A taxa é lida dinamicamente do controle existente. O fator efetivo permanece em 1x enquanto `globalThis.loaderIsVisible !== false`, e volta a 1x se o loader reaparecer. A instalação é idempotente por documento.

## Isolamento

- Não alterar `Date`, `performance.now`, RAF, timeout ou interval no PP.
- Não reescrever `build.js` nem depender do hash ou caminho de um jogo específico.
- Não acelerar o wrapper, o lobby ou documentos auxiliares.
- Respostas, saldo e resultado continuam controlados pelo servidor.

## Verificação

- Testar que hosts dinâmicos com `/gs2c/html5Game.do` resolvem para PP e que `/gs2c/playGame.do` não resolve.
- Testar que o script serializado seleciona o delta UHT, respeita `loaderIsVisible` e não instala os relógios genéricos no PP.
- Executar a suíte completa e o typecheck.
- Validar manualmente animações ociosas em dois jogos PP, sem realizar apostas.

## Limitações

Componentes internos que deliberadamente usam `Time.deltaTime`, como autoplay ou atualizações auxiliares do UHT, também avançam pela taxa configurada depois do loading. Relógios e requisições externas não são acelerados.
