# ADR 0011: Grades ordenadas por monitor

## Status

Aceito.

## Contexto

A issue #32 começou como um organizador de janelas livre, com drag, resize e
slots customizados. O escopo aprovado preserva o organizador por linhas e
colunas, mas permite escolher vários monitores, ordenar a prioridade e manter
uma grade independente para cada um.

O Electron informa somente os displays atualmente disponíveis. Um monitor pode
desaparecer temporariamente, porém sua configuração deve retornar quando o mesmo
`displayId` for detectado novamente. A geometria consciente de DPI e o readback
de bounds já foram estabelecidos pela ADR 0010.

## Decisão

O layout persistido usa um array versionado de `ScreenMonitorLayout`. A posição
no array é a prioridade; não existe campo numérico redundante. Cada registro
guarda `displayId`, habilitação, modo, colunas e linhas.

O módulo compartilhado `src/shared/window-layout.ts` é a fonte de verdade para:

- migrar o formato legado de um monitor para a versão 2;
- normalizar registros e remover identificadores duplicados;
- reconciliar a configuração com os displays disponíveis;
- preservar silenciosamente registros ausentes;
- habilitar o principal quando nenhum monitor conectado estiver ativo;
- concatenar as grades habilitadas em uma sequência global de slots.

Para dois monitores `5x2`, os slots 0–9 pertencem ao primeiro e os slots 10–19
ao segundo. Um índice solicitado acima da capacidade é resolvido por módulo,
mantendo o índice crescente no handle e reiniciando a geometria no primeiro slot.
Isso preserva a sobreposição existente desde o início da sequência.

O sentinel legado `primary` é transitório. Assim que displays concretos são
conhecidos, ele é substituído pelo ID do principal e a tela persiste a
reconciliação. O runtime aplica o mesmo fallback imediatamente mesmo antes da
tela de organização ser aberta.

Cada slot continua em DIP. O runtime seleciona o display correspondente e usa a
conversão DIP/físico, a escala efetivamente lançada e o readback CDP definidos
na ADR 0010. Preview, abertura e aplicação resolvem novamente os displays para
capturar mudanças de posição, resolução e escala.

## Consequências

- a distribuição é determinística e segue a ordem visível da barra lateral;
- monitores desconectados não aparecem nem recebem janelas;
- configurações desconectadas não são apagadas ou reordenadas implicitamente;
- a última desmarcação conectada é recusada;
- grades excedentes voltam ao primeiro slot e se sobrepõem como antes;
- não há pinagem de perfil, drag, resize, presets ou slots customizados;
- falha em uma janela durante `Aplicar Agora` não interrompe as seguintes;
- o formato v1 é migrado sem alteração do schema SQLite.

## Verificação

```powershell
npx tsx --test test/screen-layout-settings.test.ts test/window-layout.test.ts test/window-geometry.test.ts test/window-layout-runtime.test.ts test/database.test.ts
npm run check
npm test
npm run build
git diff --check
```

A QA manual cobre dois monitores com grades `5x2`, overflow, reordenação,
última desmarcação, desconexão/reconexão, preview fantasma, DPI e persistência.
