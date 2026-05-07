 /**
 * Enhanced Chat View - Chat Dialog
 * Three-section layout: Header (fixed row) + Display Area (elastic scrollable) + Input Section (fixed bottom 1/5)
 * 
 * Layout Specification:
 * - Section 1: Header fixed row (40-48px), flat style
 * - Section 2: Display area elastic fill, scrollable, won't be compressed
 * - Section 3: Input section fixed at bottom, about 1/5 height
 */

import { ItemView, WorkspaceLeaf, Notice, TFile } from 'obsidian';
import './styles.css';
import type { LLMWikiSettings, ChatMessage, ChatContext, OllamaMessage, OllamaToolCall, ModelConfig, FileReference } from '../types';
import { ContextManager, estimateTokens, getAvailableContextSources } from '../context/ContextManager';
import { ChatHistoryManager, ChatSaver } from '../history/ChatHistoryManager';
import { getLLMClient } from '../llm/client';
import { getOllamaTools, executeTool } from '../tools/index';
import { buildRegexFilteredIndex } from '../flows/indexContext';
import { WikiSearchEngine } from '../search/WikiSearchEngine';
import { getProviderMetadata } from '../types';
import { 
    FileSelector, 
    SnippetSelector, 
    FileItem, 
    addFileWithContext, 
    addSnippetContext,
    addSelectionAsContext,
    parseFileReferences,
    createInternalLink
} from '../context/FileSelector';

const VIEW_TYPE_CHAT = 'llm-wiki-chat-view';

type DisplayMode = 'chat' | 'history';

const SEARCH_FILES_CALL_BUDGET = 2;
const SEARCH_FILES_DEFAULT_MAX_RESULTS = 30;

// Tool call data structure for rendering
interface ToolCallDisplay {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    result?: {
        success: boolean;
        data?: unknown;
        error?: string;
    };
    expanded: boolean;
}

export class EnhancedChatView extends ItemView {
    private plugin: { settings: LLMWikiSettings; saveSettings: () => Promise<void> };
    private messages: ChatMessage[] = [];
    
    // UI Elements
    private displayAreaEl: HTMLElement | null = null;
    private messagesEl: HTMLElement | null = null;
    private historyListEl: HTMLElement | null = null;
    private inputEl: HTMLTextAreaElement | null = null;
    private contextDropdownEl: HTMLElement | null = null;
    private modelDropdownEl: HTMLElement | null = null;
    private contextTagsEl: HTMLElement | null = null;
    private modelLabelEl: HTMLElement | null = null;
    private sendBtnEl: HTMLElement | null = null;
    private tokenDisplayEl: HTMLElement | null = null;
    
    // Managers
    private contextManager: ContextManager | null = null;
    private historyManager: ChatHistoryManager | null = null;
    private chatSaver: ChatSaver | null = null;
    
    // State
    private currentModel: string = '';
    private isLoading: boolean = false;
    private contexts: ChatContext[] = [];
    private availableModels: string[] = [];
    private contextSources: { type: string; name: string; path: string }[] = [];
    private displayMode: DisplayMode = 'chat';
    
    // Abort controller for stream cancellation
    private abortController: AbortController | null = null;

