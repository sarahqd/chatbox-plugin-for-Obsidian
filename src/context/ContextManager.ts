/**
 * Context Manager - 上下文管理模块
 * 支持添加、删除、管理聊天上下文
 */

import { App, TFile, TFolder, TAbstractFile } from 'obsidian';
import type { LLMWikiSettings, ChatContext } from '../types';

/**
 * 简单的 token 计算器
 * 使用近似算法：平均每 4 个字符约等于 1 个 token
 */
export function estimateTokens(text: string): number {
    // 中文约 1.5 字符/token，英文约 4 字符/token
    // 使用折中方案
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const otherChars = text.length - chineseChars;
    return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}

/**
 * 上下文管理器类
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
     * 添加文件作为上下文
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
     * 添加 Wiki 页面作为上下文
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
     * 添加文件夹内容作为上下文
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
     * 添加文本片段作为上下文
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
     * 添加当前活动文件作为上下文
     */
    async addActiveFileContext(): Promise<ChatContext | null> {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) {
            return await this.addFileContext(activeFile);
        }
        return null;
    }

    /**
     * 删除上下文
     */
    removeContext(contextId: string): boolean {
        return this.contexts.delete(contextId);
    }

    /**
     * 清空所有上下文
     */
    clearContexts(): void {
        this.contexts.clear();
    }

    /**
     * 获取所有上下文
     */
    getAllContexts(): ChatContext[] {
        return Array.from(this.contexts.values());
    }

    /**
     * 获取上下文总数
     */
    getContextCount(): number {
        return this.contexts.size;
    }

    /**
     * 获取总 token 数
     */
    getTotalTokens(): number {
        let total = 0;
        this.contexts.forEach(context => {
            total += context.tokens;
        });
        return total;
    }

    /**
     * 检查是否超过最大 token 限制
     */
    isOverLimit(): boolean {
        return this.getTotalTokens() > this.settings.maxContextTokens;
    }

    /**
     * 获取剩余可用 token 数
     */
    getRemainingTokens(): number {
        return Math.max(0, this.settings.maxContextTokens - this.getTotalTokens());
    }

    /**
     * 获取上下文使用百分比
     */
    getUsagePercentage(): number {
        return Math.min(100, (this.getTotalTokens() / this.settings.maxContextTokens) * 100);
    }

    /**
     * 组装上下文为提示词
     */
    assemblePrompt(): string {
        const contexts = this.getAllContexts();
        if (contexts.length === 0) {
            return '';
        }

        const parts: string[] = ['以下是相关的上下文信息：\n'];

        contexts.forEach((context, index) => {
            parts.push(`--- 上下文 ${index + 1}: ${context.name} ---`);
            parts.push(context.content);
            parts.push('');
        });

        parts.push('---\n请基于以上上下文信息回答用户的问题。\n');

        return parts.join('\n');
    }

    /**
     * 获取上下文摘要（用于显示）
     */
    getContextSummary(): string {
        const contexts = this.getAllContexts();
        if (contexts.length === 0) {
            return '无上下文';
        }

        const totalTokens = this.getTotalTokens();
        const maxTokens = this.settings.maxContextTokens;
        const usage = this.getUsagePercentage();

        return `${contexts.length} 个上下文 | ${totalTokens}/${maxTokens} tokens (${usage.toFixed(1)}%)`;
    }

    /**
     * 序列化上下文（用于保存）
     */
    serialize(): ChatContext[] {
        return this.getAllContexts();
    }

    /**
     * 反序列化上下文（用于恢复）
     */
    deserialize(contexts: ChatContext[]): void {
        this.clearContexts();
        contexts.forEach(context => {
            this.contexts.set(context.id, context);
        });
    }
}

/**
 * 获取 Wiki 页面列表
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
 * 获取可用的上下文源列表
 */
export async function getAvailableContextSources(
    app: App, 
    settings: LLMWikiSettings
): Promise<{ type: 'file' | 'wiki' | 'folder'; name: string; path: string }[]> {
    const sources: { type: 'file' | 'wiki' | 'folder'; name: string; path: string }[] = [];

    // 添加当前活动文件
    const activeFile = app.workspace.getActiveFile();
    if (activeFile) {
        sources.push({
            type: 'file',
            name: `当前文件: ${activeFile.name}`,
            path: activeFile.path
        });
    }

    // 添加 Wiki 页面
    const wikiPages = await getWikiPages(app, settings);
    wikiPages.slice(0, 20).forEach(page => {
        sources.push({
            type: 'wiki',
            name: `Wiki: ${page}`,
            path: page
        });
    });

    // 添加常用文件夹
    const folders = [settings.wikiPath, settings.sourcesPath];
    folders.forEach(folder => {
        const folderObj = app.vault.getAbstractFileByPath(folder);
        if (folderObj instanceof TFolder) {
            sources.push({
                type: 'folder',
                name: `文件夹: ${folder}`,
                path: folder
            });
        }
    });

    return sources;
}