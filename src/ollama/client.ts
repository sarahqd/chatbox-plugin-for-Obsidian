/**
 * Ollama API Client
 * Handles communication with local Ollama REST API
 */

import type {
    OllamaMessage,
    OllamaTool,
    OllamaChatResponse,
    OllamaEmbeddingResponse,
    OllamaToolCall,
    ModelInfo,
} from '../types';

export class OllamaClient {
    private baseUrl: string;
    private model: string;

    constructor(baseUrl: string, model: string) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.model = model;
    }

    /**
     * Update client configuration
     */
    configure(baseUrl: string, model: string): void {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.model = model;
    }

    /**
     * Send a chat request and get a response
     */
    async chat(
        messages: OllamaMessage[],
        tools?: OllamaTool[],
        systemPrompt?: string
    ): Promise<OllamaMessage> {
        const allMessages = systemPrompt
            ? [{ role: 'system' as const, content: systemPrompt }, ...messages]
            : messages;

        const response = await fetch(`${this.baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: this.model,
                messages: allMessages,
                tools: tools,
                stream: false,
            }),
        });

        if (!response.ok) {
            throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
        }

        const data = (await response.json()) as OllamaChatResponse;
        return data.message;
    }

    /**
     * Send a chat request with streaming response
     */
    async chatStream(
        messages: OllamaMessage[],
        onChunk: (text: string) => void,
        tools?: OllamaTool[],
        systemPrompt?: string
    ): Promise<OllamaMessage> {
        const allMessages = systemPrompt
            ? [{ role: 'system' as const, content: systemPrompt }, ...messages]
            : messages;

        // 转换消息格式：将 toolCalls 转换为 tool_calls (Ollama API 格式)
        const formattedMessages = allMessages.map(msg => {
            const formatted: Record<string, unknown> = {
                role: msg.role,
                content: msg.content || '',
            };
            // 转换 toolCalls -> tool_calls
            if (msg.toolCalls && msg.toolCalls.length > 0) {
                formatted.tool_calls = msg.toolCalls.map(tc => ({
                    id: tc.id,
                    type: tc.type,
                    function: {
                        name: tc.function.name,
                        arguments: tc.function.arguments,
                    },
                }));
            }
            // 保留 toolCallId 用于 tool 角色消息
            if (msg.toolCallId) {
                formatted.tool_call_id = msg.toolCallId;
            }
            return formatted;
        });

        const response = await fetch(`${this.baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: this.model,
                messages: formattedMessages,
                tools: tools,
                stream: true,
            }),
        });

        if (!response.ok) {
            throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
        }

        const reader = response.body?.getReader();
        if (!reader) {
            throw new Error('No response body');
        }

        const decoder = new TextDecoder();
        let fullContent = '';
        let toolCalls: OllamaToolCall[] = [];

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n').filter((line) => line.trim());

                for (const line of lines) {
                    try {
                        const data = JSON.parse(line);
                        if (data.message?.content) {
                            fullContent += data.message.content;
                            onChunk(data.message.content);
                        }
                        if (data.message?.tool_calls) {
                            toolCalls = data.message.tool_calls;
                        }
                    } catch {
                        // Skip invalid JSON lines
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }

        return {
            role: 'assistant',
            content: fullContent,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        };
    }

    /**
     * Generate embeddings for text
     */
    async embed(text: string): Promise<number[]> {
        const response = await fetch(`${this.baseUrl}/api/embeddings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: this.model,
                prompt: text,
            }),
        });

        if (!response.ok) {
            throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
        }

        const data = (await response.json()) as OllamaEmbeddingResponse;
        return data.embedding;
    }

    /**
     * Check if Ollama is running and accessible
     */
    async healthCheck(): Promise<boolean> {
        try {
            const response = await fetch(`${this.baseUrl}/api/tags`, {
                method: 'GET',
            });
            return response.ok;
        } catch {
            return false;
        }
    }

    /**
     * List available models
     */
    async listModels(): Promise<string[]> {
        const response = await fetch(`${this.baseUrl}/api/tags`, {
            method: 'GET',
        });

        if (!response.ok) {
            throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
        }

        const data = (await response.json()) as { models: { name: string }[] };
        return data.models.map((m) => m.name);
    }

    /**
     * List available models with detailed info
     */
    async listModelsWithInfo(): Promise<ModelInfo[]> {
        const response = await fetch(`${this.baseUrl}/api/tags`, {
            method: 'GET',
        });

        if (!response.ok) {
            throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
        }

        const data = (await response.json()) as { 
            models: { 
                name: string; 
                size?: number;
                modified_at?: string;
                digest?: string;
            }[] 
        };
        
        return data.models.map((m) => ({
            name: m.name,
            size: m.size,
            modified_at: m.modified_at,
            digest: m.digest,
        }));
    }

    /**
     * Get current model name
     */
    getModel(): string {
        return this.model;
    }

    /**
     * Set current model
     */
    setModel(model: string): void {
        this.model = model;
    }

    /**
     * Process tool calls and return results
     */
    async processToolCalls(
        toolCalls: OllamaToolCall[],
        toolHandlers: Map<string, (args: Record<string, unknown>) => Promise<unknown>>
    ): Promise<OllamaMessage[]> {
        const results: OllamaMessage[] = [];

        for (const toolCall of toolCalls) {
            const handler = toolHandlers.get(toolCall.function.name);
            if (handler) {
                try {
                    const result = await handler(toolCall.function.arguments);
                    results.push({
                        role: 'tool',
                        content: JSON.stringify(result),
                        toolCallId: toolCall.id,
                    });
                } catch (error) {
                    results.push({
                        role: 'tool',
                        content: JSON.stringify({ error: String(error) }),
                        toolCallId: toolCall.id,
                    });
                }
            }
        }

        return results;
    }
}

// Singleton instance
let clientInstance: OllamaClient | null = null;

export function getOllamaClient(baseUrl?: string, model?: string): OllamaClient {
    if (!clientInstance) {
        clientInstance = new OllamaClient(
            baseUrl || 'http://localhost:11434',
            model || 'llama3.2'
        );
    } else if (baseUrl && model) {
        clientInstance.configure(baseUrl, model);
    }
    return clientInstance;
}