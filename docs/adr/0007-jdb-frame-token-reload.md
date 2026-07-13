# ADR 0007: Frames JDB tokenizados não aceitam recuperação por reload

## Contexto

O jogo JDB é aberto com parâmetros de sessão no documento interno. Em falhas de
carga, o servidor pode responder `403` antes que qualquer script do Speed Time
seja executado. O watchdog genérico recarregava esse frame até duas vezes, mas o
reload reutilizava a URL tokenizada e agravava a falha em vez de recuperar a
sessão.

## Decisão

Declarar no perfil de timing se o provedor aceita reload automático do frame.
JDB define `supportsAutomaticFrameReload: false`; os demais perfis preservam a
recuperação existente por padrão. A decisão usa o perfil reconhecido pela
assinatura estável `gVer` + `gameType` + `mType`, sem depender do host.

Uma sessão JDB que recebeu `403` deve ser fechada e reaberta pelo lobby para que
o provedor emita uma URL nova. O runtime não tenta contornar CORS nem respostas
de autorização do servidor.

## Consequências

- O bot não invalida sessões JDB com reloads automáticos.
- Falhas iniciais do servidor continuam visíveis e não são mascaradas.
- Provedores com URLs reutilizáveis mantêm a recuperação automática atual.

## Verificação

- Testes automatizados confirmam que o perfil JDB desabilita reload e que o
  monitor não inicia quando essa capacidade é falsa.
- Uma nova sessão JDB foi validada manualmente sem a tela preta recorrente.
- `npm test` e `npm run check` passam.
