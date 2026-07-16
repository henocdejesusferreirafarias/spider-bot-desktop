# Chave PIX do perfil como fonte de verdade

**Data:** 2026-07-15
**Escopo:** cadastro automático de chave PIX do tipo telefone
**Não inclui:** reutilização de uma chave entre plataformas (registrada em [issue #25](https://github.com/henocdejesusferreirafarias/spider-bot-desktop/issues/25)).

## Objetivo

Depois que a plataforma confirma uma chave PIX, ela deve deixar o estoque. A associação da chave com a conta passa a existir no próprio perfil, de forma protegida. Assim, o estoque contém apenas chaves passíveis de novo cadastro, enquanto o preflight consegue identificar uma chave já cadastrada para aquele perfil sem depender de uma linha histórica no estoque.

## Modelo de dados

`ProfileAccountRecord` receberá um parâmetro opcional de chave PIX telefone registrada. O valor será normalizado e criptografado pela mesma camada usada para CPF e senha de saque. A interface a exibe apenas mascarada.

O telefone usado para criar a conta permanece um campo independente. Nenhuma tela ou script poderá inferir a chave PIX a partir de `phoneNumber` apenas porque há uma data de cadastro PIX.

`pix_phone_keys` continuará guardando somente o estoque ativo e os estados transitórios:

- `available`: pode ser editada, excluída e alocada;
- `reserved`: pertence temporariamente a uma execução ativa;
- `pending_confirmation`: o formulário foi enviado, mas a plataforma ainda não forneceu evidência suficiente de conclusão.

O estado terminal `used` deixa de ser criado e deixa de aparecer na lista.

## Confirmação e consumo seguro

Quando o cadastro for confirmado por evidência estrutural da plataforma, a operação local será atômica:

1. validar que a chave ainda está pendente para o mesmo perfil;
2. gravar a chave PIX exata e os metadados de confirmação no perfil;
3. apagar a linha correspondente de `pix_phone_keys`;
4. concluir a execução como sucesso.

Se qualquer passo falhar, a transação não persiste mudanças parciais. A chave continua pendente e a execução é enviada para revisão; ela não volta a ficar disponível por acidente.

## Preflight

O preflight consulta a conta de recebimento da plataforma e o parâmetro PIX do perfil antes de tentar alocar estoque.

| Estado do perfil e da plataforma | Decisão |
| --- | --- |
| Perfil possui chave PIX; a máscara/estrutura da conta exibida é compatível | Concluir como chave já cadastrada; não alocar estoque. |
| Perfil possui chave PIX; plataforma mostra uma conta incompatível ou sem evidência verificável | Parar para revisão; não sobrescrever o parâmetro e não alocar outra chave. |
| Perfil não possui chave PIX; plataforma já mostra conta de recebimento | Considerar cadastro manual prévio; não alocar estoque. |
| Perfil não possui chave PIX; plataforma não mostra conta de recebimento | Seguir o fluxo normal e reservar uma chave disponível. |
| Perfil possui chave pendente | Reutilizar somente essa chave para retomar ou reconciliar a execução. |

Comparação com o valor exibido pela plataforma usa apenas sinais seguros disponíveis no cartão, como tipo da chave e a máscara de dígitos. Uma incompatibilidade explícita nunca é tratada como sucesso. Se a plataforma ocultar informação demais para validar uma chave já persistida, o resultado é revisão, não uma nova alocação.

## Migração local

Na abertura do banco, registros legados com estado `used` serão processados uma única vez:

1. se houver perfil vinculado, copiar o número cifrado para o parâmetro PIX desse perfil e preservar a data/origem de confirmação;
2. apagar a linha usada do estoque;
3. se o perfil já não existir, apagar a linha mesmo assim, pois ela não é mais uma chave disponível nem há destino válido para o parâmetro.

Registros `reserved` e `pending_confirmation` não participam da migração e continuam protegidos pela recuperação normal de execuções.

## Interface

### Chaves PIX

A listagem não exibirá mais chaves cadastradas. Chaves disponíveis exibem **Editar** e **Excluir**. Chaves reservadas ou pendentes continuam sem ações de alteração, pois estão em uma operação sensível ainda aberta.

### Perfil

O detalhe do perfil mostrará a chave PIX registrada mascarada e a data de confirmação. O valor completo não será escrito em logs ou exibido em texto aberto pela interface.

### Painel de controle e cockpit

O botão passa de **Preparar cadastro PIX** para **Cadastrar chave PIX**; durante a execução, o texto será **Cadastrando...**.

O feedback no card deixa de listar etapas internas como senha, PIN, saque e formulário. Ele mostrará somente o resumo final de categorias não zeradas, por exemplo:

`Cadastro PIX: 8 concluídos · 1 aguardando confirmação · 1 para revisão`

Detalhes técnicos continuam exclusivamente no log da operação.

## Critérios de aceitação

1. Uma chave confirmada desaparece do estoque e fica associada ao perfil correto.
2. O perfil não usa o telefone da conta como substituto da chave PIX.
3. Nova execução de um perfil com chave persistida não consome outra chave quando a plataforma confirma a mesma conta de recebimento.
4. Evidência incompatível ou insuficiente para uma chave persistida interrompe apenas aquele perfil para revisão e não bloqueia os demais.
5. Todas as chaves `used` existentes são removidas do estoque; as que possuem perfil válido são migradas para ele.
6. Chaves disponíveis voltam a permitir edição e exclusão.
7. O painel usa o rótulo novo e apresenta apenas o resumo operacional consolidado.
8. Testes cobrem persistência/remoção atômica, migração, decisões de preflight e resumo de feedback.

## Segurança e concorrência

Uma execução é dona apenas da chave em `reserved` ou `pending_confirmation`; nenhum outro perfil pode receber essa linha até ela ser confirmada ou liberada. A remoção do estoque só ocorre após confirmação estrutural e dentro da mesma transação que grava o parâmetro do perfil. Cada falha é isolada por perfil para que execuções paralelas continuem.
