# ADR 0008: Serializar o bootstrap de cadastro por readiness

## Contexto

O painel paralelo abre os navegadores em ondas e agenda as automacoes com um
delay fixo. Em maquinas ou plataformas lentas, dois cadastros ainda podem entrar
ao mesmo tempo na fase mais sensivel: navegacao inicial, espera do loading,
normalizacao da SPA e abertura do formulario.

O semaforo de `BrowserRuntimeService.launchProfile` nao cobre essa fase. Ele e
liberado depois do launch/navegacao inicial, antes de
`AutomationRuntimeService.executeAccountRegistration` preparar o cadastro. Alem
disso, o renderer aguarda todos os launches antes de chamar `runBatch`, portanto
reduzir apenas a concorrencia de launch nao impede a sobreposicao dos bootstraps.

## Causa raiz

O inicio de cada cadastro dependia somente de `index * delayMs`. O relogio nao
representa readiness: se o primeiro perfil demorasse mais que o delay, o segundo
entrava na mesma fase pesada. Um repro deterministico com dois cadastros lentos,
separados por delay, mediu pico de dois bootstraps simultaneos.

## Decisao

`AutomationRuntimeService` mantem um semaforo exclusivo, com um permit, para a
fase de bootstrap de cadastro. O permit cobre:

- preparacao do captcha automatico;
- navegacao para o link inicial;
- espera do loading e normalizacao da SPA;
- abertura do dialogo de cadastro;
- deteccao dos campos obrigatorios e do controle de envio.

O permit e liberado assim que o formulario fica acionavel. Preenchimento,
captcha apos submit, confirmacao e deposito continuam concorrentes, preservando
o paralelismo util do lote. Qualquer erro durante o bootstrap libera o permit em
`finally`.

Quando um perfil encontra a fila ocupada, o log da execucao informa que ele esta
aguardando capacidade e registra quando a capacidade e liberada. O delay
configurado continua existindo como espacamento minimo, mas deixa de ser a unica
proteção contra ambiente lento.

## Verificacao

O teste `serializes slow registration bootstrap until the entry form is ready`
exercita o caminho real de `executeAccountRegistration` com duas paginas lentas.
Ele comprova:

- pico de um bootstrap;
- entrada do segundo perfil depois do primeiro;
- liberacao do paralelismo apos o formulario ficar acionavel;
- mensagens de espera e liberacao de capacidade.

Comandos:

```powershell
npx tsx --test --test-name-pattern="serializes slow registration bootstrap" test/automation-runtime.test.ts
npx tsx --test test/automation-runtime.test.ts
npm run check
npm test
```
