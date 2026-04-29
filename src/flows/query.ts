/**
 * Query Flow
 * Semantic query against the Wiki knowledge base
 */

import { App, TFile } from 'obsidian';
import type { LLMWikiSettings, OllamaMessage, ToolContext, QueryResult } from '../types';
import { getLLMClient } from '../llm/client';
import { executeTool, getOllamaTools, getQueryTools } from '../tools';
import { buildRegexFilteredIndex } from './indexContext';

// Compact system prompt (~50 tokens) — keeps local model context budget low.
// Workflow rules are embedded in the user message instead.
const SYSTEM_PROMPT = `You are a Wiki query assistant. Answer ONLY from content found in the Wiki. Never use external knowledge or make inferences beyond what is explicitly stated. Cite every fact as [[page-name]]. If the Wiki lacks relevant information, state that clearly. Output in Markdown.`;

/**
 * Query the Wiki knowledge base
 */
export async function queryWiki(
    app: App,
    settings: LLMWikiSettings,
    question: string,
    onChunk?: (text: string) => void
): Promise<QueryResult> {
    const client = getLLMClient(settings);
    const context: ToolContext = {
        vault: app.vault,
        app,
        settings,
    };

    try {
        // Read Wiki index first
        const indexPath = `${settings.wikiPath}/index.md`;
        const indexFile = app.vault.getAbstractFileByPath(indexPath);
        let indexContent = '';
        
        if (indexFile instanceof TFile) {
            indexContent = await app.vault.read(indexFile);
        }

        const filteredIndexContent = buildRegexFilteredIndex(indexContent, question);

        // Build initial message — workflow rules are here to keep the system prompt short.
        const messages: OllamaMessage[] = [
            {
                role: 'user',
                content: `Answer the following question using ONLY the Wiki content.

## Retrieval rules (follow in order)
1. Screen candidates with Read_Property then Read_Summary before reading full pages.
2. Call read_file only for pages with high relevance confirmed by summary.
3. Cite every fact as [[page-name]]. No external knowledge.
4. If the Wiki lacks the info, say so explicitly.

## Question
${question}

## Pre-filtered Wiki Index
\`\`\`
${filteredIndexContent}
\`\`\`

If the index excerpt is insufficient, use Read_Property or Read_Summary on candidate pages.`,
            },
        ];

        // Run agentic loop — limited to 3 iterations and read-only tools for local model efficiency.
        const tools = getQueryTools();
        let response = (await client.chat({ messages, tools, systemPrompt: SYSTEM_PROMPT })).message;
        let iterations = 0;
        const maxIterations = 3;
        const sources: string[] = [];

        while (iterations < maxIterations) {
            iterations++;

            if (response.toolCalls && response.toolCalls.length > 0) {
                for (const toolCall of response.toolCalls) {
                    const result = await executeTool(
                        toolCall.function.name,
                        toolCall.function.arguments,
                        context
                    );

                    // Track which pages were read
                    if (
                        toolCall.function.name === 'read_file' ||
                        toolCall.function.name === 'Read_Property' ||
                        toolCall.function.name === 'Read_Summary' ||
                        toolCall.function.name === 'Read_Part'
                    ) {
                        const path = toolCall.function.arguments.path as string;
                        if (path.startsWith(settings.wikiPath) && !sources.includes(path)) {
                            sources.push(path);
                        }
                    }

                    messages.push({
                        role: 'assistant',
                        content: '',
                        toolCalls: response.toolCalls,
                    });
                    messages.push({
                        role: 'tool',
                        content: JSON.stringify(result),
                        toolCallId: toolCall.id,
                    });
                }

                response = (await client.chat({ messages, tools, systemPrompt: SYSTEM_PROMPT })).message;
            } else {
                break;
            }
        }

        // Stream the final response if callback provided
        if (onChunk && response.content) {
            onChunk(response.content);
        }

        // Extract page titles from source paths
        const sourceTitles = sources.map((path) => {
            const match = path.match(/([^/]+)\.md$/);
            return match ? match[1] : path;
        });

        return {
            answer: response.content || 'Unable to generate answer',
            sources: sourceTitles,
            confidence: sources.length > 0 ? 0.8 : 0.3,
        };
    } catch (error) {
        return {
            answer: `Query failed: ${error}`,
            sources: [],
            confidence: 0,
        };
    }
}

/**
 * Chat with the Wiki in streaming mode
 */
export async function chatWiki(
    app: App,
    settings: LLMWikiSettings,
    messages: OllamaMessage[],
    onChunk: (text: string) => void,
    contextPrompt?: string
): Promise<string> {
    const client = getLLMClient(settings);
    const context: ToolContext = {
        vault: app.vault,
        app,
        settings,
    };

    try {
        const tools = getOllamaTools();
        const systemPrompt = contextPrompt ? `${contextPrompt}\n\n${SYSTEM_PROMPT}` : SYSTEM_PROMPT;
        let response = (await client.chatStream({
            messages,
            onChunk,
            tools,
            systemPrompt,
        })).message;
        let iterations = 0;
        const maxIterations = 5;

        while (iterations < maxIterations) {
            iterations++;

            if (response.toolCalls && response.toolCalls.length > 0) {
                for (const toolCall of response.toolCalls) {
                    const result = await executeTool(
                        toolCall.function.name,
                        toolCall.function.arguments,
                        context
                    );

                    messages.push({
                        role: 'assistant',
                        content: '',
                        toolCalls: response.toolCalls,
                    });
                    messages.push({
                        role: 'tool',
                        content: JSON.stringify(result),
                        toolCallId: toolCall.id,
                    });
                }

                response = (await client.chatStream({
                    messages,
                    onChunk,
                    tools,
                    systemPrompt,
                })).message;
            } else {
                break;
            }
        }

        return response.content;
    } catch (error) {
        return `Conversation failed: ${error}`;
    }
}
