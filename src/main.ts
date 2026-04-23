/**
 * WikiChat Plugin - Main Entry Point
 * Transforms Obsidian into an AI-driven, self-maintaining knowledge base
 */

import { Plugin, PluginSettingTab, App, Setting, WorkspaceLeaf, TFile, Notice, Modal } from 'obsidian';
import type { LLMWikiSettings, LLMProvider, ModelConfig, ProviderConfig } from './types';
import { DEFAULT_SETTINGS, DEFAULT_PROVIDERS } from './types';
import { getOllamaClient } from './ollama/client';
import { getLLMClient, resetLLMClient } from './llm/client';
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
        this.addRibbonIcon('bot', 'WikiChat', (evt: MouseEvent) => {
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

        console.log('WikiChat Plugin loaded');
    }

    onunload() {
        this.app.workspace.detachLeavesOfType(VIEW_TYPE_CHAT);
        console.log('WikiChat Plugin unloaded');
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
        containerEl.createEl('h2', { text: 'WikiChat Settings' });

        // Model Management
        containerEl.createEl('h3', { text: 'Model Management' });
        this.renderModelManagement(containerEl);

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

        const contextLengthSetting = new Setting(containerEl)
            .setName('Maximum Context Length')
            .setDesc('Maximum context token count (4k - 128k)');
        
        // Add a display span for the value in 'k' format
        const valueDisplay = contextLengthSetting.controlEl.createSpan({ cls: 'context-length-display' });
        const updateDisplay = (value: number) => {
            const kValue = Math.round(value / 1024);
            valueDisplay.textContent = `${kValue}k`;
        };
        
        contextLengthSetting.addSlider((slider) =>
            slider
                .setLimits(4096, 131072, 1024)
                .setValue(this.plugin.settings.maxContextTokens || 8192)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.maxContextTokens = value;
                    updateDisplay(value);
                    await this.plugin.saveSettings();
                })
        );
        
        updateDisplay(this.plugin.settings.maxContextTokens || 8192);

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

    private renderProviderSettings(containerEl: HTMLElement): void {
        const provider = this.plugin.settings.provider;
        const providerConfig = this.plugin.settings.providers.find(p => p.name === provider);

        if (provider === 'Ollama') {
            new Setting(containerEl)
                .setName('Ollama URL')
                .setDesc('Ollama API address')
                .addText((text) =>
                    text
                        .setPlaceholder('http://localhost:11434')
                        .setValue(providerConfig?.baseUrl || this.plugin.settings.ollamaUrl)
                        .onChange(async (value) => {
                            const config = this.getOrCreateProviderConfig('Ollama');
                            config.baseUrl = value;
                            this.plugin.settings.ollamaUrl = value; // Legacy compatibility
                            await this.plugin.saveSettings();
                        })
                );
        } else if (provider === 'OpenAI') {
            new Setting(containerEl)
                .setName('OpenAI API Key')
                .setDesc('Your OpenAI API key')
                .addText((text) =>
                    text
                        .setPlaceholder('sk-...')
                        .setValue(providerConfig?.apiKey || '')
                        .onChange(async (value) => {
                            const config = this.getOrCreateProviderConfig('OpenAI');
                            config.apiKey = value;
                            config.enabled = value.length > 0;
                            await this.plugin.saveSettings();
                        })
                );

            new Setting(containerEl)
                .setName('OpenAI Base URL')
                .setDesc('Custom API endpoint (optional)')
                .addText((text) =>
                    text
                        .setPlaceholder('https://api.openai.com/v1')
                        .setValue(providerConfig?.baseUrl || '')
                        .onChange(async (value) => {
                            const config = this.getOrCreateProviderConfig('OpenAI');
                            config.baseUrl = value;
                            await this.plugin.saveSettings();
                        })
                );
        } else if (provider === 'Anthropic') {
            new Setting(containerEl)
                .setName('Anthropic API Key')
                .setDesc('Your Anthropic API key')
                .addText((text) =>
                    text
                        .setPlaceholder('sk-ant-...')
                        .setValue(providerConfig?.apiKey || '')
                        .onChange(async (value) => {
                            const config = this.getOrCreateProviderConfig('Anthropic');
                            config.apiKey = value;
                            config.enabled = value.length > 0;
                            await this.plugin.saveSettings();
                        })
                );
        } else if (provider === 'DeepSeek') {
            new Setting(containerEl)
                .setName('DeepSeek API Key')
                .setDesc('Your DeepSeek API key')
                .addText((text) =>
                    text
                        .setPlaceholder('sk-...')
                        .setValue(providerConfig?.apiKey || '')
                        .onChange(async (value) => {
                            const config = this.getOrCreateProviderConfig('DeepSeek');
                            config.apiKey = value;
                            config.enabled = value.length > 0;
                            await this.plugin.saveSettings();
                        })
                );
        } else if (provider === 'OpenAI Compatible') {
            new Setting(containerEl)
                .setName('API Key')
                .setDesc('API key for OpenAI compatible provider')
                .addText((text) =>
                    text
                        .setPlaceholder('Enter API key')
                        .setValue(providerConfig?.apiKey || '')
                        .onChange(async (value) => {
                            const config = this.getOrCreateProviderConfig('OpenAI Compatible');
                            config.apiKey = value;
                            config.enabled = value.length > 0;
                            await this.plugin.saveSettings();
                        })
                );

            new Setting(containerEl)
                .setName('Base URL')
                .setDesc('API endpoint for OpenAI compatible provider')
                .addText((text) =>
                    text
                        .setPlaceholder('https://api.example.com/v1')
                        .setValue(providerConfig?.baseUrl || '')
                        .onChange(async (value) => {
                            const config = this.getOrCreateProviderConfig('OpenAI Compatible');
                            config.baseUrl = value;
                            await this.plugin.saveSettings();
                        })
                );
        }
    }

    private getOrCreateProviderConfig(provider: LLMProvider): ProviderConfig {
        let config = this.plugin.settings.providers.find(p => p.name === provider);
        if (!config) {
            config = {
                name: provider,
                displayName: provider,
                enabled: provider === 'Ollama',
            };
            this.plugin.settings.providers.push(config);
        }
        return config;
    }

    private renderModelManagement(containerEl: HTMLElement): void {
        // Add model button (moved to top, replacing Current Model dropdown)
        new Setting(containerEl)
            .setName('Add New Model')
            .setDesc('Configure a new model')
            .addButton((button) =>
                button
                    .setButtonText('+ Add Model')
                    .onClick(() => {
                        new ModelEditModal(this.app, this.plugin, null, () => this.display()).open();
                    })
            );

        // Model list table
        const modelsContainer = containerEl.createDiv({ cls: 'model-list-container' });
        
        // Table header
        const tableHeader = modelsContainer.createDiv({ cls: 'model-table-header' });
        tableHeader.createSpan({ text: 'Model Name', cls: 'model-header-name' });
        tableHeader.createSpan({ text: 'Provider', cls: 'model-header-provider' });
        tableHeader.createSpan({ text: 'Actions', cls: 'model-header-actions' });
        
        // Table body
        const tableBody = modelsContainer.createDiv({ cls: 'model-table-body' });
        
        this.plugin.settings.models.forEach(model => {
                const modelRow = tableBody.createDiv({ cls: 'model-row' });
                
                // Model name cell
                const nameCell = modelRow.createDiv({ cls: 'model-cell-name' });
                nameCell.createSpan({ text: model.name, cls: 'model-name' });
                
                // Provider cell
                const providerCell = modelRow.createDiv({ cls: 'model-cell-provider' });
                providerCell.createSpan({ text: model.provider, cls: 'model-provider' });
                
                // Actions cell
                const actionsCell = modelRow.createDiv({ cls: 'model-cell-actions' });
                
                // Edit button (icon)
                const editBtn = actionsCell.createEl('button', { cls: 'model-icon-btn model-edit-btn', attr: { title: 'Edit' } });
                editBtn.setText('🖊');
                editBtn.onClickEvent(() => {
                    new ModelEditModal(this.app, this.plugin, model, () => this.display()).open();
                });
                
                // Delete button (icon)
                const deleteBtn = actionsCell.createEl('button', { cls: 'model-icon-btn model-delete-btn', attr: { title: 'Delete' } });
                deleteBtn.setText('🗑');
                deleteBtn.onClickEvent(async () => {
                    // Remove model from list
                    const index = this.plugin.settings.models.findIndex(m => m.id === model.id);
                    if (index >= 0) {
                        this.plugin.settings.models.splice(index, 1);
                        // Update currentModelId if needed
                        if (this.plugin.settings.currentModelId === model.id) {
                            this.plugin.settings.currentModelId = this.plugin.settings.models[0]?.id || '';
                        }
                        await this.plugin.saveSettings();
                        this.display();
                    }
                });
            });

    }
}

