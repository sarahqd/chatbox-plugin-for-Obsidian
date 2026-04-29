/**
 * Query Flow
 * Semantic query against the Wiki knowledge base
 */

import { App, TFile } from 'obsidian';
import type { LLMWikiSettings, OllamaMessage, ToolContext, QueryResult } from '../types';
import { getLLMClient } from '../llm/client';
import { executeTool, getOllamaTools, getQueryTools } from '../tools';
import { buildRegexFilteredIndex } from './indexContext';
import type { WikiSearchEngine } from '../search/WikiSearchEngine';

// Maximum characters per tool result is computed dynamically from the active model's
// context window — see maxToolResultChars inside queryWiki().

// Compact system prompt (~50 tokens) — keeps local model context budget low.
// Workflow rules are embedded in the user message instead.
const SYSTEM_PROMPT = `You are a Wiki query assistant. Answer ONLY from content found in the Wiki. Never use external knowledge or make inferences beyond what is explicitly stated. Cite every fact as [[page-name]]. If the Wiki lacks relevant information, state that clearly. Output in Markdown.`;

/**
 * Build a compact context block from BM25 search results.
 * Pre-fetches Read_Summary I/O for each candidate (no LLM call) so the model
 * can answer in a single pass without tool calls for most queries.
 */
async function buildBM25Context(
    app: App,
    settings: LLMWikiSettings,
    question: string,
    searchEngine: WikiSearchEngine,
    topN = 8
): Promise<{ contextText: string; sources: string[] }> {
    const results = searchEngine.search(question, topN);
    if (results.length === 0) {
        return { contextText: '(No matching pages found in BM25 index)', sources: [] };
    }

    const sources: string[] = [];
    const lines: string[] = [];

    // Fetch summaries for all results in parallel (I/O only, no LLM).
    const summaries = await Promise.all(
        results.map(async (result) => {
            if (result.summary) return result.summary;
            try {
                const file = app.vault.getAbstractFileByPath(result.path);
                if (file instanceof TFile) {
                    const raw = await app.vault.read(file);
                    const m = raw.match(/^## Summary\s*\n([\s\S]*?)(?=^##|\z)/m);
                    return m ? m[1].replace(/\s+/g, ' ').trim() : '';
                }
            } catch (_) { /* ignore read errors */ }
            return '';
        })
    );

    for (let i = 0; i < results.length; i++) {
        const result = results[i];
        sources.push(result.path);
        const summary = summaries[i];

        lines.push(`### [[${result.path.replace(/\.md$/, '')}|${result.title}]]`);
        if (summary) {
            lines.push(summary);
        }
        lines.push('');
    }

    return { contextText: lines.join('\n'), sources };
}

/**
 * Query the Wiki knowledge base.
 *
 * @param searchEngine  Optional pre-built WikiSearchEngine (BM25 in-memory index).
 *                      When provided, replaces the slow index.md full-file read with
 *                      an O(1) in-memory BM25 search — critical for 10k+ document wikis.
 */
export async function queryWiki(
    app: App,
    settings: LLMWikiSettings,
    question: string,
    onChunk?: (text: string) => void,
    searchEngine?: WikiSearchEngine
): Promise<QueryResult> {
    const client = getLLMClient(settings);
    const context: ToolContext = {
        vault: app.vault,
        app,
        settings,
    };

    try {
        let retrievalContext = '';
        let preFetchedSources: string[] = [];

        if (searchEngine?.isReady()) {
            // Fast path: BM25 in-memory search + pre-fetch summaries (zero LLM tokens wasted).
            const { contextText, sources } = await buildBM25Context(app, settings, question, searchEngine);
            retrievalContext = contextText;
            preFetchedSources = sources;
        } else {
            // Fallback: read index.md (TOC of slice files) from the dedicated index directory,
            // then read every slice file it references and concatenate before filtering.
            const idxDir = settings.indexPath || 'WikiIndex';
            const tocFile = app.vault.getAbstractFileByPath(`${idxDir}/index.md`);
            let combinedContent = '';
            if (tocFile instanceof TFile) {
                const tocContent = await app.vault.read(tocFile);
                // Extract wikilink targets: [[idxDir/YYYY-MM|label]] → "idxDir/YYYY-MM"
                const linkRe = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
                let m: RegExpExecArray | null;
                const sliceReads: Promise<string>[] = [];
                while ((m = linkRe.exec(tocContent)) !== null) {
                    const target = m[1].trim();
                    const slicePath = target.endsWith('.md') ? target : `${target}.md`;
                    const sliceFile = app.vault.getAbstractFileByPath(slicePath);
                    if (sliceFile instanceof TFile) {
                        sliceReads.push(app.vault.read(sliceFile));
                    }
                }
                const sliceContents = await Promise.all(sliceReads);
                combinedContent = sliceContents.join('\n\n');
            }
            retrievalContext = buildRegexFilteredIndex(combinedContent, question);
        }

        // Build initial message — workflow rules are here to keep the system prompt short.
        const messages: OllamaMessage[] = [
            {
                role: 'user',
                content: `Answer the following question using ONLY the Wiki content below.
If the provided context is sufficient, answer directly without calling any tools.
Only use Read_Summary or read_file if a specific page not shown below is clearly needed.

## Question
${question}

## Retrieved Wiki Context (BM25 ranked)
${retrievalContext}`,
            },
        ];

        // Run agentic loop — capped at 2 iterations for local model budget.
        // Most queries answer in 0 tool calls when BM25 context is pre-loaded.
        // Compute per-call tool result budget from current model's context window.
        const activeModel = settings.models.find(m => m.id === settings.currentModelId);
        const maxCtx = activeModel?.contextLength || settings.maxContextTokens || 8192;
        const maxToolResultChars = Math.max(1000, Math.floor(maxCtx * 4 * 0.5));
        const tools = getQueryTools();
        let response = (await client.chat({ messages, tools, systemPrompt: SYSTEM_PROMPT })).message;
        let iterations = 0;
        const maxIterations = 2;
        const sources: string[] = [...preFetchedSources];

        while (iterations < maxIterations) {
            iterations++;

            if (response.toolCalls && response.toolCalls.length > 0) {
                // Push assistant message once before executing tool calls (not per-call).
                messages.push({
                    role: 'assistant',
                    content: '',
                    toolCalls: response.toolCalls,
                });

                // Execute all tool calls in parallel — all query tools are read-only.
                const toolResults = await Promise.all(
                    response.toolCalls.map(tc =>
                        executeTool(tc.function.name, tc.function.arguments, context)
                    )
                );

                for (let i = 0; i < response.toolCalls.length; i++) {
                    const toolCall = response.toolCalls[i];
                    const result = toolResults[i];

                    // Track which pages were read
                    if (
                        toolCall.function.name === 'read_file' ||
                        toolCall.function.name === 'Read_Property' ||
                        toolCall.function.name === 'Read_Summary' ||
                        toolCall.function.name === 'Read_Part'
                    ) {
                        const path = toolCall.function.arguments.path as string;
                        if (path && path.startsWith(settings.wikiPath) && !sources.includes(path)) {
                            sources.push(path);
                        }
                    }

                    // Truncate large tool results to prevent context overflow on small models.
                    let resultStr = JSON.stringify(result);
                    if (resultStr.length > maxToolResultChars) {
                        const truncated = { ...result, data: resultStr.slice(0, maxToolResultChars) + '…(truncated)' };
                        resultStr = JSON.stringify(truncated);
                    }

                    messages.push({
                        role: 'tool',
                        content: resultStr,
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
        const activeModel = settings.models.find(m => m.id === settings.currentModelId);
        const maxCtx = activeModel?.contextLength || settings.maxContextTokens || 8192;
        const maxToolResultChars = Math.max(1000, Math.floor(maxCtx * 4 * 0.5));

        while (iterations < maxIterations) {
            iterations++;

            if (response.toolCalls && response.toolCalls.length > 0) {
                // Push assistant message once before executing tool calls (not per-call).
                messages.push({
                    role: 'assistant',
                    content: '',
                    toolCalls: response.toolCalls,
                });

                // Execute all tool calls in parallel.
                const toolResults = await Promise.all(
                    response.toolCalls.map(tc =>
                        executeTool(tc.function.name, tc.function.arguments, context)
                    )
                );

                for (let i = 0; i < response.toolCalls.length; i++) {
                    const toolCall = response.toolCalls[i];
                    let resultStr = JSON.stringify(toolResults[i]);
                    if (resultStr.length > maxToolResultChars) {
                        const truncated = { ...toolResults[i], data: resultStr.slice(0, maxToolResultChars) + '…(truncated)' };
                        resultStr = JSON.stringify(truncated);
                    }
                    messages.push({
                        role: 'tool',
                        content: resultStr,
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
