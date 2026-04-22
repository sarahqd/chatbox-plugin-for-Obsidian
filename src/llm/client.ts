/**
 * Unified LLM Client
 * Manages multiple LLM providers and model configurations
 */

import type { 
    LLMWikiSettings, 
    LLMProvider, 
    ModelConfig, 
    ProviderConfig,
    OllamaMessage, 
    OllamaTool, 
    OllamaToolCall 
} from '../types';
import type { LLMProviderInterface, LLMProviderConfig, LLMChatOptions, LLMStreamOptions, LLMResponse } from './types';
import { OllamaClient } from '../ollama/client';
import { OpenAIProvider } from './openai';
import { AnthropicProvider } from './anthropic';

export class LLMClient implements LLMProviderInterface {
    readonly name = 'unified';
    private settings: LLMWikiSettings;
    private providers: Map<string, LLMProviderInterface> = new Map();
    private currentModel: ModelConfig | null = null;

    constructor(settings: LLMWikiSettings) {
        this.settings = settings;
        this.initializeProviders();
        this.setCurrentModel(settings.currentModelId);
    }

    private initializeProviders(): void {
        // Initialize Ollama provider
        const ollamaConfig = this.settings.providers.find(p => p.name === 'Ollama');
        if (ollamaConfig?.enabled) {
            const client = new OllamaClient(
                ollamaConfig.baseUrl || this.settings.ollamaUrl,
                this.settings.model
            );
            this.providers.set('Ollama', this.wrapOllamaClient(client));
        }

        // Initialize OpenAI provider
        const openaiConfig = this.settings.providers.find(p => p.name === 'OpenAI');
        if (openaiConfig?.enabled && openaiConfig.apiKey) {
            this.providers.set('OpenAI', new OpenAIProvider({
                apiKey: openaiConfig.apiKey,
                baseUrl: openaiConfig.baseUrl,
                model: 'gpt-4o',
            }));
        }

        // Initialize Anthropic provider
        const anthropicConfig = this.settings.providers.find(p => p.name === 'Anthropic');
        if (anthropicConfig?.enabled && anthropicConfig.apiKey) {
            this.providers.set('Anthropic', new AnthropicProvider({
                apiKey: anthropicConfig.apiKey,
                baseUrl: anthropicConfig.baseUrl,
                model: 'claude-3-5-sonnet-20241022',
            }));
        }

        // Initialize DeepSeek provider (uses OpenAI-compatible API)
        const deepseekConfig = this.settings.providers.find(p => p.name === 'DeepSeek');
        if (deepseekConfig?.enabled && deepseekConfig.apiKey) {
            this.providers.set('DeepSeek', new OpenAIProvider({
                apiKey: deepseekConfig.apiKey,
                baseUrl: deepseekConfig.baseUrl || 'https://api.deepseek.com/v1',
                model: 'deepseek-chat',
            }));
        }

        // Initialize OpenAI Compatible provider
        const customConfig = this.settings.providers.find(p => p.name === 'OpenAI Compatible');
        if (customConfig?.enabled && customConfig.apiKey && customConfig.baseUrl) {
            this.providers.set('OpenAI Compatible', new OpenAIProvider({
                apiKey: customConfig.apiKey,
                baseUrl: customConfig.baseUrl,
                model: 'default',
            }));
        }
    }

    private wrapOllamaClient(client: OllamaClient): LLMProviderInterface {
        return {
            name: 'Ollama',
            chat: async (options: LLMChatOptions): Promise<LLMResponse> => {
                const message = await client.chat(
                    options.messages,
                    options.tools,
                    options.systemPrompt
                );
                return { message };
            },
            chatStream: async (options: LLMStreamOptions): Promise<LLMResponse> => {
                const message = await client.chatStream(
                    options.messages,
                    options.onChunk,
                    options.tools,
                    options.systemPrompt
                );
                return { message };
            },
            embed: async (text: string): Promise<number[]> => {
                return client.embed(text);
            },
            listModels: async (): Promise<string[]> => {
                return client.listModels();
            },
            healthCheck: async (): Promise<boolean> => {
                return client.healthCheck();
            },
        };
    }

    private getProvider(name: LLMProvider): LLMProviderInterface | undefined {
        return this.providers.get(name);
    }

    setCurrentModel(modelId: string): void {
        const model = this.settings.models.find(m => m.id === modelId);
        if (model) {
            this.currentModel = model;
        } else if (this.settings.models.length > 0) {
            // Fallback to first model or default
            this.currentModel = this.settings.models.find(m => m.isDefault) || this.settings.models[0];
        }
    }

    getCurrentModel(): ModelConfig | null {
        return this.currentModel;
    }

    updateSettings(settings: LLMWikiSettings): void {
        this.settings = settings;
        this.providers.clear();
        this.initializeProviders();
        this.setCurrentModel(settings.currentModelId);
    }

    private getProviderForModel(model: ModelConfig): LLMProviderInterface {
        let provider = this.getProvider(model.provider);
        
        if (!provider) {
            // Try to initialize the provider if it exists in settings
            const config = this.settings.providers.find(p => p.name === model.provider);
            if (config) {
                this.initializeProviderFromConfig(config, model);
                provider = this.getProvider(model.provider);
            }
        }

        if (!provider) {
            throw new Error(`Provider ${model.provider} is not available or not configured`);
        }

        return provider;
    }

