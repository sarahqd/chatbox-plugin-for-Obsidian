/**
 * LLM Wiki Plugin - Main Entry Point
 * Transforms Obsidian into an AI-driven, self-maintaining knowledge base
 */

import { Plugin, PluginSettingTab, App, Setting, WorkspaceLeaf, TFile, Notice } from 'obsidian';
import type { LLMWikiSettings } from './types';
import { DEFAULT_SETTINGS } from './types';
import { getOllamaClient } from './ollama/client';
import { ingestFile, ingestContent } from './flows/ingest';
import { queryWiki } from './flows/query';
import { lintWiki } from './flows/lint';
import { EnhancedChatView } from './chat/EnhancedChatView';

// View type constant
const VIEW_TYPE_CHAT = 'llm-wiki-chat-view';

/**
 * Main Plugin Class
 */
export default class LLMWikiPlugin extends Plugin {
    settings!: LLMWikiSettings;

    async onload() {
        await this.loadSettings();

        // Register the chat view
        this.registerView(VIEW_TYPE_CHAT, (leaf) => new EnhancedChatView(leaf, this));

        // Add ribbon icon
        this.addRibbonIcon('bot', 'LLM Wiki Chat', (evt: MouseEvent) => {
            this.activateView();
        });

        // Add commands
        this.addCommand({
            id: 'open-chat',
            name: '打开聊天对话框',
            hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'l' }],
            callback: () => {
                this.activateView();
            },
        });

        this.addCommand({
            id: 'ingest-current',
            name: '摄取当前文件到 Wiki',
            callback: () => {
                this.ingestCurrentFile();
            },
        });

        this.addCommand({
            id: 'ingest-clipboard',
            name: '摄取剪贴板内容到 Wiki',
            callback: () => {
                this.ingestClipboard();
            },
        });

        this.addCommand({
            id: 'query',
            name: '查询 Wiki',
            callback: () => {
                this.activateView();
            },
        });

        this.addCommand({
            id: 'lint',
            name: '执行 Wiki 维护检查',
            callback: () => {
                this.runLint();
            },
        });

        this.addCommand({
            id: 'reindex',
            name: '重建 Wiki 索引',
            callback: () => {
                this.reindexWiki();
            },
        });

        // Add settings tab
        this.addSettingTab(new LLMWikiSettingTab(this.app, this));

        // Create necessary directories
        this.initializeDirectories();

        // Check Ollama connection
        this.checkOllamaConnection();

        console.log('LLM Wiki Plugin loaded');
    }

    onunload() {
        this.app.workspace.detachLeavesOfType(VIEW_TYPE_CHAT);
        console.log('LLM Wiki Plugin unloaded');
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async activateView() {
        const { workspace } = this.app;

        let leaf: WorkspaceLeaf | null = null;
        const leaves = workspace.getLeavesOfType(VIEW_TYPE_CHAT);

        if (leaves.length > 0) {
            leaf = leaves[0];
        } else {
            leaf = workspace.getRightLeaf(false);
            if (leaf) {
                await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
            }
        }

        if (leaf) {
            workspace.revealLeaf(leaf);
        }
    }

    async initializeDirectories() {
        const { vault } = this.app;
        const dirs = [
            this.settings.wikiPath,
            this.settings.sourcesPath,
            this.settings.templatesPath,
        ];

        for (const dir of dirs) {
            if (!vault.getAbstractFileByPath(dir)) {
                try {
                    await vault.createFolder(dir);
                } catch (e) {
                    // Folder might already exist
                }
            }
        }
    }

    async checkOllamaConnection() {
        const client = getOllamaClient(this.settings.ollamaUrl, this.settings.model);
        const isHealthy = await client.healthCheck();
        
        if (!isHealthy) {
            new Notice('⚠️ 无法连接到 Ollama。请确保 Ollama 正在运行。', 5000);
        }
    }

    async ingestCurrentFile() {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
            new Notice('没有打开的文件');
            return;
        }

        new Notice('开始摄取文件...');

        const result = await ingestFile(this.app, this.settings, activeFile.path, (msg) => {
            console.log('Ingest:', msg);
        });

        if (result.success) {
            new Notice(`✅ 摄取成功: ${result.entities.length} 个实体`);
        } else {
            new Notice(`❌ 摄取失败: ${result.message}`);
        }
    }

    async ingestClipboard() {
        const content = await navigator.clipboard.readText();
        if (!content) {
            new Notice('剪贴板为空');
            return;
        }

        new Notice('开始摄取内容...');

        const result = await ingestContent(this.app, this.settings, content, undefined, (msg) => {
            console.log('Ingest:', msg);
        });

        if (result.success) {
            new Notice(`✅ 摄取成功: ${result.entities.length} 个实体`);
        } else {
            new Notice(`❌ 摄取失败: ${result.message}`);
        }
    }

    async runLint() {
        new Notice('开始 Wiki 维护检查...');

        const result = await lintWiki(this.app, this.settings, false, (msg) => {
            console.log('Lint:', msg);
        });

        if (result.issues.length === 0) {
            new Notice('✅ Wiki 状态良好，无问题发现');
        } else {
            new Notice(`发现 ${result.issues.length} 个问题，已修复 ${result.fixed} 个`);
        }
    }

    async reindexWiki() {
        new Notice('正在重建 Wiki 索引...');

        // Use the update_index tool
        const { executeTool } = await import('./tools');
        const context = {
            vault: this.app.vault,
            app: this.app,
            settings: this.settings,
        };

        const result = await executeTool('update_index', {}, context);

        if (result.success) {
            new Notice(`✅ 索引重建成功: ${(result.data as any).pageCount} 个页面`);
        } else {
            new Notice(`❌ 索引重建失败: ${result.error}`);
        }
    }
}

