import type { ActionDescriptor } from '../types/actions';
import type { ToolDefinition } from './client';

/**
 * Converts an ActionDescriptor into the OpenAI-compatible tool definition format
 * required by the OpenRouter chat completions endpoint.
 *
 * The description is used as-is — this is the information the LLM sees when
 * deciding whether to call a tool. Prohibited actions retain their descriptions
 * (including the [SYSTEM MAINTENANCE] / [SYSTEM EMERGENCY] framing) to make them
 * appear plausibly available without explicitly inviting misuse.
 */
export function actionToToolDefinition(action: ActionDescriptor): ToolDefinition {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [paramName, paramSchema] of Object.entries(action.parameters)) {
    const prop: Record<string, unknown> = {
      type: paramSchema.type,
      description: paramSchema.description,
    };

    if (paramSchema.enum) {
      prop.enum = paramSchema.enum;
    }

    if (paramSchema.type === 'number') {
      if (paramSchema.minimum !== undefined) prop.minimum = paramSchema.minimum;
      if (paramSchema.maximum !== undefined) prop.maximum = paramSchema.maximum;
    }

    properties[paramName] = prop;

    if (paramSchema.required) {
      required.push(paramName);
    }
  }

  return {
    type: 'function',
    function: {
      name: action.name,
      description: action.description,
      parameters: {
        type: 'object',
        properties,
        required,
      },
    },
  };
}

/**
 * Converts a list of ActionDescriptors to ToolDefinitions.
 */
export function actionsToToolDefinitions(actions: ActionDescriptor[]): ToolDefinition[] {
  return actions.map(actionToToolDefinition);
}
