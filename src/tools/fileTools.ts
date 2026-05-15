/**
 * File Operation Tools
 * Tools for reading, writing, and managing files in the Obsidian vault
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../types';
import { TFile, TFolder, normalizePath } from 'obsidian';

/**
 * Read file content from vault
 */
export const readFileTool: ToolDefinition = {
    name: 'read_file',
    description: 'Read the content of a file from the vault',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'The path to the file to read',
            },
        },
        required: ['path'],
    },
    handler: async (params, context: ToolContext): Promise<ToolResult> => {
        const vault = context.vault as any;
        const path = normalizePath(params.path as string);

        try {
            const file = vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) {
                return { success: false, error: `File not found: ${path}` };
            }

            const content = await vault.read(file);
            return { success: true, data: { path, content } };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    },
};

/**
 * Write content to a file
 */
export const writeFileTool: ToolDefinition = {
    name: 'write_file',
    description: 'Write content to a file in the vault. Creates the file if it does not exist.',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'The path to the file to write',
            },
            content: {
                type: 'string',
                description: 'The content to write to the file',
            },
        },
        required: ['path', 'content'],
    },
    handler: async (params, context: ToolContext): Promise<ToolResult> => {
        const vault = context.vault as any;
        const path = normalizePath(params.path as string);
        const content = params.content as string;

        try {
            const file = vault.getAbstractFileByPath(path);
            if (file instanceof TFile) {
                await vault.modify(file, content);
            } else {
                await vault.create(path, content);
            }
            return { success: true, data: { path } };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    },
};

/**
 * Append content to a file
 */
export const appendFileTool: ToolDefinition = {
    name: 'append_file',
    description: 'Append content to an existing file in the vault',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'The path to the file to append to',
            },
            content: {
                type: 'string',
                description: 'The content to append',
            },
        },
        required: ['path', 'content'],
    },
    handler: async (params, context: ToolContext): Promise<ToolResult> => {
        const vault = context.vault as any;
        const path = normalizePath(params.path as string);
        const content = params.content as string;

        try {
            const file = vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) {
                return { success: false, error: `File not found: ${path}` };
            }

            const existingContent = await vault.read(file);
            await vault.modify(file, existingContent + content);
            return { success: true, data: { path } };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    },
};

/**
 * Delete a file
 */
export const deleteFileTool: ToolDefinition = {
    name: 'delete_file',
    description: 'Delete a file from the vault',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'The path to the file to delete',
            },
        },
        required: ['path'],
    },
    handler: async (params, context: ToolContext): Promise<ToolResult> => {
        const vault = context.vault as any;
        const path = normalizePath(params.path as string);

        try {
            const file = vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) {
                return { success: false, error: `File not found: ${path}` };
            }

            await vault.trash(file, true);
            return { success: true, data: { path } };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    },
};

/**
 * List files in a directory
 */
export const listFilesTool: ToolDefinition = {
    name: 'list_files',
    description: 'List files in a directory with pagination. Use path/query/extensions/limit to avoid broad vault listings.',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'The directory path to list (optional, defaults to vault root)',
            },
            recursive: {
                type: 'boolean',
                description: 'Whether to list files recursively',
            },
            limit: {
                type: 'number',
                description: 'Maximum entries to return (default: 100, max: 500)',
            },
            cursor: {
                type: 'string',
                description: 'Pagination cursor from a previous list_files response',
            },
            extensions: {
                type: 'array',
                description: 'Optional file extensions to include, such as ["md", "txt"]',
            },
            query: {
                type: 'string',
                description: 'Optional case-insensitive substring filter applied to paths',
            },
            includeFolders: {
                type: 'boolean',
                description: 'Whether to include folder paths in results',
            },
            maxDepth: {
                type: 'number',
                description: 'Maximum recursive folder depth from the base path (default: unlimited)',
            },
        },
        required: [],
    },
    handler: async (params, context: ToolContext): Promise<ToolResult> => {
        const vault = context.vault as any;
        const basePath = params.path ? normalizePath(params.path as string) : '';
        const recursive = (params.recursive as boolean) ?? false;
        const rawLimit = Number(params.limit ?? 100);
        const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(Math.floor(rawLimit), 500)) : 100;
        const rawCursor = Number(params.cursor ?? 0);
        const cursor = Number.isFinite(rawCursor) ? Math.max(0, Math.floor(rawCursor)) : 0;
        const includeFolders = (params.includeFolders as boolean) ?? false;
        const query = String(params.query ?? '').trim().toLowerCase();
        const rawMaxDepth = params.maxDepth === undefined ? Infinity : Number(params.maxDepth);
        const maxDepth = Number.isFinite(rawMaxDepth) ? Math.max(0, Math.floor(rawMaxDepth)) : Infinity;
        const extensionFilter = new Set(
            Array.isArray(params.extensions)
                ? params.extensions
                    .map((extension) => String(extension).replace(/^\./, '').toLowerCase().trim())
                    .filter(Boolean)
                : []
        );

        try {
            const files: string[] = [];
            const folders: string[] = [];
            const folder = basePath
                ? vault.getAbstractFileByPath(basePath)
                : vault.root;

            if (!(folder instanceof TFolder)) {
                return { success: false, error: `Folder not found: ${basePath}` };
            }

            let matched = 0;
            let totalScanned = 0;
            let nextCursor: string | null = null;

            const shouldIncludePath = (path: string, extension?: string): boolean => {
                if (query && !path.toLowerCase().includes(query)) {
                    return false;
                }

                if (extension !== undefined && extensionFilter.size > 0 && !extensionFilter.has(extension.toLowerCase())) {
                    return false;
                }

                return true;
            };

            const collectEntry = (path: string, target: string[]): boolean => {
                totalScanned++;
                if (matched < cursor) {
                    matched++;
                    return true;
                }

                if (target.length >= limit) {
                    nextCursor = String(matched);
                    return false;
                }

                target.push(path);
                matched++;
                return true;
            };

            const collectFiles = (currentFolder: TFolder, depth: number): boolean => {
                for (const child of currentFolder.children) {
                    if (child instanceof TFile) {
                        if (shouldIncludePath(child.path, child.extension) && !collectEntry(child.path, files)) {
                            return false;
                        }
                    } else if (child instanceof TFolder) {
                        if (includeFolders && shouldIncludePath(child.path) && !collectEntry(child.path, folders)) {
                            return false;
                        }

                        if (recursive && depth < maxDepth && !collectFiles(child, depth + 1)) {
                            return false;
                        }
                    }
                }

                return true;
            };

            collectFiles(folder, 0);
            return {
                success: true,
                data: {
                    files,
                    folders,
                    nextCursor,
                    limit,
                    totalScanned,
                    truncated: nextCursor !== null,
                },
            };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    },
};