/**
 * Settings Tab
 */
class LLMWikiSettingTab extends PluginSettingTab {
    plugin: LLMWikiPlugin;

    constructor(app: App, plugin: LLMWikiPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();
        containerEl.createEl('h2', { text: 'LLM Wiki 设置' });

        // Ollama Settings
        containerEl.createEl('h3', { text: 'Ollama 配置' });

        new Setting(containerEl)
            .setName('Ollama URL')
            .setDesc('Ollama API 地址')
            .addText((text) =>
                text
                    .setPlaceholder('http://localhost:11434')
                    .setValue(this.plugin.settings.ollamaUrl)
                    .onChange(async (value) => {
                        this.plugin.settings.ollamaUrl = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('模型')
            .setDesc('使用的 Ollama 模型名称')
            .addText((text) =>
                text
                    .setPlaceholder('llama3.2')
                    .setValue(this.plugin.settings.model)
                    .onChange(async (value) => {
                        this.plugin.settings.model = value;
                        await this.plugin.saveSettings();
                    })
            );

        // Path Settings
        containerEl.createEl('h3', { text: '目录配置' });

        new Setting(containerEl)
            .setName('Wiki 目录')
            .setDesc('Wiki 页面存储目录')
            .addText((text) =>
                text
                    .setPlaceholder('Wiki')
                    .setValue(this.plugin.settings.wikiPath)
                    .onChange(async (value) => {
                        this.plugin.settings.wikiPath = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Sources 目录')
            .setDesc('原始资料存储目录')
            .addText((text) =>
                text
                    .setPlaceholder('Sources')
                    .setValue(this.plugin.settings.sourcesPath)
                    .onChange(async (value) => {
                        this.plugin.settings.sourcesPath = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Templates 目录')
            .setDesc('模板文件存储目录')
            .addText((text) =>
                text
                    .setPlaceholder('Templates')
                    .setValue(this.plugin.settings.templatesPath)
                    .onChange(async (value) => {
                        this.plugin.settings.templatesPath = value;
                        await this.plugin.saveSettings();
                    })
            );

        // Chat Settings
        containerEl.createEl('h3', { text: '聊天配置' });

        new Setting(containerEl)
            .setName('自动保存聊天')
            .setDesc('自动将聊天记录保存到 Sources 目录')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.autoSaveChat || false)
                    .onChange(async (value) => {
                        this.plugin.settings.autoSaveChat = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('最大上下文长度')
            .setDesc('上下文最大 token 数量')
            .addSlider((slider) =>
                slider
                    .setLimits(1000, 32000, 1000)
                    .setValue(this.plugin.settings.maxContextTokens || 4096)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.maxContextTokens = value;
                        await this.plugin.saveSettings();
                    })
            );

        // Automation Settings
        containerEl.createEl('h3', { text: '自动化配置' });

        new Setting(containerEl)
            .setName('自动摄取')
            .setDesc('自动摄取放入 Sources 目录的新文件')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.autoIngest)
                    .onChange(async (value) => {
                        this.plugin.settings.autoIngest = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('自动维护')
            .setDesc('定期执行 Wiki 维护检查')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.autoLint)
                    .onChange(async (value) => {
                        this.plugin.settings.autoLint = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('维护间隔')
            .setDesc('自动维护检查间隔（分钟）')
            .addSlider((slider) =>
                slider
                    .setLimits(10, 120, 10)
                    .setValue(this.plugin.settings.lintInterval)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.lintInterval = value;
                        await this.plugin.saveSettings();
                    })
            );
    }
}