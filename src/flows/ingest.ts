/**
 * Ingest Flow
 * Incremental ingestion of new documents into the Wiki
 */

import type { App, TFile } from 'obsidian';
import type { LLMWikiSettings, OllamaMessage, ToolContext, IngestResult } from '../types';
import { getOllamaClient } from '../ollama/client';
import { executeTool, getOllamaTools } from '../tools';

const SYSTEM_PROMPT = `你是一个知识库管理助手。你的任务是将新的文档内容整合到现有的 Wiki 知识库中。

## 工作流程
1. 分析新文档，提取关键信息、实体和概念
2. 检查 Wiki 索引，查找相关联的现有页面
3. 决定是创建新页面还是更新现有页面
4. 使用提供的工具执行文件操作
5. 确保添加适当的 [[双向链接]]

## Wiki 页面规范
- 每个页面必须有 YAML frontmatter
- 使用 [[双链]] 语法连接相关概念
- 保持内容简洁、结构化
- 为每个页面提供简短摘要

## 可用工具
你可以使用以下工具来操作文件和 Wiki：
- read_file: 读取文件内容
- write_file: 写入文件
- list_files: 列出目录文件
- search_files: 搜索文件内容
- create_wiki_page: 创建新的 Wiki 页面
- update_wiki_page: 更新现有 Wiki 页面
- add_backlink: 添加双向链接
- update_index: 更新 Wiki 索引
- log_operation: 记录操作日志

请根据需要调用这些工具来完成任务。`;

/**
 * Ingest a file into the Wiki
 */
export async function ingestFile(
    app: App,
    settings: LLMWikiSettings,
    filePath: string,
    onProgress?: (message: string) => void
): Promise<IngestResult> {
    const client = getOllamaClient(settings.ollamaUrl, settings.model);
    const context: ToolContext = {
        vault: app.vault,
        app,
        settings,
    };

    try {
        // Step 1: Read the source file
        onProgress?.(`正在读取文件: ${filePath}`);
        const file = app.vault.getAbstractFileByPath(filePath);
        if (!(file instanceof TFile)) {
            return {
                success: false,
                sourcePath: filePath,
                operation: 'skip',
                entities: [],
                message: '文件不存在',
            };
        }

        const content = await app.vault.read(file);

        // Step 2: Read Wiki index for context
        let indexContent = '';
        const indexPath = `${settings.wikiPath}/index.md`;
        const indexFile = app.vault.getAbstractFileByPath(indexPath);
        if (indexFile instanceof TFile) {
            indexContent = await app.vault.read(indexFile);
        }

        // Step 3: Ask LLM to process the document
        onProgress?.('正在分析文档内容...');
        const messages: OllamaMessage[] = [
            {
                role: 'user',
                content: `请将以下文档内容整合到 Wiki 中。

## 源文件路径
${filePath}

## 文档内容
\`\`\`
${content}
\`\`\`

## 当前 Wiki 索引
\`\`\`
${indexContent || '(Wiki 为空)'}
\`\`\`

请分析文档，提取关键实体和概念，并创建或更新相应的 Wiki 页面。`,
            },
        ];

        // Step 4: Run agentic loop with tool calling
        const tools = getOllamaTools();
        let response = await client.chat(messages, tools, SYSTEM_PROMPT);
        let iterations = 0;
        const maxIterations = 10;
        const entities: string[] = [];

        while (iterations < maxIterations) {
            iterations++;

            if (response.toolCalls && response.toolCalls.length > 0) {
                // Process tool calls
                for (const toolCall of response.toolCalls) {
                    onProgress?.(`执行工具: ${toolCall.function.name}`);
                    
                    const result = await executeTool(
                        toolCall.function.name,
                        toolCall.function.arguments,
                        context
                    );

                    // Extract entities from tool calls
                    if (toolCall.function.name === 'create_wiki_page') {
                        const title = toolCall.function.arguments.title as string;
                        entities.push(title);
                    }

                    // Add tool result to messages
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

                // Get next response
                response = await client.chat(messages, tools, SYSTEM_PROMPT);
            } else {
                // No tool calls, we're done
                break;
            }
        }

        // Step 5: Update the Wiki index
        onProgress?.('正在更新 Wiki 索引...');
        await executeTool('update_index', {}, context);

        // Step 6: Log the operation
        await executeTool(
            'log_operation',
            {
                type: 'ingest',
                source: filePath,
                operation: '文档摄取',
                entities: entities.join(','),
                status: 'success',
                message: `成功摄取文档，创建了 ${entities.length} 个页面`,
            },
            context
        );

        return {
            success: true,
            sourcePath: filePath,
            operation: entities.length > 0 ? 'create' : 'update',
            entities,
            message: `成功摄取文档，提取了 ${entities.length} 个实体`,
        };
    } catch (error) {
        return {
            success: false,
            sourcePath: filePath,
            operation: 'skip',
            entities: [],
            message: String(error),
        };
    }
}

/**
 * Ingest raw content into the Wiki
 */
export async function ingestContent(
    app: App,
    settings: LLMWikiSettings,
    content: string,
    title?: string,
    onProgress?: (message: string) => void
): Promise<IngestResult> {
    const client = getOllamaClient(settings.ollamaUrl, settings.model);
    const context: ToolContext = {
        vault: app.vault,
        app,
        settings,
    };

    try {
        // Read Wiki index for context
        let indexContent = '';
        const indexPath = `${settings.wikiPath}/index.md`;
        const indexFile = app.vault.getAbstractFileByPath(indexPath);
        if (indexFile instanceof TFile) {
            indexContent = await app.vault.read(indexFile);
        }

        onProgress?.('正在分析内容...');
        const messages: OllamaMessage[] = [
            {
                role: 'user',
                content: `请将以下内容整合到 Wiki 中。

${title ? `## 标题\n${title}\n\n` : ''}## 内容
\`\`\`
${content}
\`\`\`

## 当前 Wiki 索引
\`\`\`
${indexContent || '(Wiki 为空)'}
\`\`\`

请分析内容，提取关键实体和概念，并创建或更新相应的 Wiki 页面。`,
            },
        ];

        const tools = getOllamaTools();
        let response = await client.chat(messages, tools, SYSTEM_PROMPT);
        let iterations = 0;
        const maxIterations = 10;
        const entities: string[] = [];

        while (iterations < maxIterations) {
            iterations++;

            if (response.toolCalls && response.toolCalls.length > 0) {
                for (const toolCall of response.toolCalls) {
                    onProgress?.(`执行工具: ${toolCall.function.name}`);
                    
                    const result = await executeTool(
                        toolCall.function.name,
                        toolCall.function.arguments,
                        context
                    );

                    if (toolCall.function.name === 'create_wiki_page') {
                        const pageTitle = toolCall.function.arguments.title as string;
                        entities.push(pageTitle);
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

        await executeTool('update_index', {}, context);

        await executeTool(
            'log_operation',
            {
                type: 'ingest',
                operation: '内容摄取',
                entities: entities.join(','),
                status: 'success',
                message: `成功摄取内容，创建了 ${entities.length} 个页面`,
            },
            context
        );

        return {
            success: true,
            sourcePath: '(剪贴板)',
            operation: entities.length > 0 ? 'create' : 'update',
            entities,
            message: `成功摄取内容，提取了 ${entities.length} 个实体`,
        };
    } catch (error) {
        return {
            success: false,
            sourcePath: '(剪贴板)',
            operation: 'skip',
            entities: [],
            message: String(error),
        };
    }
}