    // File selector
    private fileSelectorEl: HTMLElement | null = null;
    private fileSelector: FileSelector | null = null;
    private snippetSelectorEl: HTMLElement | null = null;
    private snippetSelector: SnippetSelector | null = null;
    private fileSelectorVisible: boolean = false;
    private modelUpdateListener: ((event: Event) => void) | null = null;
    private wikiLinkResolutionCache: Map<string, string | null> = new Map();
    private searchFilesCallCount = 0;
    private searchEngine: WikiSearchEngine | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: { settings: LLMWikiSettings; saveSettings: () => Promise<void> }) {
        super(leaf);
        this.plugin = plugin;
        this.currentModel = plugin.settings.models.find((model) => model.id === plugin.settings.currentModelId)?.name || '';
    }

    getViewType(): string { return VIEW_TYPE_CHAT; }
    getDisplayText(): string { return 'WikiChat'; }
    getIcon(): string { return 'bot'; }

    async onOpen() {
        this.contextManager = new ContextManager(this.app, this.plugin.settings);
        this.historyManager = new ChatHistoryManager(this.app, this.plugin.settings);
        this.chatSaver = new ChatSaver(this.app, this.plugin.settings);
        await this.historyManager.initialize();

        if (!this.historyManager.getCurrentSession()) {
            this.historyManager.createNewSession();
        }

        this.render();

        if (this.messages.length === 0) {
            this.addMessage('assistant', 'Hello! I am the WikiChat assistant. I can help you:\n\n- **Ingest** new documents into Wiki\n- **Query** the Wiki knowledge base\n- **Maintain** Wiki content\n\nPlease enter your question or command.');
        }

        this.loadModels();

        // Initialise BM25 + embedding search engine
        this.searchEngine = new WikiSearchEngine(this.app, this.plugin.settings);
        this.searchEngine.build();
        this.registerEvent(this.app.vault.on('create', f => {
            if (f instanceof TFile && f.extension === 'md') this.searchEngine?.onFileCreated(f);
        }));
        this.registerEvent(this.app.vault.on('delete', f => {
            if (f instanceof TFile) this.searchEngine?.onFileDeleted(f.path);
        }));
        this.registerEvent(this.app.vault.on('modify', f => {
            if (f instanceof TFile && f.extension === 'md') this.searchEngine?.onFileChanged(f);
        }));

        // Refresh model label/list when settings page updates model configuration.
        this.modelUpdateListener = async () => {
            await this.loadModels();
            if (this.modelLabelEl) {
                this.modelLabelEl.setText(this.currentModel);
            }
        };
        document.addEventListener('wikichat:model-updated', this.modelUpdateListener);
    }

    async onClose() {
        if (this.historyManager && this.messages.length > 0) {
            await this.historyManager.saveCurrentSession();
        }

        if (this.modelUpdateListener) {
            document.removeEventListener('wikichat:model-updated', this.modelUpdateListener);
            this.modelUpdateListener = null;
        }
    }

    private render() {
        this.containerEl.children[1].empty();
        this.containerEl.children[1].addClass('llm-wiki-chat');

        const container = this.containerEl.children[1].createDiv({ cls: 'chat-container' });

        // === Section 1: Header (fixed row) ===
        this.renderHeader(container);

        // === Section 2: Display Area (elastic height, scrollable) ===
        this.renderDisplayArea(container);

        // === Section 3: Input Section (fixed bottom about 1/5) ===
        this.renderInputSection(container);
    }

    /**
     * Section 1: Header
     * - Height: Fixed row, about 40-48px
     * - Position: Fixed at sidebar top
     * - Style: Flat style, no shadow, no border
     * - Elements: WikiChat name (left) | New Chat, Chat History, Save Chat (right)
     */
    private renderHeader(container: HTMLElement) {
        const header = container.createDiv({ cls: 'chat-header' });

        // Left: Title
        header.createSpan({ text: 'WikiChat', cls: 'header-title' });

        // Right: Button group (icon style)
        const btnGroup = header.createDiv({ cls: 'header-btn-group' });

        // New chat button (plus icon for new chat)
        const newChatBtn = btnGroup.createEl('button', { cls: 'icon-btn', attr: { title: 'New Chat' } });
        newChatBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
        newChatBtn.onClickEvent(() => this.newChat());

        // Chat history button (clock icon)
        const historyBtn = btnGroup.createEl('button', { cls: 'icon-btn', attr: { title: 'Chat History' } });
        historyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>';
        historyBtn.onClickEvent(() => this.toggleDisplayMode('history'));

        // Save chat button (save icon)
        const saveBtn = btnGroup.createEl('button', { cls: 'icon-btn', attr: { title: 'Save Chat' } });
        saveBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>';
        saveBtn.onClickEvent(() => this.saveChat());
    }

    /**
     * Section 2: Display Area
     * - Height: Elastic height, filling space between header and input section
     * - Position: Below header, above input section
     * - Scroll: Supports scrolling when content overflows
     * - Feature: Won't be compressed by input section
     */
    private renderDisplayArea(container: HTMLElement) {
        this.displayAreaEl = container.createDiv({ cls: 'display-area' });
        this.renderCurrentView();
    }

    private renderCurrentView() {
        if (!this.displayAreaEl) return;
        this.displayAreaEl.empty();

        if (this.displayMode === 'chat') {
            // View 1: Current chat
            this.messagesEl = this.displayAreaEl.createDiv({ cls: 'messages-list' });
            this.renderMessages();
        } else if (this.displayMode === 'history') {
            // View 2: Chat history list
            this.historyListEl = this.displayAreaEl.createDiv({ cls: 'history-list-full' });
            this.renderHistoryList();
        }
    }

    private renderMessages() {
        if (!this.messagesEl) return;
        this.messagesEl.empty();

        this.messages.forEach(message => {
            const wrapperEl = this.messagesEl!.createDiv({ cls: `message-wrapper ${message.role}` });

            // Bubble: Only content, no icons and names displayed
            const bubbleEl = wrapperEl.createDiv({ cls: `message-bubble ${message.role}` });
            const contentEl = bubbleEl.createDiv({ cls: 'message-content' });
            
            // Check if this is an empty assistant message during loading - show loading indicator
            const isEmptyAssistant = message.role === 'assistant' && !message.content.trim() && this.isLoading;
            
            if (isEmptyAssistant) {
                // Show animated loading indicator
                contentEl.innerHTML = this.renderLoadingIndicator();
            } else {
                // Render message content with collapsible tool calls
                this.renderMessageContent(contentEl, message.content);
            }

            if (message.context && message.context.length > 0) {
                const ctxEl = bubbleEl.createDiv({ cls: 'message-context' });
                ctxEl.createSpan({ text: `📎 ${message.context.map(c => c.name).join(', ')}` });
            }

            // Time + action buttons row (below bubble)
            if (message.role !== 'system') {
                const metaEl = wrapperEl.createDiv({ cls: 'message-meta' });
                metaEl.createSpan({ text: this.formatTime(message.timestamp), cls: 'message-time' });

                // Copy button
                const copyBtn = metaEl.createEl('button', {
                    cls: 'msg-action-btn',
                    attr: { title: 'Copy content' }
                });
                copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
                copyBtn.onClickEvent(async () => {
                    await navigator.clipboard.writeText(message.content);
                    copyBtn.setAttribute('title', 'Copied!');
                    copyBtn.classList.add('copied');
                    setTimeout(() => {
                        copyBtn.setAttribute('title', 'Copy content');
                        copyBtn.classList.remove('copied');
                    }, 1500);
                });

                // Delete button
                const delBtn = metaEl.createEl('button', {
                    cls: 'msg-action-btn msg-delete-btn',
                    attr: { title: 'Delete this message' }
                });
                delBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4h6v2"></path></svg>';
                delBtn.onClickEvent(() => {
                    this.deleteMessage(message.id);
                });
            }
        });

        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
        
        // Update token display after rendering messages
        this.updateTokenDisplay();
    }
    
    /**
     * Render loading indicator with animated dots
     */
    private renderLoadingIndicator(): string {
        return '<span class="loading-indicator"><span class="loading-dot">.</span><span class="loading-dot">.</span><span class="loading-dot">.</span></span>';
    }
    
    /**
     * Render message content with collapsible tool call sections
     */
    private renderMessageContent(container: HTMLElement, content: string): void {
        // Parse content to extract tool calls and results
        const parts = this.parseToolCallContent(content);
        
        parts.forEach(part => {
            if (part.type === 'text') {
                // Regular text content
                const textEl = container.createDiv();
                textEl.innerHTML = this.renderContent(part.content);
                // Attach click handlers for wiki links
                this.attachWikiLinkHandlers(textEl);
            } else if (part.type === 'tool-call') {
                // Collapsible tool call section
                this.renderCollapsibleToolCall(container, part);
            } else if (part.type === 'tool-result') {
                // Collapsible tool result section
                this.renderCollapsibleToolResult(container, part);
            }
        });
    }
    
    /**
     * Attach click handlers to wiki link elements
     */
    private attachWikiLinkHandlers(container: HTMLElement): void {
        const wikiLinks = container.querySelectorAll('.wiki-link');
        wikiLinks.forEach((el) => {
            const linkEl = el as HTMLElement;
            const wikiLink = linkEl.getAttribute('data-wiki-link');
            if (wikiLink) {
                linkEl.addClass('wiki-link-clickable');
                linkEl.onClickEvent((e) => {
                    e.stopPropagation();
                    this.openWikiLink(wikiLink);
                });
            }
        });
    }
    
    /**
     * Open a wiki link (file in vault)
     */
    private async openWikiLink(linkText: string): Promise<void> {
        const normalizedCacheKey = linkText.trim().toLowerCase();

        // Fast path: cache hit
        if (this.wikiLinkResolutionCache.has(normalizedCacheKey)) {
            const cachedPath = this.wikiLinkResolutionCache.get(normalizedCacheKey);
            if (cachedPath) {
                const cachedFile = this.app.vault.getAbstractFileByPath(cachedPath);
                if (cachedFile instanceof TFile) {
                    const leaf = this.app.workspace.getLeaf(false);
                    await leaf.openFile(cachedFile);
                    new Notice(`Opened: ${cachedFile.path}`);
                    return;
                }
                this.wikiLinkResolutionCache.delete(normalizedCacheKey);
            } else {
                new Notice(`File not found: ${linkText}`);
                return;
            }
        }

        // Try to find the file in the vault
        // First try exact match with .md extension
        let filePath = linkText.endsWith('.md') ? linkText : `${linkText}.md`;
        let file = this.app.vault.getAbstractFileByPath(filePath);
        
        // If not found, try without extension (for files that already have it)
        if (!file) {
            file = this.app.vault.getAbstractFileByPath(linkText);
        }
        
        // If still not found, search for files with similar names
        if (!file) {
            const files = this.app.vault.getMarkdownFiles();
            const matchingFile = files.find(f => {
                const basename = f.basename || f.name.replace(/\.md$/, '');
                return basename === linkText || f.path.includes(linkText);
            });
            if (matchingFile) {
                file = matchingFile;
            }
        }
        
        if (file instanceof TFile) {
            this.wikiLinkResolutionCache.set(normalizedCacheKey, file.path);
            const leaf = this.app.workspace.getLeaf(false);
            await leaf.openFile(file);
            new Notice(`Opened: ${file.path}`);
        } else {
            this.wikiLinkResolutionCache.set(normalizedCacheKey, null);
            new Notice(`File not found: ${linkText}`);
        }
    }
    
    /**
     * Parse content to extract tool calls and results
     */
    private parseToolCallContent(content: string): Array<{type: string; content: string; toolName?: string; args?: string; success?: boolean; result?: string}> {
        const parts: Array<{type: string; content: string; toolName?: string; args?: string; success?: boolean; result?: string}> = [];
        
        // Pattern for tool call: 🔧 **Calling tool:** `name`\n```json\nargs\n```
        const toolCallPattern = /🔧 \*\*Calling tool:\*\* `([^`]+)`\n```json\n([\s\S]*?)```/g;
        // Pattern for tool result: ✅ **Tool executed successfully**\n\n**Result:**\n```json\nresult\n```
        const toolResultSuccessPattern = /✅ \*\*Tool executed successfully\*\*\n\n\*\*Result:\*\*\n```json\n([\s\S]*?)```/g;
        // Pattern for tool error: ❌ **Tool execution failed:** error
        const toolResultErrorPattern = /❌ \*\*Tool execution (?:failed|error):\*\* ([^\n]+)/g;
        
        let lastIndex = 0;
        let match;
        
        // Find all tool calls
        const toolCalls: Array<{start: number; end: number; toolName: string; args: string}> = [];
        while ((match = toolCallPattern.exec(content)) !== null) {
            toolCalls.push({
                start: match.index,
                end: match.index + match[0].length,
                toolName: match[1],
                args: match[2]
            });
        }
        
        // Find all tool results
        const toolResults: Array<{start: number; end: number; success: boolean; result: string}> = [];
        while ((match = toolResultSuccessPattern.exec(content)) !== null) {
            toolResults.push({
                start: match.index,
                end: match.index + match[0].length,
                success: true,
                result: match[1]
            });
        }
        while ((match = toolResultErrorPattern.exec(content)) !== null) {
            toolResults.push({
                start: match.index,
                end: match.index + match[0].length,
                success: false,
                result: match[1]
            });
        }
        
        // Combine and sort all special sections
        const sections: Array<{start: number; end: number; type: string; data: any}> = [
            ...toolCalls.map(tc => ({start: tc.start, end: tc.end, type: 'tool-call', data: tc})),
            ...toolResults.map(tr => ({start: tr.start, end: tr.end, type: 'tool-result', data: tr}))
        ].sort((a, b) => a.start - b.start);
        
        // Build parts array
        for (const section of sections) {
            // Add text before this section
            if (section.start > lastIndex) {
                const textContent = content.substring(lastIndex, section.start).trim();
                if (textContent) {
                    parts.push({type: 'text', content: textContent});
                }
            }
            
            // Add the section
            if (section.type === 'tool-call') {
                parts.push({
                    type: 'tool-call',
                    content: content.substring(section.start, section.end),
                    toolName: section.data.toolName,
                    args: section.data.args
                });
            } else if (section.type === 'tool-result') {
                parts.push({
                    type: 'tool-result',
                    content: content.substring(section.start, section.end),
                    success: section.data.success,
                    result: section.data.result
                });
            }
            
            lastIndex = section.end;
        }
        
        // Add remaining text
        if (lastIndex < content.length) {
            const textContent = content.substring(lastIndex).trim();
            if (textContent) {
                parts.push({type: 'text', content: textContent});
            }
        }
        
        // If no special sections found, return the whole content as text
        if (parts.length === 0 && content.trim()) {
            parts.push({type: 'text', content: content});
        }
        
        return parts;
    }
    
    /**
     * Render collapsible tool call section
     */
    private renderCollapsibleToolCall(container: HTMLElement, part: {toolName?: string; args?: string}): void {
        const section = container.createDiv({ cls: 'tool-call-section collapsed' });
        
        // Header (always visible)
        const header = section.createDiv({ cls: 'tool-call-header' });
        header.createSpan({ cls: 'tool-call-icon', text: '🔧' });
        header.createSpan({ cls: 'tool-call-name', text: part.toolName || 'tool' });
        header.createSpan({ cls: 'tool-call-toggle', text: '▶' });
        
        // Content (collapsible)
        const content = section.createDiv({ cls: 'tool-call-content' });
        const argsLabel = content.createDiv({ cls: 'tool-call-label', text: 'Arguments:' });
        const argsBlock = content.createEl('pre', { cls: 'tool-call-args' });
        argsBlock.createEl('code', { text: part.args || '{}' });
        
        // Toggle click handler
        header.onClickEvent(() => {
            const isCollapsed = section.hasClass('collapsed');
            if (isCollapsed) {
                section.removeClass('collapsed');
                section.addClass('expanded');
                header.querySelector('.tool-call-toggle')?.setText('▼');
            } else {
                section.removeClass('expanded');
                section.addClass('collapsed');
                header.querySelector('.tool-call-toggle')?.setText('▶');
            }
        });
    }
    
    /**
     * Render collapsible tool result section
     */
    private renderCollapsibleToolResult(container: HTMLElement, part: {success?: boolean; result?: string}): void {
        const section = container.createDiv({ cls: `tool-result-section collapsed ${part.success ? 'success' : 'error'}` });
        
        // Header (always visible)
        const header = section.createDiv({ cls: 'tool-result-header' });
        header.createSpan({ cls: 'tool-result-icon', text: part.success ? '✅' : '❌' });
        header.createSpan({ cls: 'tool-result-status', text: part.success ? 'Success' : 'Error' });
        header.createSpan({ cls: 'tool-result-toggle', text: '▶' });
        
        // Content (collapsible)
        const content = section.createDiv({ cls: 'tool-result-content' });
        const resultBlock = content.createEl('pre', { cls: 'tool-result-data' });
        
        // Truncate long results
        let displayResult = part.result || '';
        if (displayResult.length > 1000) {
            displayResult = displayResult.substring(0, 1000) + '\n... (truncated)';
        }
        resultBlock.createEl('code', { text: displayResult });
        
        // Toggle click handler
        header.onClickEvent(() => {
            const isCollapsed = section.hasClass('collapsed');
            if (isCollapsed) {
                section.removeClass('collapsed');
                section.addClass('expanded');
                header.querySelector('.tool-result-toggle')?.setText('▼');
            } else {
                section.removeClass('expanded');
                section.addClass('collapsed');
                header.querySelector('.tool-result-toggle')?.setText('▶');
            }
        });
    }

    /**
     * Chat history list view
     */
    private renderHistoryList() {
        if (!this.historyListEl) return;
        this.historyListEl.empty();

        // Close button
        const title = this.historyListEl.createDiv({ cls: 'history-title-bar' });
        title.createSpan({ text: 'Chat History' });
        title.createEl('button', { text: '✕ Close', cls: 'close-btn' })
            .onClickEvent(() => this.toggleDisplayMode('chat'));

        // History list
        const list = this.historyListEl.createDiv({ cls: 'history-items' });
        this.historyManager!.getRecentSessions(20).then(sessions => {
            sessions.forEach(session => {
                const item = list.createDiv({ cls: 'history-item' });
                
                const info = item.createDiv({ cls: 'history-item-info' });
                const name = info.createDiv({ cls: 'history-item-name' });
                name.setText(session.title || 'Unnamed Chat');
                const meta = info.createDiv({ cls: 'history-item-meta' });
                meta.setText(`📅 ${this.formatDate(session.updatedAt)} · ${session.messages.length} messages`);
                
                const actions = item.createDiv({ cls: 'history-item-actions' });
                actions.createEl('button', { text: '🗑️', cls: 'icon-btn-small', attr: { title: 'Delete' } })
                    .onClickEvent(async (e) => {
                        e.stopPropagation();
                        await this.historyManager!.deleteSession(session.id);
                        this.renderHistoryList();
                    });
                
                item.onClickEvent(() => {
                    this.loadSession(session);
                    this.toggleDisplayMode('chat');
                });
            });

            if (sessions.length === 0) {
                const empty = list.createDiv({ cls: 'empty-message' });
                empty.setText('No chat history');
            }
        });
    }

    /**
     * Section 3: Input Section
     * - Height: Fixed height, about 1/5 of total sidebar height
     * - Position: Always at sidebar bottom
     * - Feature: Won't be compressed by display area, always visible
     */
    private renderInputSection(container: HTMLElement) {
        const inputSection = container.createDiv({ cls: 'input-section' });

        // Unified frame: Wraps input box + toolbar
        const inputBox = inputSection.createDiv({ cls: 'input-box' });

        // Input textarea (no border, fills upper area)
        this.inputEl = inputBox.createEl('textarea', {
            attr: {
                placeholder: 'Type a message, press Enter to send, Shift + Enter for new line...',
                rows: '3'
            },
            cls: 'chat-input'
        });

        // Textarea event handling
        this.inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage(this.inputEl!.value);
                this.inputEl!.value = '';
            }
        });
        
        // @ trigger for file selector
        this.inputEl.addEventListener('input', (e) => {
            const value = this.inputEl!.value;
            const cursorPos = this.inputEl!.selectionStart || 0;
            
            // Check if user typed @
            if (value[cursorPos - 1] === '@') {
                // Check if @ is at start or preceded by whitespace/newline
                if (cursorPos === 1 || /[\s\n]/.test(value[cursorPos - 2])) {
                    this.showFileSelector();
                }
            }
        });
        
        // Handle keyboard navigation for file selector
        this.inputEl.addEventListener('keydown', (e) => {
            if (this.fileSelectorVisible && this.fileSelector) {
                if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    this.fileSelector.selectPrevious();
                } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    this.fileSelector.selectNext();
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                    this.fileSelector.confirmSelection();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    this.hideFileSelector();
                }
            }
        });

        // File selector container
        this.fileSelectorEl = inputSection.createDiv({ cls: 'file-selector-container hidden' });
        this.fileSelector = new FileSelector(
            this.app,
            this.fileSelectorEl,
            (item: FileItem) => this.handleFileSelect(item),
            (filePath: string, startLine: number, endLine: number) => this.handleSnippetConfirm(filePath, startLine, endLine)
        );
        
        // Snippet selector container
        this.snippetSelectorEl = inputSection.createDiv({ cls: 'snippet-selector-container hidden' });

        // Context tags area (above input, variable height)
        this.contextTagsEl = inputBox.createDiv({ cls: 'context-tags-area' });

        // Toolbar (no top divider, buttons have no border)
        const toolbar = inputBox.createDiv({ cls: 'input-toolbar' });

        // @ button
        const atBtn = toolbar.createEl('button', { cls: 'toolbar-btn at-btn', attr: { title: 'Add context' } });
        atBtn.setText('@');
        atBtn.onClickEvent(() => this.showFileSelector());

        // Context dropdown
        this.contextDropdownEl = toolbar.createDiv({ cls: 'combobox-dropdown context-dropdown hidden' });
        this.renderContextDropdown();

        // + button (file upload) - using plus.svg icon
        const uploadWrapper = toolbar.createDiv({ cls: 'upload-wrapper' });
        const uploadBtn = uploadWrapper.createEl('button', { cls: 'icon-btn', attr: { title: 'Upload file' } });
        uploadBtn.innerHTML = '<svg viewBox="0 0 1024 1024" width="16" height="16"><path d="M474 152m8 0l60 0q8 0 8 8l0 704q0 8-8 8l-60 0q-8 0-8-8l0-704q0-8 8-8Z" fill="currentColor"></path><path d="M168 474m8 0l672 0q8 0 8 8l0 60q0 8-8 8l-672 0q-8 0-8-8l0-60q0-8 8-8Z" fill="currentColor"></path></svg>';
        const fileInput = uploadWrapper.createEl('input', {
            attr: { type: 'file', accept: '.md,.txt,.json', multiple: true },
            cls: 'file-input-hidden'
        });
        uploadBtn.onClickEvent(() => fileInput.click());
        fileInput.addEventListener('change', () => this.handleFileUpload(fileInput));

        // Model selector with token display
        const modelSelectorWrapper = toolbar.createDiv({ cls: 'model-selector-wrapper' });
        
        const modelSelector = modelSelectorWrapper.createDiv({ cls: 'toolbar-btn model-selector' });
        this.modelLabelEl = modelSelector.createSpan({ cls: 'model-label' });
        this.modelLabelEl.setText(this.currentModel);
        modelSelector.createSpan({ text: ' ▼', cls: 'model-arrow' });
        modelSelector.onClickEvent(() => this.toggleModelDropdown());

        // Token display (used/max in k units) - hidden
        // this.tokenDisplayEl = modelSelectorWrapper.createSpan({ cls: 'token-display' });
        // this.updateTokenDisplay();

        // Model dropdown
        this.modelDropdownEl = modelSelectorWrapper.createDiv({ cls: 'combobox-dropdown model-dropdown hidden' });
        this.renderModelDropdown();

        // Send/Stop button - Rightmost in toolbar, close to frame
        this.sendBtnEl = toolbar.createEl('button', { cls: 'send-arrow-btn', attr: { title: 'Send message' } });
        this.updateSendButton();
        this.sendBtnEl.onClickEvent(() => {
            if (this.isLoading) {
                this.stopGeneration();
            } else if (this.inputEl) {
                this.sendMessage(this.inputEl.value);
                this.inputEl.value = '';
            }
        });
    }
    
    /**
     * Update send button appearance based on loading state
     * Uses SVG icons from icons/send.svg and icons/stop.svg
     */
    private updateSendButton(): void {
        if (!this.sendBtnEl) return;
        
        if (this.isLoading) {
            // Show stop button - using stop.svg icon
            this.sendBtnEl.className = 'send-btn';
            this.sendBtnEl.setAttribute('title', 'Stop generation');
            this.sendBtnEl.innerHTML = '<svg viewBox="0 0 1024 1024" width="16" height="16"><path d="M512 42.666667a469.333333 469.333333 0 1 0 469.333333 469.333333A469.333333 469.333333 0 0 0 512 42.666667z m0 864a394.666667 394.666667 0 1 1 394.666667-394.666667 395.146667 395.146667 0 0 1-394.666667 394.666667z" fill="currentColor"></path><path d="M365.333333 365.333333m5.333334 0l282.666666 0q5.333333 0 5.333334 5.333334l0 282.666666q0 5.333333-5.333334 5.333334l-282.666666 0q-5.333333 0-5.333334-5.333334l0-282.666666q0-5.333333 5.333334-5.333334Z" fill="currentColor"></path></svg>';
        } else {
            // Show send button - using send.svg icon
            this.sendBtnEl.className = 'send-btn';
            this.sendBtnEl.setAttribute('title', 'Send message');
            this.sendBtnEl.innerHTML = '<svg viewBox="0 0 1024 1024" width="16" height="16"><path d="M469.333333 597.333333c-12.8 0-21.333333-4.266667-29.866666-12.8-17.066667-17.066667-17.066667-42.666667 0-59.733333l469.333333-469.333333c17.066667-17.066667 42.666667-17.066667 59.733333 0s17.066667 42.666667 0 59.733333l-469.333333 469.333333c-8.533333 8.533333-17.066667 12.8-29.866667 12.8z" fill="currentColor"></path><path d="M640 981.333333c-17.066667 0-34.133333-8.533333-38.4-25.6l-162.133333-366.933333-371.2-166.4C51.2 413.866667 42.666667 401.066667 42.666667 384s12.8-34.133333 29.866666-38.4l853.333334-298.666667c17.066667-4.266667 34.133333 0 42.666666 8.533334 12.8 12.8 17.066667 29.866667 8.533334 42.666666l-298.666667 853.333334c-4.266667 17.066667-17.066667 29.866667-38.4 29.866666zM200.533333 388.266667l285.866667 128c8.533333 4.266667 17.066667 12.8 21.333333 21.333333l128 285.866667 234.666667-669.866667L200.533333 388.266667z" fill="currentColor"></path></svg>';
        }
    }
    
    /**
     * Stop LLM generation
     */
    private stopGeneration(): void {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        this.isLoading = false;
        this.updateSendButton();
        new Notice('Generation stopped');
    }
    
    /**
     * Update token display (used/max in k units)
     */
    private updateTokenDisplay(): void {
        if (!this.tokenDisplayEl) return;

        // Approximate request payload tokens to better match what is actually sent to model.
        const baseSystemPromptTokens = estimateTokens(this.buildBaseSystemPrompt());
        const toolSchemaTokens = estimateTokens(JSON.stringify(getOllamaTools()));

        let contextPromptTokens = 0;
        if (this.contexts.length > 0 && this.contextManager) {
            this.contextManager.deserialize(this.contexts);
            contextPromptTokens = estimateTokens(this.contextManager.assemblePrompt());
        }

        const messageTokens = this.messages.reduce((sum, msg) => {
            return sum + estimateTokens(msg.content || '');
        }, 0);

        const draftInputTokens = this.inputEl ? estimateTokens(this.inputEl.value || '') : 0;
        const requestOverheadTokens = 120;

        const usedTokens =
            baseSystemPromptTokens +
            toolSchemaTokens +
            contextPromptTokens +
            messageTokens +
            draftInputTokens +
            requestOverheadTokens;
        
        // Get max context length from current model or settings
        const currentModelConfig = this.plugin.settings.models.find(m => m.id === this.plugin.settings.currentModelId);
        const maxTokens = currentModelConfig?.contextLength || this.plugin.settings.maxContextTokens || 8192;
        
        // Convert to k units (1k = 1000 tokens)
        const usedK = (usedTokens / 1000).toFixed(1);
        const maxK = Math.round(maxTokens / 1000);

        this.tokenDisplayEl.setText(`${usedK}/${maxK}k`);
        
        // Add warning class if over 80%
        if (usedTokens > maxTokens * 0.8) {
            this.tokenDisplayEl.addClass('token-warning');
        } else {
            this.tokenDisplayEl.removeClass('token-warning');
        }
    }

    private buildBaseSystemPrompt(): string {
        return `You are the WikiChat assistant, an AI assistant specialized in maintaining and managing knowledge bases. You can help users ingest knowledge, answer queries, and maintain the knowledge base.

