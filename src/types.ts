/**
 * LLM Wiki Plugin - Type Definitions
 */

// ============== Provider Types ==============

export type LLMProvider = 'Ollama' | 'OpenAI' | 'Anthropic' | 'DeepSeek' | 'OpenAI Compatible';

export interface ProviderConfig {
    name: LLMProvider;
    displayName: string;
    apiKey?: string;
    baseUrl?: string;
    enabled: boolean;
}

export interface ModelConfig {
    id: string;           // Unique identifier
    name: string;         // Display name
    provider: LLMProvider;
    modelId: string;      // Actual model ID for API calls
    baseUrl?: string;     // Override provider base URL
    apiKey?: string;      // Override provider API key (for custom models)
    contextLength?: number;
    description?: string;
    isDefault?: boolean;
    supportsTools?: boolean;
    supportsVision?: boolean;
}

// ============== Settings ==============

export interface LLMWikiSettings {
    // Legacy settings (for backward compatibility)
    ollamaUrl: string;
    model: string;
    
    // New provider settings
    provider: LLMProvider;
    providers: ProviderConfig[];
    models: ModelConfig[];
    currentModelId: string;
    
    wikiPath: string;
    sourcesPath: string;
    templatesPath: string;
    autoIngest: boolean;
    autoLint: boolean;
    lintInterval: number;
    // Chat enhancement settings
    maxContextTokens: number;      // Max context token count
    autoSaveChat: boolean;         // Auto save chat
    chatHistoryPath: string;       // Chat history save path
    showHistoryPanel: boolean;     // Whether to show history panel
    maxHistoryDisplay: number;     // Max history panel display count
}

// Default provider configurations
export const DEFAULT_PROVIDERS: ProviderConfig[] = [
    { name: 'Ollama', displayName: 'Ollama', baseUrl: 'http://localhost:11434', enabled: true },
    { name: 'OpenAI', displayName: 'OpenAI', enabled: false },
    { name: 'Anthropic', displayName: 'Anthropic', enabled: false },
    { name: 'DeepSeek', displayName: 'DeepSeek', baseUrl: 'https://api.deepseek.com', enabled: false },
    { name: 'OpenAI Compatible', displayName: 'OpenAI Compatible', enabled: false },
];

// Default model configurations (empty - user must add models)
export const DEFAULT_MODELS: ModelConfig[] = [];

export const DEFAULT_SETTINGS: LLMWikiSettings = {
    // Legacy settings
    ollamaUrl: 'http://localhost:11434',
    model: '',
    
    // New provider settings
    provider: 'Ollama',
    providers: DEFAULT_PROVIDERS,
    models: DEFAULT_MODELS,
    currentModelId: '',
    
    wikiPath: 'Wiki',
    sourcesPath: 'Sources',
    templatesPath: 'Templates',
    autoIngest: true,
    autoLint: false,
    lintInterval: 60,
    // Chat enhancement default settings
    maxContextTokens: 8192,
    autoSaveChat: false,
    chatHistoryPath: 'Sources/chats',
    showHistoryPanel: true,
    maxHistoryDisplay: 3,
};

// ============== Ollama API Types ==============

export interface OllamaMessage {
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    toolCalls?: OllamaToolCall[];
    toolCallId?: string;
}

export interface OllamaToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: Record<string, unknown>;
    };
}

export interface OllamaTool {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: {
            type: 'object';
            properties: Record<string, {
                type: string;
                description: string;
                enum?: string[];
            }>;
            required?: string[];
        };
    };
}

export interface OllamaChatRequest {
    model: string;
    messages: OllamaMessage[];
    tools?: OllamaTool[];
    stream?: boolean;
}

export interface OllamaChatResponse {
    model: string;
    message: OllamaMessage;
    done: boolean;
}

export interface OllamaEmbeddingRequest {
    model: string;
    prompt: string;
}

export interface OllamaEmbeddingResponse {
    embedding: number[];
}

// ============== Tool Types ==============

export interface ToolContext {
    vault: unknown; // Obsidian Vault
    app: unknown; // Obsidian App
    settings: LLMWikiSettings;
}

export interface ToolResult {
    success: boolean;
    data?: unknown;
    error?: string;
}

export type ToolHandler = (params: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;

export interface ToolDefinition {
    name: string;
    description: string;
    parameters: OllamaTool['function']['parameters'];
    handler: ToolHandler;
}

// ============== Wiki Types ==============

export interface WikiPageFrontmatter {
    title: string;
    created: string;
    updated: string;
    tags: string[];
    related: string[];
}

export interface WikiPage {
    path: string;
    frontmatter: WikiPageFrontmatter;
    content: string;
    summary: string;
}

export interface IngestResult {
    success: boolean;
    sourcePath: string;
    targetPath?: string;
    operation: 'create' | 'update' | 'skip';
    entities: string[];
    message: string;
}

export interface QueryResult {
    answer: string;
    sources: string[];
    confidence: number;
}

export interface LintIssue {
    type: 'broken_link' | 'contradiction' | 'duplicate' | 'stale';
    path: string;
    description: string;
    suggestion?: string;
}

export interface LintResult {
    issues: LintIssue[];
    fixed: number;
    pending: number;
}

// ============== Chat Types ==============

// Context type
export interface ChatContext {
    id: string;
    type: 'file' | 'wiki' | 'folder' | 'text' | 'snippet';
    name: string;
    path?: string;
    content: string;
    tokens: number;
    // Obsidian internal link format: [[path]] or [[path|display]]
    link?: string;
    // For snippet type: line range
    startLine?: number;
    endLine?: number;
}

// File reference in message (parsed from [[file]] syntax)
export interface FileReference {
    path: string;
    displayName?: string;
    fullMatch: string;
}

export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: number;
    toolCalls?: OllamaToolCall[];
    pending?: boolean;
    context?: ChatContext[];  // Associated context
}

// Chat session type
export interface ChatSession {
    id: string;
    title: string;
    messages: ChatMessage[];
    model: string;
    createdAt: number;
    updatedAt: number;
    totalTokens: number;
}

// Model info
export interface ModelInfo {
    name: string;
    size?: number;
    modified_at?: string;
    digest?: string;
}

export interface ChatState {
    messages: ChatMessage[];
    isLoading: boolean;
    pendingAction?: {
        type: string;
        params: Record<string, unknown>;
        description: string;
    };
    currentSession?: ChatSession;
    contexts: ChatContext[];
    currentModel: string;
}

// ============== Operation Log Types ==============

export interface OperationLog {
    timestamp: string;
    type: 'ingest' | 'query' | 'lint' | 'manual';
    source?: string;
    target?: string;
    operation: string;
    entities?: string[];
    status: 'success' | 'failed' | 'pending';
    message: string;
}