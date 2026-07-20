# Issue 29: validacao manual da exclusao em lote

Data: 2026-07-19

## Dez perfis fechados

Foi criada uma instancia temporaria real de `PredatorDatabase`, com dez perfis e
500 arquivos de cache por perfil. Os IDs foram enviados ao mesmo
`deleteProfilesWithConcurrency` usado pelo IPC, com concorrencia 2 e remocao real
por `fs.promises.rm`.

Resultado observado:

```json
{"profiles":10,"files":5000,"deleted":10,"failed":0,"peakConcurrency":2,"eventLoopTicks":612,"elapsedMs":705,"remainingDirectories":0,"remainingRows":0}
```

O timer do event loop executou 612 vezes enquanto a remocao estava pendente. Na
implementacao anterior, o timer nao executava ate `rmSync` terminar.

## Perfis ativos e fechados misturados

Foi criada outra base temporaria com dez perfis e 100 arquivos por perfil. Tres
receberam handles ativos no `BrowserRuntimeService`, com o listener real de
`context.close`; os outros sete permaneceram fechados.

Resultado observado:

```json
{"total":10,"active":3,"inactive":7,"stopped":3,"deleted":10,"failed":0,"finalProgress":{"total":10,"completed":10,"deleted":10,"failed":0},"remainingDirectories":0,"remainingRows":0}
```

Somente os tres perfis ativos passaram por `stopProfile`. O lote chegou a 10/10,
apagou as dez pastas e removeu as dez linhas do SQLite.

## Encerramento escopado e feedback

- `browser-runtime-stop.test.ts` cobre pagina travada, contexto real de fechamento,
  kill forcado que nunca resolve e preservacao das notificacoes que persistem
  `idle` quando a remocao de arquivos falha.
- `browser-process-kill.test.ts` comprova que a selecao de processos casa somente
  com o `user-data-dir` alvo e nao inclui outro perfil nem o Chrome do usuario.
- `profile-deletion-renderer.test.ts` cobre `Excluindo X de Y`, resumo de falhas e
  manutencao dos IDs falhos para nova tentativa.
- Nenhum `taskkill /IM chrome.exe` foi introduzido; o fallback permanece
  `forceKillProfileBrowser(storagePath)`.

Os dois workspaces temporarios foram removidos depois das assercoes.
