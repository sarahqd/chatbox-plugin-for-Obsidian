/**
 * Query Flow
 * Semantic query against the Wiki knowledge base
 */

import type { App, TFile } from 'obsidian';
import type { LLMWikiSettings, OllamaMessage, ToolContext, QueryResult } from '../types';
import { getOllamaClient } from '../ollama/client';
import { executeTool, getOllamaTools } from '../tools';

const SYSTEM_PROMPT = `你是一个知识库查询助手。你的任务是回答用户的问题，并提供准确的引用来源。

## 工作流程
1. 首先阅读 Wiki 索引 (index.md) 了解知识库结构
2. 根据问题定位相关的 Wiki 页面
3. 读取相关页面的详细内容
4. 综合多个来源生成准确的回答
5. 在回答中标注引用来源，使用 [[页面名]] 格式

## 回答规范
- 回答要准确、简洁
- 必须标注信息来源
- 如果信息不确定，明确说明
- 使用 Markdown 格式
- 相关概念使用 [[双链]] 语法

## 可用工具
- read_file: 读取文件内容
- search_files: 搜索文件内容
- list_files: 列出目录文件`;

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
                content: `请回答以下问题：

## 问题
${question}

## Wiki 索引
\`\`\`
${indexContent || '(Wiki 为空)'}
\`\`\`

请先定位相关页面，然后读取内容来回答问题。`,
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
            answer: response.content || '无法生成回答',
            sources: sourceTitles,
            confidence: sources.length > 0 ? 0.8 : 0.3,
        };
    } catch (error) {
        return {
            answer: `查询失败: ${error}`,
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
        return `对话失败: ${error}`;
    }
}