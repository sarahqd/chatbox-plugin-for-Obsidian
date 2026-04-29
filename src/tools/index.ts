/**
 * Tool Registry
 * Central registry for all LLM tools
 */

import type { ToolDefinition, ToolContext, OllamaTool } from '../types';
import { fileTools } from './fileTools';
import { wikiTools } from './wikiTools';

/**
 * All registered tools
 */
export const allTools: ToolDefinition[] = [...fileTools, ...wikiTools];

/**
 * Tool registry map for quick lookup
 */
export const toolRegistry = new Map<string, ToolDefinition>();

// Initialize registry
for (const tool of allTools) {
    toolRegistry.set(tool.name, tool);
}

/**
 * Get a tool by name
 */
export function getTool(name: string): ToolDefinition | undefined {
    return toolRegistry.get(name);
}

/**
 * Get all tools as Ollama tool definitions
 */
const _cachedOllamaTools: OllamaTool[] = allTools.map((tool) => ({
    type: 'function' as const,
    function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
    },
}));

export function getOllamaTools(): OllamaTool[] {
    return _cachedOllamaTools;
}

/**
 * Read-only tools for the query flow.
 * Excludes all write/create/update tools to minimise token usage with local models.
 */
const QUERY_TOOL_NAMES = new Set(['read_file', 'Read_Summary', 'Read_Property', 'Read_Part']);

const _cachedQueryTools: OllamaTool[] = allTools
    .filter((tool) => QUERY_TOOL_NAMES.has(tool.name))
    .map((tool) => ({
        type: 'function' as const,
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        },
    }));

export function getQueryTools(): OllamaTool[] {
    return _cachedQueryTools;
}

/**
 * Execute a tool by name
 */
export async function executeTool(
    name: string,
    params: Record<string, unknown>,
    context: ToolContext
): Promise<{ success: boolean; data?: unknown; error?: string }> {
    const tool = toolRegistry.get(name);
    if (!tool) {
        return { success: false, error: `Unknown tool: ${name}` };
    }
    return tool.handler(params, context);
}

/**
 * Get tool descriptions for system prompt
 */
export function getToolDescriptions(): string {
    return allTools
        .map((tool) => {
            const params = Object.entries(tool.parameters.properties)
                .map(([key, value]) => `    - ${key}: ${value.description}`)
                .join('\n');
            return `- ${tool.name}: ${tool.description}\n  Parameters:\n${params}`;
        })
        .join('\n\n');
}