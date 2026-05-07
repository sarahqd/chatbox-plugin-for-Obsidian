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

function toWikiFileNameStem(value: string): string {
    return value.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_');
}

function normalizeRelatedLink(link: string, wikiPath: string): string {
    const trimmed = link.trim();
    if (!trimmed) {
        return trimmed;
    }

    const wikilinkMatch = trimmed.match(/^\[\[([^|\]]+)(?:\|([^\]]+))?\]\]$/);
    if (wikilinkMatch) {
        const rawTarget = normalizePath(wikilinkMatch[1].trim()).replace(/\.md$/, '');
        const rawAlias = wikilinkMatch[2]?.trim();
        const normalizedTarget = rawTarget.includes('/')
            ? rawTarget
            : normalizePath(`${wikiPath}/${toWikiFileNameStem(rawTarget)}`);
        const alias = rawAlias || rawTarget;
        return `[[${normalizedTarget}|${alias}]]`;
    }

    const normalizedTarget = normalizePath(`${wikiPath}/${toWikiFileNameStem(trimmed)}`);
    return `[[${normalizedTarget}|${trimmed}]]`;
}

function normalizeRelatedLinks(related: string[], wikiPath: string): string[] {
    const seen = new Set<string>();
    const normalized: string[] = [];

    for (const link of related) {
        const normalizedLink = normalizeRelatedLink(link, wikiPath);
        if (!normalizedLink || seen.has(normalizedLink)) {
            continue;
        }

        seen.add(normalizedLink);
        normalized.push(normalizedLink);
    }

    return normalized;
}

function pathToWikilinkWithAlias(path: string, alias: string): string {
    const pathWithoutMd = normalizePath(path).replace(/\.md$/, '');
    return `[[${pathWithoutMd}|${alias}]]`;
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
    // Quote wikilinks to preserve [[link]] format in YAML
    const relatedYaml = fm.related.length > 0
        ? fm.related.map(r => `  - "${r}"`).join('\n')
        : '  []';

    // Escape summary for YAML (single-line, quote if non-empty)
    const summaryLine = fm.summary ? `\nsummary: "${fm.summary.replace(/"/g, '\\"').replace(/\n/g, ' ')}"` : '';
    
    return `---\ntitle: ${fm.title}\ncreated: ${fm.created}\nupdated: ${fm.updated}${summaryLine}\ntags:\n${tagsYaml}\nrelated:\n${relatedYaml}\n---`;
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
        // Match YAML array format: related:\n  - "[[link1]]"\n  - "[[link2]]"
        // or: related:\n  - [[link1]]\n  - [[link2]] (legacy format)
        const relatedArrayMatch = fmText.match(/related:\s*\n((?:\s+- .+\n?)+)/);
        if (relatedArrayMatch) {
            related = relatedArrayMatch[1].match(/- (.+)/g)?.map(r => {
                let value = r.replace('- ', '').trim();
                // Remove surrounding quotes if present (both single and double)
                if ((value.startsWith('"') && value.endsWith('"')) || 
                    (value.startsWith("'") && value.endsWith("'"))) {
                    value = value.slice(1, -1);
                }
                return value;
            }).filter(Boolean) || [];
        }
    }

    const frontmatter: WikiPageFrontmatter = {
        title: titleMatch?.[1]?.trim() || '',
        created: createdMatch?.[1]?.trim() || '',
        updated: updatedMatch?.[1]?.trim() || '',
        tags,
        related,
    };

    // Parse summary
    const summaryMatch = fmText.match(/summary:\s*"?([^"\n]+)"?/);
    if (summaryMatch) {
        frontmatter.summary = summaryMatch[1].trim();
    }

    return { frontmatter, body };
}

const wikiPropertyNames = ['title', 'created', 'updated', 'tags', 'related'] as const;

type WikiPropertyName = typeof wikiPropertyNames[number];

interface WikiSectionMatch {
    headingStart: number;
    headingEnd: number;
    bodyStart: number;
    end: number;
    level: number;
    content: string;
}

