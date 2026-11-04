# opencode-plans

Plugin do [OpenCode](https://opencode.ai) (V2) que persiste **planos do modo
Plan** em um SQLite dedicado e os expõe de duas formas:

- **Tools tipadas** no namespace `plans` — `save`, `list`, `get`, `update`,
  `delete`, `doctor`;
- **Painel lateral “Planos”** no app desktop, com lista, progresso, checklist
  e o Markdown original.

A gravação é sempre explícita: o agente Plan chama `plans.save` ao apresentar
um plano final, ou o usuário usa `/save-plan` / o botão **Salvar último plano**.
Não há captura heurística de toda resposta do Plan.

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
externa: tools e GUI leem/gravam o `plans.db` com o `node:sqlite` embutido no
runtime (in-process, síncrono) — o mesmo backend no processo Bun das tools e no
processo principal do Electron.

O repo `opencode-tools` consome este projeto como **git submodule** em
`plugins/plans` e faz o symlink via `setup.sh` (que também roda o `npm install`
e o `npm run gui:build`).

## O que o plugin faz

1. **Persiste um plano** (`plans.save`) com título, Markdown, passos e vínculo
   ao projeto/sessão. O `plans.save` aceita `id` para atualizar um plano
   existente.
2. **Lista e lê planos** (`plans.list`, `plans.get`) por projeto e status.
3. **Marca progresso** (`plans.update`): passos `todo`/`done` e status do
   plano (`active`, `done`, `abandoned`, `superseded`). Quando todos os passos
   ficam `done`, o plano vira `done`.
4. **Injeta contexto**: agentes fora do Plan recebem um bloco curto com os
   planos ativos do projeto e os passos pendentes do plano da sessão.
5. **Painel lateral**: lista por projeto, progresso, checklist interativo,
   ações (concluir, reabrir, arquivar, remover) e Markdown do plano.
6. **Salvar o último plano**: `/save-plan` (servidor) e o botão do painel
   usam a última mensagem do agente `plan` na sessão.

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

Schema (v1):

- `plans` — id, project_id, project_directory, session_id, message_id, title,
  body, status, created_at, updated_at, completed_at.
- `plan_steps` — plan_id, position, step_id, text, status.

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
index.ts                 registra tools + /save-plan + injeção de contexto
plans.ts                 definições das tools plans.*
src/store.ts             camada única: node:sqlite, schema, migrações, SQL
src/capture.ts           extrai o último plano do agente Plan da sessão
src/inject.ts            blocos injetados no Plan e nos demais agentes
src/gui.tsx              ./gui-experimental → { main, setup }
src/gui/main.ts          provider IPC (PlansApi) sobre o store
src/gui/contract.ts      contrato IPC + schemas
src/gui/setup.tsx        painel, comando e menu
src/gui/view.tsx         UI SolidJS
src/gui/i18n.ts          PT-BR / EN-US
test/                    bun tests
dist/gui-experimental.cjs  GUI compilado (gitignored)
```
