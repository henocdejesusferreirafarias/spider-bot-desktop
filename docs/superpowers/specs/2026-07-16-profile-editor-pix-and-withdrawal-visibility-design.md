# Visibilidade de PIX e senha de saque no editor de perfil

## Objetivo

Tornar os dados operacionais já persistidos no perfil visíveis no formulário de edição, sem permitir que a chave PIX confirmada seja sobrescrita manualmente.

## Escopo

O modal **Editar perfil** passa a exibir:

- **CPF**, substituindo o rótulo incorreto `CPF PIX`; o campo preserva o comportamento editável atual.
- **Senha de saque**, editável como hoje, com um controle explícito para alternar entre ocultar e mostrar seus seis dígitos. O estado inicial permanece oculto e é local ao modal.
- **Chave PIX**, em campo de leitura apenas, com o valor completo de `profile.account.pixPhoneKey`. Quando não houver chave confirmada, o campo mostra um estado vazio coerente e não cria nenhum valor no perfil.

## Decisões

- A chave PIX não integra `ProfileDraft` e não é enviada ao salvar. A única origem que pode alterá-la continua sendo a confirmação estrutural da automação no banco local.
- A senha de saque continua pertencendo ao `ProfileDraft`; apenas seu tipo visual alterna entre `password` e `text`.
- Não haverá novo botão de detalhes na tabela neste ajuste. O editor passa a ser o ponto de consulta para esses três parâmetros.
- O rótulo `CPF PIX` será corrigido para `CPF` também no modal de detalhes, para manter a terminologia consistente.

## Comportamento esperado

1. Ao editar um perfil sem chave PIX confirmada, o campo de chave PIX é visível, bloqueado e vazio.
2. Ao editar um perfil com chave PIX confirmada, o campo mostra a chave completa e bloqueada.
3. Alternar a visibilidade da senha não modifica seu valor nem a salva por si só.
4. Salvar uma edição que não altera a senha nem o CPF não modifica a chave PIX persistida.

## Testes

- Cobrir uma função de apresentação isolada para o estado da chave PIX no editor: valor completo quando existente e vazio quando ausente.
- Cobrir que o rótulo de CPF não inclui PIX.
- Validar por typecheck e build; o teste manual confirma a alternância visual da senha e o campo PIX bloqueado.

## Fora de escopo

- Alterar a chave PIX manualmente.
- Criar ou expor a ação de detalhes na tabela de perfis.
- Mudar a persistência, o preflight ou o fluxo de cadastro PIX.
