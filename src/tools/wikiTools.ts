/**
 * Wiki Maintenance Tools
 * Tools for creating, updating, and maintaining Wiki pages
 */

import type { ToolDefinition, ToolContext, ToolResult, WikiPageFrontmatter } from '../types';
import { TFile, normalizePath } from 'obsidian';

/**
 * Convert a file path to wikilink format [[path/without/md|basename]]
 */
function pathToWikilink(path: string): string {
    // Remove .md extension if present
    const pathWithoutMd = path.replace(/\.md$/, '');
    // Get basename for display text
    const basename = pathWithoutMd.split('/').pop() || pathWithoutMd;
    return `[[${pathWithoutMd}|${basename}]]`;
}

/**
 * Generate YAML frontmatter for a Wiki page
 */
function generateFrontmatter(fm: WikiPageFrontmatter): string {
    // Format tags as YAML array
    const tagsYaml = fm.tags.length > 0 
        ? fm.tags.map(t => `  - ${t}`).join('\n')
        : '  []';
    
    // Format related as YAML array with wikilinks
    const relatedYaml = fm.related.length > 0
        ? fm.related.map(r => `  - ${r}`).join('\n')
        : '  []';
    
    return `---
title: ${fm.title}
created: ${fm.created}
updated: ${fm.updated}
tags:
${tagsYaml}
related:
${relatedYaml}
---`;
}

/**
 * Parse YAML frontmatter from content
 */
function parseFrontmatter(content: string): { frontmatter: WikiPageFrontmatter | null; body: string } {
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) {
        return { frontmatter: null, body: content };
    }

    const fmText = match[1];
    const body = match[2];

    const titleMatch = fmText.match(/title:\s*(.+)/);
    const createdMatch = fmText.match(/created:\s*(.+)/);
    const updatedMatch = fmText.match(/updated:\s*(.+)/);
    
    // Parse tags - support both array format and inline format
    let tags: string[] = [];
    const tagsInlineMatch = fmText.match(/tags:\s*\[(.+)\]/);
    if (tagsInlineMatch) {
        tags = tagsInlineMatch[1].split(',').map(t => t.trim()).filter(Boolean);
    } else {
        // Match YAML array format: tags:\n  - tag1\n  - tag2
        const tagsArrayMatch = fmText.match(/tags:\s*\n((?:\s+- .+\n?)+)/);
        if (tagsArrayMatch) {
            tags = tagsArrayMatch[1].match(/- (.+)/g)?.map(t => t.replace('- ', '').trim()) || [];
        }
    }
    
    // Parse related - support both array format and inline format
    let related: string[] = [];
    const relatedInlineMatch = fmText.match(/related:\s*\[(.+)\]/);
    if (relatedInlineMatch) {
        related = relatedInlineMatch[1].split(',').map(r => r.trim()).filter(Boolean);
    } else {
        // Match YAML array format: related:\n  - [[link1]]\n  - [[link2]]
        const relatedArrayMatch = fmText.match(/related:\s*\n((?:\s+- .+\n?)+)/);
        if (relatedArrayMatch) {
            related = relatedArrayMatch[1].match(/- (.+)/g)?.map(r => r.replace('- ', '').trim()) || [];
        }
    }

    const frontmatter: WikiPageFrontmatter = {
        title: titleMatch?.[1]?.trim() || '',
        created: createdMatch?.[1]?.trim() || '',
        updated: updatedMatch?.[1]?.trim() || '',
        tags,
        related,
    };

    return { frontmatter, body };
}

/**
 * Create a new Wiki page
 */
