# Padronização de transições PIX remanescentes

## Escopo

Aplicar o modelo já validado de transição a dois pontos do fluxo novo:

1. confirmação do cadastro inicial da senha de saque;
2. abertura do modal PIN após “Adicionar PIX”.

Não inclui remoção do legado nem altera preenchimento/registro da chave PIX.

## Modelo único

Cada transição segue a mesma sequência:

1. aguardar origem estrutural única e estável em duas leituras consecutivas,
   separadas por 180 ms, até 4 segundos;
2. executar uma única ação no alvo resolvido;
3. aguardar condicionalmente o destino por até 12 segundos;
4. aceitar sucesso somente pelo destino estrutural.

O retorno imediato de listener, dispatch ou locator nunca é a confirmação final.
Se uma tentativa disparar a transição e depois rejeitar, o destino ainda é
observado. Não há segundo clique, segundo dispatch ou novo listener.

## Confirmação da senha de saque

A origem exige dois PIN-grids visíveis, com seis células completas cada, e uma
única ação semântica habilitada de confirmação. A ação é resolvida dentro do
contexto vivo da página; os rótulos e seletores não capturam variáveis do
processo principal.

O destino válido é a superfície de saque pronta. Permanecer no setup, perder a
origem sem aparecer destino ou receber retorno ambíguo falha após a espera.

## Ação Adicionar PIX

A origem exige uma única ação semântica “adicionar PIX” resolvida pelo listener
Vue ou fallback DOM já existente. Antes da execução, a mesma candidata precisa
aparecer em duas leituras consecutivas, com o mesmo listener/fallback
identificado.

Depois da única tentativa, o modal PIN é a confirmação. Rejeição do handler
após iniciar a transição não encerra a execução; ausência do PIN ao fim da
espera falha, sem repetir a ação.

## Diagnósticos e isolamento

Diagnósticos contêm apenas contagens, índices, booleanos e classe de tentativa
(`actionRejected`). Não incluem PIN, CPF, valores de input, host, texto de
usuário ou chave PIX.

Cada janela mantém seu próprio estado de estabilização e espera. Nenhum timeout
ou resultado é compartilhado entre janelas.

## Verificação

- teste de origem que só estabiliza na segunda leitura;
- teste de tentativa rejeitada seguida de destino pronto;
- teste de destino ausente sem segunda ação;
- `npm test` e `npm run check`;
- validação manual simultânea em múltiplas plataformas.

