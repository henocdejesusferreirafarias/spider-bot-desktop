# ADR 0004: Gate reversível de loading para o Speed Time PG

## Contexto

O Speed Time de PG acelera os relógios genéricos do navegador para o frame do jogo. Após a primeira tela jogável, um desbloqueio permanente fazia com que telas posteriores de carregamento, reconexão ou erro também fossem aceleradas. Isso podia antecipar timeouts internos e levar o jogo a acusar falha de conexão.

O experimento alternativo de `Director.tick` não era compatível com o runtime PG observado e foi removido, junto com sua flag e telemetria temporárias.

## Decisão

Manter um estado local de loading apenas para frames PG. O estado é recalculado pela presença do canvas e por mensagens conhecidas de carregamento/intersticial, com atualização por `MutationObserver` com debounce de 80 ms e uma verificação nativa a cada 300 ms.

Quando o estado muda para loading, `syncSpeed()` restaura os relógios nativos. Quando o canvas volta a estar disponível sem tela de loading, `syncSpeed()` reaplica a velocidade escolhida pelo usuário. Nenhuma consulta ao DOM é feita no caminho por frame de timer, RAF ou `Date`.

## Consequências

- Telas PG de loading e reconexão seguem o tempo normal, inclusive depois de o jogo já ter carregado uma vez.
- A velocidade configurada retorna automaticamente quando o jogo fica pronto.
- O custo é limitado a mutações relevantes do DOM e uma checagem leve de 300 ms por frame PG.
- A estratégia WG por `cc.Director.prototype.tick` permanece isolada e inalterada.

## Verificação

- Testes automatizados confirmam o cache de loading, o observador e a ausência do desbloqueio permanente e do experimento de `Director.tick` para PG.
- `npm run check` e `npm test` passam.
- A validação final requer abrir um jogo PG com 2x ou 4x, atravessar uma tela de loading/reconexão e confirmar que ela roda em 1x antes de o jogo voltar à velocidade escolhida.
