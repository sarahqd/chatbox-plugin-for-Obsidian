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
            name: 'Open chat dialog',
            hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'l' }],
            callback: () => {
                this.activateView();
            },
        });

        this.addCommand({
            id: 'ingest-current',
            name: 'Ingest current file to Wiki',
            callback: () => {
                this.ingestCurrentFile();
            },
        });

        this.addCommand({
            id: 'ingest-clipboard',
            name: 'Ingest clipboard content to Wiki',
            callback: () => {
                this.ingestClipboard();
            },
        });

        this.addCommand({
            id: 'query',
            name: 'Query Wiki',
            callback: () => {
                this.activateView();
            },
        });

        this.addCommand({
            id: 'lint',
            name: 'Run Wiki maintenance check',
            callback: () => {
                this.runLint();
            },
        });

        this.addCommand({
            id: 'reindex',
            name: 'Rebuild Wiki index',
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
            new Notice('⚠️ Cannot connect to Ollama. Please ensure Ollama is running.', 5000);
        }
    }

    async ingestCurrentFile() {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
            new Notice('No file open');
            return;
        }

        new Notice('Starting file ingestion...');

        const result = await ingestFile(this.app, this.settings, activeFile.path, (msg) => {
            console.log('Ingest:', msg);
        });

        if (result.success) {
            new Notice(`✅ Ingestion successful: ${result.entities.length} entities`);
        } else {
            new Notice(`❌ Ingestion failed: ${result.message}`);
        }
    }

    async ingestClipboard() {
        const content = await navigator.clipboard.readText();
        if (!content) {
            new Notice('Clipboard is empty');
            return;
        }

        new Notice('Starting content ingestion...');

        const result = await ingestContent(this.app, this.settings, content, undefined, (msg) => {
            console.log('Ingest:', msg);
        });

        if (result.success) {
            new Notice(`✅ Ingestion successful: ${result.entities.length} entities`);
        } else {
            new Notice(`❌ Ingestion failed: ${result.message}`);
        }
    }

    async runLint() {
        new Notice('Starting Wiki maintenance check...');

        const result = await lintWiki(this.app, this.settings, false, (msg) => {
            console.log('Lint:', msg);
        });

        if (result.issues.length === 0) {
            new Notice('✅ Wiki is in good condition, no issues found');
        } else {
            new Notice(`Found ${result.issues.length} issues, fixed ${result.fixed} of them`);
        }
    }

    async reindexWiki() {
        new Notice('Rebuilding Wiki index...');

        // Use the update_index tool
        const { executeTool } = await import('./tools');
        const context = {
            vault: this.app.vault,
            app: this.app,
            settings: this.settings,
        };

        const result = await executeTool('update_index', {}, context);

        if (result.success) {
            new Notice(`✅ Index rebuild successful: ${(result.data as any).pageCount} pages`);
        } else {
            new Notice(`❌ Index rebuild failed: ${result.error}`);
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
        containerEl.createEl('h2', { text: 'LLM Wiki Settings' });

        // Ollama Settings
        containerEl.createEl('h3', { text: 'Ollama Configuration' });

        new Setting(containerEl)
            .setName('Ollama URL')
            .setDesc('Ollama API address')
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
            .setName('Model')
            .setDesc('Ollama model name to use')
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
        containerEl.createEl('h3', { text: 'Directory Configuration' });

        new Setting(containerEl)
            .setName('Wiki Directory')
            .setDesc('Wiki page storage directory')
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
            .setName('Sources Directory')
            .setDesc('Source material storage directory')
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
            .setName('Templates Directory')
            .setDesc('Template file storage directory')
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
        containerEl.createEl('h3', { text: 'Chat Configuration' });

        new Setting(containerEl)
            .setName('Auto-save Chat')
            .setDesc('Automatically save chat history to Sources directory')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.autoSaveChat || false)
                    .onChange(async (value) => {
                        this.plugin.settings.autoSaveChat = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Maximum Context Length')
            .setDesc('Maximum context token count')
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
        containerEl.createEl('h3', { text: 'Automation Configuration' });

        new Setting(containerEl)
            .setName('Auto-ingest')
            .setDesc('Automatically ingest new files placed in Sources directory')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.autoIngest)
                    .onChange(async (value) => {
                        this.plugin.settings.autoIngest = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Auto-maintenance')
            .setDesc('Periodically run Wiki maintenance checks')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.autoLint)
                    .onChange(async (value) => {
                        this.plugin.settings.autoLint = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Maintenance Interval')
            .setDesc('Auto maintenance check interval (minutes)')
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