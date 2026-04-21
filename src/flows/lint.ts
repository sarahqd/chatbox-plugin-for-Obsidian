/**
 * Lint Flow
 * Automatic maintenance of the Wiki knowledge base
 */

import { App, TFile } from 'obsidian';
import type { LLMWikiSettings, OllamaMessage, ToolContext, LintResult, LintIssue } from '../types';
import { getOllamaClient } from '../ollama/client';
import { executeTool, getOllamaTools } from '../tools';

const SYSTEM_PROMPT = `You are a knowledge base maintenance assistant. Your task is to detect and fix issues in the Wiki.

## Check Items
1. **Broken link detection**: Check if [[wikilinks]] point to non-existent pages
2. **Contradiction detection**: Check if there are contradictory statements between different pages
3. **Duplicate detection**: Check if there are pages with duplicate content
4. **Stale detection**: Check if there are pages that haven't been updated for a long time

## Fix Principles
- Fix broken links: Create missing pages or remove links
- Resolve contradictions: Mark contradictions and suggest merging
- Merge duplicates: Keep the more complete version
- Update stale: Mark pages that need updating

## Available Tools
- read_file: Read file contents
- write_file: Write to file
- list_files: List directory files
- search_files: Search file contents
- update_wiki_page: Update Wiki page
- log_operation: Log operation record`;

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
        onProgress?.('Scanning Wiki directory...');
        const wikiFiles = app.vault.getMarkdownFiles().filter(
            (file) => file.path.startsWith(settings.wikiPath) && 
                     !file.path.endsWith('index.md') && 
                     !file.path.endsWith('log.md')
        );

        // Step 2: Check for broken links
        onProgress?.('Checking broken links...');
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
                        description: `Broken link: [[${linkTarget}]] does not exist`,
                        suggestion: `Create page "${linkTarget}" or remove the link`,
                    });
                }
            }
        }

        // Step 3: Check for stale pages (not updated in 30 days)
        onProgress?.('Checking stale pages...');
        const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
        
        for (const file of wikiFiles) {
            if (file.stat.mtime < thirtyDaysAgo) {
                issues.push({
                    type: 'stale',
                    path: file.path,
                    description: `Page not updated for over 30 days`,
                    suggestion: `Check if content needs updating`,
                });
            }
        }

        // Step 4: Use LLM for advanced checks (contradictions, duplicates)
        if (wikiFiles.length > 0) {
            onProgress?.('Running intelligent detection...');
            
            const indexPath = `${settings.wikiPath}/index.md`;
            const indexFile = app.vault.getAbstractFileByPath(indexPath);
            let indexContent = '';
            if (indexFile instanceof TFile) {
                indexContent = await app.vault.read(indexFile);
            }

            const messages: OllamaMessage[] = [
                {
                    role: 'user',
                    content: `Please check if the following Wiki has any issues:

## Wiki Index
\`\`\`
${indexContent}
\`\`\`

## Detected Issues
${issues.map((i) => `- [${i.type}] ${i.path}: ${i.description}`).join('\n') || '(None)'}

Please check for:
1. Pages with duplicate content
2. Contradictory statements
3. Other potential issues

If issues are found, please use tools to record or fix them.`,
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
                        onProgress?.(`Executing: ${toolCall.function.name}`);
                        
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
                operation: 'Wiki maintenance check',
                status: 'success',
                message: `Found ${issues.length} issues, fixed ${fixed} of them`,
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
                description: `Check failed: ${error}`,
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
        onProgress?.(`Fixing: ${issue.description}`);

        const messages: OllamaMessage[] = [
            {
                role: 'user',
                content: `Please fix the following issue:

## Issue Type
${issue.type}

## Issue Location
${issue.path}

## Issue Description
${issue.description}

## Suggestion
${issue.suggestion || 'None'}

Please use tools to fix this issue.`,
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