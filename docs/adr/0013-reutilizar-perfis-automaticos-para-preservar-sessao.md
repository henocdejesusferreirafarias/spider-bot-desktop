# ADR 0013: Reutilizar perfis automaticos para preservar sessao

## Status

Aceito.

## Contexto

A fabrica e o atalho de abertura rapida criavam um perfil Chromium novo a cada
execucao. Fechar uma janela e abrir novamente o mesmo endereco, portanto, usava
outro `storagePath` e perdia cookies e `localStorage`, inclusive o login do
SpiderDash.

Ao abrir duas telas depois de autenticar uma, ate a tela equivalente ao perfil
anterior pedia e-mail e senha outra vez. A pasta persistente ja funcionava; ela
apenas nunca era escolhida de novo pelos fluxos automaticos.

## Causa raiz

- a fabrica chamava `profiles.create` para todo item de todo lote;
- o atalho de abertura rapida tambem sempre criava um perfil;
- nao havia busca por perfil automatico parado e compativel;
- cada perfil novo recebe propositalmente um `storagePath` isolado.

## Decisao

Antes de criar um perfil, os dois fluxos procuram o perfil automatico parado
mais recentemente usado que tenha o mesmo endereco, proxy e modo de navegacao.
A fabrica reserva cada candidato uma unica vez no lote, portanto duas telas
simultaneas continuam em perfis diferentes.

O perfil reutilizado mantem o proprio `storagePath`, cookies e `localStorage`.
Perfis ativos, arquivados, manuais, com outro proxy, outro endereco ou outro
modo de navegacao nao sao reutilizados. Quando nao existe candidato compativel,
um perfil novo e criado normalmente.

A automacao de cadastro existente acompanha o perfil reutilizado e recebe os
parametros atuais do lote. Isso evita duplicar automacoes e mantem a decisao de
isolamento por perfil.

## Consequencias

- fechar e reabrir a mesma tela automatica preserva o login;
- lotes seguintes reaproveitam os perfis ja autenticados antes de criar novos;
- uma tela realmente nova continua isolada e pede login na primeira vez;
- proxy e modo de navegacao nunca mudam silenciosamente por causa da reutilizacao;
- a separacao de cookies entre perfis simultaneos permanece intacta.

## Verificacao

```powershell
npx tsx --test test/profile-reuse.test.ts
npm run check
npm test
git diff --check
```

O teste manual fecha um perfil automatico autenticado no SpiderDash e abre o
mesmo endereco com o mesmo proxy e modo. O ID e o `storagePath` permanecem e a
sessao abre autenticada. Ao pedir uma tela adicional, o perfil reutilizado nao
e selecionado duas vezes; um segundo perfil isolado e provisionado.