function isWikiPropertyName(value: string): value is WikiPropertyName {
    return wikiPropertyNames.includes(value as WikiPropertyName);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findSection(body: string, heading: string): WikiSectionMatch | null {
    const headingRegex = new RegExp(`^#{1,6}\\s+${escapeRegExp(heading.trim())}\\s*$`, 'm');
    const headingMatch = headingRegex.exec(body);
    if (!headingMatch) {
        return null;
    }

    const headingStart = headingMatch.index;
    const headingLine = headingMatch[0];
    const level = headingLine.match(/^#+/)?.[0].length || 1;
    const headingEnd = headingStart + headingLine.length;

    let bodyStart = headingEnd;
    if (body.slice(bodyStart, bodyStart + 2) === '\r\n') {
        bodyStart += 2;
    } else if (body[bodyStart] === '\n') {
        bodyStart += 1;
    }

    const remainder = body.slice(bodyStart);
    const nextHeadingRegex = new RegExp(`^#{1,${level}}\\s+.+$`, 'm');
    const nextHeadingMatch = nextHeadingRegex.exec(remainder);
    const end = nextHeadingMatch ? bodyStart + nextHeadingMatch.index : body.length;

    return {
        headingStart,
        headingEnd,
        bodyStart,
        end,
        level,
        content: body.slice(bodyStart, end),
    };
}

function normalizeSectionContent(content: string, hasFollowingSection: boolean): string {
    const normalized = content
        .replace(/^(?:\r?\n)+/, '')
        .replace(/(?:\r?\n)+$/, '');

    if (!normalized) {
        return hasFollowingSection ? '\n' : '';
    }

    return hasFollowingSection ? `${normalized}\n\n` : `${normalized}\n`;
}

function replaceSectionContent(body: string, heading: string, newContent: string): string | null {
    const section = findSection(body, heading);
    if (!section) {
        return null;
    }

    const hasFollowingSection = section.end < body.length;
    const replacement = normalizeSectionContent(newContent, hasFollowingSection);
    return body.slice(0, section.bodyStart) + replacement + body.slice(section.end);
}

async function readWikiPage(
    vault: any,
    path: string
): Promise<{ file: TFile; frontmatter: WikiPageFrontmatter; body: string } | { error: string }> {
    const file = vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
        return { error: `Wiki page not found: ${path}` };
    }

    const content = await vault.read(file);
    const { frontmatter, body } = parseFrontmatter(content);

    if (!frontmatter) {
        return { error: 'Invalid Wiki page: no frontmatter found' };
    }

    return { file, frontmatter, body };
}

async function saveWikiPage(vault: any, file: TFile, frontmatter: WikiPageFrontmatter, body: string): Promise<void> {
    const fullContent = `${generateFrontmatter(frontmatter)}\n${body}`;
    await vault.modify(file, fullContent);
}

function touchUpdated(frontmatter: WikiPageFrontmatter): void {
    frontmatter.updated = new Date().toISOString().split('T')[0];
}

function parsePropertyValue(property: WikiPropertyName, value: unknown): string | string[] {
    if (property === 'tags' || property === 'related') {
        if (Array.isArray(value)) {
            return value.map((item) => String(item).trim()).filter(Boolean);
        }

        return String(value)
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
    }

    return String(value);
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
        const fileName = toWikiFileNameStem(title);
        const path = normalizePath(`${settings.wikiPath}/${fileName}.md`);

        // Build related array: include source_path if provided
        const related: string[] = normalizeRelatedLinks(relatedInput, settings.wikiPath);
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

        // Extract summary from ## Summary section of the content for frontmatter
        const summaryMaxLength = context.settings.summaryMaxLength ?? 200;
        const summaryBodyMatch = content.match(/^## Summary\s*\n([\s\S]*?)(?=^##|\Z)/m);
        const extractedSummary = summary || (summaryBodyMatch ? summaryBodyMatch[1].replace(/\s+/g, ' ').trim() : '');
        if (extractedSummary) {
            frontmatter.summary = extractedSummary.slice(0, summaryMaxLength);
        }

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

            // Upsert behavior: if page exists, update it; otherwise create it.
            const existingFile = vault.getAbstractFileByPath(path);
            if (existingFile instanceof TFile) {
                const existingContent = await vault.read(existingFile);
                const { frontmatter: existingFrontmatter } = parseFrontmatter(existingContent);

                const mergedFrontmatter: WikiPageFrontmatter = {
                    title,
                    created: existingFrontmatter?.created || now,
                    updated: now,
                    tags: tags.length > 0 ? tags : (existingFrontmatter?.tags || []),
                    related: related.length > 0 ? related : (existingFrontmatter?.related || []),
                };

                // Carry over extracted summary
                if (extractedSummary) {
                    mergedFrontmatter.summary = extractedSummary.slice(0, summaryMaxLength);
                }

                const updatedContent = `${generateFrontmatter(mergedFrontmatter)}

# ${title}

${summary ? `## Summary\n\n${summary}\n\n` : ''}## Content\n\n${content}
`;

                await vault.modify(existingFile, updatedContent);
                return { success: true, data: { path, title, action: 'updated' } };
            }

            await vault.create(path, fullContent);
            return { success: true, data: { path, title, action: 'created' } };
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
                const inputRelated = (params.related as string).split(',').map(r => r.trim()).filter(Boolean);
                frontmatter.related = normalizeRelatedLinks(inputRelated, context.settings.wikiPath);
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

export const readSummaryTool: ToolDefinition = {
    name: 'Read_Summary',
    description: 'Read only the Summary section from a Wiki page',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'The path to the Wiki page',
            },
        },
        required: ['path'],
    },
    handler: async (params, context: ToolContext): Promise<ToolResult> => {
        const vault = context.vault as any;
        const path = normalizePath(params.path as string);

        try {
            const page = await readWikiPage(vault, path);
            if ('error' in page) {
                return { success: false, error: page.error };
            }

            const section = findSection(page.body, 'Summary');
            if (!section) {
                return { success: false, error: 'Summary section not found' };
            }

            return {
                success: true,
                data: {
                    path,
                    summary: section.content.trim(),
                },
            };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    },
};

export const updateSummaryTool: ToolDefinition = {
    name: 'Update_Summary',
    description: 'Modify only the Summary section of a Wiki page',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'The path to the Wiki page',
            },
            summary: {
                type: 'string',
                description: 'The new Summary content',
            },
        },
        required: ['path', 'summary'],
    },
    handler: async (params, context: ToolContext): Promise<ToolResult> => {
        const vault = context.vault as any;
        const path = normalizePath(params.path as string);

        try {
            const page = await readWikiPage(vault, path);
            if ('error' in page) {
                return { success: false, error: page.error };
            }

            const newBody = replaceSectionContent(page.body, 'Summary', params.summary as string);
            if (newBody === null) {
                return { success: false, error: 'Summary section not found' };
            }

            touchUpdated(page.frontmatter);
            await saveWikiPage(vault, page.file, page.frontmatter, newBody);
            return { success: true, data: { path } };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    },
};

export const readPropertyTool: ToolDefinition = {
    name: 'Read_Property',
    description: 'Read only one frontmatter property from a Wiki page',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'The path to the Wiki page',
            },
            property: {
                type: 'string',
                description: 'Frontmatter property name: title, created, updated, tags, or related',
                enum: [...wikiPropertyNames],
            },
        },
        required: ['path', 'property'],
    },
    handler: async (params, context: ToolContext): Promise<ToolResult> => {
        const vault = context.vault as any;
        const path = normalizePath(params.path as string);
        const property = String(params.property || '');

        if (!isWikiPropertyName(property)) {
            return { success: false, error: `Unsupported property: ${property}` };
        }

        try {
            const page = await readWikiPage(vault, path);
            if ('error' in page) {
                return { success: false, error: page.error };
            }

            return {
                success: true,
                data: {
                    path,
                    property,
                    value: page.frontmatter[property],
                },
            };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    },
};

export const updatePropertyTool: ToolDefinition = {
    name: 'Update_Property',
    description: 'Modify only one frontmatter property of a Wiki page',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'The path to the Wiki page',
            },
            property: {
                type: 'string',
                description: 'Frontmatter property name: title, created, updated, tags, or related',
                enum: [...wikiPropertyNames],
            },
            value: {
                type: 'string',
                description: 'New property value, or comma-separated values for tags and related',
            },
        },
        required: ['path', 'property', 'value'],
    },
    handler: async (params, context: ToolContext): Promise<ToolResult> => {
        const vault = context.vault as any;
        const path = normalizePath(params.path as string);
        const property = String(params.property || '');

        if (!isWikiPropertyName(property)) {
            return { success: false, error: `Unsupported property: ${property}` };
        }

        try {
            const page = await readWikiPage(vault, path);
            if ('error' in page) {
                return { success: false, error: page.error };
            }

            if (property === 'related') {
                const value = parsePropertyValue(property, params.value) as string[];
                page.frontmatter[property] = normalizeRelatedLinks(value, context.settings.wikiPath) as never;
            } else {
                page.frontmatter[property] = parsePropertyValue(property, params.value) as never;
            }
            if (property !== 'updated') {
                touchUpdated(page.frontmatter);
            }

            await saveWikiPage(vault, page.file, page.frontmatter, page.body);
            return { success: true, data: { path, property } };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    },
};

export const updateContentTool: ToolDefinition = {
    name: 'Update_Content',
    description: 'Modify only the Content section of a Wiki page',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'The path to the Wiki page',
            },
            content: {
                type: 'string',
                description: 'The new Content section body',
            },
        },
        required: ['path', 'content'],
    },
    handler: async (params, context: ToolContext): Promise<ToolResult> => {
        const vault = context.vault as any;
        const path = normalizePath(params.path as string);

        try {
            const page = await readWikiPage(vault, path);
            if ('error' in page) {
                return { success: false, error: page.error };
            }

            const newBody = replaceSectionContent(page.body, 'Content', params.content as string);
            if (newBody === null) {
                return { success: false, error: 'Content section not found' };
            }

            touchUpdated(page.frontmatter);
            await saveWikiPage(vault, page.file, page.frontmatter, newBody);
            return { success: true, data: { path } };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    },
};

export const readPartTool: ToolDefinition = {
    name: 'Read_Part',
    description: 'Read only one named section from a Wiki page by heading title',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'The path to the Wiki page',
            },
            part: {
                type: 'string',
                description: 'Section heading title to read, such as Summary, Content, or Related Links',
            },
        },
        required: ['path', 'part'],
    },
    handler: async (params, context: ToolContext): Promise<ToolResult> => {
        const vault = context.vault as any;
        const path = normalizePath(params.path as string);
        const part = String(params.part || '').trim();

        try {
            const page = await readWikiPage(vault, path);
            if ('error' in page) {
                return { success: false, error: page.error };
            }

            const section = findSection(page.body, part);
            if (!section) {
                return { success: false, error: `Section not found: ${part}` };
            }

            return {
                success: true,
                data: {
                    path,
                    part,
                    content: section.content.trim(),
                },
            };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    },
};

export const updatePartTool: ToolDefinition = {
    name: 'Update_Part',
    description: 'Modify only one named section from a Wiki page by heading title',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'The path to the Wiki page',
            },
            part: {
                type: 'string',
                description: 'Section heading title to modify, such as Summary, Content, or Related Links',
            },
            content: {
                type: 'string',
                description: 'The replacement content for that section',
            },
        },
        required: ['path', 'part', 'content'],
    },
    handler: async (params, context: ToolContext): Promise<ToolResult> => {
        const vault = context.vault as any;
        const path = normalizePath(params.path as string);
        const part = String(params.part || '').trim();

        try {
            const page = await readWikiPage(vault, path);
            if ('error' in page) {
                return { success: false, error: page.error };
            }

            const newBody = replaceSectionContent(page.body, part, params.content as string);
            if (newBody === null) {
                return { success: false, error: `Section not found: ${part}` };
            }

            touchUpdated(page.frontmatter);
            await saveWikiPage(vault, page.file, page.frontmatter, newBody);
            return { success: true, data: { path, part } };
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
            // Use [[path|frontmatter.title]] format for related links (remove .md from path)
            const linkPath = targetPath.replace(/\.md$/, '');
            const targetLink = `[[${linkPath}|${targetTitle}]]`;
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
        const idxDir = normalizePath(settings.indexPath || 'WikiIndex');

        try {
            // Ensure index directory exists
            if (!vault.getAbstractFileByPath(idxDir)) {
                await vault.createFolder(idxDir);
            }

            // Collect all wiki content pages (only files under wikiPath, none from idxDir)
            const pages: { title: string; path: string; tags: string[]; created: string; updated: string }[] = [];
            const files = vault.getMarkdownFiles() as TFile[];

            for (const file of files) {
                if (!file.path.startsWith(settings.wikiPath + '/')) continue;
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

            // index.md is written last (after slices) so it lists the actual slice files.
            // Capture now/lastUpdated for reuse in the TOC.
            const now = new Date();
            const lastUpdated = now.toISOString().split('T')[0] + ' ' + now.toTimeString().split(' ')[0];

            // ── Group pages by YYYY-MM (using created date, fallback to updated) ──
            const grouped: Record<string, typeof pages> = {};
            const noDate: typeof pages = [];

            for (const page of pages) {
                const dateStr = page.created || page.updated;
                const monthMatch = dateStr?.match(/^(\d{4}-\d{2})/);
                if (monthMatch) {
                    const ym = monthMatch[1];
                    if (!grouped[ym]) grouped[ym] = [];
                    grouped[ym].push(page);
                } else {
                    noDate.push(page);
                }
            }

            // ── Write per-month slice files in indexPath ──
            const sliceKeys = Object.keys(grouped).sort((a, b) => b.localeCompare(a)); // newest first
            const sliceFileNames: string[] = [];

            for (const ym of sliceKeys) {
                const sliceFileName = `${ym}.md`;
                sliceFileNames.push(sliceFileName);
                const slicePath = normalizePath(`${idxDir}/${sliceFileName}`);

                const monthPages = grouped[ym].sort((a, b) => {
                    const da = a.created || a.updated || '';
                    const db = b.created || b.updated || '';
                    if (da !== db) return db.localeCompare(da);
                    return a.title.localeCompare(b.title);
                });

                let sliceContent = `# Wiki Pages — ${ym}\n\n_Auto-generated. For reading only, not searched._\n\n`;
                for (const page of monthPages) {
                    const dateStr = page.created || page.updated;
                    const dateDisplay = dateStr ? ` _(${dateStr})_` : '';
                    const tagStr = page.tags.length > 0 ? ` **[${page.tags.join(', ')}]**` : '';
                    sliceContent += `- ${pathToWikilinkWithAlias(page.path, page.title)}${dateDisplay}${tagStr}\n`;
                }

                const sliceFile = vault.getAbstractFileByPath(slicePath);
                if (sliceFile instanceof TFile) {
                    await vault.modify(sliceFile, sliceContent);
                } else {
                    await vault.create(slicePath, sliceContent);
                }
            }

            // Handle undated pages in a separate slice
            if (noDate.length > 0) {
                const undatedPath = normalizePath(`${idxDir}/undated.md`);
                let undatedContent = `# Wiki Pages — Undated\n\n_Auto-generated. For reading only, not searched._\n\n`;
                for (const page of noDate) {
                    const tagStr = page.tags.length > 0 ? ` **[${page.tags.join(', ')}]**` : '';
                    undatedContent += `- ${pathToWikilinkWithAlias(page.path, page.title)}${tagStr}\n`;
                }
                const undatedFile = vault.getAbstractFileByPath(undatedPath);
                if (undatedFile instanceof TFile) {
                    await vault.modify(undatedFile, undatedContent);
                } else {
                    await vault.create(undatedPath, undatedContent);
                }
                sliceFileNames.push('undated.md');
            }

            // Remove stale slice files that are no longer generated in this rebuild.
            const keepSliceNames = new Set(sliceFileNames);
            const staleSliceFiles = (vault.getMarkdownFiles() as TFile[]).filter((file) => {
                if (!file.path.startsWith(idxDir + '/')) {
                    return false;
                }

                const isMonthlySlice = /^\d{4}-\d{2}\.md$/.test(file.name);
                const isUndatedSlice = file.name === 'undated.md';
                if (!isMonthlySlice && !isUndatedSlice) {
                    return false;
                }

                return !keepSliceNames.has(file.name);
            });

            for (const staleFile of staleSliceFiles) {
                await vault.delete(staleFile);
            }

            // ── Write idxDir/index.md as TOC of all slice files ──
            const tocPath = normalizePath(`${idxDir}/index.md`);
            let tocContent = `# Wiki Index\n\n**Last Updated:** ${lastUpdated}\n\n**Total Pages:** ${pages.length}\n\n`;
            for (const fname of sliceFileNames) {
                const label = fname.replace('.md', '');
                tocContent += `- [[${idxDir}/${label}|${label}]]\n`;
            }
            const tocFile = vault.getAbstractFileByPath(tocPath);
            if (tocFile instanceof TFile) {
                await vault.modify(tocFile, tocContent);
            } else {
                await vault.create(tocPath, tocContent);
            }

            return { success: true, data: { pageCount: pages.length, slices: sliceFileNames.length } };
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
        const idxDir = normalizePath(settings.indexPath || 'WikiIndex');
        const logPath = normalizePath(`${idxDir}/log.md`);

        // Ensure index directory exists
        if (!vault.getAbstractFileByPath(idxDir)) {
            await vault.createFolder(idxDir);
        }

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
    readSummaryTool,
    updateSummaryTool,
    readPropertyTool,
    updatePropertyTool,
    updateContentTool,
    readPartTool,
    updatePartTool,
    addBacklinkTool,
    updateIndexTool,
    logOperationTool,
];