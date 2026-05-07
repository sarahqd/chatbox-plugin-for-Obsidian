/**
 * Lint Flow
 * Automatic maintenance of the Wiki knowledge base
 */

import { App, TFile, normalizePath } from 'obsidian';
import type { LLMWikiSettings, OllamaMessage, ToolContext, LintResult, LintIssue } from '../types';
import { getLLMClient } from '../llm/client';
import { executeTool, getOllamaTools } from '../tools';

type IssueStatus = 'fixed' | 'pending' | 'unverified';

interface IssueRecord {
    issue: LintIssue;
    status: IssueStatus;
    note?: string;
}

function normalizeRelatedValue(raw: unknown): string[] {
    if (Array.isArray(raw)) {
        return raw.map((value) => String(value).trim()).filter(Boolean);
    }

    if (typeof raw === 'string') {
        return raw.split(',').map((value) => value.trim()).filter(Boolean);
    }

    return [];
}

function extractRelatedTarget(link: string): string {
    const trimmed = link.trim();
    const match = trimmed.match(/^\[\[([^|\]]+)(?:\|[^\]]+)?\]\]$/);
    return (match?.[1] || trimmed).trim();
}

function parseFrontmatterAndBody(content: string): { frontmatter: string; body: string } {
    const match = content.match(/^(---\n[\s\S]*?\n---\n?)([\s\S]*)$/);
    if (!match) {
        return { frontmatter: '', body: content };
    }

    return {
        frontmatter: match[1],
        body: match[2],
    };
}

function removeDuplicateParagraphs(body: string): { updatedBody: string; removedCount: number } {
    const parts = body.split(/\n{2,}/);
    const seen = new Set<string>();
    const kept: string[] = [];
    let removed = 0;

    for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) {
            continue;
        }

        // Avoid mutating structure-heavy blocks where dedupe is risky.
        if (trimmed.startsWith('#') || trimmed.startsWith('-') || trimmed.startsWith('*') || trimmed.startsWith('```')) {
            kept.push(part);
            continue;
        }

        const normalized = trimmed.replace(/\s+/g, ' ');
        if (normalized.length < 20) {
            kept.push(part);
            continue;
        }

        if (seen.has(normalized)) {
            removed++;
            continue;
        }

        seen.add(normalized);
        kept.push(part);
    }

    return {
        updatedBody: kept.join('\n\n'),
        removedCount: removed,
    };
}

function collectWikiLinks(text: string): string[] {
    const links: string[] = [];
    const regex = /\[\[([^|\]]+)(?:\|[^\]]+)?\]\]/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
        links.push(match[1].trim());
    }

    return links;
}