You can use the following tools to complete tasks:
- read_file: Read full file contents from vault
- write_file: Write content to file
- append_file: Append content to file
- delete_file: Delete file
- list_files: List files in directory
- search_files: Search file contents
- create_directory: Create directory
- create_wiki_page: Create Wiki page
- update_wiki_page: Update Wiki page
- Read_Summary: Read only the Summary section
- Update_Summary: Modify only the Summary section
- Read_Property: Read only one frontmatter property
- Update_Property: Modify only one frontmatter property
- Update_Content: Modify only the Content section
- Read_Part: Read only one named section
- Update_Part: Modify only one named section
- add_backlink: Add bidirectional link
- update_index: Update Wiki index

Tool selection rules:
- When searching articles, use staged retrieval: Read_Property first, then Read_Summary, and only read full content when relevance is high.
- Consider relevance high only when title/tags/related or summary clearly match the user intent.
- If the user asks for a single named section, prefer Read_Part instead of reading the whole file.
- If the user asks to rewrite only the main body under ## Content, prefer Update_Content instead of update_wiki_page.
- If the user asks to update one specific section by heading title, prefer Update_Part.
- Use update_wiki_page only when the whole page body needs broad replacement or append behavior.

Examples:
- "Find articles about vector database indexing" -> Read_Property on candidates, then Read_Summary, then read_file only for high-match pages
- "Read the Related Links section of this page" -> Read_Part with part: "Related Links"
- "Rewrite only the Content section, keep summary and metadata unchanged" -> Update_Content