    private initializeProviderFromConfig(config: ProviderConfig, model?: ModelConfig): void {
        // Get API key and base URL from model config (if provided) or fall back to provider config
        const apiKey = model?.apiKey || config.apiKey;
        const baseUrl = model?.baseUrl || config.baseUrl;
        
        // Check if provider is enabled OR if model provides its own complete configuration
        // This allows models to work even if the provider is not globally enabled
        const canInitialize = config.enabled || (model?.apiKey && model?.baseUrl);
        
        if (config.name === 'Ollama' && canInitialize) {
            const client = new OllamaClient(
                baseUrl || this.settings.ollamaUrl,
                model?.modelId || this.settings.model
            );
            this.providers.set('Ollama', this.wrapOllamaClient(client));
        } else if (config.name === 'OpenAI' && canInitialize && apiKey) {
            this.providers.set('OpenAI', new OpenAIProvider({
                apiKey: apiKey,
                baseUrl: baseUrl,
                model: model?.modelId || 'gpt-4o',
            }));
        } else if (config.name === 'Anthropic' && canInitialize && apiKey) {
            this.providers.set('Anthropic', new AnthropicProvider({
                apiKey: apiKey,
                baseUrl: baseUrl,
                model: model?.modelId || 'claude-3-5-sonnet-20241022',
            }));
        } else if (config.name === 'DeepSeek' && canInitialize && apiKey) {
            this.providers.set('DeepSeek', new OpenAIProvider({
                apiKey: apiKey,
                baseUrl: baseUrl || 'https://api.deepseek.com/v1',
                model: model?.modelId || 'deepseek-chat',
            }));
        } else if (config.name === 'OpenAI Compatible' && canInitialize && apiKey && baseUrl) {
            this.providers.set('OpenAI Compatible', new OpenAIProvider({
                apiKey: apiKey,
                baseUrl: baseUrl,
                model: model?.modelId || 'default',
            }));
        }
    }

    async chat(options: LLMChatOptions): Promise<LLMResponse> {
        if (!this.currentModel) {
            throw new Error('No model selected');
        }

        const provider = this.getProviderForModel(this.currentModel);
        
        // Update model on provider if it has setModel method
        const providerAny = provider as any;
        if (providerAny.setModel) {
            providerAny.setModel(this.currentModel.modelId);
        }

        return provider.chat(options);
    }

    async chatStream(options: LLMStreamOptions): Promise<LLMResponse> {
        if (!this.currentModel) {
            throw new Error('No model selected');
        }

        const provider = this.getProviderForModel(this.currentModel);
        
        // Update model on provider if it has setModel method
        const providerAny = provider as any;
        if (providerAny.setModel) {
            providerAny.setModel(this.currentModel.modelId);
        }

        return provider.chatStream(options);
    }

    async embed(text: string): Promise<number[]> {
        if (!this.currentModel) {
            throw new Error('No model selected');
        }

        const provider = this.getProviderForModel(this.currentModel);
        if (!provider.embed) {
            throw new Error(`Provider ${this.currentModel.provider} does not support embeddings`);
        }

        return provider.embed(text);
    }

    async listModels(): Promise<string[]> {
        // Return model names from configured models
        return this.settings.models.map(m => m.name);
    }

    async listProviderModels(providerName: LLMProvider): Promise<string[]> {
        const provider = this.getProvider(providerName);
        if (!provider || !provider.listModels) {
            return [];
        }
        return provider.listModels();
    }

    async healthCheck(): Promise<boolean> {
        if (!this.currentModel) {
            return false;
        }

        const provider = this.getProviderForModel(this.currentModel);
        return provider.healthCheck();
    }

    async checkProviderHealth(providerName: LLMProvider): Promise<boolean> {
        const provider = this.getProvider(providerName);
        if (!provider) {
            return false;
        }
        return provider.healthCheck();
    }

    getAvailableProviders(): LLMProvider[] {
        return Array.from(this.providers.keys()) as LLMProvider[];
    }

    getEnabledProviders(): ProviderConfig[] {
        return this.settings.providers.filter(p => p.enabled);
    }

    // Model management methods
    addModel(model: ModelConfig): void {
        // Check if model with same ID exists
        const existing = this.settings.models.findIndex(m => m.id === model.id);
        if (existing >= 0) {
            this.settings.models[existing] = model;
        } else {
            this.settings.models.push(model);
        }
    }

    removeModel(modelId: string): boolean {
        const index = this.settings.models.findIndex(m => m.id === modelId);
        if (index >= 0) {
            this.settings.models.splice(index, 1);
            if (this.currentModel?.id === modelId) {
                this.currentModel = this.settings.models[0] || null;
            }
            return true;
        }
        return false;
    }

    updateModel(modelId: string, updates: Partial<ModelConfig>): boolean {
        const model = this.settings.models.find(m => m.id === modelId);
        if (model) {
            Object.assign(model, updates);
            return true;
        }
        return false;
    }

    getModels(): ModelConfig[] {
        return this.settings.models;
    }

    getModelsByProvider(provider: LLMProvider): ModelConfig[] {
        return this.settings.models.filter(m => m.provider === provider);
    }
}

// Singleton instance
let clientInstance: LLMClient | null = null;

export function getLLMClient(settings?: LLMWikiSettings): LLMClient {
    if (!clientInstance && settings) {
        clientInstance = new LLMClient(settings);
    } else if (clientInstance && settings) {
        clientInstance.updateSettings(settings);
    }
    if (!clientInstance) {
        throw new Error('LLMClient not initialized. Call getLLMClient with settings first.');
    }
    return clientInstance;
}

export function resetLLMClient(): void {
    clientInstance = null;
}