/**
 * Context Manager - Context Management Module
 * Supports adding, deleting, and managing chat contexts
 */

import { App, TFile, TFolder, TAbstractFile } from 'obsidian';
import type { LLMWikiSettings, ChatContext } from '../types';

/**
 * Simple token calculator
 * Uses approximation: average 4 characters equals 1 token
 */
export function estimateTokens(text: string): number {
    // Chinese: ~1.5 chars/token, English: ~4 chars/token
    // Use a balanced approach
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const otherChars = text.length - chineseChars;
    return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}

/**
 * Context Manager Class
 */
export class ContextManager {
    private app: App;
    private settings: LLMWikiSettings;
    private contexts: Map<string, ChatContext> = new Map();

    constructor(app: App, settings: LLMWikiSettings) {
        this.app = app;
        this.settings = settings;
    }

    /**
     * Add file as context
     */
    async addFileContext(file: TFile): Promise<ChatContext | null> {
        try {
            const content = await this.app.vault.read(file);
            const tokens = estimateTokens(content);
            
            const context: ChatContext = {
                id: `file-${file.path}-${Date.now()}`,
                type: 'file',
                name: file.name,
                path: file.path,
                content: content,
                tokens: tokens
            };

            this.contexts.set(context.id, context);
            return context;
        } catch (error) {
            console.error('Failed to add file context:', error);
            return null;
        }
    }

    /**
     * Add Wiki page as context
     */
    async addWikiContext(pagePath: string): Promise<ChatContext | null> {
        try {
            const fullPath = `${this.settings.wikiPath}/${pagePath}.md`;
            const file = this.app.vault.getAbstractFileByPath(fullPath);
            
            if (file instanceof TFile) {
                const content = await this.app.vault.read(file);
                const tokens = estimateTokens(content);
                
                const context: ChatContext = {
                    id: `wiki-${pagePath}-${Date.now()}`,
                    type: 'wiki',
                    name: pagePath,
                    path: fullPath,
                    content: content,
                    tokens: tokens
                };

                this.contexts.set(context.id, context);
                return context;
            }
            return null;
        } catch (error) {
            console.error('Failed to add wiki context:', error);
            return null;
        }
    }

    /**
     * Add folder contents as context
     */
    async addFolderContext(folderPath: string, maxFiles: number = 10): Promise<ChatContext[]> {
        const addedContexts: ChatContext[] = [];
        
        try {
            const folder = this.app.vault.getAbstractFileByPath(folderPath);
            
            if (folder instanceof TFolder) {
                const files = folder.children
                    .filter((child): child is TFile => child instanceof TFile)
                    .filter(file => file.extension === 'md' || file.extension === 'txt')
                    .slice(0, maxFiles);

                for (const file of files) {
                    const context = await this.addFileContext(file);
                    if (context) {
                        addedContexts.push(context);
                    }
                }
            }
        } catch (error) {
            console.error('Failed to add folder context:', error);
        }

        return addedContexts;
    }