// Provider default URLs
const PROVIDER_DEFAULTS: Record<LLMProvider, { baseUrl: string; modelIdHint: string }> = {
    'Ollama': { baseUrl: 'http://localhost:11434', modelIdHint: 'e.g., llama3.2, qwen2.5' },
    'OpenAI': { baseUrl: 'https://api.openai.com/v1', modelIdHint: 'e.g., gpt-4o, gpt-4o-mini' },
    'Anthropic': { baseUrl: 'https://api.anthropic.com', modelIdHint: 'e.g., claude-3-5-sonnet-latest' },
    'DeepSeek': { baseUrl: 'https://api.deepseek.com', modelIdHint: 'e.g., deepseek-chat, deepseek-coder' },
    'OpenAI Compatible': { baseUrl: 'https://api.example.com/v1', modelIdHint: 'Enter model ID' },
};

/**
 * Model Edit Modal
 */
class ModelEditModal extends Modal {
    private plugin: LLMWikiPlugin;
    private model: ModelConfig | null;
    private onSave: () => void;
    
    // Form fields
    private nameInput!: HTMLInputElement;
    private providerSelect!: HTMLSelectElement;
    private modelIdInput!: HTMLInputElement;
    private baseUrlInput!: HTMLInputElement;
    private apiKeyInput!: HTMLInputElement;
    private contextLengthValue: number = 4096;
    private descriptionInput!: HTMLTextAreaElement;
    private supportsTools: boolean = true;
    
