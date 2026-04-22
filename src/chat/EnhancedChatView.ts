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
import { ContextManager, getAvailableContextSources } from '../context/ContextManager';
import { ChatHistoryManager, ChatSaver } from '../history/ChatHistoryManager';
import { getLLMClient } from '../llm/client';
import { getOllamaTools, executeTool } from '../tools/index';
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
    
    // File selector
    private fileSelectorEl: HTMLElement | null = null;
    private fileSelector: FileSelector | null = null;
    private snippetSelectorEl: HTMLElement | null = null;
    private snippetSelector: SnippetSelector | null = null;
    private fileSelectorVisible: boolean = false;

    constructor(leaf: WorkspaceLeaf, plugin: { settings: LLMWikiSettings; saveSettings: () => Promise<void> }) {
        super(leaf);
        this.plugin = plugin;
        this.currentModel = plugin.settings.model;
    }

    getViewType(): string { return VIEW_TYPE_CHAT; }
    getDisplayText(): string { return 'LLM Wiki'; }
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
            this.addMessage('assistant', 'Hello! I am the LLM Wiki assistant. I can help you:\n\n- **Ingest** new documents into Wiki\n- **Query** the Wiki knowledge base\n- **Maintain** Wiki content\n\nPlease enter your question or command.');
        }

        this.loadModels();
    }

    async onClose() {
        if (this.historyManager && this.messages.length > 0) {
            await this.historyManager.saveCurrentSession();
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
     * - Elements: LLM Wiki name (left) | New Chat, Chat History, Save Chat (right)
     */
    private renderHeader(container: HTMLElement) {
        const header = container.createDiv({ cls: 'chat-header' });

        // Left: Title
        header.createSpan({ text: 'LLM Wiki', cls: 'header-title' });

        // Right: Button group (icon style)
        const btnGroup = header.createDiv({ cls: 'header-btn-group' });

        // New chat button (trash icon for clearing)
        const newChatBtn = btnGroup.createEl('button', { cls: 'icon-btn', attr: { title: 'New Chat' } });
        newChatBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4h6v2"></path></svg>';
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
            contentEl.innerHTML = this.renderContent(message.content);

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
        atBtn.onClickEvent(() => this.toggleContextDropdown());

        // Context dropdown
        this.contextDropdownEl = toolbar.createDiv({ cls: 'combobox-dropdown context-dropdown hidden' });
        this.renderContextDropdown();

        // + button (file upload)
        const uploadWrapper = toolbar.createDiv({ cls: 'upload-wrapper' });
        const uploadBtn = uploadWrapper.createEl('button', { cls: 'toolbar-btn', attr: { title: 'Upload file' } });
        uploadBtn.setText('+');
        const fileInput = uploadWrapper.createEl('input', {
            attr: { type: 'file', accept: '.md,.txt,.json', multiple: true },
            cls: 'file-input-hidden'
        });
        fileInput.addEventListener('change', () => this.handleFileUpload(fileInput));

        // Model selector
        const modelSelector = toolbar.createDiv({ cls: 'toolbar-btn model-selector' });
        this.modelLabelEl = modelSelector.createSpan({ cls: 'model-label' });
        this.modelLabelEl.setText(this.currentModel);
        modelSelector.createSpan({ text: ' ▼', cls: 'model-arrow' });
        modelSelector.onClickEvent(() => this.toggleModelDropdown());

        // Model dropdown
        this.modelDropdownEl = toolbar.createDiv({ cls: 'combobox-dropdown model-dropdown hidden' });
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
     */
    private updateSendButton(): void {
        if (!this.sendBtnEl) return;
        
        if (this.isLoading) {
            // Show stop button
            this.sendBtnEl.className = 'stop-btn';
            this.sendBtnEl.setAttribute('title', 'Stop generation');
            this.sendBtnEl.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>';
        } else {
            // Show send button
            this.sendBtnEl.className = 'send-arrow-btn';
            this.sendBtnEl.setAttribute('title', 'Send message');
            this.sendBtnEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>';
        }
    }
    
    /**
     * Stop LLM generation
     */
    private stopGeneration(): void {
        this.isLoading = false;
        this.updateSendButton();
        new Notice('Generation stopped');
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

    private toggleModelDropdown() {
        const isHidden = this.modelDropdownEl?.hasClass('hidden');
        this.closeAllDropdowns();
        if (isHidden) {
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

        // Close on blur
        this.modelDropdownEl.addEventListener('blur', () => {
            setTimeout(() => this.modelDropdownEl?.addClass('hidden'), 150);
        });

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
            this.availableModels = this.plugin.settings.models.map(m => m.name);
            // Set current model from settings
            const currentModelConfig = this.plugin.settings.models.find(m => m.id === this.plugin.settings.currentModelId);
            if (currentModelConfig) {
                this.currentModel = currentModelConfig.name;
            }
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
        this.plugin.settings.model = modelConfig.modelId;
        await this.plugin.saveSettings();
        
        // Update LLM client
        const client = getLLMClient(this.plugin.settings);
        client.setCurrentModel(modelConfig.id);
        
        if (this.modelLabelEl) {
            this.modelLabelEl.setText(model);
        }
        
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
            return;
        }
        this.contextTagsEl.removeClass('hidden');

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
        if (this.historyManager && this.messages.length > 0) {
            await this.historyManager.saveCurrentSession();
        }
        this.messages = [];
        this.contexts = [];
        this.historyManager?.createNewSession();
        this.displayMode = 'chat';
        this.renderCurrentView();
        this.renderContextTags();
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
        const messageText = text.trim();
        
        this.addMessage('user', messageText, this.contexts.length > 0 ? [...this.contexts] : undefined);

        try {
            // Build system prompt (including tool descriptions)
            let systemPrompt = `You are the LLM Wiki assistant, an AI assistant specialized in maintaining and managing knowledge bases. You can help users ingest knowledge, answer queries, and maintain the knowledge base.

You can use the following tools to complete tasks:
- read_file: Read file contents from vault
- write_file: Write content to file
- append_file: Append content to file
- delete_file: Delete file
- list_files: List files in directory
- search_files: Search file contents
- create_directory: Create directory
- create_wiki_page: Create Wiki page
- update_wiki_page: Update Wiki page
- add_backlink: Add bidirectional link
- update_index: Update Wiki index

When you need to use tools, please call the corresponding tool functions.`;
            
            // If there's context, add to system prompt
            if (this.contexts.length > 0 && this.contextManager) {
                // Sync contexts to context manager
                this.contextManager.deserialize(this.contexts);
                const contextContent = this.contextManager.assemblePrompt();
                systemPrompt += `\n\n## Context Information\n${contextContent}`;
            }

            // Build message list
            const messages: OllamaMessage[] = this.messages
                .filter(m => m.role !== 'system')
                .slice(-10)
                .map(m => ({ role: m.role, content: m.content }));

            // Add an empty assistant message for streaming updates
            this.addMessage('assistant', '');

            // Use unified LLM client to send request
            const client = getLLMClient(this.plugin.settings);
            
            // Get tool definitions
            const tools = getOllamaTools();
            
            // Tool call loop
            let maxIterations = 5; // Prevent infinite loop
            let iteration = 0;
            let useTools = true; // Whether to use tools
            
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
                        systemPrompt
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
                                
                                // Execute tool
                                const result = await executeTool(toolName, toolArgs, toolContext);
                                
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
                                
                                // Add tool result to message list
                                toolResults.push({
                                    role: 'tool',
                                    content: JSON.stringify(result),
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
                            systemPrompt
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
            this.addMessage('system', `❌ Error: ${error}`);
        } finally {
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
        
        // Handle wiki links [[link]]
        result = result.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '<span class="wiki-link">[[$1]]</span>');
        
        // Handle bold **text**
        result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        
        // Handle italic *text*
        result = result.replace(/\*([^*]+)\*/g, '<em>$1</em>');
        
        // Handle newlines (but not inside code blocks)
        result = result.replace(/\n/g, '<br>');
        
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
}
