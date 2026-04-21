/**
 * Chat History Manager - 聊天历史管理模块
 * 支持保存、加载、管理聊天历史记录
 */

import { App, TFile, TFolder, TAbstractFile } from 'obsidian';
import type { LLMWikiSettings, ChatSession, ChatMessage } from '../types';

/**
 * 聊天历史管理器类
 */
export class ChatHistoryManager {
    private app: App;
    private settings: LLMWikiSettings;
    private currentSession: ChatSession | null = null;
    private historyFile: string;

    constructor(app: App, settings: LLMWikiSettings) {
        this.app = app;
        this.settings = settings;
        this.historyFile = `${settings.chatHistoryPath}/history.json`;
    }

    /**
     * 初始化历史记录目录
     */
    async initialize(): Promise<void> {
        const chatPath = this.settings.chatHistoryPath;
        const folder = this.app.vault.getAbstractFileByPath(chatPath);
        
        if (!folder) {
            await this.app.vault.createFolder(chatPath);
        }

        // 确保历史文件存在
        const historyFile = this.app.vault.getAbstractFileByPath(this.historyFile);
        if (!historyFile) {
            await this.app.vault.create(this.historyFile, JSON.stringify({ sessions: [] }, null, 2));
        }
    }

    /**
     * 创建新的聊天会话
     */
    createNewSession(): ChatSession {
        const session: ChatSession = {
            id: `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            title: '新对话',
            messages: [],
            model: this.settings.model,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            totalTokens: 0
        };
        this.currentSession = session;
        return session;
    }

    /**
     * 获取当前会话
     */
    getCurrentSession(): ChatSession | null {
        return this.currentSession;
    }

    /**
     * 设置当前会话
     */
    setCurrentSession(session: ChatSession): void {
        this.currentSession = session;
    }

    /**
     * 添加消息到当前会话
     */
    addMessageToSession(message: ChatMessage): void {
        if (this.currentSession) {
            this.currentSession.messages.push(message);
            this.currentSession.updatedAt = Date.now();
            
            // 更新标题（使用第一条用户消息）
            if (this.currentSession.title === '新对话' && message.role === 'user') {
                this.currentSession.title = this.generateTitle(message.content);
            }
        }
    }

    /**
     * 更新会话中的最后一条消息
     */
    updateLastMessage(content: string): void {
        if (this.currentSession && this.currentSession.messages.length > 0) {
            const lastIndex = this.currentSession.messages.length - 1;
            this.currentSession.messages[lastIndex].content = content;
            this.currentSession.updatedAt = Date.now();
        }
    }

    /**
     * 生成会话标题
     */
    private generateTitle(content: string): string {
        // 截取前30个字符作为标题
        const title = content.trim().substring(0, 30);
        return title.length < content.trim().length ? title + '...' : title;
    }

    /**
     * 保存当前会话到历史
     */
    async saveCurrentSession(): Promise<boolean> {
        if (!this.currentSession || this.currentSession.messages.length === 0) {
            return false;
        }

        try {
            await this.initialize();
            
            const historyData = await this.loadHistoryData();
            
            // 查找是否已存在
            const existingIndex = historyData.sessions.findIndex(
                (s: ChatSession) => s.id === this.currentSession!.id
            );
            
            if (existingIndex >= 0) {
                historyData.sessions[existingIndex] = this.currentSession;
            } else {
                historyData.sessions.unshift(this.currentSession);
            }
            
            // 按更新时间排序
            historyData.sessions.sort((a: ChatSession, b: ChatSession) => b.updatedAt - a.updatedAt);
            
            // 限制历史数量（最多保存 100 条）
            if (historyData.sessions.length > 100) {
                historyData.sessions = historyData.sessions.slice(0, 100);
            }
            
            await this.app.vault.adapter.write(
                this.historyFile,
                JSON.stringify(historyData, null, 2)
            );
            
            return true;
        } catch (error) {
            console.error('Failed to save session:', error);
            return false;
        }
    }

    /**
     * 加载历史数据
     */
    private async loadHistoryData(): Promise<{ sessions: ChatSession[] }> {
        try {
            const file = this.app.vault.getAbstractFileByPath(this.historyFile);
            if (file instanceof TFile) {
                const content = await this.app.vault.read(file);
                return JSON.parse(content);
            }
        } catch (error) {
            console.error('Failed to load history data:', error);
        }
        return { sessions: [] };
    }

    /**
     * 获取所有历史会话
     */
    async getAllSessions(): Promise<ChatSession[]> {
        const data = await this.loadHistoryData();
        return data.sessions;
    }

    /**
     * 获取最近的 N 个历史会话
     */
    async getRecentSessions(limit: number = 3): Promise<ChatSession[]> {
        const sessions = await this.getAllSessions();
        return sessions.slice(0, limit);
    }

    /**
     * 根据 ID 加载会话
     */
    async loadSession(sessionId: string): Promise<ChatSession | null> {
        const sessions = await this.getAllSessions();
        const session = sessions.find(s => s.id === sessionId);
        if (session) {
            this.currentSession = session;
        }
        return session || null;
    }

    /**
     * 删除会话
     */
    async deleteSession(sessionId: string): Promise<boolean> {
        try {
            const historyData = await this.loadHistoryData();
            historyData.sessions = historyData.sessions.filter(
                (s: ChatSession) => s.id !== sessionId
            );
            
            await this.app.vault.adapter.write(
                this.historyFile,
                JSON.stringify(historyData, null, 2)
            );
            
            return true;
        } catch (error) {
            console.error('Failed to delete session:', error);
            return false;
        }
    }

    /**
     * 清空所有历史
     */
    async clearAllHistory(): Promise<boolean> {
        try {
            await this.app.vault.adapter.write(
                this.historyFile,
                JSON.stringify({ sessions: [] }, null, 2)
            );
            return true;
        } catch (error) {
            console.error('Failed to clear history:', error);
            return false;
        }
    }

    /**
     * 格式化时间显示
     */
    formatTime(timestamp: number): string {
        const now = Date.now();
        const diff = now - timestamp;
        const oneMinute = 60 * 1000;
        const oneHour = 60 * oneMinute;
        const oneDay = 24 * oneHour;

        if (diff < oneHour) {
            const minutes = Math.floor(diff / oneMinute);
            return `${minutes} 分钟前`;
        } else if (diff < oneDay) {
            const hours = Math.floor(diff / oneHour);
            return `${hours} 小时前`;
        } else if (diff < 7 * oneDay) {
            const days = Math.floor(diff / oneDay);
            return `${days} 天前`;
        } else {
            const date = new Date(timestamp);
            return `${date.getMonth() + 1}/${date.getDate()}`;
        }
    }

    /**
     * 获取会话摘要信息
     */
    getSessionSummary(session: ChatSession): {
        title: string;
        time: string;
        messageCount: number;
        model: string;
    } {
        return {
            title: session.title,
            time: this.formatTime(session.updatedAt),
            messageCount: session.messages.length,
            model: session.model
        };
    }

    /**
     * 清空当前会话消息
     */
    clearCurrentSession(): void {
        if (this.currentSession) {
            this.currentSession.messages = [];
            this.currentSession.updatedAt = Date.now();
        }
    }
}

/**
 * 聊天保存器类
 */
export class ChatSaver {
    private app: App;
    private settings: LLMWikiSettings;

    constructor(app: App, settings: LLMWikiSettings) {
        this.app = app;
        this.settings = settings;
    }

    /**
     * 保存聊天为 Markdown 文件
     */
    async saveAsMarkdown(session: ChatSession): Promise<string | null> {
        try {
            const chatPath = this.settings.chatHistoryPath;
            const folder = this.app.vault.getAbstractFileByPath(chatPath);
            
            if (!folder) {
                await this.app.vault.createFolder(chatPath);
            }

            const fileName = `chat-${this.formatDateTime(session.createdAt)}.md`;
            const filePath = `${chatPath}/${fileName}`;
            
            const content = this.generateMarkdown(session);
            
            const existingFile = this.app.vault.getAbstractFileByPath(filePath);
            if (existingFile) {
                await this.app.vault.modify(existingFile as TFile, content);
            } else {
                await this.app.vault.create(filePath, content);
            }
            
            return filePath;
        } catch (error) {
            console.error('Failed to save chat as markdown:', error);
            return null;
        }
    }

    /**
     * 格式化日期时间
     */
    private formatDateTime(timestamp: number): string {
        const date = new Date(timestamp);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        return `${year}-${month}-${day}-${hours}-${minutes}-${seconds}`;
    }

    /**
     * 生成 Markdown 内容
     */
    private generateMarkdown(session: ChatSession): string {
        const lines: string[] = [];
        const dateStr = new Date(session.createdAt).toLocaleString('zh-CN');

        lines.push(`# 聊天记录 - ${dateStr}`);
        lines.push('');
        lines.push('## 元信息');
        lines.push('');
        lines.push(`- 模型: ${session.model}`);
        lines.push(`- 消息数: ${session.messages.length}`);
        lines.push(`- 创建时间: ${dateStr}`);
        lines.push(`- 更新时间: ${new Date(session.updatedAt).toLocaleString('zh-CN')}`);
        lines.push('');

        // 添加上下文信息
        const contexts = session.messages
            .filter(m => m.context && m.context.length > 0)
            .flatMap(m => m.context || []);
        
        if (contexts.length > 0) {
            lines.push('### 上下文');
            lines.push('');
            contexts.forEach(ctx => {
                lines.push(`- ${ctx.name} (${ctx.tokens} tokens)`);
            });
            lines.push('');
        }

        lines.push('## 对话');
        lines.push('');

        session.messages.forEach(message => {
            const time = new Date(message.timestamp).toLocaleTimeString('zh-CN');
            const role = message.role === 'user' ? '用户' : 
                         message.role === 'assistant' ? '助手' : '系统';
            
            lines.push(`### ${role} (${time})`);
            lines.push('');
            lines.push(message.content);
            lines.push('');

            // 添加工具调用信息
            if (message.toolCalls && message.toolCalls.length > 0) {
                lines.push('**工具调用:**');
                lines.push('```json');
                lines.push(JSON.stringify(message.toolCalls, null, 2));
                lines.push('```');
                lines.push('');
            }
        });

        return lines.join('\n');
    }
}