export const createWikiPageTool: ToolDefinition = {
    name: 'create_wiki_page',
    description: 'Create a new Wiki page with proper frontmatter and structure',
    parameters: {
        type: 'object',
        properties: {
            title: {
                type: 'string',
                description: 'The title of the Wiki page',
            },
            content: {
                type: 'string',
                description: 'The main content of the page',
            },
            summary: {
                type: 'string',
                description: 'A brief summary of the page',
            },
            tags: {
                type: 'string',
                description: 'Comma-separated list of tags',
            },
            related: {
                type: 'string',
                description: 'Comma-separated list of related wiki pages (e.g., [[path/to/file|file]])',
            },
            source_path: {
                type: 'string',
                description: 'Path to the original source file (will be linked as [[path|basename]])',
            },
        },
        required: ['title', 'content'],
    },
    handler: async (params, context: ToolContext): Promise<ToolResult> => {
        const vault = context.vault as any;
        const settings = context.settings;
        const title = params.title as string;
        const content = params.content as string;
        const summary = (params.summary as string) || '';
        const tags = (params.tags as string)?.split(',').map(t => t.trim()).filter(Boolean) || [];
        const relatedInput = (params.related as string)?.split(',').map(r => r.trim()).filter(Boolean) || [];
        const sourcePath = params.source_path as string | undefined;

        const now = new Date().toISOString().split('T')[0];
        const fileName = title.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_');
        const path = normalizePath(`${settings.wikiPath}/${fileName}.md`);

        // Build related array: include source_path if provided
        const related: string[] = [...relatedInput];
        if (sourcePath) {
            const normalizedSourcePath = normalizePath(sourcePath);
            const sourceFile = vault.getAbstractFileByPath(normalizedSourcePath);
            if (sourceFile instanceof TFile) {
                // Use [[path|basename]] format for related links (remove .md from path)
                const linkPath = normalizedSourcePath.replace(/\.md$/, '');
                const sourceLink = `[[${linkPath}|${sourceFile.basename}]]`;
                if (!related.includes(sourceLink)) {
                    related.push(sourceLink);
                }
            }
        }

        const frontmatter: WikiPageFrontmatter = {
            title,
            created: now,
            updated: now,
            tags,
            related,
        };

        const fullContent = `${generateFrontmatter(frontmatter)}

# ${title}

${summary ? `## Summary\n\n${summary}\n\n` : ''}## Content\n\n${content}
`;

        try {
            // Ensure Wiki directory exists
            const wikiFolder = vault.getAbstractFileByPath(settings.wikiPath);
            if (!wikiFolder) {
                await vault.createFolder(settings.wikiPath);
            }

            // Check if file already exists
            const existingFile = vault.getAbstractFileByPath(path);
            if (existingFile instanceof TFile) {
                return { success: false, error: `Wiki page already exists: ${path}` };
            }

            await vault.create(path, fullContent);
            return { success: true, data: { path, title } };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    },
};

/**
 * Update an existing Wiki page
 */
export const updateWikiPageTool: ToolDefinition = {
    name: 'update_wiki_page',
    description: 'Update an existing Wiki page with new content',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'The path to the Wiki page',
            },
            content: {
                type: 'string',
                description: 'The new content (optional, will append if not replacing)',
            },
            append: {
                type: 'boolean',
                description: 'Whether to append content instead of replacing',
            },
            tags: {
                type: 'string',
                description: 'New comma-separated tags (optional)',
            },
            related: {
                type: 'string',
                description: 'New comma-separated related links (optional, e.g., [[path/to/file|file]])',
            },
            source_path: {
                type: 'string',
                description: 'Path to the original source file (will be linked as [[path|basename]])',
            },
        },
        required: ['path'],
    },
    handler: async (params, context: ToolContext): Promise<ToolResult> => {
        const vault = context.vault as any;
        const path = normalizePath(params.path as string);
        const sourcePath = params.source_path as string | undefined;

        try {
            const file = vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) {
                return { success: false, error: `Wiki page not found: ${path}` };
            }

            const existingContent = await vault.read(file);
            const { frontmatter, body } = parseFrontmatter(existingContent);

            if (!frontmatter) {
                return { success: false, error: 'Invalid Wiki page: no frontmatter found' };
            }

            const now = new Date().toISOString().split('T')[0];
            frontmatter.updated = now;

            if (params.tags) {
                frontmatter.tags = (params.tags as string).split(',').map(t => t.trim()).filter(Boolean);
            }

            if (params.related) {
                frontmatter.related = (params.related as string).split(',').map(r => r.trim()).filter(Boolean);
            }

            let newBody = body;
            if (params.content) {
                if (params.append) {
                    newBody = body + '\n\n' + (params.content as string);
                } else {
                    newBody = params.content as string;
                }
            }

            // Add or update source link if source_path is provided
            let sourceSection = '';
            if (sourcePath) {
                const normalizedSourcePath = normalizePath(sourcePath);
                const sourceFile = vault.getAbstractFileByPath(normalizedSourcePath);
                if (sourceFile instanceof TFile) {
                    // Use [[path|basename]] format for source link (remove .md from path)
                    const linkPath = normalizedSourcePath.replace(/\.md$/, '');
                    sourceSection = `## Source\n\nOriginal file: [[${linkPath}|${sourceFile.basename}]]\n\n`;
                    
                    // Check if body already has a Source section, if so replace it
                    const sourceSectionRegex = /## Source\n\nOriginal file: \[\[[^\]]+\]\]\n\n/;
                    if (sourceSectionRegex.test(newBody)) {
                        newBody = newBody.replace(sourceSectionRegex, sourceSection);
                        sourceSection = ''; // Already added in replacement
                    } else if (!newBody.includes('## Source')) {
                        // Add source section after the title (first # line)
                        const lines = newBody.split('\n');
                        let insertIndex = 0;
                        for (let i = 0; i < lines.length; i++) {
                            if (lines[i].startsWith('# ')) {
                                insertIndex = i + 1;
                                // Skip empty lines after title
                                while (insertIndex < lines.length && lines[insertIndex].trim() === '') {
                                    insertIndex++;
                                }
                                break;
                            }
                        }
                        if (insertIndex > 0) {
                            lines.splice(insertIndex, 0, '', sourceSection.trim(), '');
                            newBody = lines.join('\n');
                            sourceSection = ''; // Already added
                        }
                    }
                }
            }

            const fullContent = `${generateFrontmatter(frontmatter)}\n${newBody}`;
            await vault.modify(file, fullContent);

            return { success: true, data: { path } };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    },
};

