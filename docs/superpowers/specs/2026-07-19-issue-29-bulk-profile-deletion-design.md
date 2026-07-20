# Issue 29: exclusão em lote de perfis sem travar a interface

## Contexto e causa raiz

A interface atualmente chama a exclusão individual em sequência. Cada chamada fecha o navegador, remove a linha do SQLite, apaga a pasta do perfil com `rmSync` e publica um snapshot completo. Mesmo com todos os navegadores fechados, a remoção recursiva síncrona bloqueia o processo principal do Electron enquanto percorre milhares de arquivos. Para perfis abertos existe um segundo risco: `page.close()` ocorre antes do timeout de `context.close()` e pode esperar indefinidamente.

## Alternativas consideradas

1. Manter a exclusão individual e apenas mostrar um indicador. É simples, mas não elimina o bloqueio real nem os snapshots repetidos.
2. Disparar todas as exclusões com `Promise.all`. Reduz o tempo total, porém pode saturar disco, antivírus e memória em computadores fracos.
3. Criar uma operação em lote com concorrência limitada. Elimina o trabalho repetido, preserva a responsividade e limita a pressão sobre o equipamento. Esta é a opção escolhida.

## Desenho aprovado

- O renderer envia todos os IDs selecionados por um único IPC `profiles:delete-many`.
- O processo principal executa no máximo duas exclusões simultâneas.
- Cada perfil passa pela mesma operação reutilizável: validar existência, encerrar seu navegador com tempo total limitado, remover sua pasta de forma assíncrona e apagar seus dados do SQLite.
- O timeout cobre também `page.close()`. Se for atingido, a recuperação continua restrita ao `user-data-dir` daquele perfil por `forceKillProfileBrowser`; nunca será usado um encerramento global do Chrome.
- Uma falha gera um resultado individual e não interrompe os outros perfis.
- O processo principal emite progresso leve com total, concluídos, removidos e falhos. Um único snapshot completo e uma única notificação de instâncias são publicados ao final.
- O renderer mostra `Excluindo X de Y` durante a operação e um resumo quando houver falhas. Sucessos são removidos da seleção; falhas permanecem selecionadas para nova tentativa.
- A exclusão individual permanece compatível e reutiliza a mesma operação por perfil.

## Consistência e erros

A pasta é removida antes do registro no SQLite. Se a remoção física falhar, o perfil continua visível e pode ser tentado novamente; não será criado um registro removido com arquivos órfãos. Um perfil já ausente será tratado como falha explícita, sem afetar os demais.

## Verificação

- Teste de regressão comprovando que a remoção de arquivos não bloqueia o loop de eventos.
- Teste de concorrência comprovando o limite de duas exclusões.
- Teste de falha parcial comprovando que os demais perfis continuam e que o resultado preserva os IDs falhos.
- Teste de timeout cobrindo uma página cujo `close()` nunca resolve e a recuperação escopada ao perfil.
- Teste de contrato do renderer para progresso e seleção residual.
- Verificação manual com dez perfis fechados contendo arquivos, depois com perfis ativos e inativos misturados, confirmando interface responsiva, progresso, remoção dos diretórios e preservação do Chrome do usuário.

## Fora de escopo

Não haverá fila persistente de exclusão, lixeira recuperável nem alteração do diretório legado de sessões nesta issue.