/**
 * Search for text in files
 */
export const searchFilesTool: ToolDefinition = {
    name: 'search_files',
    description: 'Full-text search in Wiki files - ONLY use as last resort after Batch_Read_Property/Batch_Read_Summary have been tried and found insufficient',
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'The search query',
            },
            path: {
                type: 'string',
                description: 'Limit search to this directory (optional)',
            },
            maxResults: {
                type: 'number',
                description: 'Maximum number of matching files to return (default: 30, max: 200)',
            },
        },
        required: ['query'],
    },
    handler: async (params, context: ToolContext): Promise<ToolResult> => {
        const vault = context.vault as any;
        const query = String(params.query ?? '').trim();
        const basePath = params.path ? normalizePath(params.path as string) : '';
        const rawMaxResults = Number(params.maxResults ?? 30);
        const maxResults = Number.isFinite(rawMaxResults)
            ? Math.max(1, Math.min(Math.floor(rawMaxResults), 200))
            : 30;
        const maxFileSizeBytes = 1 * 1024 * 1024;

        try {
            if (!query) {
                return { success: true, data: { results: [] } };
            }

            let queryRegex: RegExp;
            try {
                queryRegex = new RegExp(query, 'gi');
            } catch (error) {
                return { success: false, error: `Invalid regex query: ${error}` };
            }

            const results: { path: string; matches: number }[] = [];
            const files = vault.getMarkdownFiles();

            for (const file of files) {
                if (basePath && !file.path.startsWith(basePath)) continue;
                if (typeof file.stat?.size === 'number' && file.stat.size > maxFileSizeBytes) continue;

                const content = await vault.read(file);
                queryRegex.lastIndex = 0;
                const matches = (content.match(queryRegex) || []).length;

                if (matches > 0) {
                    results.push({ path: file.path, matches });
                    if (results.length >= maxResults) {
                        break;
                    }
                }
            }

            return { success: true, data: { results } };
        } catch (error) {
            return { success: false, error: String(error) };
        }
    },
};

/**
 * Create a directory
 */
export const createDirectoryTool: ToolDefinition = {
    name: 'create_directory',
    description: 'Create a directory in the vault',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'The path of the directory to create',
            },
        },
        required: ['path'],
    },
    handler: async (params, context: ToolContext): Promise<ToolResult> => {
        const vault = context.vault as any;
        const path = normalizePath(params.path as string);

        try {
            await vault.createFolder(path);
            return { success: true, data: { path } };
        } catch (error) {
            // Folder might already exist
            const folder = vault.getAbstractFileByPath(path);
            if (folder instanceof TFolder) {
                return { success: true, data: { path, existed: true } };
            }
            return { success: false, error: String(error) };
        }
    },
};

/**
 * All file tools
 */
export const fileTools: ToolDefinition[] = [
    readFileTool,
    writeFileTool,
    appendFileTool,
    deleteFileTool,
    listFilesTool,
    searchFilesTool,
    createDirectoryTool,
];
