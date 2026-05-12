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
    description: 'List all files in a directory',
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
        },
        required: [],
    },
    handler: async (params, context: ToolContext): Promise<ToolResult> => {
        const vault = context.vault as any;
        const basePath = params.path ? normalizePath(params.path as string) : '';
        const recursive = (params.recursive as boolean) ?? false;

        try {
            const files: string[] = [];
            const folder = basePath
                ? vault.getAbstractFileByPath(basePath)
                : vault.root;

            if (!(folder instanceof TFolder)) {
                return { success: false, error: `Folder not found: ${basePath}` };
            }

            const collectFiles = (currentFolder: TFolder) => {
                for (const child of currentFolder.children) {
                    if (child instanceof TFile) {
                        files.push(child.path);
                    } else if (recursive && child instanceof TFolder) {
                        collectFiles(child);
                    }
                }
            };

            collectFiles(folder);
            return { success: true, data: { files } };
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