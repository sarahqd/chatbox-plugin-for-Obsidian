/**
 * Lint Flow
 * Automatic maintenance of the Wiki knowledge base
 */

import { App, TFile } from 'obsidian';
import type { LLMWikiSettings, OllamaMessage, ToolContext, LintResult, LintIssue } from '../types';
import { getLLMClient } from '../llm/client';
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
- Read_Summary: Read only the Summary section
- Update_Summary: Modify only the Summary section
- Read_Property: Read only one frontmatter property
- Update_Property: Modify only one frontmatter property
- Update_Content: Modify only the Content section
- Read_Part: Read only one named section
- Update_Part: Modify only one named section
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
    const client = getLLMClient(settings);
    const context: ToolContext = {
        vault: app.vault,
        app,
        settings,
    };

    const issues: LintIssue[] = [];
    let fixed = 0;
    const nowTs = Date.now();
    const lastLintTime = settings.lastLintTime ?? 0;

    try {
        // Step 1: Get all Wiki pages
        onProgress?.('Scanning Wiki directory...');
        const wikiFiles = app.vault.getMarkdownFiles().filter(
            (file) => file.path.startsWith(settings.wikiPath) && 
                     !file.path.endsWith('index.md') && 
                     !file.path.endsWith('log.md')
        );

        const changedFiles = lastLintTime > 0
            ? wikiFiles.filter((file) => file.stat.mtime > lastLintTime)
            : wikiFiles;

        onProgress?.(
            lastLintTime > 0
                ? `Incremental scan: ${changedFiles.length} changed files (of ${wikiFiles.length} total)`
                : `Full scan: ${wikiFiles.length} files`
        );

        // Step 2: Check for broken links in changed files
        onProgress?.('Checking broken links...');
        const pageNames = new Set(
            wikiFiles.map((f) => f.basename)
        );

        for (const file of changedFiles) {
            const cache = app.metadataCache.getFileCache(file);
            const links = cache?.links ?? [];

            for (const link of links) {
                const linkTarget = link.link.split('#')[0].trim();
                if (linkTarget && !pageNames.has(linkTarget)) {
                    issues.push({
                        type: 'broken_link',
                        path: file.path,
                        description: `Broken link: [[${linkTarget}]] does not exist`,
                        suggestion: `Create page "${linkTarget}" or remove the link`,
                    });
                }
            }
        }

        // Step 3: Check for stale pages (monthly check - not updated in 30 days)
        const thirtyDaysInMs = 30 * 24 * 60 * 60 * 1000;
        const lastStaleCheckTime = settings.lastStaleCheckTime ?? 0;
        const shouldCheckStale = Date.now() - lastStaleCheckTime >= thirtyDaysInMs;

        if (shouldCheckStale) {
            onProgress?.('Checking stale pages (monthly check)...');
            const thirtyDaysAgo = Date.now() - thirtyDaysInMs;
            
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
        } else {
            const daysUntilNextCheck = Math.ceil((thirtyDaysInMs - (Date.now() - lastStaleCheckTime)) / (24 * 60 * 60 * 1000));
            onProgress?.(`Stale check skipped (next check in ${daysUntilNextCheck} days)`);
        }

        // Step 4: Use LLM for advanced checks (contradictions, duplicates)
        if (changedFiles.length > 0) {
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

## Changed Pages Since Last Check
${changedFiles.map((file) => `- ${file.path}`).join('\n') || '(None)'}

Please check for:
1. Pages with duplicate content
2. Contradictory statements
3. Other potential issues

If issues are found, please use tools to record or fix them.`,
                },
            ];

            const tools = getOllamaTools();
            let response = (await client.chat({ messages, tools, systemPrompt: SYSTEM_PROMPT })).message;
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

                    response = (await client.chat({ messages, tools, systemPrompt: SYSTEM_PROMPT })).message;
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
                message: `Scanned ${changedFiles.length}/${wikiFiles.length} files, found ${issues.length} issues, fixed ${fixed} of them`,
            },
            context
        );

        return {
            issues,
            fixed,
            pending: issues.length - fixed,
            lastLintTime: nowTs,
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
            lastLintTime: settings.lastLintTime ?? 0,
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
    const client = getLLMClient(settings);
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
        let response = (await client.chat({ messages, tools, systemPrompt: SYSTEM_PROMPT })).message;
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

                response = (await client.chat({ messages, tools, systemPrompt: SYSTEM_PROMPT })).message;
            } else {
                break;
            }
        }

        return true;
    } catch (error) {
        return false;
    }
}