    // Dynamic elements
    private baseUrlSetting!: Setting;
    private modelIdSetting!: Setting;
    private apiKeySetting!: Setting;

    constructor(app: App, plugin: LLMWikiPlugin, model: ModelConfig | null, onSave: () => void) {
        super(app);
        this.plugin = plugin;
        this.model = model;
        this.onSave = onSave;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.addClass('model-edit-modal');

        contentEl.createEl('h2', { text: this.model ? 'Edit Model' : 'Add New Model' });

        // Name
        new Setting(contentEl)
            .setName('Display Name')
            .setDesc('Name shown in the model selector')
            .addText((text) => {
                this.nameInput = text.inputEl;
                text.setValue(this.model?.name || '');
            });

        // Provider
        new Setting(contentEl)
            .setName('Provider')
            .setDesc('LLM provider')
            .addDropdown((dropdown) => {
                dropdown.addOption('Ollama', 'Ollama');
                dropdown.addOption('OpenAI', 'OpenAI');
                dropdown.addOption('Anthropic', 'Anthropic');
                dropdown.addOption('DeepSeek', 'DeepSeek');
                dropdown.addOption('OpenAI Compatible', 'OpenAI Compatible');
                dropdown.setValue(this.model?.provider || 'Ollama');
                dropdown.onChange((value) => {
                    this.updateProviderDefaults(value as LLMProvider);
                });
                this.providerSelect = dropdown.selectEl;
            });

        // Model ID
        this.modelIdSetting = new Setting(contentEl)
            .setName('Model ID')
            .setDesc('Actual model identifier for API calls')
            .addText((text) => {
                this.modelIdInput = text.inputEl;
                text.setValue(this.model?.modelId || '');
            });

        // Base URL (optional)
        this.baseUrlSetting = new Setting(contentEl)
            .setName('Base URL')
            .setDesc('Override provider base URL (optional)')
            .addText((text) => {
                this.baseUrlInput = text.inputEl;
                text.setValue(this.model?.baseUrl || '');
            });

        // API Key (optional)
        this.apiKeySetting = new Setting(contentEl)
            .setName('API Key')
            .setDesc('Override provider API key (optional)')
            .addText((text) => {
                this.apiKeyInput = text.inputEl;
                text.setValue(this.model?.apiKey || '');
            });

        // Initialize with provider defaults
        const initialProvider = (this.model?.provider || 'Ollama') as LLMProvider;
        this.updateProviderDefaults(initialProvider, !this.model);

        // Context Length (with slider like settings interface)
        this.contextLengthValue = this.model?.contextLength || 4096;
        
        const contextLengthSetting = new Setting(contentEl)
            .setName('Context Length')
            .setDesc('Maximum context token count (4k - 128k)');
        
        // Add a display span for the value in 'k' format
        const valueDisplay = contextLengthSetting.controlEl.createSpan({ cls: 'context-length-display' });
        const updateDisplay = (value: number) => {
            const kValue = Math.round(value / 1024);
            valueDisplay.textContent = `${kValue}k`;
        };
        
        contextLengthSetting.addSlider((slider) =>
            slider
                .setLimits(4096, 131072, 1024)
                .setValue(this.contextLengthValue)
                .setDynamicTooltip()
                .onChange((value) => {
                    this.contextLengthValue = value;
                    updateDisplay(value);
                })
        );
        
        updateDisplay(this.contextLengthValue);

        // Description
        new Setting(contentEl)
            .setName('Description')
            .setDesc('Model description (optional)')
            .addTextArea((text) => {
                this.descriptionInput = text.inputEl;
                text.setValue(this.model?.description || '');
            });

        // Supports Tools
        new Setting(contentEl)
            .setName('Supports Tools')
            .setDesc('Whether this model supports function calling')
            .addToggle((toggle) => {
                toggle.setValue(this.model?.supportsTools ?? true);
                toggle.onChange((value) => {
                    this.supportsTools = value;
                });
            });

        // Buttons
        const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
        
        buttonContainer.createEl('button', { text: 'Cancel', cls: 'modal-cancel-btn' })
            .onClickEvent(() => this.close());
        
        buttonContainer.createEl('button', { text: 'Save', cls: 'modal-save-btn' })
            .onClickEvent(() => this.saveModel());
    }
    
