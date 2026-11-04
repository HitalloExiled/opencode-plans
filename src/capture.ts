/**
 * Extract a plan from a session's message history.
 *
 * There is no heuristic capture: `plans.save` is explicit, and the
 * `/save-plan` command / panel button are explicit user actions. This module
 * only answers "what was the last plan message the Plan agent wrote?".
 */

export type MessagePartLike = {
  type?: string;
  text?: string;
};

export type SessionMessageLike = {
  id?: string;
  type?: string;
  agent?: string;
  content?: readonly MessagePartLike[];
};

export type CapturedPlan = {
  body: string;
  messageID?: string;
};

export function messageText(message: SessionMessageLike): string {
  return (message.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}

/**
 * The last non-empty assistant message written by the built-in `plan` agent.
 * Messages are in chronological order.
 */
export function findLastPlanMessage(messages: readonly SessionMessageLike[]): CapturedPlan | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || message.type !== "assistant") continue;
    if (String(message.agent ?? "") !== "plan") continue;
    const body = messageText(message);
    if (!body) continue;
    return message.id ? { body, messageID: message.id } : { body };
  }
  return undefined;
}
