# Issue 32: relatório de QA manual multimonitor

## Ambiente

- Branch: `feat/issue-32-multimonitor-layout`
- Commit testado: PENDENTE
- Windows: PENDENTE
- Versão do app: `1.1.18`
- Banco/instância de teste: PENDENTE

## Displays observados

| ID | Principal | Bounds | Work area | Escala | Grade | Habilitado |
| --- | --- | --- | --- | --- | --- | --- |
| PENDENTE | PENDENTE | PENDENTE | PENDENTE | PENDENTE | PENDENTE | PENDENTE |

## Gates automatizados

| Gate | Resultado | Evidência |
| --- | --- | --- |
| `npm test` | PENDENTE | |
| `npm run check` | PENDENTE | |
| `npm run build` | PENDENTE | |
| `git diff --check` | PENDENTE | |

## Cenários manuais

| Cenário | Evidência esperada | Resultado | Evidência real |
| --- | --- | --- | --- |
| Barra lateral | Somente conectados; checkbox, nome/principal, resolução/escala e setas | PENDENTE | |
| Seleção | Clicar no item troca o calibrador sem alterar habilitação | PENDENTE | |
| Grades independentes | Alterar linha/coluna afeta somente o monitor selecionado | PENDENTE | |
| Dois monitores `5x2` | Slots 0–9 no primeiro e 10–19 no segundo | PENDENTE | |
| 21ª janela | Sobrepõe o slot global 0 | PENDENTE | |
| Reordenação | Distribuição troca de monitor após `Aplicar Agora` | PENDENTE | |
| Última desmarcação | Configuração não muda e aviso aparece | PENDENTE | |
| Desconectar/reconectar | Item some e retorna com configuração e ordem preservadas | PENDENTE | |
| Preview fantasma | Molduras aparecem em todos os monitores habilitados | PENDENTE | |
| DPI e bounds | Geometria usa o display correto e readback difere no máximo dois pixels | PENDENTE | |
| Reinício/migração | V2 persiste sem perder modo, linha e coluna do formato v1 | PENDENTE | |

## Geometria observada

| Slot global | Display | Retângulo solicitado | Bounds retornados | Diferença | Resultado |
| --- | --- | --- | --- | --- | --- |
| PENDENTE | PENDENTE | PENDENTE | PENDENTE | PENDENTE | PENDENTE |

## Capturas

- Barra lateral: PENDENTE
- Preview fantasma: PENDENTE
- Distribuição 10+10: PENDENTE

## Observações

Não preencher cenários sem evidência real. Se o ambiente tiver somente um
monitor, registrar os casos multimonitor como `BLOQUEADO PELO AMBIENTE`, não
como aprovados.
