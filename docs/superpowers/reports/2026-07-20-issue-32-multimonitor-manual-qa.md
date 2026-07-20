# Issue 32: relatório de QA manual multimonitor

## Ambiente

- Branch: `feat/issue-32-multimonitor-layout`
- Commit de implementação: `b1ab4c1`
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
| `npm test` | PASSOU | 421 testes aprovados; 0 falhas, ignorados ou pendentes |
| `npm run check` | PASSOU | TypeScript dos processos Electron e renderer sem erros |
| `npm run build` | PASSOU | Renderer Vite (60 módulos) e processo principal compilados |
| `git diff --check` | PASSOU | Nenhum erro de whitespace |

## Cenários manuais

| Cenário | Evidência esperada | Resultado | Evidência real |
| --- | --- | --- | --- |
| Barra lateral | Somente conectados; checkbox, nome/principal, resolução/escala e setas | A EXECUTAR PELO USUÁRIO | |
| Seleção | Clicar no item troca o calibrador sem alterar habilitação | A EXECUTAR PELO USUÁRIO | |
| Grades independentes | Alterar linha/coluna afeta somente o monitor selecionado | A EXECUTAR PELO USUÁRIO | |
| Dois monitores `5x2` | Slots 0–9 no primeiro e 10–19 no segundo | A EXECUTAR PELO USUÁRIO | |
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

## Capturas

- Barra lateral: a registrar pelo usuário
- Preview fantasma: a registrar pelo usuário
- Distribuição 10+10: a registrar pelo usuário

## Observações

A QA manual foi explicitamente deixada para o usuário. Não preencher cenários
sem evidência real. Se o ambiente tiver somente um monitor, registrar os casos
multimonitor como `BLOQUEADO PELO AMBIENTE`, não como aprovados.
