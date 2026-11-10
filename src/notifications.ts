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
  "plan.nudge":
    "You presented a final plan but did not call plans.save. Call plans.save now with the plan you just presented; do not ask and do not replan.",
  "plan.nudge.action": "Plan not saved",
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
  "plan.nudge":
    "Você apresentou um plano final mas não chamou plans.save. Chame plans.save agora com o plano que acabou de apresentar; não pergunte e não replaneje.",
  "plan.nudge.action": "Plano não salvo",
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
