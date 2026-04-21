/**
 * Lint Flow
 * Automatic maintenance of the Wiki knowledge base
 */

import type { App, TFile } from 'obsidian';
import type { LLMWikiSettings, OllamaMessage, ToolContext, LintResult, LintIssue } from '../types';
import { getOllamaClient } from '../ollama/client';
import { executeTool, getOllamaTools } from '../tools';

const SYSTEM_PROMPT = `你是一个知识库维护助手。你的任务是检测和修复 Wiki 中的问题。

## 检查项目
1. **断链检测**: 检查 [[双链]] 是否指向不存在的页面
2. **矛盾检测**: 检查不同页面间是否存在矛盾的陈述
3. **重复检测**: 检查是否存在内容重复的页面
4. **过期检测**: 检查是否有长时间未更新的页面

## 修复原则
- 修复断链：创建缺失页面或移除链接
- 解决矛盾：标记矛盾并建议合并
- 合并重复：保留更完整的版本
- 更新过期：标记需要更新的页面

## 可用工具
- read_file: 读取文件内容
- write_file: 写入文件
- list_files: 列出目录文件
- search_files: 搜索文件内容
- update_wiki_page: 更新 Wiki 页面
- log_operation: 记录操作日志`;

/**
 * Run lint checks on the Wiki
 */
export async function lintWiki(
    app: App,
    settings: LLMWikiSettings,
    autoFix: boolean = false,
    onProgress?: (message: string) => void
): Promise<LintResult> {
    const client = getOllamaClient(settings.ollamaUrl, settings.model);
    const context: ToolContext = {
        vault: app.vault,
        app,
        settings,
    };

    const issues: LintIssue[] = [];
    let fixed = 0;

    try {
        // Step 1: Get all Wiki pages
        onProgress?.('正在扫描 Wiki 目录...');
        const wikiFiles = app.vault.getMarkdownFiles().filter(
            (file) => file.path.startsWith(settings.wikiPath) && 
                     !file.path.endsWith('index.md') && 
                     !file.path.endsWith('log.md')
        );

        // Step 2: Check for broken links
        onProgress?.('正在检查断链...');
        const pageNames = new Set(
            wikiFiles.map((f) => f.basename)
        );

        for (const file of wikiFiles) {
            const content = await app.vault.read(file);
            const links = content.match(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g) || [];
            
            for (const link of links) {
                const linkTarget = link.replace(/\[\[|\]\]/g, '').split('|')[0];
                if (!pageNames.has(linkTarget)) {
                    issues.push({
                        type: 'broken_link',
                        path: file.path,
                        description: `断链: [[${linkTarget}]] 不存在`,
                        suggestion: `创建页面 "${linkTarget}" 或移除链接`,
                    });
                }
            }
        }

        // Step 3: Check for stale pages (not updated in 30 days)
        onProgress?.('正在检查过期页面...');
        const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
        
        for (const file of wikiFiles) {
            if (file.stat.mtime < thirtyDaysAgo) {
                issues.push({
                    type: 'stale',
                    path: file.path,
                    description: `页面超过 30 天未更新`,
                    suggestion: `检查内容是否需要更新`,
                });
            }
        }

        // Step 4: Use LLM for advanced checks (contradictions, duplicates)
        if (wikiFiles.length > 0) {
            onProgress?.('正在进行智能检测...');
            
            const indexPath = `${settings.wikiPath}/index.md`;
            const indexFile = app.vault.getAbstractFileByPath(indexPath);
            let indexContent = '';
            if (indexFile instanceof TFile) {
                indexContent = await app.vault.read(indexFile);
            }

            const messages: OllamaMessage[] = [
                {
                    role: 'user',
                    content: `请检查以下 Wiki 是否存在问题：

## Wiki 索引
\`\`\`
${indexContent}
\`\`\`

## 已检测问题
${issues.map((i) => `- [${i.type}] ${i.path}: ${i.description}`).join('\n') || '(无)'}

请检查是否存在：
1. 内容重复的页面
2. 相互矛盾的陈述
3. 其他潜在问题

如果发现问题，请使用工具记录或修复。`,
                },
            ];

            const tools = getOllamaTools();
            let response = await client.chat(messages, tools, SYSTEM_PROMPT);
            let iterations = 0;
            const maxIterations = 5;

            while (iterations < maxIterations) {
                iterations++;

                if (response.toolCalls && response.toolCalls.length > 0) {
                    for (const toolCall of response.toolCalls) {
                        onProgress?.(`执行: ${toolCall.function.name}`);
                        
                        const result = await executeTool(
                            toolCall.function.name,
                            toolCall.function.arguments,
                            context
                        );

                        if (result.success) {
                            fixed++;
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
        }

        // Step 5: Log the lint operation
        await executeTool(
            'log_operation',
            {
                type: 'lint',
                operation: 'Wiki 维护检查',
                status: 'success',
                message: `发现 ${issues.length} 个问题，修复了 ${fixed} 个`,
            },
            context
        );

        return {
            issues,
            fixed,
            pending: issues.length - fixed,
        };
    } catch (error) {
        return {
            issues: [{
                type: 'broken_link',
                path: '',
                description: `检查失败: ${error}`,
            }],
            fixed: 0,
            pending: 0,
        };
    }
}

/**
 * Fix a specific lint issue
 */
export async function fixLintIssue(
    app: App,
    settings: LLMWikiSettings,
    issue: LintIssue,
    onProgress?: (message: string) => void
): Promise<boolean> {
    const client = getOllamaClient(settings.ollamaUrl, settings.model);
    const context: ToolContext = {
        vault: app.vault,
        app,
        settings,
    };

    try {
        onProgress?.(`正在修复: ${issue.description}`);

        const messages: OllamaMessage[] = [
            {
                role: 'user',
                content: `请修复以下问题：

## 问题类型
${issue.type}

## 问题位置
${issue.path}

## 问题描述
${issue.description}

## 建议
${issue.suggestion || '无'}

请使用工具修复这个问题。`,
            },
        ];

        const tools = getOllamaTools();
        let response = await client.chat(messages, tools, SYSTEM_PROMPT);
        let iterations = 0;
        const maxIterations = 3;

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

                response = await client.chat(messages, tools, SYSTEM_PROMPT);
            } else {
                break;
            }
        }

        return true;
    } catch (error) {
        return false;
    }
}