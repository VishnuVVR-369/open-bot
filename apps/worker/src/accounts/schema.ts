import type { v2 } from "@open-bot/agent";
import { integration, type AccountConnectionKind } from "@open-bot/shared";

/** How an integration's tools are described to teammates: JSON Schema, in one namespace. */

export type JsonSchema = v2.DynamicToolFunctionSpec["inputSchema"];
export type NamespaceSpec = Extract<v2.DynamicToolSpec, { type: "namespace" }>;
export type NamespaceTool = NamespaceSpec["tools"][number];

const account: JsonSchema = {
  type: "string",
  description:
    "Only when the user connected several of this kind: which one, by the account id AGENTS.md lists for it. An email address or workspace name works too, when only one matches.",
};

export const emails = (description: string): JsonSchema => ({
  type: "array",
  items: { type: "string", format: "email" },
  description,
});

export const time = (description: string): JsonSchema => ({ type: "string", description });

/**
 * One tool in a namespace. Account tools load on demand (tool search), so they don't crowd every
 * prompt. `open` lets arguments the schema doesn't name through, for tools that pass them on to
 * the provider as they are.
 */
export function tool(
  name: string,
  description: string,
  properties: Record<string, JsonSchema>,
  required: string[] = [],
  open = false,
): NamespaceTool {
  return {
    type: "function",
    name,
    description,
    inputSchema: {
      type: "object",
      properties: { ...properties, account },
      required,
      additionalProperties: open,
    },
    deferLoading: true,
  };
}

/** An integration's namespace, named as shared's definition names it. */
export function namespace(
  kind: AccountConnectionKind,
  description: string,
  tools: NamespaceTool[],
): NamespaceSpec {
  return { type: "namespace", name: integration(kind).namespace, description, tools };
}
