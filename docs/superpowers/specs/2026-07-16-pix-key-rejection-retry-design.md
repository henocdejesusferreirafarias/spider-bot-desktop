# Recusa explícita de chave PIX e nova tentativa automática

**Data:** 2026-07-16  
**Escopo:** cadastro automático de chave PIX do tipo telefone  
**Não inclui:** reutilização deliberada de uma chave PIX entre plataformas (mantida na [issue #25](https://github.com/henocdejesusferreirafarias/spider-bot-desktop/issues/25)).

## Problema

Algumas plataformas recusam uma chave PIX que já está vinculada a outro usuário, mas mantêm aberto o formulário de adição. O toast observado é um `ui-toast__toast--error` com a mensagem **“Esta conta de saque já foi vinculada por outro membro”**.

O fluxo atual trata a ausência de transição de tela como confirmação inconclusiva. Por segurança, a chave então permanece em `pending_confirmation`. Nesse caso específico, contudo, há prova explícita de que ela não foi cadastrada. Mantê-la pendente bloqueia o perfil e faz uma nova execução repetir a mesma chave.

## Objetivo

Quando a plataforma rejeitar explicitamente uma chave PIX por já estar vinculada, a automação deve marcar a chave como **Recusada**, manter a linha visível e excluível na lista, e tentar automaticamente a próxima chave disponível no mesmo formulário. A recusa é global até que a futura feature de reutilização entre plataformas redefina essa política.

## Modelo de estado

`pix_phone_keys` ganhará o estado terminal `rejected` e os metadados mínimos de rejeição:

- `rejected_at`;
- `rejection_reason`, com o classificador interno da mensagem reconhecida.

Transições permitidas:

```text
available -> reserved -> pending_confirmation -> rejected
                                              -> removida (confirmada)
```

Ao entrar em `rejected`, serão limpos os campos de reserva e pendência. A chave não é vinculada ao perfil, não é gravada como chave PIX do perfil e não pode ser alocada automaticamente em nenhuma plataforma.

## Detecção da recusa

Imediatamente antes de disparar o botão **Confirmar** do formulário PIX, a página instalará um `MutationObserver` temporário. Ele observará somente mudanças posteriores àquela tentativa e registrará toasts novos que sejam simultaneamente:

1. visíveis;
2. elementos `.ui-toast__toast--error`;
3. com descendente `.ui-toast__toast-message`;
4. reconhecidos pelo classificador semântico, inicialmente a versão normalizada de `esta conta de saque ja foi vinculada por outro membro`.

A normalização remove acentos, diferenças de caixa e espaços extras. O observador é desconectado ao terminar a tentativa, inclusive em erro ou timeout, para não deixar listeners entre execuções.

Toasts genéricos, antigos, não visíveis ou sem mensagem classificada não provocam recusa. Eles preservam a regra atual de pendência/revisão, pois ainda não constituem prova de que a chave não foi cadastrada.

## Fluxo de nova tentativa

1. Reservar uma chave disponível para o perfil e preenchê-la no formulário PIX já validado.
2. Promover a chave a `pending_confirmation` imediatamente antes do submit.
3. Observar o resultado da tentativa com o observador de toast e os sinais estruturais já existentes.
4. Se houver confirmação estrutural, persistir a chave no perfil e removê-la do estoque, como hoje.
5. Se houver rejeição explícita classificada, mover a chave para `rejected` de forma guardada pelo mesmo perfil e execução.
6. Sem reiniciar o navegador, navegar ou pedir senha novamente, limpar/substituir apenas o campo de telefone no formulário vivo, validar o novo preenchimento e tentar a próxima chave disponível.
7. Repetir somente enquanto uma chave elegível puder ser reservada. Cada recusa deixa a chave fora do conjunto elegível, portanto o laço é finito e não repete uma mesma chave.
8. Se não houver mais chave disponível, encerrar apenas aquele perfil como revisão/falha controlada. Os demais perfis em paralelo continuam normalmente.

O preenchimento de retry deve usar o mesmo mecanismo de setter nativo/eventos do formulário, com confirmação de que o valor anterior foi substituído; não pode simplesmente concatenar dígitos no campo existente.

## Interface e estoque

| Estado | Cor/Texto | Automação | Ações na lista |
| --- | --- | --- | --- |
| `available` | Disponível | Elegível | Editar e Excluir |
| `reserved` | Em cadastro | Protegida por execução ativa | Nenhuma |
| `pending_confirmation` | Aguardando confirmação | Protegida até reconciliação | Nenhuma |
| `rejected` | Recusada (vermelho) | Nunca elegível | Excluir |

`rejected` não compõe a contagem de estoque disponível. A exclusão permite ao usuário remover chaves que não quer manter como histórico; edição continua proibida, pois alterar o número transformaria uma recusa histórica em uma chave nova e confundiria o estado.

Os logs detalhados registram a recusa e cada nova tentativa sem imprimir o telefone completo. O feedback compacto do painel continua mostrando apenas o desfecho final do perfil; se todas as chaves forem recusadas, ele aparece como item para revisão.

## Concorrência e segurança

A mudança para `rejected` será uma atualização condicional: a linha precisa continuar em `pending_confirmation` e pertencer ao mesmo perfil e à mesma execução. Assim, uma tentativa atrasada não pode recusar a chave de outro perfil nem alterar uma chave já confirmada.

Cada retry reserva a próxima chave através da operação atômica já usada pelo estoque. Janelas paralelas não recebem a mesma chave. Se o navegador fechar após a promoção a pendente e antes de haver uma mensagem classificada, a regra existente de pendência é preservada; a chave não é recusada por inferência.

## Critérios de aceitação

1. O toast observado é reconhecido mesmo que desapareça antes do próximo polling normal.
2. A chave que recebeu a recusa passa de `pending_confirmation` para `rejected`, sem vínculo PIX no perfil.
3. Uma chave `rejected` não é selecionada em execuções futuras e não entra na contagem disponível.
4. A lista mostra **Recusada** em vermelho e permite apenas **Excluir** para esse estado.
5. Após uma recusa, a execução preenche e submete a próxima chave disponível no mesmo formulário, sem repetir senha de saque, navegação ou PIN.
6. Uma confirmação posterior persiste somente a chave efetivamente aceita e remove apenas essa chave do estoque.
7. Sem chave elegível restante, somente o perfil afetado fica para revisão; os demais continuam.
8. Toast não reconhecido, ausência de toast ou interrupção mantém a chave pendente em vez de marcá-la como recusada.
9. Testes cobrem o classificador de toast, transição guardada, exclusão autorizada, exclusão da contagem de estoque, retry com nova chave e esgotamento de opções.
