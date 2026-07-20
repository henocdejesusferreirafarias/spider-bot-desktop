# ADR 0009: Exclusao em lote nao bloqueante de perfis

## Status

Aceito.

## Contexto

A exclusao de varias contas era implementada no renderer como uma sequencia de
chamadas individuais. Cada chamada apagava recursivamente a pasta Chromium com
`rmSync` no processo principal e publicava um snapshot completo. Dez perfis
fechados podiam manter a interface sem responder enquanto milhares de arquivos
eram removidos.

Perfis abertos tinham outro risco: `page.close()` acontecia antes do timeout de
`context.close()`. Uma pagina que nunca respondesse impedia o proprio timeout de
comecar.

## Causa raiz

- remocao recursiva sincrona no event loop principal do Electron;
- uma chamada IPC e um snapshot completo por perfil;
- timeout restrito ao contexto, sem cobrir o fechamento das paginas;
- ausencia de progresso e interrupcao do lote na primeira rejeicao.

## Decisao

O renderer envia todos os IDs em `profiles:delete-many`. O main usa dois workers,
preserva a ordem dos resultados e transforma falhas em resultados individuais.
Assim uma falha nao cancela os perfis restantes e computadores fracos nao recebem
uma rajada ilimitada de operacoes de disco.

`PredatorDatabase.deleteProfile` aguarda `fs.promises.rm` antes de remover a linha
do SQLite. Se a pasta falhar, o perfil continua visivel e pode ser tentado outra
vez. O lote publica progresso leve e somente um snapshot completo ao terminar.

O fechamento de navegador tem um teto unico que cobre paginas e contexto. Em
timeout ou rejeicao, o fallback continua sendo
`forceKillProfileBrowser(storagePath)`, escopado ao perfil conforme o ADR 0001.

## Consequencias

- a interface continua processando eventos durante a remocao das pastas;
- o usuario ve `Excluindo X de Y` e um resumo de falhas;
- perfis falhos permanecem selecionados para nova tentativa;
- a exclusao individual reutiliza o mesmo coordenador;
- o lote nao e persistido e nao sobrevive a um encerramento do aplicativo.

## Verificacao

```powershell
npx tsx --test test/profile-deletion.test.ts test/database.test.ts test/browser-runtime-stop.test.ts test/profile-deletion-renderer.test.ts
npm run check
npm test
git diff --check
```

A verificacao manual usa dez perfis fechados com milhares de arquivos e confirma
concorrencia maxima de dois, event loop responsivo, diretorios e linhas removidos.
O caso de pagina travada confirma que apenas o `storagePath` alvo e enviado ao
encerramento forcado.