    /**
     * Update placeholder and visibility based on provider
     */
    private updateProviderDefaults(provider: LLMProvider, isNewModel: boolean = false): void {
        const defaults = PROVIDER_DEFAULTS[provider];
        
        // Update base URL placeholder
        this.baseUrlInput.placeholder = defaults.baseUrl;
        if (isNewModel && !this.baseUrlInput.value) {
            this.baseUrlInput.value = '';
        }
        
        // Update model ID hint
        this.modelIdSetting.setDesc(defaults.modelIdHint);
        
        // Show/hide API key field based on provider
        // Ollama doesn't need API key, others do
        const needsApiKey = provider !== 'Ollama';
        this.apiKeySetting.settingEl.style.display = needsApiKey ? 'flex' : 'none';
    }

    private async saveModel(): Promise<void> {
        const name = this.nameInput.value.trim();
        const provider = this.providerSelect.value as LLMProvider;
        const modelId = this.modelIdInput.value.trim();

        if (!name || !modelId) {
            new Notice('Name and Model ID are required');
            return;
        }

        const modelConfig: ModelConfig = {
            id: this.model?.id || `${provider}-${modelId}-${Date.now()}`,
            name,
            provider,
            modelId,
            baseUrl: this.baseUrlInput.value.trim() || undefined,
            apiKey: this.apiKeyInput.value.trim() || undefined,
            contextLength: this.contextLengthValue,
            description: this.descriptionInput.value.trim() || undefined,
            supportsTools: this.supportsTools,
            isDefault: this.model?.isDefault || false,
        };

        if (this.model) {
            // Update existing model
            const index = this.plugin.settings.models.findIndex(m => m.id === this.model!.id);
            if (index >= 0) {
                this.plugin.settings.models[index] = modelConfig;
            }
        } else {
            // Add new model
            this.plugin.settings.models.push(modelConfig);
        }

        await this.plugin.saveSettings();
        this.close();
        this.onSave();
    }

    onClose(): void {
        const { contentEl } = this;
        contentEl.empty();
    }
}
