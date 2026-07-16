# Abertura segura do prompt de senha para adicionar PIX

## Contexto

O fluxo de entrada PIX chega de forma confirmada à aba de conta para
recebimento: a rota viva está em `active=10`, a área de recebimento está
visível e há uma ação PIX de adicionar. A próxima fatia deve acionar essa ação
e parar antes de inserir qualquer dado.

## Objetivo

Abrir, uma única vez, o prompt de senha de saque que protege a inclusão de uma
chave PIX. Sucesso desta fatia é o prompt de senha visível, não o formulário
de cadastro PIX.

## Localização e acionamento

A rotina trabalha somente na superfície de recebimento já confirmada. Ela
normaliza o texto de controles visíveis e considera elegíveis os que associam
PIX a um verbo de adicionar, vincular ou cadastrar.

Para cada elemento elegível, ela procura o listener Vue vivo no próprio
elemento ou em ancestrais próximos e deduplica elementos aninhados pelo mesmo
listener. A maior pontuação semântica deve produzir exatamente uma ação. A
rotina invoca esse listener uma vez; se a skin não expuser o listener, envia um
único evento de clique ao único controle validado.

Não usa coordenadas, host, marca, URL fixa, clique genérico, Pinia direto ou o
fluxo legado `programmaticPixUiAction`.

## Idempotência e confirmação

Antes do acionamento, a rotina verifica se o prompt de senha de saque já está
visível. Nesse caso, ela não clica novamente e retorna que a senha é exigida.

Depois do clique, um polling condicional de `PIX_MS(12000)` aguarda o prompt.
O teto é doze segundos no padrão e 12–72 segundos quando
`SPIDERBOT_PIX_SLOWNESS` estiver entre 1 e 6.

A confirmação prioriza a estrutura: exatamente um PIN-grid visível dentro de
um dialog, popup, overlay ou modal. O texto normalizado
`inserir senha/pin` + `senha de saque` + `proximo` é somente fallback.
O modal de criação de senha possui dois PIN-grids e, portanto, não confirma
esta etapa.

## Falhas e isolamento

Ação ausente, ambígua, listener que lança ou prompt ausente no prazo falham
sem segundo clique e sem avançar. O diagnóstico registra somente o tipo de
falha e os candidatos, nunca a senha.

A etapa não preenche PIN, não abre o formulário PIX, não seleciona tipo de
chave e não submete dados. Cada janela conserva sua sessão, deadline e
resultado independentes sob o limite de concorrência atual.

## Resultado e verificação

Sucesso recebe o estado `withdrawal_password_required` e um log claro de
que o prompt foi confirmado.

- teste: nenhum ou mais de um listener elegível não dispara clique;
- teste: um listener único é acionado uma vez;
- teste: prompt já aberto não provoca novo clique;
- teste: waiter ignora transição parcial e encerra somente no prompt;
- teste manual: a automação para no modal de senha de saque após “PIX /
  Adicionar”, sem preencher um dígito;
- `npm test` e `npm run check` passam.

