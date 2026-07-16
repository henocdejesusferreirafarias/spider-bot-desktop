# ADR 0006: Speed Time PP pelo delta UHT

## Contexto

Jogos PP usam PIXI para renderização, mas o loop proprietário `globalDoFrame` atualiza animações e lógica cliente por `Time.deltaTime`.

## Decisão

Reconhecer somente `/gs2c/html5Game.do` e multiplicar a propriedade configurável `Time.deltaTime` pela taxa dinâmica. Manter 1x enquanto `loaderIsVisible` não for exatamente `false` e não instalar relógios genéricos no PP.

## Consequências

- Animações UHT e lógica visual cliente aceleram.
- Loading, RAF, timers globais e rede permanecem no tempo normal.
- Componentes internos que usam deliberadamente `Time.deltaTime` também avançam pela taxa escolhida.
