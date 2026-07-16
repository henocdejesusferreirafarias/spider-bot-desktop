# WG Speed Time via Cocos Director

## Contexto

O controle Speed Time já possui um registry de provedores, mas o perfil WG dependia de hosts de entrega que mudam entre sessões. O launcher observado mantém o caminho `/clientv3/index.html`; o jogo analisado usa Cocos 3.8.3. O teste manual comprovou que multiplicar o argumento de `cc.Director.tick(delta)` acelera a animação; `Scheduler.setTimeScale()` não a acelera.

## Decisão

Adicionar a estratégia `cocos-director-tick` ao registry de timing e atribuí-la ao perfil WG. O caminho `/clientv3/index.html` seleciona um candidato e o runtime confirma `cc.Director.prototype.tick` antes de aplicar o patch.

O script de controles do mundo principal deve instalar, de forma idempotente e antes da inicialização do jogo, um wrapper em `cc.Director.prototype.tick`. O wrapper lê a taxa atual de `data-rtc-speed` a cada frame e multiplica apenas um delta numérico finito. Em 1x, encaminha o delta sem alteração.

## Escopo

- Reconhecer launchers WG com host dinâmico pelo caminho estável e confirmação do Cocos Director.
- Aplicar a estratégia WG sem alterar as estratégias PG e PP.
- Cobrir o registry e a seleção de estratégia com testes automatizados.
- Registrar a verificação manual e as salvaguardas em ADR.

## Fora de escopo

- Alterar a estratégia PG/Cocos existente.
- Aplicar a estratégia a frames sem o caminho `/clientv3/index.html` ou sem Cocos Director.
- Implementar speed específico de PP.

## Verificação

1. Testes unitários confirmam o reconhecimento do frame WG e a estratégia correspondente.
2. `npm run check` e `npm test` passam.
3. Em jogo WG, testar 1x, 2x, 4x e 8x; o comportamento deve voltar imediatamente ao normal em 1x e não afetar páginas que não são frames de jogo.
