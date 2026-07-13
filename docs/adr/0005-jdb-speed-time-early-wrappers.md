# ADR 0005: Speed Time JDB com wrappers antecipados

## Contexto

A JDB abre o jogo em uma nova aba, normalmente em um documento interno com hosts dinâmicos. O runtime proprietário captura RAF e relógios durante o boot, por isso alterações feitas depois pelo Console não afetam a jogabilidade.

## Decisão

Reconhecer o documento JDB pela combinação dos parâmetros `gVer`, `gameType` e `mType`, independente do host e de ele ser iframe ou página principal. Instalar wrappers dinâmicos de RAF, timers, `performance.now`, `Date.now` e `new Date()` no início do documento, ainda em 1x, para que o runtime capture essas funções.

A velocidade configurada só é liberada após um `pointerdown` entregue ao canvas. Durante o loading, as camadas DOM ficam acima do canvas e o relógio permanece em 1x.

## Consequências

- A nova aba usa o tratamento de páginas já existente no contexto do navegador.
- Não há telemetria, flag temporária nem reescrita do bundle JDB.
- O primeiro teste manual deve confirmar se o runtime proprietário responde aos wrappers capturados no boot.
