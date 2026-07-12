# ADR 0003: Speed Time WG pelo Director do Cocos

## Contexto

O perfil WG do Speed Time usava um padrão provisório e não reconhecia hosts de entrega que mudam entre sessões. Foram observados `https://pwmercjm.wgnetworking.com/clientv3/index.html` e `https://6imyktbb.wgkonnect.com/clientv3/index.html`. O jogo analisado expõe Cocos 3.8.3, `cc.Director` e um canvas.

O patch histórico de PG depende de `_timeScale` em um bundle Cocos. No WG, o bundle usa `timeScale` sem sublinhado. O experimento com `cc.director.getScheduler().setTimeScale(2)` não acelerou a animação. Já um wrapper temporário que multiplicou o argumento de `cc.Director.tick(delta)` acelerou o jogo corretamente.

## Decisão

O caminho `/clientv3/index.html` seleciona um candidato WG e a presença de `cc.Director.prototype.tick` confirma Cocos 3 antes de aplicar a estratégia `cocos-director-tick`. Portanto, a decisão não depende do host de entrega.

O script de controles do mundo principal aguarda o `cc.Director.prototype.tick` e o substitui uma única vez. O wrapper lê `data-rtc-speed` em cada frame, multiplica apenas deltas numéricos finitos e chama o método original. Em 1x, o delta não muda. O marcador no wrapper evita empilhamento em reinjeções.

## Consequências

- O patch não altera PG nem PP e não aplica os timers genéricos ao candidato WG, evitando escalar o delta duas vezes.
- O loop do jogo WG é acelerado sem reescrever bundles de terceiros.
- Launchers WG em hosts ou caminhos diferentes permanecem fora de escopo até haver uma URL observada e testes correspondentes.

## Verificação

- O launcher WG real foi testado manualmente em 1x, 2x, 4x e 8x com a mesma estratégia de `Director.tick`.
- Testes automatizados verificam reconhecimento WG, isolamento de URL não-WG e a serialização do padrão para injeção.
- `npm run check` e `npm test` passam após a implementação.
