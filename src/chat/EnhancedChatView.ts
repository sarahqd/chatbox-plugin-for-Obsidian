/**
 * Enhanced Chat View - 聊天对话框
 * 三段式布局：头部(固定一行) + 信息展示区(弹性可滚动) + 输入界面(固定底部1/5)
 * 
 * 布局规范：
 * - 第一部分：头部固定一行 (40-48px)，扁平风格
 * - 第二部分：信息展示区弹性填充，可滚动，不会被挤压
 * - 第三部分：输入界面固定底部，约1/5高度
 */

import { ItemView, WorkspaceLeaf, Notice, TFile } from 'obsidian';
import './styles.css';
import type { LLMWikiSettings, ChatMessage, ChatContext, OllamaMessage, OllamaToolCall } from '../types';
import { ContextManager, getAvailableContextSources } from '../context/ContextManager';
import { ChatHistoryManager, ChatSaver } from '../history/ChatHistoryManager';
import { getOllamaClient } from '../ollama/client';
import { getOllamaTools, executeTool } from '../tools/index';

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
            this.addMessage('assistant', '你好！我是 LLM Wiki 助手。我可以帮助你：\n\n- **摄取** 新文档到 Wiki\n- **查询** Wiki 知识库\n- **维护** Wiki 内容\n\n请输入你的问题或指令。');
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

        // === 第一部分: 头部 (固定一行) ===
        this.renderHeader(container);

        // === 第二部分: 信息展示区 (弹性高度，可滚动) ===
        this.renderDisplayArea(container);

        // === 第三部分: 输入界面 (固定底部约1/5) ===
        this.renderInputSection(container);
    }

    /**
     * 第一部分：头部
     * - 高度：固定一行，约 40-48px
     * - 位置：固定在 sidebar 顶部
     * - 风格：扁平风格，无阴影，无边框
     * - 元素：LLM Wiki 名称(左) | 新建对话、聊天记录、保存聊天(右)
     */
    private renderHeader(container: HTMLElement) {
        const header = container.createDiv({ cls: 'chat-header' });

        // 左侧：标题
        header.createSpan({ text: 'LLM Wiki', cls: 'header-title' });

        // 右侧：按钮组 (扁平风格)
        const btnGroup = header.createDiv({ cls: 'header-btn-group' });

        // 新建对话按钮
        const newChatBtn = btnGroup.createEl('button', { cls: 'flat-btn', attr: { title: '新建对话' } });
        newChatBtn.setText('新建');
        newChatBtn.onClickEvent(() => this.newChat());

        // 聊天记录按钮
        const historyBtn = btnGroup.createEl('button', { cls: 'flat-btn', attr: { title: '聊天记录' } });
        historyBtn.setText('记录');
        historyBtn.onClickEvent(() => this.toggleDisplayMode('history'));

        // 保存聊天按钮
        const saveBtn = btnGroup.createEl('button', { cls: 'flat-btn', attr: { title: '保存聊天' } });
        saveBtn.setText('保存');
        saveBtn.onClickEvent(() => this.saveChat());
    }

    /**
     * 第二部分：信息展示区
     * - 高度：弹性高度，填充头部和输入界面之间的空间
     * - 位置：头部下方，输入界面上方
     * - 滚动：内容超出时支持滚动
     * - 特性：不会被输入界面挤压
     */
    private renderDisplayArea(container: HTMLElement) {
        this.displayAreaEl = container.createDiv({ cls: 'display-area' });
        this.renderCurrentView();
    }

    private renderCurrentView() {
        if (!this.displayAreaEl) return;
        this.displayAreaEl.empty();

        if (this.displayMode === 'chat') {
            // 视图一：当前聊天
            this.messagesEl = this.displayAreaEl.createDiv({ cls: 'messages-list' });
            this.renderMessages();
        } else if (this.displayMode === 'history') {
            // 视图二：聊天记录列表
            this.historyListEl = this.displayAreaEl.createDiv({ cls: 'history-list-full' });
            this.renderHistoryList();
        }
    }

    private renderMessages() {
        if (!this.messagesEl) return;
        this.messagesEl.empty();

        this.messages.forEach(message => {
            const wrapperEl = this.messagesEl!.createDiv({ cls: `message-wrapper ${message.role}` });

            // 气泡：只有内容，不显示图标和名称
            const bubbleEl = wrapperEl.createDiv({ cls: `message-bubble ${message.role}` });
            const contentEl = bubbleEl.createDiv({ cls: 'message-content' });
            contentEl.innerHTML = this.renderContent(message.content);

            if (message.context && message.context.length > 0) {
                const ctxEl = bubbleEl.createDiv({ cls: 'message-context' });
                ctxEl.createSpan({ text: `📎 ${message.context.map(c => c.name).join(', ')}` });
            }

            // 时间 + 操作按钮行（气泡外部下方）
            if (message.role !== 'system') {
                const metaEl = wrapperEl.createDiv({ cls: 'message-meta' });
                metaEl.createSpan({ text: this.formatTime(message.timestamp), cls: 'message-time' });

                // 拷贝按钮
                const copyBtn = metaEl.createEl('button', {
                    cls: 'msg-action-btn',
                    attr: { title: '拷贝内容' }
                });
                copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
                copyBtn.onClickEvent(async () => {
                    await navigator.clipboard.writeText(message.content);
                    copyBtn.setAttribute('title', '已拷贝！');
                    copyBtn.classList.add('copied');
                    setTimeout(() => {
                        copyBtn.setAttribute('title', '拷贝内容');
                        copyBtn.classList.remove('copied');
                    }, 1500);
                });

                // 删除按钮
                const delBtn = metaEl.createEl('button', {
                    cls: 'msg-action-btn msg-delete-btn',
                    attr: { title: '删除此条消息' }
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
     * 聊天记录列表视图
     */
    private renderHistoryList() {
        if (!this.historyListEl) return;
        this.historyListEl.empty();

        // 关闭按钮
        const title = this.historyListEl.createDiv({ cls: 'history-title-bar' });
        title.createSpan({ text: '聊天记录' });
        title.createEl('button', { text: '✕ 关闭', cls: 'close-btn' })
            .onClickEvent(() => this.toggleDisplayMode('chat'));

        // 历史记录列表
        const list = this.historyListEl.createDiv({ cls: 'history-items' });
        this.historyManager!.getRecentSessions(20).then(sessions => {
            sessions.forEach(session => {
                const item = list.createDiv({ cls: 'history-item' });
                
                const info = item.createDiv({ cls: 'history-item-info' });
                const name = info.createDiv({ cls: 'history-item-name' });
                name.setText(session.title || '未命名对话');
                const meta = info.createDiv({ cls: 'history-item-meta' });
                meta.setText(`📅 ${this.formatDate(session.updatedAt)} · ${session.messages.length} 条消息`);
                
                const actions = item.createDiv({ cls: 'history-item-actions' });
                actions.createEl('button', { text: '🗑️', cls: 'icon-btn-small', attr: { title: '删除' } })
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
                empty.setText('暂无历史记录');
            }
        });
    }

    /**
     * 第三部分：输入界面
     * - 高度：固定高度，约为 sidebar 总高度的 1/5
     * - 位置：始终位于 sidebar 最底部
     * - 特性：不会被信息展示区挤压，始终可见
     */
    private renderInputSection(container: HTMLElement) {
        const inputSection = container.createDiv({ cls: 'input-section' });

        // 统一外框：包裹输入框 + 工具栏
        const inputBox = inputSection.createDiv({ cls: 'input-box' });

        // 输入框（无边框，占满上方区域）
        this.inputEl = inputBox.createEl('textarea', {
            attr: {
                placeholder: '输入消息，按 Enter 发送，按 Shift + Enter 换行...',
                rows: '3'
            },
            cls: 'chat-input'
        });

        // Textarea 事件处理
        this.inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage(this.inputEl!.value);
                this.inputEl!.value = '';
            }
        });

        // 工具栏（无顶部分隔线，按钮无边框）
        const toolbar = inputBox.createDiv({ cls: 'input-toolbar' });

        // @ 按钮
        const atBtn = toolbar.createEl('button', { cls: 'toolbar-btn at-btn', attr: { title: '添加上下文' } });
        atBtn.setText('@');
        atBtn.onClickEvent(() => this.toggleContextDropdown());

        // 上下文下拉框
        this.contextDropdownEl = toolbar.createDiv({ cls: 'combobox-dropdown context-dropdown hidden' });
        this.renderContextDropdown();

        // + 按钮 (文件上传)
        const uploadWrapper = toolbar.createDiv({ cls: 'upload-wrapper' });
        const uploadBtn = uploadWrapper.createEl('button', { cls: 'toolbar-btn', attr: { title: '上传文件' } });
        uploadBtn.setText('+');
        const fileInput = uploadWrapper.createEl('input', {
            attr: { type: 'file', accept: '.md,.txt,.json', multiple: true },
            cls: 'file-input-hidden'
        });
        fileInput.addEventListener('change', () => this.handleFileUpload(fileInput));

        // 模型选择器
        const modelSelector = toolbar.createDiv({ cls: 'toolbar-btn model-selector' });
        this.modelLabelEl = modelSelector.createSpan({ cls: 'model-label' });
        this.modelLabelEl.setText(this.currentModel);
        modelSelector.createSpan({ text: ' ▼', cls: 'model-arrow' });
        modelSelector.onClickEvent(() => this.toggleModelDropdown());

        // 模型下拉框
        this.modelDropdownEl = toolbar.createDiv({ cls: 'combobox-dropdown model-dropdown hidden' });
        this.renderModelDropdown();

        // 上下文标签
        this.contextTagsEl = toolbar.createDiv({ cls: 'context-tags' });

        // 发送按钮 (向右箭头) - 工具栏最右侧，贴近框线
        const sendBtn = toolbar.createEl('button', { cls: 'send-arrow-btn', attr: { title: '发送消息' } });
        sendBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>';
        sendBtn.onClickEvent(() => {
            if (this.inputEl) {
                this.sendMessage(this.inputEl.value);
                this.inputEl.value = '';
            }
        });
    }

    // === 下拉框方法 ===

    private toggleContextDropdown() {
        const isHidden = this.contextDropdownEl?.hasClass('hidden');
        this.closeAllDropdowns();
        if (isHidden) {
            this.contextDropdownEl?.removeClass('hidden');
            // 下拉框获取焦点
            this.contextDropdownEl?.focus();
        }
    }

    private toggleModelDropdown() {
        const isHidden = this.modelDropdownEl?.hasClass('hidden');
        this.closeAllDropdowns();
        if (isHidden) {
            this.modelDropdownEl?.removeClass('hidden');
            // 下拉框获取焦点
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
        // 设置 tabindex 使下拉框可获取焦点
        this.contextDropdownEl.setAttribute('tabindex', '-1');

        // 失去焦点时关闭
        this.contextDropdownEl.addEventListener('blur', () => {
            setTimeout(() => this.contextDropdownEl?.addClass('hidden'), 150);
        });

        this.loadContextSources();

        if (this.contextSources.length === 0) {
            const item = this.contextDropdownEl.createDiv({ cls: 'dropdown-item' });
            item.setText('加载中...');
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
        // 设置 tabindex 使下拉框可获取焦点
        this.modelDropdownEl.setAttribute('tabindex', '-1');

        // 失去焦点时关闭
        this.modelDropdownEl.addEventListener('blur', () => {
            setTimeout(() => this.modelDropdownEl?.addClass('hidden'), 150);
        });

        if (this.availableModels.length === 0) {
            const item = this.modelDropdownEl.createDiv({ cls: 'dropdown-item' });
            item.setText('加载模型列表...');
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

    // === 操作方法 ===

    private toggleDisplayMode(mode: DisplayMode) {
        if (this.displayMode === mode) {
            this.displayMode = 'chat';  // 再次点击返回聊天
        } else {
            this.displayMode = mode;
        }
        this.renderCurrentView();
    }

    private async loadModels() {
        try {
            const client = getOllamaClient(this.plugin.settings.ollamaUrl, this.currentModel);
            this.availableModels = await client.listModels();
            this.renderModelDropdown();
        } catch (e) {
            console.error('Failed to load models:', e);
        }
    }

    private async loadContextSources() {
        this.contextSources = await getAvailableContextSources(this.app, this.plugin.settings);
    }

    private async selectModel(model: string) {
        this.currentModel = model;
        this.plugin.settings.model = model;
        await this.plugin.saveSettings();
        getOllamaClient(this.plugin.settings.ollamaUrl, model).setModel(model);
        
        if (this.modelLabelEl) {
            this.modelLabelEl.setText(model);
        }
        
        this.renderModelDropdown();
        new Notice(`已切换到模型: ${model}`);
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
            const icon = ctx.type === 'file' ? '📄' : ctx.type === 'wiki' ? '📖' : '📝';
            tag.createSpan({ text: `${icon} ${ctx.name}` });
            tag.createEl('button', { text: '✕', cls: 'tag-remove' })
                .onClickEvent(() => this.removeContext(ctx.id));
        });
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
     * 新建对话
     * - 切换信息展示区为"当前聊天"视图
     * - 创建新的聊天会话
     * - 自动保存当前对话到历史记录
     * - 清空消息列表和上下文
     * - 生成新的会话 ID
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
        new Notice('已创建新对话');
    }

    /**
     * 保存聊天
     * - 将当前聊天保存为 Markdown 文件
     * - 保存路径可配置（默认 `Sources/chats/`）
     * - 显示保存成功提示
     */
    private async saveChat() {
        if (!this.historyManager || !this.chatSaver) return;

        const session = this.historyManager.getCurrentSession();
        if (session) {
            const path = await this.chatSaver.saveAsMarkdown(session);
            if (path) {
                new Notice(`聊天已保存: ${path}`);
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
        const messageText = text.trim();
        
        this.addMessage('user', messageText, this.contexts.length > 0 ? [...this.contexts] : undefined);

        try {
            // 构建系统提示（包含工具说明）
            let systemPrompt = `你是 LLM Wiki 助手，一个专门用于维护和管理知识库的 AI 助手。你可以帮助用户摄取知识、回答查询和维护知识库。

你可以使用以下工具来完成任务：
- read_file: 读取 vault 中的文件内容
- write_file: 写入内容到文件
- append_file: 追加内容到文件
- delete_file: 删除文件
- list_files: 列出目录中的文件
- search_files: 搜索文件内容
- create_directory: 创建目录
- create_wiki_page: 创建 Wiki 页面
- update_wiki_page: 更新 Wiki 页面
- add_backlink: 添加双向链接
- update_index: 更新 Wiki 索引

当需要使用工具时，请调用相应的工具函数。`;
            
            // 如果有上下文，添加到系统提示
            if (this.contexts.length > 0 && this.contextManager) {
                const contextContent = this.contextManager.assemblePrompt();
                systemPrompt += `\n\n## 上下文信息\n${contextContent}`;
            }

            // 构建消息列表
            const messages: OllamaMessage[] = this.messages
                .filter(m => m.role !== 'system')
                .slice(-10)
                .map(m => ({ role: m.role, content: m.content }));

            // 添加一个空的助手消息用于流式更新
            this.addMessage('assistant', '');

            // 使用 Ollama 客户端发送请求
            const client = getOllamaClient(this.plugin.settings.ollamaUrl, this.currentModel);
            
            // 获取工具定义
            const tools = getOllamaTools();
            
            // 工具调用循环
            let maxIterations = 5; // 防止无限循环
            let iteration = 0;
            let useTools = true; // 是否使用工具
            
            while (iteration < maxIterations) {
                iteration++;
                
                let fullResponse = '';
                let toolCalls: OllamaToolCall[] = [];
                
                try {
                    // 发送流式请求（带工具）
                    const response = await client.chatStream(
                        messages, 
                        (chunk: string) => {
                            fullResponse += chunk;
                            this.appendToLastMessage(chunk);
                        }, 
                        useTools ? tools : undefined, 
                        systemPrompt
                    );

                    // 更新最后一条消息的完整内容
                    if (this.messages.length > 0) {
                        this.messages[this.messages.length - 1].content = fullResponse;
                    }

                    // 检查是否有工具调用
                    if (response.toolCalls && response.toolCalls.length > 0) {
                        toolCalls = response.toolCalls;
                        
                        // 显示工具调用信息
                        for (const toolCall of toolCalls) {
                            const toolName = toolCall.function.name;
                            const toolArgs = toolCall.function.arguments;
                            this.appendToLastMessage(`\n\n🔧 调用工具: ${toolName}(${JSON.stringify(toolArgs)})...`);
                        }
                        
                        // 执行工具调用
                        const toolResults: OllamaMessage[] = [];
                        for (const toolCall of toolCalls) {
                            const toolName = toolCall.function.name;
                            const toolArgs = toolCall.function.arguments;
                            
                            try {
                                // 构建工具上下文
                                const toolContext = {
                                    vault: this.app.vault,
                                    app: this.app,
                                    settings: this.plugin.settings
                                };
                                
                                // 执行工具
                                const result = await executeTool(toolName, toolArgs, toolContext);
                                
                                // 显示工具结果
                                if (result.success) {
                                    this.appendToLastMessage(`\n✅ 工具执行成功`);
                                    if (result.data) {
                                        const dataStr = JSON.stringify(result.data, null, 2);
                                        // 限制显示长度
                                        const displayStr = dataStr.length > 500 ? dataStr.substring(0, 500) + '...' : dataStr;
                                        this.appendToLastMessage(`\n结果: ${displayStr}`);
                                    }
                                } else {
                                    this.appendToLastMessage(`\n❌ 工具执行失败: ${result.error}`);
                                }
                                
                                // 添加工具结果到消息列表
                                toolResults.push({
                                    role: 'tool',
                                    content: JSON.stringify(result),
                                    toolCallId: toolCall.id
                                });
                            } catch (error) {
                                const errorMsg = String(error);
                                this.appendToLastMessage(`\n❌ 工具执行异常: ${errorMsg}`);
                                toolResults.push({
                                    role: 'tool',
                                    content: JSON.stringify({ success: false, error: errorMsg }),
                                    toolCallId: toolCall.id
                                });
                            }
                        }
                        
                        // 将助手消息和工具结果添加到消息历史
                        messages.push({
                            role: 'assistant',
                            content: fullResponse,
                            toolCalls: toolCalls
                        });
                        messages.push(...toolResults);
                        
                        // 继续循环，让 LLM 处理工具结果
                        continue;
                    }
                    
                    // 没有工具调用，结束循环
                    break;
                    
                } catch (error) {
                    const errorMsg = String(error);
                    
                    // 如果是 400 错误且正在使用工具，可能是模型不支持工具调用
                    if (errorMsg.includes('400') && useTools) {
                        console.log('模型可能不支持工具调用，尝试不带工具重新请求...');
                        useTools = false;
                        this.appendToLastMessage('\n\n⚠️ 当前模型可能不支持工具调用，正在以普通模式重试...');
                        
                        // 重试时不带工具
                        let retryResponse = '';
                        await client.chatStream(
                            messages, 
                            (chunk: string) => {
                                retryResponse += chunk;
                                this.appendToLastMessage(chunk);
                            }, 
                            undefined, // 不带工具
                            systemPrompt
                        );
                        
                        if (this.messages.length > 0) {
                            this.messages[this.messages.length - 1].content = retryResponse;
                        }
                        break;
                    }
                    
                    // 其他错误直接抛出
                    throw error;
                }
            }
            
            if (iteration >= maxIterations) {
                this.appendToLastMessage('\n\n⚠️ 已达到最大工具调用次数限制');
            }

        } catch (error) {
            console.error('Ollama chat error:', error);
            this.addMessage('system', `❌ 错误: ${error}`);
        } finally {
            this.isLoading = false;
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
        return new Date(timestamp).toLocaleDateString('zh-CN', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    private renderContent(content: string): string {
        return content
            .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '<span class="wiki-link">[[$1]]</span>')
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/\*([^*]+)\*/g, '<em>$1</em>')
            .replace(/\n/g, '<br>');
    }
}