    /**
     * Add text snippet as context
     */
    addTextContext(name: string, content: string): ChatContext {
        const tokens = estimateTokens(content);
        
        const context: ChatContext = {
            id: `text-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type: 'text',
            name: name,
            content: content,
            tokens: tokens
        };

        this.contexts.set(context.id, context);
        return context;
    }

    /**
     * Add current active file as context
     */
    async addActiveFileContext(): Promise<ChatContext | null> {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) {
            return await this.addFileContext(activeFile);
        }
        return null;
    }

    /**
     * Remove context
     */
    removeContext(contextId: string): boolean {
        return this.contexts.delete(contextId);
    }

    /**
     * Clear all contexts
     */
    clearContexts(): void {
        this.contexts.clear();
    }

    /**
     * Get all contexts
     */
    getAllContexts(): ChatContext[] {
        return Array.from(this.contexts.values());
    }

    /**
     * Get context count
     */
    getContextCount(): number {
        return this.contexts.size;
    }

    /**
     * Get total token count
     */
    getTotalTokens(): number {
        let total = 0;
        this.contexts.forEach(context => {
            total += context.tokens;
        });
        return total;
    }

    /**
     * Check if over max token limit
     */
    isOverLimit(): boolean {
        return this.getTotalTokens() > this.settings.maxContextTokens;
    }

    /**
     * Get remaining available tokens
     */
    getRemainingTokens(): number {
        return Math.max(0, this.settings.maxContextTokens - this.getTotalTokens());
    }

    /**
     * Get context usage percentage
     */
    getUsagePercentage(): number {
        return Math.min(100, (this.getTotalTokens() / this.settings.maxContextTokens) * 100);
    }

    /**
     * Assemble context as prompt
     */
    assemblePrompt(): string {
        const contexts = this.getAllContexts();
        if (contexts.length === 0) {
            return '';
        }

        const parts: string[] = ['Here is the relevant context information:\n'];

        contexts.forEach((context, index) => {
            parts.push(`--- Context ${index + 1}: ${context.name} ---`);
            parts.push(context.content);
            parts.push('');
        });

        parts.push('---\nPlease answer the user\'s question based on the above context.\n');

        return parts.join('\n');
    }

    /**
     * Get context summary (for display)
     */
    getContextSummary(): string {
        const contexts = this.getAllContexts();
        if (contexts.length === 0) {
            return 'No context';
        }

        const totalTokens = this.getTotalTokens();
        const maxTokens = this.settings.maxContextTokens;
        const usage = this.getUsagePercentage();

        return `${contexts.length} contexts | ${totalTokens}/${maxTokens} tokens (${usage.toFixed(1)}%)`;
    }

    /**
     * Serialize context (for saving)
     */
    serialize(): ChatContext[] {
        return this.getAllContexts();
    }

    /**
     * Deserialize context (for restoring)
     */
    deserialize(contexts: ChatContext[]): void {
        this.clearContexts();
        contexts.forEach(context => {
            this.contexts.set(context.id, context);
        });
    }
}

/**
 * Get Wiki page list
 */
export async function getWikiPages(app: App, settings: LLMWikiSettings): Promise<string[]> {
    const pages: string[] = [];
    const wikiFolder = app.vault.getAbstractFileByPath(settings.wikiPath);
    
    if (wikiFolder instanceof TFolder) {
        const collectPages = (folder: TFolder, prefix: string = '') => {
            folder.children.forEach(child => {
                if (child instanceof TFile && child.extension === 'md') {
                    const pageName = prefix ? `${prefix}/${child.basename}` : child.basename;
                    pages.push(pageName);
                } else if (child instanceof TFolder) {
                    collectPages(child, prefix ? `${prefix}/${child.name}` : child.name);
                }
            });
        };
        collectPages(wikiFolder);
    }
    
    return pages;
}

/**
 * Get available context sources list
 */
export async function getAvailableContextSources(
    app: App, 
    settings: LLMWikiSettings
): Promise<{ type: 'file' | 'wiki' | 'folder'; name: string; path: string }[]> {
    const sources: { type: 'file' | 'wiki' | 'folder'; name: string; path: string }[] = [];

    // Add current active file
    const activeFile = app.workspace.getActiveFile();
    if (activeFile) {
        sources.push({
            type: 'file',
            name: `Current file: ${activeFile.name}`,
            path: activeFile.path
        });
    }

    // Add Wiki pages
    const wikiPages = await getWikiPages(app, settings);
    wikiPages.slice(0, 20).forEach(page => {
        sources.push({
            type: 'wiki',
            name: `Wiki: ${page}`,
            path: page
        });
    });

    // Add common folders
    const folders = [settings.wikiPath, settings.sourcesPath];
    folders.forEach(folder => {
        const folderObj = app.vault.getAbstractFileByPath(folder);
        if (folderObj instanceof TFolder) {
            sources.push({
                type: 'folder',
                name: `Folder: ${folder}`,
                path: folder
            });
        }
    });

    return sources;
}
