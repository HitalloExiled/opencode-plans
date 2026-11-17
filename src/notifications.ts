/**
 * Localized copy for synthetic messages the plans plugin writes into the
 * session. The GUI passes the interface locale; unknown locales fall back to
 * EN-US, matching the rest of the plugin's UI tables.
 */

export type NotificationLocale = "pt-br" | "en-us";

const EN: Record<string, string> = {
  "plan.status": 'The user marked the plan "{0}" as {1}.',
  "plan.status.action": '{0} the plan "{1}"',
  "plan.updated": 'The user updated the plan "{0}".',
  "plan.updated.action": 'Updated the plan "{0}"',
  "step.status": 'The user marked the step "{0}" as {1} in the plan "{2}" ({3}/{4}).',
  "step.status.action": '{0} the step "{1}" ({2}/{3})',
  "plan.removed": 'The user removed the plan "{0}".',
  "plan.removed.action": 'Removed the plan "{0}"',
  "plan.moved": 'The user moved the plan "{0}" to this session.',
  "plan.moved.action": 'Moved the plan "{0}" to this session',
  "status.done": "done",
  "status.archived": "archived",
  "status.superseded": "superseded",
  "status.active": "reopened",
  "status.done.action": "Completed",
  "status.archived.action": "Archived",
  "status.superseded.action": "Superseded",
  "status.active.action": "Reopened",
  "step.done": "done",
  "step.doing": "in progress",
  "step.todo": "pending",
  "step.done.action": "Completed",
  "step.doing.action": "Started",
  "step.todo.action": "Reopened",
  "save.none":
    "No Plan agent plan was found in this session. Generate a plan in Plan mode and try again.",
  "save.failed": "Failed to save the plan: {0}",
  "save.saved": "Plan saved: {0}",
  "save.id": "id: {0}",
  "save.progress": "{0}/{1} steps completed",
  "work.titleRequired": "Use /work <title> to name the work item.",
  "work.created": 'Work item created: "{0}"',
  "work.project": "project: {0}",
  "work.id": "id: {0}",
  "work.failed": "Failed to create the work item: {0}",
  "run.merge.prompt":
    'You are the single merge session of the run "{0}" (integration branch {1}) in this worktree. Drain the queue: call merge.next; for the returned item, merge its branch into the current branch (git merge --no-edit wi/<item>), resolve conflicts here, run the project verify command when one is configured, then mark it with merge.done. If the merge cannot be completed, call merge.fail with the reason. Never touch the base branch.',
  "run.merge.wake": "A new item was enqueued; call merge.next.",
  "run.merge.manualPrompt":
    'You are the merge session of the repository "{0}". Manual executions wait for a merge: drain the queue with merge.next; for the returned item, merge its branch into this checkout (git merge --no-edit wi/<item>), resolve conflicts here, run the project verify command when one is configured, then mark it with merge.done. If the merge cannot be completed, call merge.fail with the reason. Never touch the base branch.',
  "run.item.prompt":
    'Execute the plan "{0}" (id: {1}) for the work item "{2}" (id: {3}) in this worktree. Read it with plans.get, do the steps and mark them with plans.update ("doing" then "done"). Do not switch branches or merge: the run integrates through the merge queue. When every step is done and nothing is blocked, summarize the result and say it is ready for acceptance; the work item stays doing.',
};

const PT: Record<string, string> = {
  "plan.status": 'O usuário marcou o plano "{0}" como {1}.',
  "plan.status.action": '{0} o plano "{1}"',
  "plan.updated": 'O usuário atualizou o plano "{0}".',
  "plan.updated.action": 'Atualizou o plano "{0}"',
  "step.status": 'O usuário marcou o passo "{0}" como {1} no plano "{2}" ({3}/{4}).',
  "step.status.action": '{0} o passo "{1}" ({2}/{3})',
  "plan.removed": 'O usuário removeu o plano "{0}".',
  "plan.removed.action": 'Removeu o plano "{0}"',
  "plan.moved": 'O usuário moveu o plano "{0}" para esta sessão.',
  "plan.moved.action": 'Moveu o plano "{0}" para esta sessão',
  "status.done": "concluído",
  "status.archived": "arquivado",
  "status.superseded": "substituído",
  "status.active": "reaberto",
  "status.done.action": "Concluiu",
  "status.archived.action": "Arquivou",
  "status.superseded.action": "Substituiu",
  "status.active.action": "Reabriu",
  "step.done": "concluído",
  "step.doing": "em andamento",
  "step.todo": "pendente",
  "step.done.action": "Concluiu",
  "step.doing.action": "Iniciou",
  "step.todo.action": "Reabriu",
  "save.none":
    "Nenhum plano do agente Plan foi encontrado nesta sessão. Gere um plano no modo Plan e tente novamente.",
  "save.failed": "Falha ao salvar o plano: {0}",
  "save.saved": "Plano salvo: {0}",
  "save.id": "id: {0}",
  "save.progress": "{0}/{1} passos concluídos",
  "work.titleRequired": "Use /work <título> para nomear o work item.",
  "work.created": 'Work item criado: "{0}"',
  "work.project": "projeto: {0}",
  "work.id": "id: {0}",
  "work.failed": "Falha ao criar o work item: {0}",
  "run.merge.prompt":
    'Você é a sessão única de merge do run "{0}" (branch de integração {1}) neste worktree. Drene a fila: chame merge.next; para o item retornado, mergeie a branch dele na branch atual (git merge --no-edit wi/<item>), resolva conflitos aqui, rode o comando de verificação do projeto quando configurado e marque com merge.done. Se o merge não puder ser concluído, chame merge.fail com o motivo. Nunca toque na branch base.',
  "run.merge.wake": "Um novo item entrou na fila; chame merge.next.",
  "run.merge.manualPrompt":
    'Você é a sessão de merge do repositório "{0}". Execuções manuais esperam um merge: drene a fila com merge.next; para o item retornado, mergeie a branch dele neste checkout (git merge --no-edit wi/<item>), resolva conflitos aqui, rode o comando de verificação do projeto quando configurado e marque com merge.done. Se o merge não puder ser concluído, chame merge.fail com o motivo. Nunca toque na branch base.',
  "run.item.prompt":
    'Execute o plano "{0}" (id: {1}) do work item "{2}" (id: {3}) neste worktree. Leia com plans.get, faça os passos e marque cada um com plans.update ("doing" e depois "done"). Não troque de branch nem mergeie: o run integra pela fila de merge. Quando todos os passos estiverem concluídos e nada estiver bloqueado, resuma o resultado e diga que está pronto para aceite; o work item continua doing.',
};

const TABLES: Record<NotificationLocale, Record<string, string>> = {
  "en-us": EN,
  "pt-br": PT,
};

/** PT-* locales get pt-br; everything else (including unknown) gets en-us. */
export function notificationLocale(raw?: string | null): NotificationLocale {
  return (raw ?? "").toLowerCase().startsWith("pt") ? "pt-br" : "en-us";
}

export function tn(locale: NotificationLocale, key: string, ...args: unknown[]): string {
  let value = TABLES[locale]?.[key] ?? EN[key] ?? key;
  args.forEach((arg, index) => {
    value = value.replaceAll(`{${index}}`, String(arg));
  });
  return value;
}
