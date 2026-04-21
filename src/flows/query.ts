/**
 * Query Flow
 * Semantic query against the Wiki knowledge base
 */

import { App, TFile } from 'obsidian';
import type { LLMWikiSettings, OllamaMessage, ToolContext, QueryResult } from '../types';
import { getOllamaClient } from '../ollama/client';
import { executeTool, getOllamaTools } from '../tools';

const SYSTEM_PROMPT = `You are a knowledge base query assistant. Your task is to answer user questions and provide accurate citation sources.

## Workflow
1. First read the Wiki index (index.md) to understand the knowledge base structure
2. Locate relevant Wiki pages based on the question
3. Read the detailed content of relevant pages
4. Synthesize accurate answers from multiple sources
5. Mark citation sources in the answer using [[page name]] format

## Answer Guidelines
- Answers should be accurate and concise
- Must cite information sources
- Clearly state if information is uncertain
- Use Markdown format
- Use [[wikilinks]] syntax for related concepts

## Available Tools
- read_file: Read file contents
- search_files: Search file contents
- list_files: List directory files`;

/**
 * Query the Wiki knowledge base
 */
export async function queryWiki(
    app: App,
    settings: LLMWikiSettings,
    question: string,
    onChunk?: (text: string) => void
): Promise<QueryResult> {
    const client = getOllamaClient(settings.ollamaUrl, settings.model);
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

        // Build initial message
        const messages: OllamaMessage[] = [
            {
                role: 'user',
                content: `Please answer the following question:

## Question
${question}

## Wiki Index
\`\`\`
${indexContent || '(Wiki is empty)'}
\`\`\`

Please first locate relevant pages, then read the content to answer the question.`,
            },
        ];

        // Run agentic loop
        const tools = getOllamaTools();
        let response = await client.chat(messages, tools, SYSTEM_PROMPT);
        let iterations = 0;
        const maxIterations = 5;
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
                    if (toolCall.function.name === 'read_file') {
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

                response = await client.chat(messages, tools, SYSTEM_PROMPT);
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
    const client = getOllamaClient(settings.ollamaUrl, settings.model);
    const context: ToolContext = {
        vault: app.vault,
        app,
        settings,
    };

    try {
        const tools = getOllamaTools();
        const systemPrompt = contextPrompt ? `${contextPrompt}\n\n${SYSTEM_PROMPT}` : SYSTEM_PROMPT;
        let response = await client.chatStream(messages, onChunk, tools, systemPrompt);
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

                response = await client.chatStream(messages, onChunk, tools, SYSTEM_PROMPT);
            } else {
                break;
            }
        }

        return response.content;
    } catch (error) {
        return `Conversation failed: ${error}`;
    }
}