When you need to use tools, please call the corresponding tool functions.`;
    }

    // === Dropdown Methods ===

    private toggleContextDropdown() {
        const isHidden = this.contextDropdownEl?.hasClass('hidden');
        this.closeAllDropdowns();
        if (isHidden) {
            this.contextDropdownEl?.removeClass('hidden');
            // Dropdown gets focus
            this.contextDropdownEl?.focus();
        }
    }

    private async toggleModelDropdown() {
        const isHidden = this.modelDropdownEl?.hasClass('hidden');
        this.closeAllDropdowns();
        if (isHidden) {
            // Always reload models from settings before opening,
            // so newly added models in Settings appear immediately.
            await this.loadModels();
            this.modelDropdownEl?.removeClass('hidden');
            // Dropdown gets focus
            this.modelDropdownEl?.focus();
        }
    }

    private closeAllDropdowns() {
        this.contextDropdownEl?.addClass('hidden');
        this.modelDropdownEl?.addClass('hidden');
    }

    private renderContextDropdown() {
        if (!this.contextDropdownEl) return;
        this.contextDropdownEl.empty();
        // Set tabindex to make dropdown focusable
        this.contextDropdownEl.setAttribute('tabindex', '-1');

        // Close on blur
        this.contextDropdownEl.addEventListener('blur', () => {
            setTimeout(() => this.contextDropdownEl?.addClass('hidden'), 150);
        });

        // Add selection option (for selected text in editor)
        const selectionItem = this.contextDropdownEl.createDiv({ cls: 'dropdown-item' });
        selectionItem.createSpan({ text: '✂️ Add Current Selection' });
        selectionItem.onClickEvent(async () => {
            const ctx = await addSelectionAsContext(this.app);
            if (ctx) {
                this.contexts.push(ctx);
                this.renderContextTags();
                new Notice(`Added selection: ${ctx.name}`);
            } else {
                new Notice('No text selected in editor');
            }
            this.contextDropdownEl?.addClass('hidden');
        });

        // Divider
        this.contextDropdownEl.createDiv({ cls: 'dropdown-divider' });

        this.loadContextSources();

        if (this.contextSources.length === 0) {
            const item = this.contextDropdownEl.createDiv({ cls: 'dropdown-item' });
            item.setText('Loading...');
            return;
        }

        this.contextSources.forEach(source => {
            const item = this.contextDropdownEl!.createDiv({ cls: 'dropdown-item' });
            const icon = source.type === 'file' ? '📄' : source.type === 'wiki' ? '📖' : '📁';
            item.createSpan({ text: `${icon} ${source.name}` });
            item.onClickEvent(() => {
                this.addContext(source);
                this.contextDropdownEl?.addClass('hidden');
            });
        });
    }

    private renderModelDropdown() {
        if (!this.modelDropdownEl) return;
        this.modelDropdownEl.empty();
        // Set tabindex to make dropdown focusable
        this.modelDropdownEl.setAttribute('tabindex', '-1');

        // Keep focus on the dropdown while interacting (including scrollbar drag)
        // so blur handler does not close it before users can scroll/select.
        this.modelDropdownEl.onmousedown = (e) => {
            e.preventDefault();
        };

        // Prevent wheel events from bubbling to outer containers.
        this.modelDropdownEl.onwheel = (e) => {
            e.stopPropagation();
        };

        // Close on blur
        this.modelDropdownEl.onblur = () => {
            setTimeout(() => this.modelDropdownEl?.addClass('hidden'), 150);
        };

        if (this.availableModels.length === 0) {
            const item = this.modelDropdownEl.createDiv({ cls: 'dropdown-item' });
            item.setText('Loading model list...');
            return;
        }

        this.availableModels.forEach(model => {
            const item = this.modelDropdownEl!.createDiv({ 
                cls: `dropdown-item ${model === this.currentModel ? 'selected' : ''}` 
            });
            if (model === this.currentModel) {
                item.createSpan({ text: '✓ ' });
            }
            item.createSpan({ text: model });
            item.onClickEvent(() => {
                this.selectModel(model);
                this.modelDropdownEl?.addClass('hidden');
            });
        });
    }

    // === Operation Methods ===

    private toggleDisplayMode(mode: DisplayMode) {
        if (this.displayMode === mode) {
            this.displayMode = 'chat';  // Click again to return to chat
        } else {
            this.displayMode = mode;
        }
        this.renderCurrentView();
    }

    private async loadModels() {
        try {
            // Load models from settings
            const models = this.plugin.settings.models;
            this.availableModels = models.map(m => m.name);

            // Set current model from settings; fallback to first model or empty.
            const currentModelConfig = models.find(m => m.id === this.plugin.settings.currentModelId) || models[0];
            if (currentModelConfig) {
                this.currentModel = currentModelConfig.name;
                this.plugin.settings.currentModelId = currentModelConfig.id;
            } else {
                this.currentModel = '';
                this.plugin.settings.currentModelId = '';
            }

            if (this.modelLabelEl) {
                this.modelLabelEl.setText(this.currentModel);
            }

            // Keep runtime client in sync with latest settings/model selection.
            getLLMClient(this.plugin.settings);

            // Update token display after loading models
            this.updateTokenDisplay();
            this.renderModelDropdown();
        } catch (e) {
            console.error('Failed to load models:', e);
        }
    }

    private async loadContextSources() {
        this.contextSources = await getAvailableContextSources(this.app, this.plugin.settings);
    }

    private async selectModel(model: string) {
        // Find the model config by name
        const modelConfig = this.plugin.settings.models.find(m => m.name === model);
        if (!modelConfig) return;
        
        this.currentModel = model;
        this.plugin.settings.currentModelId = modelConfig.id;
        await this.plugin.saveSettings();
        
        // Update LLM client
        const client = getLLMClient(this.plugin.settings);
        client.setCurrentModel(modelConfig.id);
        
        if (this.modelLabelEl) {
            this.modelLabelEl.setText(model);
        }
        
        // Update token display when model changes
        this.updateTokenDisplay();
        
        this.renderModelDropdown();
        new Notice(`Switched to model: ${model}`);
    }

    private async addContext(source: { type: string; name: string; path: string }) {
        if (!this.contextManager) return;

        let ctx: ChatContext | null = null;
        if (source.type === 'file') {
            const file = this.app.vault.getAbstractFileByPath(source.path);
            if (file instanceof TFile) {
                ctx = await this.contextManager.addFileContext(file);
            }
        } else if (source.type === 'wiki') {
            ctx = await this.contextManager.addWikiContext(source.path);
        }

        if (ctx) {
            this.contexts.push(ctx);
            this.renderContextTags();
        }
    }

    private renderContextTags() {
        if (!this.contextTagsEl) return;
        this.contextTagsEl.empty();

        if (this.contexts.length === 0) {
            this.contextTagsEl.addClass('hidden');
            this.updateTokenDisplay();
            return;
        }
        this.contextTagsEl.removeClass('hidden');
        this.updateTokenDisplay();

        this.contexts.forEach(ctx => {
            const tag = this.contextTagsEl!.createSpan({ cls: 'context-tag' });
            const icon = ctx.type === 'file' ? '📄' : ctx.type === 'wiki' ? '📖' : ctx.type === 'snippet' ? '✂️' : '📝';
            
            // Show name with link if available
            const nameSpan = tag.createSpan({ text: `${icon} ${ctx.name}` });
            if (ctx.link) {
                nameSpan.setAttribute('title', ctx.link);
                nameSpan.addClass('has-link');
                // Click to open file
                nameSpan.onClickEvent(() => this.openContextFile(ctx));
            }
            
            // Remove button only (no edit button)
            tag.createEl('button', { text: '✕', cls: 'tag-remove' })
                .onClickEvent(() => this.removeContext(ctx.id));
        });
    }
    
    /**
     * Open context file in editor
     */
    private async openContextFile(ctx: ChatContext): Promise<void> {
        if (!ctx.path) return;
        
        const file = this.app.vault.getAbstractFileByPath(ctx.path);
        if (file instanceof TFile) {
            const leaf = this.app.workspace.getLeaf(false);
            await leaf.openFile(file);
        }
    }
    
    /**
     * Edit context (modify snippet range or file content)
     */
    private async editContext(ctx: ChatContext): Promise<void> {
        if (ctx.type === 'snippet' && ctx.path) {
            // Show snippet selector to modify range
            await this.showSnippetSelector(ctx.path);
        } else if (ctx.type === 'file' && ctx.path) {
            // Open file in editor
            await this.openContextFile(ctx);
            new Notice('File opened in editor. Use @ → Add Current Selection to update context.');
        }
    }

    private removeContext(contextId: string) {
        this.contexts = this.contexts.filter(c => c.id !== contextId);
        this.renderContextTags();
    }

    private async handleFileUpload(input: HTMLInputElement) {
        if (!input.files || !this.contextManager) return;

        for (let i = 0; i < input.files.length; i++) {
            const file = input.files[i];
            const content = await file.text();
            const ctx = this.contextManager.addTextContext(file.name, content);
            this.contexts.push(ctx);
        }
        this.renderContextTags();
        input.value = '';
    }

    private async loadSession(session: any) {
        this.messages = [...session.messages];
        this.contexts = [];
        this.currentModel = session.model;
        this.historyManager!.setCurrentSession(session);
        this.renderMessages();
    }

    /**
     * Create new chat
     * - Switch display area to "current chat" view
     * - Create new chat session
     * - Auto-save current chat to history
     * - Clear message list and context
     * - Generate new session ID
     */
    private async newChat() {
        if (this.isLoading) {
            this.stopGeneration();
        }

        if (this.historyManager && this.messages.length > 0) {
            await this.historyManager.saveCurrentSession();
        }
        this.messages = [];
        this.contexts = [];
        if (this.inputEl) {
            this.inputEl.value = '';
        }
        this.wikiLinkResolutionCache.clear();
        this.historyManager?.createNewSession();
        this.displayMode = 'chat';
        this.renderCurrentView();
        this.renderContextTags();
        this.updateTokenDisplay();
        new Notice('New chat created');
    }

    /**
     * Save chat
     * - Save current chat as Markdown file
     * - Save path is configurable (default `Sources/chats/`)
     * - Show save success notification
     */
    private async saveChat() {
        if (!this.historyManager || !this.chatSaver) return;

        const session = this.historyManager.getCurrentSession();
        if (session) {
            const path = await this.chatSaver.saveAsMarkdown(session);
            if (path) {
                new Notice(`Chat saved: ${path}`);
            }
        }
    }

    addMessage(role: 'user' | 'assistant' | 'system', content: string, context?: ChatContext[]): ChatMessage {
        const message: ChatMessage = {
            id: Date.now().toString(),
            role,
            content,
            timestamp: Date.now(),
            context
        };
        this.messages.push(message);

        if (this.historyManager) {
            this.historyManager.addMessageToSession(message);
        }

        this.renderMessages();
        return message;
    }

    appendToLastMessage(text: string) {
        if (this.messages.length > 0) {
            this.messages[this.messages.length - 1].content += text;
            this.renderMessages();
        }
    }

    private deleteMessage(id: string) {
        this.messages = this.messages.filter(m => m.id !== id);
        this.renderMessages();
    }

    async sendMessage(text: string) {
        if (!text.trim() || this.isLoading) return;

        this.isLoading = true;
        this.updateSendButton();
        this.searchFilesCallCount = 0;
        const messageText = text.trim();
        
        // Create abort controller for this request
        this.abortController = new AbortController();
        const signal = this.abortController.signal;
        
        this.addMessage('user', messageText, this.contexts.length > 0 ? [...this.contexts] : undefined);

        try {
            const relevantIndexContext = await this.getRelevantIndexContext(messageText);

            // Build system prompt (including tool descriptions)
            let systemPrompt = this.buildBaseSystemPrompt();

            if (relevantIndexContext) {
                systemPrompt += `\n\n## BM25+Embedding Retrieved Sections\n\n\`\`\`\n${relevantIndexContext}\n\`\`\`\n\nThese sections were retrieved from the wiki using BM25 + embedding rerank. Use them as the primary retrieval context, and read specific pages with tools when more detail is needed.`;
            }
            
            // If there's context, add to system prompt
            if (this.contexts.length > 0 && this.contextManager) {
                // Sync contexts to context manager
                this.contextManager.deserialize(this.contexts);
                const contextContent = this.contextManager.assemblePrompt();
                systemPrompt += `\n\n## Context Information\n${contextContent}`;
            }

            // Build message list.
            // For small-context local models (≤8k tokens), keep fewer turns to leave
            // room for the system prompt, BM25 context, and tool schemas.
            const currentModelConfig = this.plugin.settings.models.find(
                m => m.id === this.plugin.settings.currentModelId
            );
            const maxCtx = currentModelConfig?.contextLength || this.plugin.settings.maxContextTokens || 8192;
            const historyTurns = maxCtx <= 8192 ? 4 : 10;

            const recentMessages = this.messages
                .filter(m => m.role !== 'system')
                .slice(-historyTurns);

            const messages: OllamaMessage[] = [];
            for (const msg of recentMessages) {
                // Keep UI text unchanged, but send normalized wiki link paths for user messages.
                const contentForModel = msg.role === 'user'
                    ? await this.normalizeMessageWikiLinks(msg.content)
                    : msg.content;
                messages.push({ role: msg.role, content: contentForModel });
            }

            // Add an empty assistant message for streaming updates
            this.addMessage('assistant', '');

            // Use unified LLM client to send request
            const client = getLLMClient(this.plugin.settings);
            
            // Get tool definitions
            const tools = getOllamaTools();
            
            // Check if current model supports tool calls
            let useTools = currentModelConfig?.supportsTools ?? true; // Read from model config, default true
            
            // Tool call loop — prevent infinite loops with a reasonable upper bound
            // Can be configured per model or use a sensible default
            const maxIterations = currentModelConfig?.maxToolIterations ?? 100; // Configurable, default to 5
            let iteration = 0;
            
            while (iteration < maxIterations) {
                iteration++;
                
                let fullResponse = '';
                let toolCalls: OllamaToolCall[] = [];
                
                try {
                    // Send streaming request (with tools)
                    const response = await client.chatStream({
                        messages, 
                        onChunk: (chunk: string) => {
                            fullResponse += chunk;
                            this.appendToLastMessage(chunk);
                        },
                        tools: useTools ? tools : undefined, 
                        systemPrompt,
                        signal  // Pass abort signal for cancellation
                    });

                    // Update last message with full content
                    if (this.messages.length > 0) {
                        this.messages[this.messages.length - 1].content = fullResponse;
                    }

                    // Check if there are tool calls
                    if (response.message.toolCalls && response.message.toolCalls.length > 0) {
                        toolCalls = response.message.toolCalls;
                        
                        // Display tool call information
                        for (const toolCall of toolCalls) {
                            const toolName = toolCall.function.name;
                            const toolArgs = toolCall.function.arguments;
                            this.appendToLastMessage(`\n\n🔧 **Calling tool:** \`${toolName}\`\n\`\`\`json\n${JSON.stringify(toolArgs, null, 2)}\n\`\`\`\n`);
                        }
                        
                        // Execute tool calls
                        const toolResults: OllamaMessage[] = [];
                        for (const toolCall of toolCalls) {
                            const toolName = toolCall.function.name;
                            const toolArgs = toolCall.function.arguments;
                            
                            try {
                                // Build tool context
                                const toolContext = {
                                    vault: this.app.vault,
                                    app: this.app,
                                    settings: this.plugin.settings
                                };

                                const normalizedToolArgs: Record<string, unknown> =
                                    toolArgs && typeof toolArgs === 'object'
                                        ? { ...(toolArgs as Record<string, unknown>) }
                                        : {};

                                if (toolName === 'search_files') {
                                    this.searchFilesCallCount += 1;
                                    if (this.searchFilesCallCount > SEARCH_FILES_CALL_BUDGET) {
                                        const budgetError = `search_files call budget exceeded (${SEARCH_FILES_CALL_BUDGET} per message). Narrow path scope or use Read_Property/Read_Summary first.`;
                                        this.appendToLastMessage(`\n❌ **Tool execution skipped:** ${budgetError}`);
                                        toolResults.push({
                                            role: 'tool',
                                            content: JSON.stringify({ success: false, error: budgetError }),
                                            toolCallId: toolCall.id
                                        });
                                        continue;
                                    }

                                    if (normalizedToolArgs.maxResults === undefined) {
                                        normalizedToolArgs.maxResults = SEARCH_FILES_DEFAULT_MAX_RESULTS;
                                    }
                                }
                                
                                // Execute tool
                                const result = await executeTool(toolName, normalizedToolArgs, toolContext);
                                
                                // Display tool result with markdown formatting
                                if (result.success) {
                                    this.appendToLastMessage(`\n✅ **Tool executed successfully**`);
                                    if (result.data) {
                                        const dataStr = JSON.stringify(result.data, null, 2);
                                        // Limit display length
                                        const displayStr = dataStr.length > 1000 ? dataStr.substring(0, 1000) + '\n... (truncated)' : dataStr;
                                        this.appendToLastMessage(`\n\n**Result:**\n\`\`\`json\n${displayStr}\n\`\`\``);
                                    }
                                } else {
                                    this.appendToLastMessage(`\n❌ **Tool execution failed:** ${result.error}`);
                                }
                                
                                // Add tool result to message list.
                                // Truncate large results based on the active model's context window.
                                // Budget: ~50% of context for tool results (4 chars ≈ 1 token).
                                const maxToolResultChars = Math.max(1000, Math.floor(maxCtx * 4 * 0.5));
                                let toolResultStr = JSON.stringify(result);
                                if (toolResultStr.length > maxToolResultChars) {
                                    const truncated = { success: result.success, data: toolResultStr.slice(0, maxToolResultChars) + '…(truncated)' };
                                    toolResultStr = JSON.stringify(truncated);
                                }
                                toolResults.push({
                                    role: 'tool',
                                    content: toolResultStr,
                                    toolCallId: toolCall.id
                                });
                            } catch (error) {
                                const errorMsg = String(error);
                                this.appendToLastMessage(`\n❌ **Tool execution error:** ${errorMsg}`);
                                toolResults.push({
                                    role: 'tool',
                                    content: JSON.stringify({ success: false, error: errorMsg }),
                                    toolCallId: toolCall.id
                                });
                            }
                        }
                        
                        // Add assistant message and tool results to message history
                        messages.push({
                            role: 'assistant',
                            content: fullResponse,
                            toolCalls: toolCalls
                        });
                        messages.push(...toolResults);
                        
                        // Continue loop, let LLM process tool results
                        continue;
                    }
                    
                    // No tool calls, end loop
                    break;
                    
                } catch (error) {
                    const errorMsg = String(error);
                    
                    // If it's a 400 error and using tools, model might not support tool calls
                    if (errorMsg.includes('400') && useTools) {
                        console.log('Model may not support tool calls, retrying without tools...');
                        useTools = false;
                        this.appendToLastMessage('\n\n⚠️ Current model may not support tool calls, retrying in normal mode...');
                        
                        // Retry without tools
                        let retryResponse = '';
                        await client.chatStream({
                            messages, 
                            onChunk: (chunk: string) => {
                                retryResponse += chunk;
                                this.appendToLastMessage(chunk);
                            },
                            tools: undefined, // Without tools
                            systemPrompt,
                            signal  // Pass abort signal for cancellation
                        });
                        
                        if (this.messages.length > 0) {
                            this.messages[this.messages.length - 1].content = retryResponse;
                        }
                        break;
                    }
                    
                    // Other errors, throw directly
                    throw error;
                }
            }
            
            if (iteration >= maxIterations) {
                this.appendToLastMessage('\n\n⚠️ Reached maximum tool call limit');
            }

        } catch (error) {
            console.error('Ollama chat error:', error);
            
            // Check if this was an abort (user cancelled)
            if (signal.aborted) {
                // Don't show error for user-initiated cancellation
                // Just ensure the last message has some content if it was empty
                if (this.messages.length > 0 && !this.messages[this.messages.length - 1].content.trim()) {
                    this.messages[this.messages.length - 1].content = '*Generation stopped*';
                    this.renderMessages();
                }
            } else {
                this.addMessage('system', `❌ Error: ${error}`);
            }
        } finally {
            // Clean up abort controller
            this.abortController = null;
            this.isLoading = false;
            this.updateSendButton();
        }
    }

    private formatTime(timestamp: number): string {
        const d = new Date(timestamp);
        const yyyy = d.getFullYear();
        const MM = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const HH = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return `${yyyy}-${MM}-${dd} ${HH}:${mm}`;
    }

    private formatDate(timestamp: number): string {
        return new Date(timestamp).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    private renderContent(content: string): string {
        // First, handle code blocks (```language\ncode\n```)
        let result = content;
        
        // Process code blocks first (before other replacements)
        result = result.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
            const escapedCode = this.escapeHtml(code.trim());
            return `<pre class="code-block" data-lang="${lang || 'text'}"><code>${escapedCode}</code></pre>`;
        });
        
        // Then handle inline code (`code`)
        result = result.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
        
        // Handle wiki links [[link]] - make them clickable with data attribute
        result = result.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, (_, linkText) => {
            const escapedLink = this.escapeHtml(linkText);
            return `<span class="wiki-link" data-wiki-link="${escapedLink}">[[${escapedLink}]]</span>`;
        });
        
        // Handle headings (must be at start of line or after newline)
        // ## Heading -> <h2>Heading</h2>
        result = result.replace(/^### (.+)$/gm, '<h3 class="md-heading md-h3">$1</h3>');
        result = result.replace(/^## (.+)$/gm, '<h2 class="md-heading md-h2">$1</h2>');
        result = result.replace(/^# (.+)$/gm, '<h1 class="md-heading md-h1">$1</h1>');
        
        // Handle unordered lists (- item or * item)
        result = result.replace(/^- (.+)$/gm, '<li class="md-list-item">$1</li>');
        result = result.replace(/^\* (.+)$/gm, '<li class="md-list-item">$1</li>');
        
        // Handle ordered lists (1. item)
        result = result.replace(/^\d+\. (.+)$/gm, '<li class="md-list-item md-ordered">$1</li>');
        
        // Wrap consecutive list items in <ul>
        result = result.replace(/(<li class="md-list-item"[^>]*>.*?<\/li>\n?)+/g, (match) => {
            return `<ul class="md-list">${match}</ul>`;
        });
        
        // Handle bold **text**
        result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        
        // Handle italic *text* (but not if it's part of a list marker already processed)
        result = result.replace(/(?<!<li[^>]*>)\*([^*]+)\*/g, '<em>$1</em>');
        
        // Handle links [text](url)
        result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="md-link" target="_blank">$1</a>');
        
        // Handle blockquotes (> text)
        result = result.replace(/^> (.+)$/gm, '<blockquote class="md-quote">$1</blockquote>');
        
        // Handle horizontal rules (---)
        result = result.replace(/^---$/gm, '<hr class="md-hr">');
        
        // Handle newlines (but not inside code blocks or after block elements)
        result = result.replace(/\n(?!<\/(?:pre|h[1-6]|ul|ol|li|blockquote|hr)>)/g, '<br>');
        
        return result;
    }
    
    private escapeHtml(text: string): string {
        const escapeMap: Record<string, string> = {
            '&': '\u0026amp;',
            '<': '\u003C',
            '>': '\u003E',
            '"': '\u0022quot;',
            "'": '\u0027039;'
        };
        let result = text;
        for (const [char, entity] of Object.entries(escapeMap)) {
            result = result.split(char).join(entity);
        }
        return result;
    }
    
    // === File Selector Methods ===
    
    /**
     * Show the file selector (triggered by @)
     */
    private showFileSelector(): void {
        if (!this.fileSelectorEl || !this.fileSelector) return;
        
        this.fileSelectorEl.removeClass('hidden');
        this.fileSelector.show('@');
        this.fileSelectorVisible = true;
    }
    
    /**
     * Hide the file selector
     */
    private hideFileSelector(): void {
        if (!this.fileSelectorEl || !this.fileSelector) return;
        
        this.fileSelector.hide();
        this.fileSelectorEl.addClass('hidden');
        this.fileSelectorVisible = false;
    }
    
    /**
     * Handle file selection from file selector
     */
    private async handleFileSelect(item: FileItem): Promise<void> {
        if (item.type !== 'file') return;
        
        // Hide file selector
        this.hideFileSelector();
        
        // Remove @ from input
        if (this.inputEl) {
            const value = this.inputEl.value;
            const cursorPos = this.inputEl.selectionStart || 0;
            // Find and remove the @ that triggered the selector
            const beforeAt = value.substring(0, cursorPos - 1);
            const afterAt = value.substring(cursorPos);
            this.inputEl.value = beforeAt + afterAt;
        }
        
        // Add file as context with link
        const ctx = await addFileWithContext(this.app, item.path);
        if (ctx) {
            this.contexts.push(ctx);
            this.renderContextTags();
            new Notice(`Added context: ${item.name}`);
            
            // Ask if user wants to add entire file or select snippet
            // For now, we add the entire file. User can use snippet selector for partial content.
        }
    }
    
    /**
     * Handle snippet confirmation
     */
    private async handleSnippetConfirm(filePath: string, startLine: number, endLine: number): Promise<void> {
        // Hide snippet selector
        if (this.snippetSelectorEl) {
            this.snippetSelectorEl.addClass('hidden');
        }
        if (this.snippetSelector) {
            this.snippetSelector.hide();
        }
        
        // Add snippet as context
        const ctx = await addSnippetContext(this.app, filePath, startLine, endLine);
        if (ctx) {
            this.contexts.push(ctx);
            this.renderContextTags();
            new Notice(`Added snippet: ${ctx.name}`);
        }
    }
    
    /**
     * Show snippet selector for a file
     */
    private async showSnippetSelector(filePath: string): Promise<void> {
        if (!this.snippetSelectorEl) return;
        
        try {
            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (file instanceof TFile) {
                const content = await this.app.vault.read(file);
                
                this.snippetSelectorEl.removeClass('hidden');
                this.snippetSelector = new SnippetSelector(
                    this.app,
                    this.snippetSelectorEl,
                    filePath,
                    content,
                    (fp, start, end) => this.handleSnippetConfirm(fp, start, end)
                );
                this.snippetSelector.show();
            }
        } catch (error) {
            console.error('Failed to show snippet selector:', error);
        }
    }

    /**
     * Parse [[file]] references from message and return file paths
     */
    private extractFileReferences(text: string): FileReference[] {
        return parseFileReferences(text);
    }

    /**
     * Normalize wiki links in user message to full file paths when possible.
     * Example: [[Note]] -> [[folder/Note.md|Note]] (if resolvable)
     */
    private async normalizeMessageWikiLinks(text: string): Promise<string> {
        const references = this.extractFileReferences(text);
        if (references.length === 0) {
            return text;
        }

        return text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (fullMatch, rawPath: string, rawDisplay?: string) => {
            const originalTarget = rawPath.trim();
            const resolvedTarget = this.resolveWikiLinkToPath(originalTarget);
            if (!resolvedTarget) {
                return fullMatch;
            }

            const displayName = rawDisplay?.trim() || this.getWikiLinkDisplayName(originalTarget);
            return createInternalLink(resolvedTarget, displayName);
        });
    }

    private async getRelevantIndexContext(question: string): Promise<string | null> {
        // Primary path: BM25 + optional embedding rerank
        if (this.searchEngine?.isReady()) {
            try {
                const top30 = this.searchEngine.search(question, 30);
                if (top30.length > 0) {
                    const embedFn = this.buildEmbedFn();
                    const chunks = await this.searchEngine.rerank(question, top30, embedFn, 10);
                    if (chunks.length > 0) {
                        return chunks
                            .map(c => `### [[${c.path.replace(/\.md$/, '')}|${c.title}]]\n${c.chunk}`)
                            .join('\n\n---\n\n');
                    }
                }
            } catch (e) {
                console.warn('[WikiChat] WikiSearchEngine error, falling back to index.md:', e);
            }
        }

        // Fallback: regex-filtered index.md
        const indexPath = `${this.plugin.settings.wikiPath}/index.md`;
        const indexFile = this.app.vault.getAbstractFileByPath(indexPath);
        if (!(indexFile instanceof TFile)) return null;
        const indexContent = await this.app.vault.read(indexFile);
        return buildRegexFilteredIndex(indexContent, question);
    }

    private buildEmbedFn(): ((text: string) => Promise<number[]>) | null {
        const { currentEmbeddingModelId, embeddingModels } = this.plugin.settings;
        if (!currentEmbeddingModelId) return null;
        const cfg = embeddingModels?.find(m => m.id === currentEmbeddingModelId);
        if (!cfg?.baseUrl || !cfg?.modelId) return null;
        const meta = getProviderMetadata(cfg.provider);
        if (meta.apiStyle === 'ollama') {
            return async (text: string) => {
                const res = await fetch(`${cfg.baseUrl}/api/embed`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model: cfg.modelId, input: text }),
                });
                const json = await res.json();
                return json.embeddings?.[0] ?? [];
            };
        }
        // OpenAI-compatible
        return async (text: string) => {
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
            const res = await fetch(`${cfg.baseUrl}/embeddings`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ model: cfg.modelId, input: text }),
            });
            const json = await res.json();
            return json.data?.[0]?.embedding ?? [];
        };
    }

    /**
     * Resolve wiki link target to an actual vault path, preserving heading/block suffix.
     */
    private resolveWikiLinkToPath(target: string): string | null {
        const [rawBasePath, ...suffixParts] = target.split('#');
        const basePath = rawBasePath.trim();
        const suffix = suffixParts.length > 0 ? `#${suffixParts.join('#')}` : '';

        if (!basePath) {
            return null;
        }

        const resolvedBasePath = this.findWikiFilePath(basePath);
        if (!resolvedBasePath) {
            return null;
        }

        return `${resolvedBasePath}${suffix}`;
    }

    /**
     * Find file path using Obsidian's metadataCache, scoped to the wiki directory.
     * getFirstLinkpathDest() is O(1) — metadataCache maintains its own internal index
     * and stays in sync with vault changes automatically.
     */
    private findWikiFilePath(linkPath: string): string | null {
        const cacheKey = linkPath.trim().toLowerCase();
        if (this.wikiLinkResolutionCache.has(cacheKey)) {
            return this.wikiLinkResolutionCache.get(cacheKey) || null;
        }

        // Delegate to Obsidian's native wikilink resolver (handles basename, path, aliases).
        const resolved = this.app.metadataCache.getFirstLinkpathDest(linkPath, '');
        const wikiPath = this.plugin.settings.wikiPath;
        const resolvedPath =
            resolved instanceof TFile && resolved.path.startsWith(wikiPath + '/')
                ? resolved.path
                : null;

        this.wikiLinkResolutionCache.set(cacheKey, resolvedPath);
        return resolvedPath;
    }

    /**
     * Derive readable display name from wiki link target.
     */
    private getWikiLinkDisplayName(target: string): string {
        const basePath = target.split('#')[0].trim();
        if (!basePath) {
            return target;
        }
        const segments = basePath.split('/');
        return segments[segments.length - 1] || basePath;
    }
}
