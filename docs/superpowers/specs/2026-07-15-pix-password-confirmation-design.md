# Confirmação do PIN de saque e abertura do formulário PIX

## Contexto

Após o PIN de saque existente ser preenchido, a plataforma mantém um modal
`ui-popup ui-dialog` com um único PIN-grid completo e um botão primário
habilitado, “Próximo”. Um clique bem-sucedido abre o formulário de adicionar
PIX na mesma rota de saque (`active=10`).

## Objetivo

Clicar exatamente uma vez na confirmação do PIN e validar, por transição
estrutural, que o formulário de adicionar PIX foi aberto. Esta etapa não
preenche, seleciona, confirma ou envia uma chave PIX.

## Ação de origem

O contexto do modal é resolvido dinamicamente pelo resolvedor já existente.
A ação é permitida somente quando esse contexto contém:

1. um único `.ui-password-input` visível com seis células preenchidas;
2. o modal raiz `.ui-popup.ui-dialog` que contém esse grid;
3. exatamente um botão primário `.ui-button` visível e habilitado nesse modal;
4. rótulo semântico normalizado `próximo`, `proximo`, `confirmar`, `next` ou
   `continue`, usado como reforço e não como seletor global.

O clique usa locator do navegador limitado ao modal, portanto não usa
coordenadas, viewport, zoom, host ou ordem global de elementos. Ele é tentado
uma única vez. Falha de ação não produz repetição.

## Destino confirmado

Depois do clique, a rotina aguarda condicionalmente até 12 segundos. O destino
é confirmado apenas quando todos os sinais abaixo coexistirem:

- rota de saque ainda em `active=10`;
- não há PIN-grid visível nem teclado numérico visível;
- existe exatamente um modal raiz `.ui-popup.ui-dialog` visível;
- esse modal contém dois inputs visíveis;
- esse modal contém ao menos um seletor `.ui-select__reference` visível;
- esse modal contém uma ação primária habilitada;
- o texto normalizado do modal contém `pix` como reforço semântico.

O seletor e os inputs são os sinais estruturais principais. O texto PIX evita
aceitar um diálogo estruturalmente semelhante, mas não é suficiente sozinho.

## Falhas e isolamento

Antes do clique, PIN incompleto, origem ambígua, botão ausente/desabilitado ou
rótulo incompatível falham sem interação. Depois do clique, ausência de
transição, permanência do PIN ou destino incompleto falham sem segundo clique.
Os diagnósticos registram somente contagens e sinais booleanos, nunca PIN,
texto de inputs ou CPF.

Cada janela resolve, clica e espera seu próprio modal. Não há estado global
de clique, rota ou timeout.

## Resultado e verificação

Sucesso retorna `pix_add_form_ready`: o formulário PIX está aberto, mas nenhum
campo foi alterado.

- teste: a origem aceita exatamente um botão no PIN completo e recusa origem
  parcial/ambígua;
- teste: destino requer todos os sinais estruturais e não aceita somente texto;
- teste: espera de destino não aciona segundo clique;
- teste manual: as janelas chegam ao formulário “Adicionar PIX” e permanecem
  sem dados enviados;
- `npm test` e `npm run check` passam.