/**
 * Add a backlink to a Wiki page
 */
export const addBacklinkTool: ToolDefinition = {
    name: 'add_backlink',
    description: 'Add a bidirectional link between two Wiki pages',
    parameters: {
        type: 'object',
        properties: {
            source: {
                type: 'string',
                description: 'The source page path',
            },
            target: {
                type: 'string',
                description: 'The target page path (will be linked)',
            },
        },
        required: ['source', 'target'],
    },
    handler: async (params, context: ToolContext): Promise<ToolResult> => {
        const vault = context.vault as any;
        const sourcePath = normalizePath(params.source as string);
        const targetPath = normalizePath(params.target as string);

        try {
            // Get target page title
            const targetFile = vault.getAbstractFileByPath(targetPath);
            if (!(targetFile instanceof TFile)) {
                return { success: false, error: `Target page not found: ${targetPath}` };
            }

            const targetContent = await vault.read(targetFile);
            const { frontmatter: targetFm } = parseFrontmatter(targetContent);
            const targetTitle = targetFm?.title || targetFile.basename;

            // Update source page
            const sourceFile = vault.getAbstractFileByPath(sourcePath);
            if (!(sourceFile instanceof TFile)) {
                return { success: false, error: `Source page not found: ${sourcePath}` };
            }

            const sourceContent = await vault.read(sourceFile);
            const { frontmatter: sourceFm, body: sourceBody } = parseFrontmatter(sourceContent);

            if (!sourceFm) {
                return { success: false, error: 'Invalid source page: no frontmatter' };
            }

            // Add to related if not already present
            // Use [[path|basename]] format for related links (remove .md from path)
            const linkPath = targetPath.replace(/\.md$/, '');
            const targetLink = `[[${linkPath}|${targetFile.basename}]]`;
            if (!sourceFm.related.some(r => r.includes(linkPath))) {
                sourceFm.related.push(targetLink);
            }

            const now = new Date().toISOString().split('T')[0];
            sourceFm.updated = now;

            const fullContent = `${generateFrontmatter(sourceFm)}\n${sourceBody}`;
            await vault.modify(sourceFile, fullContent);

            return { success: true, data: { source: sourcePath, target: targetPath, targetTitle } };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    },
};

/**
 * Update the Wiki index
 */
export const updateIndexTool: ToolDefinition = {
    name: 'update_index',
    description: 'Update the Wiki index.md with all current pages',
    parameters: {
        type: 'object',
        properties: {
            force: {
                type: 'boolean',
                description: 'Force full rebuild of index',
            },
        },
        required: [],
    },
    handler: async (params, context: ToolContext): Promise<ToolResult> => {
        const vault = context.vault as any;
        const settings = context.settings;
        const indexPath = normalizePath(`${settings.wikiPath}/index.md`);

        try {
            // List all Wiki pages
            const wikiFolder = vault.getAbstractFileByPath(settings.wikiPath);
            if (!wikiFolder) {
                return { success: false, error: 'Wiki folder not found' };
            }

            const pages: { title: string; path: string; tags: string[]; created: string; updated: string }[] = [];
            const files = vault.getMarkdownFiles();

            for (const file of files) {
                if (!file.path.startsWith(settings.wikiPath) || file.path === indexPath) continue;

                const content = await vault.read(file);
                const { frontmatter } = parseFrontmatter(content);
                pages.push({
                    title: frontmatter?.title || file.basename,
                    path: file.path,
                    tags: frontmatter?.tags || [],
                    created: frontmatter?.created || '',
                    updated: frontmatter?.updated || '',
                });
            }

            // Sort pages by title
            pages.sort((a, b) => a.title.localeCompare(b.title));

            // Group by year (based on updated or created date)
            const grouped: Record<string, typeof pages> = {};
            const noDate: typeof pages = [];
            
            for (const page of pages) {
                const dateStr = page.updated || page.created;
                if (dateStr) {
                    // Extract year from date string (format: YYYY-MM-DD)
                    const yearMatch = dateStr.match(/^(\d{4})/);
                    if (yearMatch) {
                        const year = yearMatch[1];
                        if (!grouped[year]) grouped[year] = [];
                        grouped[year].push(page);
                    } else {
                        noDate.push(page);
                    }
                } else {
                    noDate.push(page);
                }
            }

            // Generate index content (English)
            const now = new Date();
            const lastUpdated = now.toISOString().split('T')[0] + ' ' + now.toTimeString().split(' ')[0];
            let indexContent = `# Wiki Index\n\n**Last Updated:** ${lastUpdated}\n\n**Total Pages:** ${pages.length}\n\n---\n\n## Index\n\n`;

            // Sort years in descending order (newest first)
            const years = Object.keys(grouped).sort((a, b) => b.localeCompare(a));
            
            for (const year of years) {
                indexContent += `### ${year}\n\n`;
                // Sort pages within each year by date (newest first), then by title
                const yearPages = grouped[year].sort((a, b) => {
                    const dateA = a.updated || a.created || '';
                    const dateB = b.updated || b.created || '';
                    // Sort by date descending first
                    if (dateA !== dateB) return dateB.localeCompare(dateA);
                    // Then by title ascending
                    return a.title.localeCompare(b.title);
                });
                
                for (const page of yearPages) {
                    const dateStr = page.updated || page.created;
                    const dateDisplay = dateStr ? ` _(${dateStr})_` : '';
                    const tagStr = page.tags.length > 0 ? ` **[${page.tags.join(', ')}]**` : '';
                    indexContent += `- [[${page.title}]]${dateDisplay}${tagStr}\n`;
                }
                indexContent += '\n';
            }
            
            // Add pages without dates at the end
            if (noDate.length > 0) {
                indexContent += `### Undated\n\n`;
                for (const page of noDate) {
                    const tagStr = page.tags.length > 0 ? ` **[${page.tags.join(', ')}]**` : '';
                    indexContent += `- [[${page.title}]]${tagStr}\n`;
                }
                indexContent += '\n';
            }

            // Write index
            const indexFile = vault.getAbstractFileByPath(indexPath);
            if (indexFile instanceof TFile) {
                await vault.modify(indexFile, indexContent);
            } else {
                await vault.create(indexPath, indexContent);
            }

            return { success: true, data: { pageCount: pages.length } };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    },
};

/**
 * Log an operation to log.md
 */
export const logOperationTool: ToolDefinition = {
    name: 'log_operation',
    description: 'Log an operation to the Wiki log file',
    parameters: {
        type: 'object',
        properties: {
            type: {
                type: 'string',
                description: 'Operation type: ingest, query, lint, or manual',
                enum: ['ingest', 'query', 'lint', 'manual'],
            },
            source: {
                type: 'string',
                description: 'Source file path (optional)',
            },
            target: {
                type: 'string',
                description: 'Target file path (optional)',
            },
            operation: {
                type: 'string',
                description: 'Description of the operation',
            },
            entities: {
                type: 'string',
                description: 'Comma-separated list of entities involved',
            },
            status: {
                type: 'string',
                description: 'Operation status',
                enum: ['success', 'failed', 'pending'],
            },
            message: {
                type: 'string',
                description: 'Additional message',
            },
        },
        required: ['type', 'operation', 'status'],
    },
    handler: async (params, context: ToolContext): Promise<ToolResult> => {
        const vault = context.vault as any;
        const settings = context.settings;
        const logPath = normalizePath(`${settings.wikiPath}/log.md`);

        const timestamp = new Date().toLocaleString('en-US');
        const type = params.type as string;
        const operation = params.operation as string;
        const status = params.status as string;
        const entities = (params.entities as string)?.split(',').map(e => e.trim()).filter(Boolean) || [];

        const logEntry = `
## ${timestamp} - ${type.toUpperCase()} Operation
- **Source**: ${params.source || 'N/A'}
- **Target**: ${params.target || 'N/A'}
- **Operation**: ${operation}
- **Entities**: ${entities.join(', ') || 'N/A'}
- **Status**: ${status === 'success' ? '✅ Success' : status === 'failed' ? '❌ Failed' : '⏳ Pending'}
${params.message ? `- **Note**: ${params.message}` : ''}
`;

        try {
            const logFile = vault.getAbstractFileByPath(logPath);
            if (logFile instanceof TFile) {
                const existing = await vault.read(logFile);
                await vault.modify(logFile, existing + logEntry);
            } else {
                const header = `# Wiki Operation Log\n\nRecords all AI operations.\n`;
                await vault.create(logPath, header + logEntry);
            }

            return { success: true };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    },
};

/**
 * All Wiki tools
 */
export const wikiTools: ToolDefinition[] = [
    createWikiPageTool,
    updateWikiPageTool,
    addBacklinkTool,
    updateIndexTool,
    logOperationTool,
];