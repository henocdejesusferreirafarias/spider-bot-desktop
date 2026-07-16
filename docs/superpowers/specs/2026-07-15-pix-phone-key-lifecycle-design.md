# Ciclo seguro de estoque e confirmação de chave PIX PHONE

## Contexto

O fluxo novo alcança e preenche o modal vivo “Adicionar PIX” com uma chave PIX PHONE, mas ainda não envia o formulário. A implementação atual também mantém a chave reservada por perfil após qualquer interrupção e a listagem mostra apenas chaves disponíveis. Isso pode esconder uma reserva antiga e fazer o usuário não saber qual chave será usada numa nova execução.

As plataformas observadas permitem uma conta de recebimento PIX por perfil. Após o envio, a conta aparece em `active=10` como `PIX(PHONE)`, mas o número é mascarado tanto no DOM quanto no store `withdraw.accountList` (por exemplo, `41***690`). A chave íntegra não pode ser relida da plataforma.

## Objetivo

Concluir o cadastro PIX PHONE com um único envio verificável e administrar o estoque sem reservas invisíveis ou permanentes. Uma chave só pode ser marcada como usada após a plataforma confirmar seu cadastro. Interrupções anteriores ao envio final devolvem a chave ao estoque; interrupções ambíguas após o envio preservam uma pendência vinculada ao perfil para reconciliação.

## Estados da chave

Cada chave PHONE terá exatamente um destes estados:

- `available`: pode ser atribuída a uma execução.
- `reserved`: aluguel temporário de uma execução ativa; guarda perfil, run e instante da reserva.
- `pending_confirmation`: o envio final pode ter chegado à plataforma; guarda perfil, run e instante da pendência.
- `used`: a plataforma confirmou o cadastro; guarda perfil, conta e instante de consumo para auditoria.

`reserved` não sobrevive como vínculo de retomada. Ao encerrar uma execução antes de um clique final efetivamente disparado — sucesso parcial, erro, cancelamento ou fechamento do navegador — a chave volta a `available`.

Na inicialização e antes de uma nova alocação, o banco também libera reservas cujo run não está ativo. Essa recuperação automática nunca toca em `pending_confirmation` ou `used`.

Antes de despachar o clique final, a chave transita de `reserved` para `pending_confirmation` em uma gravação durável. Isso elimina a janela em que a plataforma poderia cadastrar a chave, mas o processo cair antes de o bot registrar a pendência. Se a ação final não for sequer tentada, a transição é revertida para `available`; se for tentada e o resultado permanecer incerto, a pendência é preservada.

## Preflight para cadastro limpo e retomada

Ao chegar na área de recebimento `active=10`, antes de reservar qualquer chave, a automação resolve o estado da conta PIX da própria plataforma:

1. Sem chave pendente no perfil e sem conta PIX cadastrada: pode reservar uma chave `available` e seguir para o formulário.
2. Sem chave pendente, mas com qualquer conta PIX cadastrada manualmente: não reserva chave, não tenta abrir o formulário e retorna `pix_already_registered`. As demais janelas seguem normalmente.
3. Com chave `pending_confirmation` e sem conta PIX cadastrada: promove a mesma chave para a execução atual e tenta concluir o cadastro; nunca busca outra chave no estoque.
4. Com chave pendente e uma conta PIX cadastrada: compara a máscara, conforme as regras abaixo.

Uma conta diferente da chave pendente é um conflito: a janela para, registra `pix_key_conflict` com diagnóstico sem valores sensíveis e conserva a pendência. Não consome outra chave, não sobrescreve a conta existente e não interrompe os outros perfis do lote.

## Envio e confirmação da plataforma

O envio só ocorre quando o modal PIX vivo está único, em `active=10`, sem PIN ou teclado virtual, com tipo `PHONE` e nome/chave/CPF previamente confirmados. O botão `Confirmar` é localizado dentro desse modal vivo por controle semântico; não há coordenadas, host específico ou segundo clique.

Após um despacho único, a rotina faz espera condicional com teto escalável, sem `sleep` de sucesso fixo. A confirmação exige todos estes sinais:

- rota de saque continua em `active=10`;
- o modal “Adicionar PIX” deixa de estar visível;
- não há superfície de erro da plataforma;
- a área de contas de recebimento está presente;
- existe uma conta identificada estruturalmente como `PIX(PHONE)`;
- a máscara da conta é compatível com a chave alvo.

A compatibilidade usa apenas os trechos numéricos visíveis fora dos asteriscos. Para `41***690`, a chave alvo precisa começar com `41` e terminar com `690`. O matcher deve exigir no mínimo dois dígitos de prefixo e três de sufixo; se a skin revelar menos evidência que isso, a decisão automática é proibida e a chave permanece `pending_confirmation` para revisão.

Na mesma execução, o estado anterior sem conta PIX e o aparecimento posterior de uma conta compatível reforçam a confirmação. Na retomada, uma conta compatível muda a pendência para `used`; ausência de conta reutiliza a mesma chave pendente; conta incompatível gera conflito.

## Estoque e interface

A listagem de Chaves PIX deve usar estes rótulos em português, mantendo os identificadores técnicos internos apenas no código:

- `available` → **Disponível**;
- `reserved` → **Em cadastro**;
- `pending_confirmation` → **Aguardando confirmação**;
- `used` → **Cadastrada**.

A listagem não revela números completos. Para estados não disponíveis, mostra perfil vinculado e timestamp relevante. Ações de editar, excluir ou realocar são permitidas apenas para chaves **Disponíveis**.

Chaves pendentes e conflitos devem ficar visíveis ao operador, com uma ação futura de revisão manual; esta fatia não libera pendências manualmente nem altera contas cadastradas na plataforma.

## Isolamento, falhas e registros

As transições usam atualização atômica condicionada pelo estado anterior para que duas janelas não reservem ou consumam a mesma chave. Cada perfil mantém seu próprio run, modal, deadline e decisão; falha, pendência ou conflito de um perfil não cancela os demais, que já são processados por resultados isolados.

Logs e métricas podem registrar estado, etapa, motivo e tempos, mas nunca telefone, CPF, nome, PIN, máscara completa ou trechos numéricos da chave.

## Verificação

- testes de banco para transições atômicas `available → reserved → available`, `reserved → pending_confirmation → used` e rejeição de transições inválidas;
- testes puros de compatibilidade de máscara, evidência insuficiente e detecção de conflito;
- testes de preflight sem reserva quando uma conta PIX manual já existe;
- testes de retomada com pendência: conta compatível, ausente e incompatível;
- testes do clique único e da espera condicional pela conta PIX listada;
- testes da listagem para todos os estados sem expor números completos;
- `npm test`, `npm run check` e validação manual em múltiplas plataformas.
