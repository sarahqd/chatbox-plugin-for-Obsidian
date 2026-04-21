/**
 * Chat History Manager - Chat history management module
 * Supports saving, loading, and managing chat history records
 */

import { App, TFile, TFolder, TAbstractFile } from 'obsidian';
import type { LLMWikiSettings, ChatSession, ChatMessage } from '../types';

/**
 * Chat history manager class
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
     * Initialize history directory
     */
    async initialize(): Promise<void> {
        const chatPath = this.settings.chatHistoryPath;
        const folder = this.app.vault.getAbstractFileByPath(chatPath);
        
        if (!folder) {
            await this.app.vault.createFolder(chatPath);
        }

        // Ensure history file exists
        const historyFile = this.app.vault.getAbstractFileByPath(this.historyFile);
        if (!historyFile) {
            await this.app.vault.create(this.historyFile, JSON.stringify({ sessions: [] }, null, 2));
        }
    }

    /**
     * Create new chat session
     */
    createNewSession(): ChatSession {
        const session: ChatSession = {
            id: `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            title: 'New Chat',
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
     * Get current session
     */
    getCurrentSession(): ChatSession | null {
        return this.currentSession;
    }

    /**
     * Set current session
     */
    setCurrentSession(session: ChatSession): void {
        this.currentSession = session;
    }

    /**
     * Add message to current session
     */
    addMessageToSession(message: ChatMessage): void {
        if (this.currentSession) {
            this.currentSession.messages.push(message);
            this.currentSession.updatedAt = Date.now();
            
            // Update title (use first user message)
            if (this.currentSession.title === 'New Chat' && message.role === 'user') {
                this.currentSession.title = this.generateTitle(message.content);
            }
        }
    }

    /**
     * Update last message in session
     */
    updateLastMessage(content: string): void {
        if (this.currentSession && this.currentSession.messages.length > 0) {
            const lastIndex = this.currentSession.messages.length - 1;
            this.currentSession.messages[lastIndex].content = content;
            this.currentSession.updatedAt = Date.now();
        }
    }

    /**
     * Generate session title
     */
    private generateTitle(content: string): string {
        // Take first 30 characters as title
        const title = content.trim().substring(0, 30);
        return title.length < content.trim().length ? title + '...' : title;
    }

    /**
     * Save current session to history
     */
    async saveCurrentSession(): Promise<boolean> {
        if (!this.currentSession || this.currentSession.messages.length === 0) {
            return false;
        }

        try {
            await this.initialize();
            
            const historyData = await this.loadHistoryData();
            
            // Find if already exists
            const existingIndex = historyData.sessions.findIndex(
                (s: ChatSession) => s.id === this.currentSession!.id
            );
            
            if (existingIndex >= 0) {
                historyData.sessions[existingIndex] = this.currentSession;
            } else {
                historyData.sessions.unshift(this.currentSession);
            }
            
            // Sort by update time
            historyData.sessions.sort((a: ChatSession, b: ChatSession) => b.updatedAt - a.updatedAt);
            
            // Limit history count (max 100 records)
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
     * Load history data
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
     * Get all history sessions
     */
    async getAllSessions(): Promise<ChatSession[]> {
        const data = await this.loadHistoryData();
        return data.sessions;
    }

    /**
     * Get recent N history sessions
     */
    async getRecentSessions(limit: number = 3): Promise<ChatSession[]> {
        const sessions = await this.getAllSessions();
        return sessions.slice(0, limit);
    }

    /**
     * Load session by ID
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
     * Delete session
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
     * Clear all history
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
     * Format time display
     */
    formatTime(timestamp: number): string {
        const now = Date.now();
        const diff = now - timestamp;
        const oneMinute = 60 * 1000;
        const oneHour = 60 * oneMinute;
        const oneDay = 24 * oneHour;

        if (diff < oneHour) {
            const minutes = Math.floor(diff / oneMinute);
            return `${minutes} minutes ago`;
        } else if (diff < oneDay) {
            const hours = Math.floor(diff / oneHour);
            return `${hours} hours ago`;
        } else if (diff < 7 * oneDay) {
            const days = Math.floor(diff / oneDay);
            return `${days} days ago`;
        } else {
            const date = new Date(timestamp);
            return `${date.getMonth() + 1}/${date.getDate()}`;
        }
    }

    /**
     * Get session summary info
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
     * Clear current session messages
     */
    clearCurrentSession(): void {
        if (this.currentSession) {
            this.currentSession.messages = [];
            this.currentSession.updatedAt = Date.now();
        }
    }
}

/**
 * Chat saver class
 */
export class ChatSaver {
    private app: App;
    private settings: LLMWikiSettings;

    constructor(app: App, settings: LLMWikiSettings) {
        this.app = app;
        this.settings = settings;
    }

    /**
     * Save chat as Markdown file
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
     * Format date time
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
     * Generate Markdown content
     */
    private generateMarkdown(session: ChatSession): string {
        const lines: string[] = [];
        const dateStr = new Date(session.createdAt).toLocaleString('en-US');

        lines.push(`# Chat Record - ${dateStr}`);
        lines.push('');
        lines.push('## Meta Information');
        lines.push('');
        lines.push(`- Model: ${session.model}`);
        lines.push(`- Message Count: ${session.messages.length}`);
        lines.push(`- Created: ${dateStr}`);
        lines.push(`- Updated: ${new Date(session.updatedAt).toLocaleString('en-US')}`);
        lines.push('');

        // Add context information
        const contexts = session.messages
            .filter(m => m.context && m.context.length > 0)
            .flatMap(m => m.context || []);
        
        if (contexts.length > 0) {
            lines.push('### Context');
            lines.push('');
            contexts.forEach(ctx => {
                lines.push(`- ${ctx.name} (${ctx.tokens} tokens)`);
            });
            lines.push('');
        }

        lines.push('## Conversation');
        lines.push('');

        session.messages.forEach(message => {
            const time = new Date(message.timestamp).toLocaleTimeString('en-US');
            const role = message.role === 'user' ? 'User' : 
                         message.role === 'assistant' ? 'Assistant' : 'System';
            
            lines.push(`### ${role} (${time})`);
            lines.push('');
            lines.push(message.content);
            lines.push('');

            // Add tool call information
            if (message.toolCalls && message.toolCalls.length > 0) {
                lines.push('**Tool Calls:**');
                lines.push('```json');
                lines.push(JSON.stringify(message.toolCalls, null, 2));
                lines.push('```');
                lines.push('');
            }
        });

        return lines.join('\n');
    }
}