function isPathWithinRoot(path: string, root: string): boolean {
    const normalizedPath = normalizePath(path);
    const normalizedRoot = normalizePath(root);
    return normalizedPath === normalizedRoot || normalizedPath.startsWith(normalizedRoot + '/');
}

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
    const issueRecords: IssueRecord[] = [];
    const addIssue = (issue: LintIssue): void => {
        issues.push(issue);
        issueRecords.push({ issue, status: 'pending' });
    };
    let fixed = 0;
    let relatedCleaned = 0;
    let duplicateRemoved = 0;
    let indexSliceBrokenLinks = 0;
    let shouldRebuildIndex = false;
    const fixedPaths = new Set<string>();
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
                    addIssue({
                        type: 'broken_link',
                        path: file.path,
                        description: `Broken link: [[${linkTarget}]] does not exist`,
                        suggestion: `Create page "${linkTarget}" or remove the link`,
                    });
                }
            }
        }

        // Step 2.5: Remove duplicate text blocks in changed files.
        onProgress?.('Checking duplicate paragraphs...');
        for (const file of changedFiles) {
            const original = await app.vault.read(file);
            const { frontmatter, body } = parseFrontmatterAndBody(original);
            const { updatedBody, removedCount } = removeDuplicateParagraphs(body);

            if (removedCount <= 0) {
                continue;
            }

            const issue: LintIssue = {
                type: 'duplicate',
                path: file.path,
                description: `Detected duplicate content blocks: ${removedCount}`,
                suggestion: 'Remove repeated content blocks while preserving first occurrence',
            };
            addIssue(issue);

            if (!autoFix) {
                continue;
            }

            const updated = `${frontmatter}${updatedBody}`;
            await app.vault.modify(file, updated);
            fixed++;
            duplicateRemoved += removedCount;
            fixedPaths.add(file.path);
            shouldRebuildIndex = true;
        }

        // Step 2.6: Remove deleted-page references from frontmatter.related.
        onProgress?.('Checking related references...');
        for (const file of wikiFiles) {
            const cache = app.metadataCache.getFileCache(file);
            const related = normalizeRelatedValue(cache?.frontmatter?.related);
            if (related.length === 0) {
                continue;
            }

            const kept: string[] = [];
            const removed: string[] = [];

            for (const item of related) {
                const target = extractRelatedTarget(item);
                if (!target) {
                    continue;
                }

                const resolved = app.metadataCache.getFirstLinkpathDest(target, file.path);
                const existsInAllowedRoots =
                    resolved instanceof TFile &&
                    (isPathWithinRoot(resolved.path, settings.wikiPath) ||
                        isPathWithinRoot(resolved.path, settings.sourcesPath));
                if (existsInAllowedRoots) {
                    kept.push(item);
                } else {
                    removed.push(item);
                }
            }

            if (removed.length === 0) {
                continue;
            }

            for (const removedItem of removed) {
                addIssue({
                    type: 'broken_link',
                    path: file.path,
                    description: `Broken related reference: ${removedItem}`,
                    suggestion: 'Remove deleted page from related',
                });
            }

            if (!autoFix) {
                continue;
            }

            const result = await executeTool(
                'Update_Property',
                {
                    path: file.path,
                    property: 'related',
                    value: kept.join(','),
                },
                context
            );

            if (result.success) {
                relatedCleaned += removed.length;
                fixed += removed.length;
                fixedPaths.add(file.path);
                shouldRebuildIndex = true;
            }
        }

        // Step 2.7: If index slices reference deleted pages, request index rebuild.
        onProgress?.('Checking index slice links...');
        const idxDir = settings.indexPath || 'WikiIndex';
        const indexSliceFiles = app.vault.getMarkdownFiles().filter((file) => {
            if (!file.path.startsWith(idxDir + '/')) {
                return false;
            }

            const isMonthlySlice = /^\d{4}-\d{2}\.md$/.test(file.name);
            const isUndatedSlice = file.name === 'undated.md';
            return isMonthlySlice || isUndatedSlice;
        });

        for (const sliceFile of indexSliceFiles) {
            const content = await app.vault.read(sliceFile);
            const targets = collectWikiLinks(content);
            for (const target of targets) {
                const resolved = app.metadataCache.getFirstLinkpathDest(target, sliceFile.path);
                const existsInWiki = resolved instanceof TFile && resolved.path.startsWith(settings.wikiPath + '/');
                if (existsInWiki) {
                    continue;
                }

                indexSliceBrokenLinks++;
                addIssue({
                    type: 'broken_link',
                    path: sliceFile.path,
                    description: `Index slice contains deleted page link: [[${target}]]`,
                    suggestion: 'Rebuild wiki index slices',
                });
                shouldRebuildIndex = true;
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
            
            const idxDir = settings.indexPath || 'WikiIndex';
            const indexPath = `${idxDir}/index.md`;
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
                            const toolPath = toolCall.function.arguments?.path;
                            if (typeof toolPath === 'string' && toolPath.length > 0) {
                                fixedPaths.add(toolPath);
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
        }

        if (autoFix && shouldRebuildIndex) {
            onProgress?.('Rebuilding wiki index slices...');
            const rebuildResult = await executeTool('update_index', {}, context);
            if (rebuildResult.success) {
                fixed++;
            }
        }

        for (const record of issueRecords) {
            if (fixedPaths.has(record.issue.path)) {
                record.status = 'fixed';
                record.note = 'matched successful update on same path';
            } else if (autoFix) {
                record.status = 'unverified';
                record.note = 'auto-fix enabled but no direct path match';
            } else {
                record.status = 'pending';
                record.note = 'auto-fix disabled';
            }
        }

        const issueDetails = issueRecords.length === 0
            ? '- None'
            : issueRecords
                .map((record, idx) => {
                    const suggestion = record.issue.suggestion ? ` | suggestion: ${record.issue.suggestion}` : '';
                    const note = record.note ? ` | note: ${record.note}` : '';
                    return `${idx + 1}. [${record.issue.type}] ${record.issue.path || 'N/A'} | status: ${record.status} | desc: ${record.issue.description}${suggestion}${note}`;
                })
                .join('\n');

        // Step 5: Log the lint operation
        await executeTool(
            'log_operation',
            {
                type: 'lint',
                operation: 'Wiki maintenance check',
                status: 'success',
                message:
                    `Scanned ${changedFiles.length}/${wikiFiles.length} files, found ${issues.length} issues, fixed ${issueRecords.filter(r => r.status === 'fixed').length} issues.` +
                    ` duplicateRemoved=${duplicateRemoved} relatedCleaned=${relatedCleaned} indexSliceBrokenLinks=${indexSliceBrokenLinks}`,
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