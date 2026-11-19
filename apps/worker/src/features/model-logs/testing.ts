// Requests and streams shaped like Codex's and the Responses API's, for the model proxy's tests.

export const user = (text: string) => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});

/** A request body shaped like Codex's, on a thread and turn. */
export function codexBody(thread: string, turn: string, input: unknown[]) {
  return {
    model: "gpt-6.1-sol",
    instructions: "You are Codex.",
    input,
    tools: [{ type: "function", name: "exec_command", parameters: {} }],
    tool_choice: "auto",
    parallel_tool_calls: true,
    store: false,
    stream: true,
    prompt_cache_key: thread,
    client_metadata: {
      thread_id: thread,
      turn_id: turn,
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: thread,
        turn_id: turn,
        request_kind: "turn",
      }),
    },
  };
}

export function sseEvent(data: Record<string, unknown>) {
  return `event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** The events a turn streams, split where the stand-in pauses: after the first one. */
export function turnEvents(text: string): [string, string] {
  return [
    sseEvent({ type: "response.created", response: { id: "resp_1", model: "gpt-6.1-sol" } }),
    sseEvent({
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        role: "assistant",
        id: "msg_1",
        content: [{ type: "output_text", text }],
      },
    }) +
      sseEvent({
        type: "response.completed",
        response: {
          id: "resp_1",
          status: "completed",
          usage: {
            input_tokens: 12_000,
            input_tokens_details: { cached_tokens: 2_000 },
            output_tokens: 300,
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      }),
  ];
}
