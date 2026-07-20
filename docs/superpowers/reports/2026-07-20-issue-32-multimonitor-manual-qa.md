# Issue 32: relatório de QA manual multimonitor

## Ambiente

- Branch: `feat/issue-32-multimonitor-layout`
- Commit da correção Win32: `bc39336`
- Windows: 11
- Versão do app: `1.1.18`
- Responsável pela QA manual: usuário

## Displays observados

| ID | Principal | Bounds | Work area | Escala | Grade | Habilitado |
| --- | --- | --- | --- | --- | --- | --- |
| A registrar pelo usuário | | | | | | |

## Gates automatizados

| Gate | Resultado | Evidência |
| --- | --- | --- |
| `npm test` | PASSOU | 438 testes aprovados em 30,9 s; 0 falhas, ignorados ou pendentes |
| `npm run check` | PASSOU | TypeScript dos processos Electron e renderer sem erros em 9,6 s |
| `npm run build` | PASSOU | Renderer Vite (60 módulos) e processo principal compilados em 19,1 s |
| `git diff --check` | PASSOU | Nenhum erro de whitespace |

## Cenários manuais

| Cenário | Evidência esperada | Resultado | Evidência real |
| --- | --- | --- | --- |
| Barra lateral | Somente conectados; checkbox, nome/principal, resolução/escala e setas | A EXECUTAR PELO USUÁRIO | |
| Seleção | Clicar no item troca o calibrador sem alterar habilitação | A EXECUTAR PELO USUÁRIO | |
| Grades independentes | Alterar linha/coluna afeta somente o monitor selecionado | A EXECUTAR PELO USUÁRIO | |
| Dois monitores `5x2` | Slots 0–9 no primeiro e 10–19 no segundo | REVALIDAR APÓS CORREÇÃO | Teste inicial encontrou o segundo monitor deslocado para a esquerda |
| 21ª janela | Sobrepõe o slot global 0 | A EXECUTAR PELO USUÁRIO | |
| Reordenação | Distribuição troca de monitor após `Aplicar Agora` | A EXECUTAR PELO USUÁRIO | |
| Última desmarcação | Configuração não muda e aviso aparece | A EXECUTAR PELO USUÁRIO | |
| Desconectar/reconectar | Item some e retorna com configuração e ordem preservadas | A EXECUTAR PELO USUÁRIO | |
| Preview fantasma | Molduras aparecem em todos os monitores habilitados | A EXECUTAR PELO USUÁRIO | |
| DPI e bounds | Geometria usa o display correto e readback difere no máximo dois pixels | A EXECUTAR PELO USUÁRIO | |
| Reinício/migração | V2 persiste sem perder modo, linha e coluna do formato v1 | A EXECUTAR PELO USUÁRIO | |

## Geometria observada

| Slot global | Display | Retângulo solicitado | Bounds retornados | Diferença | Resultado |
| --- | --- | --- | --- | --- | --- |
| A registrar pelo usuário | | | | | |

## Correção Win32 da origem do monitor

| Verificação | Resultado | Evidência |
| --- | --- | --- |
| Testes do helper e batching | PASSOU | 11 testes: segurança, parsing, lote de 20 perfis, serialização, retry, cancelamento e shutdown |
| Helper real no Windows | PASSOU | Compilou C# P/Invoke e retornou `window-not-ready` para perfil inexistente sem mover janelas |
| Typecheck e build | PASSOU | `npm run check` e `npm run build` concluídos sem erro |
| `5x2` no monitor direito com escala interna menor que 1 | PENDENTE (usuário) | |
| Monitor à esquerda/acima | PENDENTE (usuário) | |
| Chrome pessoal não é movido | PENDENTE (usuário) | |
| Nenhum PowerShell residual | PASSOU | Auditoria após a sonda não encontrou `powershell.exe -EncodedCommand` residual |

## Capturas

- Barra lateral: a registrar pelo usuário
- Preview fantasma: a registrar pelo usuário
- Distribuição 10+10: a registrar pelo usuário

## Observações

A QA manual foi explicitamente deixada para o usuário. Não preencher cenários
sem evidência real. Se o ambiente tiver somente um monitor, registrar os casos
multimonitor como `BLOQUEADO PELO AMBIENTE`, não como aprovados.

O teste manual com monitores de 1920×1080 e 2400×1080, ambos em 100%, revelou
que a grade do segundo monitor invadia o primeiro. A investigação mediu o
primeiro slot próximo de `x=1811`, contra alvo físico próximo de `x=1928`.
Electron entregava o retângulo físico correto; o deslocamento surgia porque o
Chromium com escala interna `0.94` traduzia a origem do segundo monitor e o
readback CDP confirmava o mesmo espaço interno incorreto.

A correção atual preserva CDP para tamanho e usa `SetWindowPos`/`GetWindowRect`
como autoridade final de `x/y`. O cenário continua pendente de reteste manual
real pelo usuário; nenhum resultado físico foi presumido neste relatório.
