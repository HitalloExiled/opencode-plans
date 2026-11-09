# opencode-plans

Plugin do [OpenCode](https://opencode.ai) (V2) que persiste **planos do modo
Plan** em um SQLite dedicado e os expõe de duas formas:

- **Tools tipadas** no namespace `plans` — `save`, `list`, `get`, `update`,
  `delete`, `doctor`;
- **Painel lateral “Planos”** no app desktop, com lista, progresso, checklist
  e o Markdown original.

A gravação é sempre explícita: o agente Plan chama `plans.save` no mesmo turno
em que apresenta o plano final, assim que não houver mais perguntas ou escolhas
**bloqueantes** pendentes do usuário — sem pedir permissão. Uma escolha
**opcional/recomendada** não bloqueia o save: o passo entra no plano marcado
como “(Opcional, recomendado)”. Salvar/editar o plano
(`plans.save`/`plans.update`) é permitido no **Plan mode** porque grava apenas o
`plans.db`, não arquivos do repositório; só editar arquivos exige Build. O
usuário também pode usar `/save-plan` (captura direta) ou o botão **Salvar
plano**, que apenas envia um hint para o agente chamar `plans.save`. Não há
captura heurística de toda resposta do Plan.

O plugin é autocontido: nenhum import de fora do diretório (só
`@opencode/plugin`, `effect`, `zod` e `node:sqlite` do runtime), e nenhum dado
é escrito dentro do repo — o banco vive em
`~/.local/share/opencode/plans/plans.db` (ou `$PLANS_DB`).

## Instalação

```bash
git clone git@github.com:HitalloExiled/opencode-plans.git
cd opencode-plans
npm install --legacy-peer-deps
npm run gui:build
mkdir -p ~/.config/opencode/plugins
ln -sfn "$PWD" ~/.config/opencode/plugins/plans
```

> `--legacy-peer-deps` porque o `@opencode/plugin` declara um peer opcional de
> vite >= 6 enquanto o build usa vite 5.

Reinicie o OpenCode (ou aguarde o hot-reload). O plugin não precisa de CLI
externa: as tools leem/gravam o `plans.db` com o `node:sqlite` embutido no
runtime (in-process, síncrono). A GUI fala com o plugin servidor via RPC, então
não abre o banco nem depende do processo principal do Electron.

O repo `opencode-tools` consome este projeto como **git submodule** em
`plugins/plans` e faz o symlink via `setup.sh` (que também roda o `npm install`
e o `npm run gui:build`).

## O que o plugin faz

1. **Persiste um plano** (`plans.save`) com título, Markdown, passos e vínculo
   ao projeto/sessão. O `plans.save` aceita `id` para **substituir o
   texto/estrutura** de um plano existente: isso recria os passos e reinicia
   IDs/status. Não use `save` para marcar progresso. Os passos são extraídos
   com o **texto exato** e o body é guardado como template, com
   `<!-- plans:steps -->` no lugar do checklist.
2. **Lista e lê planos** (`plans.list`, `plans.get`): por padrão só a
   **sessão atual**; `scope: "project"` é opt-in para ver/ler planos de outras
   sessões do mesmo projeto. O `get`/`update`/`delete` das tools recusam plano
   de outra sessão.
3. **Marca progresso** (`plans.update`): passos `todo`/`doing`/`done`
   (`stepID` + `stepStatus`) e status do plano (`active`, `done`, `archived`,
   `superseded`). Os IDs (`s1`, `s2`, …) aparecem no `plans.get`; use-os em
   vez de reescrever o body. No máximo um passo por plano fica `doing`; marcar
   outro volta o anterior para `todo`. Quando todos os passos ficam `done`, o
   plano vira `done`. O agente marca `doing` antes de começar um passo e
   `done` ao concluir.
4. **Injeta contexto**: agentes fora do Plan recebem um bloco curto com os
   planos ativos **da sessão atual** e os passos pendentes do plano da sessão,
   com o passo `doing` primeiro.
5. **Painel lateral**: por padrão lista só a **sessão ativa**; o toggle
   **Projeto** traz todos os planos do projeto, com a sessão de origem em cada
   card. Planos de outra sessão têm o botão **Mover para esta sessão**. O
   painel guarda por sessão o plano aberto, a busca, os filtros e o estado
   colapsado do corpo, então fechar e reabrir a aba restaura a mesma tela; com
   um plano aberto, os filtros ficam ocultos.
6. **Salvar o último plano**: `/save-plan` (servidor) captura a última mensagem
   do agente `plan` na sessão. O botão **Salvar plano** do painel não salva
   direto: ele envia um hint pedindo ao agente que chame `plans.save` com o
   plano apresentado.
7. **Notifica o agente**: quando o usuário marca/altera um passo, muda o
   status, move ou remove um plano no painel, o servidor grava uma mensagem
   sintética na **sessão dona do plano** (`resume: false`) com a ação na
   descrição. O agente vê a alteração no próximo request. Em escopo Projeto,
   isso é a sessão de origem do plano, não a sessão que está visualizando.
8. **Executa o plano**: no card e no detalhe de um plano **active**, o botão
   **Executar** move o plano para a sessão atual quando necessário, troca o
   agente da sessão para **Build** e envia um prompt para o agente ler o plano
   com `plans.get`, seguir os passos e atualizar o estado com `plans.update`.
   O prompt é uma mensagem de usuário normal (sem `delivery: "queue"`), então
   inicia o turno imediatamente; o botão só habilita com a sessão ociosa. O
   prompt não obriga `plans.get`: o bloco `<plans-context>` já traz os passos
   pendentes com IDs (`s1`, `s2`, …); `plans.get` fica para o texto completo ou
   para passos fora do contexto.
   Enquanto executa, o botão
   vira **Pausar**: ele interrompe o turno (`session.interrupt`), grava uma
   mensagem sintética avisando que o usuário pausou o plano e volta o agente
   para **Plan**. Clicar em Executar novamente retoma do estado atual. Normal
   completion mantém o agente em Build.

### Formato dos passos

O agente deve colocar os passos em **uma única seção `## Passos`**, com uma
lista plana `- [ ]`, um passo por linha, texto exato e sem negrito/links/
backticks. Não repetir a lista em “Critérios de aceite”, exemplos ou outras
seções. O parser ignora bullets/numeradas fora da seção de passos para não
transformar “Invariantes” ou “Decisões” em checklist.

Na leitura, `plans.get` substitui `<!-- plans:steps -->` pela lista atual e
nunca devolve o marcador. Cada passo aparece com seu ID, no formato
`- [x] (s1) texto`: o `(s1)` é o valor a passar em `plans.update`. Marcar
status nunca exige body — body serve só para mudar texto/estrutura e recria os
passos. Por isso `plans.update` recusa `body` combinado com
`stepStatus`/`stepID`/`position` e recusa um body cujos textos de passos não
mudaram (troca apenas de checkboxes). No painel, a seção **Steps** é
interativa e o body é exibido sem o checklist extraído.

### Nomes e permissões

- **Code Mode:** `tools.plans.save`, `tools.plans.list`, `tools.plans.get`,
  `tools.plans.update`, `tools.plans.delete`, `tools.plans.doctor`.
- **Sessões regulares:** nomes efetivos `plans_save`, `plans_list`, ... —
  `options: { namespace: "plans" }` é o que prefixa o nome no catálogo.
- O Plan agent é instruído a chamar `plans.save` ao apresentar o plano final;
  a tool só escreve no `plans.db`, nunca no repositório.

## Dados

```
~/.local/share/opencode/plans/plans.db   # padrão
$PLANS_DB                                # override (testes/isolamento)
```

Schema (v2):

- `plans` — id, project_id, project_directory, session_id, message_id, title,
  body (template com `<!-- plans:steps -->`), status, created_at, updated_at,
  completed_at.
- `plan_steps` — plan_id, position, step_id, text, status
  (`todo` | `doing` | `done`).

O banco é criado no primeiro uso; as migrações são idempotentes e controladas
por `PRAGMA user_version`. Nada de `*.db` no repositório.

## Desenvolvimento

```bash
npm install --legacy-peer-deps
bun run typecheck       # index.ts + plans.ts
bun run typecheck:gui   # src/** (Solid JSX)
bun run gui:build       # dist/gui-experimental.cjs
```

Testes (a partir do `opencode-tools/`):

```bash
bun test plugins/plans/test
```

Smoke do store sem tocar no banco real:

```bash
cd plugins/plans
PLANS_DB=/tmp/plans-test.db bun -e 'import("./src/store.ts").then(async (m) => { const s = await m.requireStore(); console.log(m.renderDoctor(m.doctorInfo(s))) })'
```

## Estrutura

```
index.ts                 registra tools + /save-plan + RPC + injeção de contexto
plans.ts                 definições das tools plans.*
src/store.ts             camada única: node:sqlite, schema, migrações, SQL
src/rpc.ts               handlers RPC do servidor (list/read/write)
src/capture.ts           extrai o último plano do agente Plan da sessão
src/inject.ts            blocos injetados no Plan e nos demais agentes
src/gui.tsx              ./gui-experimental → setup
src/gui/contract.ts      contrato RPC + schemas
src/gui/setup.tsx        painel, comando e menu
src/gui/view.tsx         UI SolidJS
src/gui/i18n.ts          PT-BR / EN-US
test/                    bun tests
dist/gui-experimental.cjs  GUI compilado (gitignored)
```
