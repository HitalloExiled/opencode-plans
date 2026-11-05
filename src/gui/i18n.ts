/* ------------------------------------------------------------------ */
/* i18n                                                               */
/* ------------------------------------------------------------------ */

/**
 * Localization for the Plans GUI, following the OpenCode locale but
 * supporting only `pt-br` and `en-us`; everything else falls back to
 * `en-us`. Keys missing from the pt-br table are served from en-us, so an
 * incomplete translation never loses a string.
 */

import { usePlugin } from "@opencode/plugin/gui";

type Table = Record<string, string>;

const EN: Table = {
  title: "Plans",
  saveLast: "Save last plan",
  refresh: "Refresh",
  project: "Project",
  "search.label": "Search plans",
  "search.placeholder": "Search plans…",
  "filters.label": "Plan filters",
  "filters.scope": "Plan scope",
  "scope.session": "This session",
  "scope.project": "Project",
  "status.active": "Active",
  "status.done": "Done",
  "status.archived": "Archived",
  "status.superseded": "Superseded",
  "filter.active": "Active",
  "filter.done": "Done",
  "filter.all": "All",
  loading: "Loading…",
  "empty.title": "No plans saved here yet",
  "empty.hint":
    "Generate a plan in Plan mode, then use /save-plan or ask the agent to call plans.save.",
  "empty.search": "No plans match your search.",
  "empty.searchHint": "Try a different term.",
  steps: "Steps",
  "step.state": "Step status",
  "step.todo": "To do",
  "step.doing": "Doing",
  "step.done": "Done",
  progress: "{0}/{1} steps",
  "progress.doing": "{0} in progress",
  noSteps: "No structured steps were extracted from this plan.",
  plan: "Plan",
  created: "Created",
  updated: "Updated",
  completed: "Completed",
  session: "Session",
  back: "Back",
  markDone: "Mark as done",
  reopen: "Reopen",
  archive: "Archive",
  remove: "Delete",
  "toast.saved": "Plan saved",
  "toast.saveError": "Could not save the plan",
  "toast.noSession": "No active session",
  "toast.saveRequested": "Saving the last plan…",
  "toast.updated": "Plan updated",
  "toast.updateError": "Could not update the plan",
  "toast.removed": "Plan deleted",
  "toast.removeError": "Could not delete the plan",
  moveToSession: "Move to this session",
  "toast.moved": "Plan moved to this session",
  "toast.moveError": "Could not move the plan",
  "confirm.remove.title": "Delete this plan?",
  "confirm.remove.desc": "This removes the plan and its steps from plans.db. It cannot be undone.",
  "confirm.remove.confirm": "Delete",
};

const PT: Table = {
  title: "Planos",
  saveLast: "Salvar último plano",
  refresh: "Atualizar",
  project: "Projeto",
  "search.label": "Buscar planos",
  "search.placeholder": "Buscar planos…",
  "filters.label": "Filtros de planos",
  "filters.scope": "Escopo dos planos",
  "scope.session": "Esta sessão",
  "scope.project": "Projeto",
  "status.active": "Ativo",
  "status.done": "Concluído",
  "status.archived": "Arquivado",
  "status.superseded": "Substituído",
  "filter.active": "Ativos",
  "filter.done": "Concluídos",
  "filter.all": "Todos",
  loading: "Carregando…",
  "empty.title": "Nenhum plano salvo aqui ainda",
  "empty.hint":
    "Gere um plano no modo Plan, depois use /save-plan ou peça ao agente para chamar plans.save.",
  "empty.search": "Nenhum plano corresponde à busca.",
  "empty.searchHint": "Tente outro termo.",
  steps: "Passos",
  "step.state": "Status do passo",
  "step.todo": "A fazer",
  "step.doing": "Fazendo",
  "step.done": "Feito",
  progress: "{0}/{1} passos",
  "progress.doing": "{0} em andamento",
  noSteps: "Nenhum passo estruturado foi extraído deste plano.",
  plan: "Plano",
  created: "Criado",
  updated: "Atualizado",
  completed: "Concluído",
  session: "Sessão",
  back: "Voltar",
  markDone: "Marcar como concluído",
  reopen: "Reabrir",
  archive: "Arquivar",
  remove: "Remover",
  "toast.saved": "Plano salvo",
  "toast.saveError": "Não foi possível salvar o plano",
  "toast.noSession": "Nenhuma sessão ativa",
  "toast.saveRequested": "Salvando o último plano…",
  "toast.updated": "Plano atualizado",
  "toast.updateError": "Não foi possível atualizar o plano",
  "toast.removed": "Plano removido",
  "toast.removeError": "Não foi possível remover o plano",
  moveToSession: "Mover para esta sessão",
  "toast.moved": "Plano movido para esta sessão",
  "toast.moveError": "Não foi possível mover o plano",
  "confirm.remove.title": "Remover este plano?",
  "confirm.remove.desc": "Isso remove o plano e seus passos do plans.db. Não pode ser desfeito.",
  "confirm.remove.confirm": "Remover",
};

export function useT() {
  const ctx = usePlugin();
  return (key: string, ...args: unknown[]): string => {
    const locale = (ctx.locale.locale() ?? "").toLowerCase();
    const table = locale.startsWith("pt") ? PT : EN;
    let value = table[key] ?? EN[key] ?? key;
    args.forEach((arg, index) => {
      value = value.replaceAll(`{${index}}`, String(arg));
    });
    return value;
  };
}
