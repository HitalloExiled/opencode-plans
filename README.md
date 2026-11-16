# opencode-plans

Plugin do [OpenCode](https://opencode.ai) (V2) que persiste **planos do modo
Plan** em um SQLite dedicado e os expõe de duas formas:

- **Tools tipadas** no namespace `plans` — `save`, `list`, `get`, `update`,
  `delete`, `doctor`;
- **Painel lateral “Planos”** no app desktop, com lista, progresso, checklist
  e o Markdown original;
- **Pill “Planos · N”** na linha de título da timeline (`session.header`), que
  abre todos os planos em um overlay, sem escopo de sessão.

A gravação é sempre explícita e **esperada**: o agente Plan chama `plans.save`
no mesmo turno em que apresenta o plano final, assim que não houver mais
perguntas ou escolhas **bloqueantes** pendentes do usuário — sem pedir
permissão. O lembrete do Plan mode sobre "plan files" (arquivos markdown em
`~/.opencode/plan`) **não** cobre `plans.save`; esperar o usuário pedir é uma
leitura errada da regra. Uma escolha
**opcional/recomendada** não bloqueia o save: o passo entra no plano marcado
como “(Opcional, recomendado)”. Salvar/editar o plano
(`plans.save`/`plans.update`) é permitido no **Plan mode** porque grava apenas o
`plans.db`, não arquivos do repositório; só editar arquivos exige Build. O
usuário também pode usar `/save-plan` (captura direta) ou o botão **Salvar do
agente**, que apenas envia um hint para o agente chamar `plans.save`. Não há
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

1. **Dois fluxos, com toggle na GUI**: **Nativo** (padrão) usa Plan/Build
   exatamente como antes; **Dedicado** usa os agentes próprios. A escolha fica
   em `flow.json`, ao lado do `plans.db`, e vale para a instalação.
2. **Dois agentes próprios** (fluxo dedicado), **clones por comportamento** do
   Plan e do Build: mesmas descrições, **sem system**. O **Executor** edita e
   roda como o Build. O **Planner** é o Plan **sem a exceção do diretório de
   planos**: toda edição é negada e as ferramentas `edit`/`write`/`patch` nem
   aparecem no catálogo — o plano vive no `plans.db`. Ele recebe o mesmo
   reminder que o core injeta no Plan, antes do prompt e inclusive depois de
   compactação. Por cima do clone, um bloco `<plans-flow>` na cauda pede para
   salvar o plano no mesmo turno (`plans.save`, um por pedido) e marcar
   progresso (`plans.update`, `doing` -> `done`). O Executar do painel troca a
   sessão para o Executor; pausar volta ao Planner.
3. **Persiste um plano** (`plans.save`) com título, Markdown, passos e vínculo
   ao projeto/sessão. O `plans.save` aceita `id` para **substituir o
   texto/estrutura** de um plano existente: isso recria os passos e reinicia
   IDs/status. Não use `save` para marcar progresso. Os passos são extraídos
   com o **texto exato** e o body é guardado como template, com
   `<!-- plans:steps -->` no lugar do checklist.
4. **Lista e lê planos** (`plans.list`, `plans.get`): por padrão só a
   **sessão atual**; `scope: "project"` é opt-in para ver/ler planos de outras
   sessões do mesmo projeto. O `get`/`update`/`delete` das tools recusam plano
   de outra sessão.
5. **Marca progresso** (`plans.update`): passos `todo`/`doing`/`done`
   (`stepID` + `stepStatus`) e status do plano (`active`, `done`, `archived`,
   `superseded`). Os IDs (`s1`, `s2`, …) aparecem no `plans.get`; use-os em
   vez de reescrever o body. No máximo um passo por plano fica `doing`; marcar
   outro volta o anterior para `todo`. Quando todos os passos ficam `done`, o
   plano vira `done`. O agente marca `doing` antes de começar um passo e
   `done` ao concluir.
6. **Injeta uma regra de routing (system)**: em todo request o plugin anexa um
   system part constante (`Plans routing`) liberando `plans.save`/`plans.update`
   no Plan mode e lembrando de salvar o plano final no mesmo turno. O texto é
   byte-idêntico entre requests, então o prefixo do KV cache não muda. Contexto
   dinâmico (plano da sessão + pendentes) só entra no **tail** da última
   mensagem do usuário e **apenas depois de uma compactação**, quando o plano
   saiu da conversa.
7. **Painel lateral**: por padrão lista só a **sessão ativa**; o toggle
   **Projeto** traz todos os planos do projeto, com a sessão de origem em cada
   card. Planos de outra sessão têm o botão **Mover para esta sessão**. O
   painel guarda por sessão o plano aberto, a busca, os filtros, a página e a
   altura dos passos, então fechar e reabrir a aba restaura a mesma tela; com
   um plano aberto, os filtros ficam ocultos. A listagem é paginada no cliente
   (10 por página); no detalhe, corpo e passos rolam independentemente e a
   altura dos passos é ajustável pelo divisor.
8. **Salvar o último plano**: `/save-plan` (servidor) captura a última mensagem
   do agente `plan` na sessão. O botão **Salvar do agente** do painel não salva
   direto: ele envia um hint pedindo ao agente que chame `plans.save` com o
   plano apresentado.
9. **Notifica o agente**: quando o usuário marca/altera um passo, muda o
   status, move ou remove um plano no painel, o servidor grava uma mensagem
   sintética na **sessão dona do plano** (`resume: false`) com a ação na
   descrição. O agente vê a alteração no próximo request. Em escopo Projeto,
   isso é a sessão de origem do plano, não a sessão que está visualizando.
10. **Executa o plano**: no card e no detalhe de um plano **active**, o botão
   **Executar** move o plano para a sessão atual quando necessário, troca o
   agente da sessão para o **Executor** e envia um prompt para o agente ler o plano
   com `plans.get`, seguir os passos e atualizar o estado com `plans.update`.
   O prompt é uma mensagem de usuário normal (sem `delivery: "queue"`), então
   inicia o turno imediatamente; o botão só habilita com a sessão ociosa. O
   prompt orienta o agente a ler com `plans.get` quando o plano não estiver na
   conversa; a regra de routing no system já lembra de salvar no mesmo turno.
   Enquanto executa, o botão
   vira **Pausar**: ele interrompe o turno (`session.interrupt`), grava uma
   mensagem sintética avisando que o usuário pausou o plano e volta o agente
   para o **Planner**. Clicar em Executar novamente retoma do estado atual. Normal
   completion mantém o agente no Executor.
11. **Executar pela pill do composer**: quando a sessão está ociosa e tem um
   plano **active**, uma pill **Executar plano** aparece na linha acima do
   composer (com o progresso `done/total`). O clique chama o mesmo
   `executionFor(session)` do botão do painel — o handle compartilhado grava o
   estado `{ planID, pending }` por sessão e executa `runPlan` —, então o painel
   mostra **Pausar** para um run iniciado pela pill (e vice-versa). Ela é
   alimentada pelo evento RPC `opencode.plans/changed`, emitido pelo
   `plans.save`, pelos tools de escrita e pelos handlers do painel; some
   enquanto o agente roda e quando o plano termina (todos os passos `done`
   viram status `done`).
12. **Pill “Planos · N” e overlay**: um pill na linha de título da timeline
    mostra a contagem de planos **ativos** e abre um overlay com todos os
    planos de todos os projetos e sessões, **ordenados por projeto** (com
    cabeçalho a cada troca, mesmo entre páginas) e com **filtro de projetos em
    multiselect** — o painel continua em lista plana (o slot `session.header`
    coloca pills de plugins diferentes lado a lado; `window.bottom` empilharia). Não há atalho de teclado nem
    comando na paleta. Reusa o mesmo corpo do
    painel; a diferença são os filtros (**Projeto | Tudo**, default **Tudo**) e
    a ausência das ações que dependem de sessão (criar, mover, hint de salvar).
    O botão **Abrir sessão** leva à sessão dona do plano; **Executar** roda na
    sessão do plano, **sem mover**. Consulta só o servidor builtin, porque o
    `plans.db` é local a ele.

### Criação e edição pela UI

O botão **Novo plano** abre um editor com título, objetivo/contexto e lista de
passos. O botão **Editar** no detalhe reabre o mesmo editor. Salvar grava direto
via RPC `save`, sem depender do agente: o body é recomposto com `## Passos` e os
status existentes são preservados por texto. O botão **Salvar do agente**
continua como ação secundária (hint) para planos gerados em conversa.

### Injeção e cache

O plugin escreve no request em dois lugares, com regras opostas:

- **System (constante):** `Plans routing`, re-empurrada byte-idêntica em todo
  request. Empurrar só uma vez faz o head encolher no request seguinte e força
  um re-prefill completo da conversa; notes e memory seguem a mesma regra.
- **Tail (dinâmico):** o bloco `<plans-context>` com o plano da sessão e os
  pendentes é anexado à última mensagem do usuário, e só quando o request tem
  uma parte de compactação. Dado dinâmico nunca vai para o system: mudaria o
  prefixo a cada `plans.update`.

Não há nudge pós-turno. A obrigação de salvar vem da regra no system, que
compete no mesmo nível com o “Do not modify any other files” do Plan mode e
diz explicitamente que `plans.db` não é arquivo do repositório.

### Agente próprio (opcional)

O plugin não cria agentes em runtime; o editor só atualiza/remove agentes
existentes. Quem quiser um agente de planejamento dedicado pode defini-lo em
`opencode.jsonc` (`agents`). O plugin não injeta instruções nele; o fluxo
UI → Build não depende disso.

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

## Work items, iniciativas e execução (F4)

- **Backlog** (`work.*`): `work.list`/`work.get` leem a **iniciativa** resolvida
  pelo diretório (corpo do item em `<work-item-body>`, tratado como dado) e
  `work.save`/`work.update` escrevem — no máximo **3 itens por pedido**, dedupe
  por título normalizado + pai + status não-terminal, `origin=agent`; fechar
  (`done`/`dropped`) só com o planner ou o usuário.
- **Iniciativas**: **Nova iniciativa** no topo da superfície (nome + um ou mais
  repositórios; o primeiro é primário) e **Gerenciar iniciativa** para renomear,
  adicionar/remover repositórios e trocar o primário.
- **Superfície Trabalho** (overlay): lista, quadro por status e **grafo de
dependências**; com uma iniciativa selecionada, **Executar iniciativa**. O
  grafo cria/remove dependências explícitas (seta do dependente para a
  dependência) e mostra as implícitas tracejadas, read-only.
- **Planejar**: sem plano, um popup lista os **projetos do OpenCode** e aceita um
  caminho novo; o path vira repositório da iniciativa, fica no item e a sessão
  abre nele. Com plano, o Planejar reabre a sessão do plano.
- **Run**: o pré-voo exige repositório git, `base_ref`, nenhum run ativo, itens `ready`
  com plano `active` e grafo acíclico. O run cria `run/<id>` (integração) e, por
  item, um worktree + branch `wi/<item>` a partir do **tip da integração**; a
  sessão do executor roda nesse diretório e o plano é a fonte da verdade.
- **Fila de merge**: item concluído é **enfileirado**, nunca mergeado pelo
  engine. Uma **sessão única** (worktree de integração) drena com
  `merge.list/next/done/fail`: claim FIFO com um `merging` por vez,
  `merge.done` confere `merge-base --is-ancestor` e grava o SHA; `merge.fail`
  para a fila e deixa o run falhar. A **base nunca muda**; dependentes só
  começam quando a dependência está `merged`.
- **Dependências implícitas**: `plans.save` aceita `touches` (arquivos/globs);
  interseção vira aresta `kind='implicit'` na direção determinística
  (rank → created_at → id); footprint vazio conflita com tudo e serializa.
- **Cancelar/retry/restart**: cancelar interrompe as sessões e fecha os itens;
  retry recria a branch do tip; ao subir, runs `running` viram `interrupted` e
  merges em voo voltam para `queued` (sem retomada automática).

## Dados

```
~/.local/share/opencode/plans/plans.db   # padrão
$PLANS_DB                                # override (testes/isolamento)
```

Schema (v7):

- `plans` — id, project_id, project_directory, session_id, message_id, title,
  body (template com `<!-- plans:steps -->`), status, created_at, updated_at,
  completed_at, work_item_id.
- `plan_steps` — plan_id, position, step_id, text, status
  (`todo` | `doing` | `done`).
- `plan_touches` — plan_id, path (footprint declarado).
- `initiatives` / `initiative_repos` — iniciativa (N repositórios) e
  `base_branch`, `max_parallel`, `verify_command`.
- `work_items`, `work_item_deps` (kind/reason) — necessidades, hierarquia,
  ordem e dependências explícitas/implícitas.
- `runs`, `run_items`, `merge_queue` — execução da iniciativa (F4).

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
index.ts                 registra tools + /save-plan + RPC
plans.ts                 definições das tools plans.*
src/store.ts             camada única: node:sqlite, schema, migrações, SQL
src/rpc.ts               handlers RPC do servidor (list/read/write)
src/capture.ts           extrai o último plano do agente Plan da sessão
src/inject.ts            regra de routing (system) + bloco pós-compactação (tail)
src/gui.tsx              ./gui-experimental → setup
src/gui/contract.ts      contrato RPC + schemas
src/gui/setup.tsx        painel, comando e menu
src/gui/view.tsx         UI SolidJS
src/gui/i18n.ts          PT-BR / EN-US
test/                    bun tests
dist/gui-experimental.cjs  GUI compilado (gitignored)
```
