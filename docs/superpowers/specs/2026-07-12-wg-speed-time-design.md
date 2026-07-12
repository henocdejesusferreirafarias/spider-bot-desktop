# WG Speed Time via Cocos Director

## Contexto

O controle Speed Time já possui um registry de provedores, mas o perfil WG não reconhece o launcher real observado em produção: `*.wgnetworking.com/clientv3/index.html`. O jogo analisado usa Cocos 3.8.3. O teste manual comprovou que multiplicar o argumento de `cc.Director.tick(delta)` acelera a animação; `Scheduler.setTimeScale()` não a acelera.

## Decisão

Adicionar a estratégia `cocos-director-tick` ao registry de timing e atribuí-la ao perfil WG. O frame WG será reconhecido pelo host `wgnetworking.com` e caminho `/clientv3/index.html`.

O script de controles do mundo principal deve instalar, de forma idempotente e antes da inicialização do jogo, um wrapper em `cc.Director.prototype.tick`. O wrapper lê a taxa atual de `data-rtc-speed` a cada frame e multiplica apenas um delta numérico finito. Em 1x, encaminha o delta sem alteração.

## Escopo

- Reconhecer launchers WG em qualquer subdomínio de `wgnetworking.com`.
- Aplicar a estratégia WG sem alterar as estratégias PG e PP.
- Cobrir o registry e a seleção de estratégia com testes automatizados.
- Registrar a verificação manual e as salvaguardas em ADR.

## Fora de escopo

- Alterar a estratégia PG/Cocos existente.
- Declarar suporte para hosts WG fora de `wgnetworking.com` sem evidência de URL.
- Implementar speed específico de PP.

## Verificação

1. Testes unitários confirmam o reconhecimento do frame WG e a estratégia correspondente.
2. `npm run check` e `npm test` passam.
3. Em jogo WG, testar 1x, 2x, 4x e 8x; o comportamento deve voltar imediatamente ao normal em 1x e não afetar páginas que não são frames de jogo.
