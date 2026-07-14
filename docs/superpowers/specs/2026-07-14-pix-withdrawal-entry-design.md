# Entrada confiável do fluxo PIX pela gestão de saques

## Objetivo

Substituir o fluxo legado de cadastro PIX por uma primeira fatia segura: para cada janela escolhida, navegar ao Perfil, confirmar que o Perfil foi renderizado, acionar a ação viva de Gestão de saques da própria SPA e classificar o estado final. Esta fatia não preenche senha de saque, não abre o modal PIX, não reserva chave PIX e não envia formulários.

## Evidências observadas

- A SPA expõe um router Vue em runtime e uma rota de Perfil (`/home/mine`) e saque (`withdraw`).
- Navegar diretamente para `withdraw` não decide se a conta precisa de senha.
- A ação renderizada `Gestão de saques`, quando acionada a partir do Perfil, levou uma conta sem senha à tela `security`, com `Defina sua senha de saque` e `Confirmar Nova Senha`.
- O listener Vue é uma referência criada em runtime; não pode ser armazenado nem hardcoded entre páginas ou sessões. A intenção da ação é estável, a referência não é.

## Escopo da primeira fatia

1. A ação do controle PIX passa a preparar a entrada no fluxo, não a declarar que uma chave PIX foi cadastrada.
2. Cada janela executa as etapas `profile` e `withdrawal-management` com waits condicionais e um diagnóstico de falha por etapa.
3. O resultado de uma janela é exatamente um de:
   - `needs_withdrawal_password`: a superfície de definição de senha de saque foi confirmada;
   - `withdrawal_ready`: a superfície de saque foi confirmada;
   - `failed`: nenhuma superfície esperada foi confirmada ou uma etapa não encontrou sua capacidade.
4. O processo usa concorrência limitada a duas janelas ativas, mantendo resultados, cancelamento e logs por perfil isolados.
5. A UI comunica preparação do fluxo; não afirma que PIX foi cadastrado nesta fatia.

## Fora de escopo

- Definir, confirmar ou recuperar senha de saque.
- Abrir o cadastro PIX, selecionar tipo, preencher formulário, enviar ou confirmar persistência.
- Reservar, consumir, liberar ou alterar estoque de chaves PIX.
- Suporte a tipos de chave além do contrato já existente.
- Mapeamento por domínio, marca, cor, coordenadas ou seletor de uma plataforma.

## Arquitetura

### Descoberta e acionamento

Uma operação de SPA dedicada recebe a página/frame atual e a intenção `withdrawal-management`. Ela:

1. encontra o router vivo no main world;
2. resolve a rota de Perfil pela tabela de rotas viva e pelos padrões semânticos existentes;
3. navega para Perfil;
4. espera uma superfície de Perfil forte: rota compatível, identificação/ações de perfil e uma ação de Gestão de saques encontrada de forma não ambígua;
5. invoca o listener Vue vivo dessa ação, sem `HTMLElement.click`, coordenadas ou cache de referência;
6. aguarda e classifica uma superfície de definição de senha ou de saque.

O resolvedor de Gestão de saques normaliza acentos, caixa e espaços e usa aliases de saque (`gestão de saques`, `gestão saque`, `saques`, `withdraw`, `withdrawal`, `cash out`) junto de atributos acessíveis e do listener vivo. Ele só aciona um candidato único de alta confiança. Ausência ou ambiguidade é falha explícita, nunca chute.

### Validação e waits

Cada wait consulta sinais da tela em polling curto, com teto de segurança. Nenhum `waitForTimeout` é usado como confirmação. A conclusão inclui a etapa, rota observada, sinais encontrados/ausentes e tempo decorrido.

- Perfil: rota de perfil + superfície de perfil + ação de Gestão de saques elegível.
- Senha ausente: rota/estado de segurança + frases estruturais de definição e confirmação de senha.
- Saque pronto: superfície de saque/conta de recebimento; URL sozinha não basta.

### Concorrência

O orquestrador processa perfis únicos através do `AsyncSemaphore` existente, com dois workers por padrão. Cada worker mantém a sessão, run, logs e cancelamento próprios. Falha de um perfil não cancela os demais. O limite será exposto apenas quando a primeira fatia estiver estável; nesta fatia é uma constante interna conservadora.

### Remoção do legado

Será removido todo o caminho exclusivo do cadastro PIX antigo: reserva/consumo de telefone, navegação direta a saque, prompts de senha embutidos, aba de recebimento, modal, seleção PHONE, preenchimento, submit e confirmação. Utilidades genéricas já compartilhadas por depósito, navegação e outras rotinas permanecem.

## Contrato e UI

`PixKeyRegistrationControlResult` passa a comunicar o resultado preparatório (`needs_withdrawal_password`, `withdrawal_ready` ou `failed`) e a etapa de falha quando aplicável. O botão e feedback do painel deixam claro que esta versão prepara o cadastro PIX, sem alegar conclusão de cadastro.

O IPC não verifica estoque nem reserva chave nesta fatia, pois nenhuma chave é utilizada.

## Testes de aceite

- Uma janela no início navega ao Perfil e só aciona Gestão de saques depois de validar o Perfil.
- Perfil que nunca renderiza falha em `profile` com diagnóstico, sem tentar o listener.
- Ação de Gestão de saques única chama seu listener e classifica `needs_withdrawal_password` quando a tela de setup aparece.
- Ação de Gestão de saques única classifica `withdrawal_ready` quando a superfície de saque aparece.
- Ausência ou ambiguidade da ação falha em `withdrawal-management` sem acionar candidato algum.
- Vários perfis respeitam máximo de duas execuções ativas e isolam falhas.
- Nenhuma chamada a reserva, consumo ou atualização de chave PIX é feita.
- `npm test`, `npm run check` e teste manual com `npm run dev` passam antes do próximo incremento.
