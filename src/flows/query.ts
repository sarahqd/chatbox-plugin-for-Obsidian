/**
 * Query Flow
 * Wiki retrieval with BM25 + optional embedding rerank
 */

import { App, TFile } from 'obsidian';
import type { LLMWikiSettings, SearchIndexStatus, EmbeddingModelConfig } from '../types';
import { getProviderMetadata } from '../types';
import type { WikiSearchEngine, SearchResult, ChunkResult } from '../search/WikiSearchEngine';

const DEFAULT_RETRIEVAL_TOP_N = 20;
const DEFAULT_RETRIEVAL_RERANK_TOP_K = 8;

/**
 * Build embedding function from settings.
 * Returns null if no embedding model is configured.
 */
export function buildEmbedFn(
    settings: LLMWikiSettings
): ((text: string) => Promise<number[]>) | null {
    const { currentEmbeddingModelId, embeddingModels } = settings;
    if (!currentEmbeddingModelId) return null;
    
    const cfg = embeddingModels?.find(m => m.id === currentEmbeddingModelId);
    if (!cfg?.baseUrl || !cfg?.modelId) return null;
    
    const meta = getProviderMetadata(cfg.provider);
    
    if (meta.apiStyle === 'ollama') {
        return async (text: string) => {
            try {
                const res = await fetch(`${cfg.baseUrl}/api/embed`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model: cfg.modelId, input: text }),
                });
                if (!res.ok) return [];
                const json = await res.json();
                return json.embeddings?.[0] ?? [];
            } catch {
                return [];
            }
        };
    }
    
    // OpenAI-compatible
    return async (text: string) => {
        try {
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
            const res = await fetch(`${cfg.baseUrl}/embeddings`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ model: cfg.modelId, input: text }),
            });
            if (!res.ok) return [];
            const json = await res.json();
            return json.data?.[0]?.embedding ?? [];
        } catch {
            return [];
        }
    };
}

/**
 * Check if embedding model is configured.
 */
export function hasEmbeddingModel(settings: LLMWikiSettings): boolean {
    const { currentEmbeddingModelId, embeddingModels } = settings;
    if (!currentEmbeddingModelId) return false;
    const cfg = embeddingModels?.find(m => m.id === currentEmbeddingModelId);
    return !!(cfg?.baseUrl && cfg?.modelId);
}

/**
 * Get degraded retrieval context message based on index status.
 */
export function getDegradedRetrievalContext(status: SearchIndexStatus): string {
    if (status === 'building') {
        return 'Search index is rebuilding; no preloaded wiki context is available yet. Use read-only tools if a specific page is needed.';
    }

    if (status === 'error') {
        return 'Search index is unavailable; no preloaded wiki context is available yet. Use read-only tools if a specific page is needed.';
    }

    return 'Search index is not ready yet; no preloaded wiki context is available yet. Use read-only tools if a specific page is needed.';
}

/**
 * Extract best content chunk matching query terms.
 * Reused from WikiSearchEngine for parallel chunk extraction.
 */
function extractBestChunk(content: string, queryTerms: string[]): string {
    const body = content.replace(/^---[\s\S]*?---\n/, '');
    const sections = body.split(/(?=^## .+)/m);
    if (sections.length === 0) {
        return truncateWords(body, 600);
    }

    const termSet = new Set(queryTerms.map(t => t.toLowerCase()));
    let bestSection = sections[0];
    let bestOverlap = -1;

    for (const section of sections) {
        const sectionTerms = tokenize(section);
        let overlap = 0;
        for (const term of sectionTerms) {
            if (termSet.has(term)) {
                overlap++;
            }
        }

        if (overlap > bestOverlap) {
            bestOverlap = overlap;
            bestSection = section;
        }
    }

    return truncateWords(bestSection.trim(), 600);
}

function tokenize(text: string): string[] {
    const matches = text.match(/[A-Za-z0-9\u4e00-\u9fa5]+/g);
    if (!matches) return [];
    return matches.map(token => token.toLowerCase()).filter(token => token.length >= 2);
}

function truncateWords(text: string, maxWords: number): string {
    const words = text.split(/\s+/);
    if (words.length <= maxWords) return text;
    return words.slice(0, maxWords).join(' ') + '...';
}

/**
 * Parallel chunk extraction for topK candidates.
 * Reads files concurrently and extracts best matching sections.
 */
async function extractChunksParallel(
    app: App,
    candidates: SearchResult[],
    queryTerms: string[]
): Promise<ChunkResult[]> {
    const results = await Promise.all(
        candidates.map(async (candidate) => {
            let chunk = candidate.summary || '';
            try {
                const file = app.vault.getAbstractFileByPath(candidate.path);
                if (file instanceof TFile) {
                    const content = await app.vault.read(file);
                    chunk = extractBestChunk(content, queryTerms);
                }
            } catch {
                // Keep summary fallback
            }
            return {
                path: candidate.path,
                title: candidate.title,
                chunk,
                score: candidate.bm25,
            };
        })
    );
    return results;
}

/**
 * Retrieval diagnostics interface for logging and debugging.
 */
export interface RetrievalDiagnostics {
    /** Timestamp of retrieval */
    timestamp: number;
    /** Original query */
    query: string;
    /** Tokenized query terms */
    queryTerms: string[];
    /** Index status at retrieval time */
    indexStatus: SearchIndexStatus;
    /** Whether search engine was ready */
    searchEngineReady: boolean;
    /** BM25 search results count */
    bm25ResultCount: number;
    /** Top BM25/fallback candidates for diagnostics */
    bm25TopResults?: Array<{ path: string; title: string; bm25: number }>;
    /** Whether embedding model is configured */
    embeddingConfigured: boolean;
    /** Embedding model ID (if configured) */
    embeddingModelId?: string;
    /** Whether embedding was successfully computed for query */
    queryEmbeddingSuccess?: boolean;
    /** Query embedding vector dimension */
    queryEmbeddingDim?: number;
    /** Number of candidates sent to rerank */
    rerankCandidateCount?: number;
    /** Final chunk count after rerank */
    rerankResultCount?: number;
    /** Top reranked chunks for diagnostics */
    rerankTopResults?: Array<{ path: string; title: string; score: number }>;
    /** Any errors encountered */
    errors: string[];
    /** Total retrieval time in ms */
    retrievalTimeMs: number;
}

/** Global diagnostics store for UI access */
let lastDiagnostics: RetrievalDiagnostics | null = null;

/**
 * Get the last retrieval diagnostics.
 */
export function getLastRetrievalDiagnostics(): RetrievalDiagnostics | null {
    return lastDiagnostics;
}

/**
 * Retrieve relevant wiki context with BM25 + optional embedding rerank.
 * 
 * Flow:
 * 1. If embedding model configured: BM25 search → Embedding rerank → Parallel chunk extraction
 * 2. If no embedding model: BM25 search → Parallel chunk extraction
 * 
 * @returns Formatted context string or null if no results
 */
export async function getRelevantIndexContext(
    app: App,
    settings: LLMWikiSettings,
    searchEngine: WikiSearchEngine | null,
    searchIndexStatus: SearchIndexStatus,
    question: string,
    retrievalTopN: number = DEFAULT_RETRIEVAL_TOP_N,
    retrievalRerankTopK: number = DEFAULT_RETRIEVAL_RERANK_TOP_K
): Promise<string | null> {
    const startTime = Date.now();
    
    // Initialize diagnostics
    const diagnostics: RetrievalDiagnostics = {
        timestamp: startTime,
        query: question,
        queryTerms: [],
        indexStatus: searchIndexStatus,
        searchEngineReady: searchEngine?.isReady() ?? false,
        bm25ResultCount: 0,
        bm25TopResults: [],
        embeddingConfigured: false,
        errors: [],
        retrievalTimeMs: 0,
    };
    
    // Check index status
    if (searchIndexStatus !== 'ready') {
        diagnostics.errors.push(`Index not ready: ${searchIndexStatus}`);
        lastDiagnostics = diagnostics;
        diagnostics.retrievalTimeMs = Date.now() - startTime;
        console.log('[WikiChat Retrieval Diagnostics]', JSON.stringify(diagnostics, null, 2));
        return getDegradedRetrievalContext(searchIndexStatus);
    }

    if (!searchEngine?.isReady()) {
        diagnostics.errors.push('Search engine not ready');
        lastDiagnostics = diagnostics;
        diagnostics.retrievalTimeMs = Date.now() - startTime;
        console.log('[WikiChat Retrieval Diagnostics]', JSON.stringify(diagnostics, null, 2));
        return null;
    }

    try {
        // Step 1: BM25 search
        const queryTerms = tokenize(question);
        diagnostics.queryTerms = queryTerms;
        
        const topResults = searchEngine.searchWithFallback(question, retrievalTopN);
        diagnostics.bm25ResultCount = topResults.length;
        diagnostics.bm25TopResults = topResults.slice(0, 5).map(r => ({
            path: r.path,
            title: r.title,
            bm25: Math.round(r.bm25 * 100) / 100,
        }));

        console.log(`[WikiChat] BM25 search: "${question}" → ${topResults.length} results (topN=${retrievalTopN})`);
        if (topResults.length === 0) {
            diagnostics.errors.push('BM25 returned no results');
            lastDiagnostics = diagnostics;
            diagnostics.retrievalTimeMs = Date.now() - startTime;
            console.log('[WikiChat Retrieval Diagnostics]', JSON.stringify(diagnostics, null, 2));
            return null;
        }

        // Step 2: Check if embedding model is configured
        const embedFn = buildEmbedFn(settings);
        const { currentEmbeddingModelId, embeddingModels } = settings;
        const embeddingCfg = embeddingModels?.find(m => m.id === currentEmbeddingModelId);
        
        diagnostics.embeddingConfigured = !!embedFn;
        if (embeddingCfg) {
            diagnostics.embeddingModelId = embeddingCfg.modelId;
        }

        let chunks: ChunkResult[];

        if (embedFn) {
            console.log(`[WikiChat] Embedding model configured: ${embeddingCfg?.modelId} (${embeddingCfg?.provider})`);
            
            // Test query embedding
            const queryVec = await embedFn(question);
            diagnostics.queryEmbeddingSuccess = queryVec.length > 0;
            diagnostics.queryEmbeddingDim = queryVec.length;
            
            if (queryVec.length === 0) {
                diagnostics.errors.push('Query embedding failed (empty vector returned)');
                console.warn('[WikiChat] Query embedding failed, falling back to BM25-only');
            } else {
                console.log(`[WikiChat] Query embedding success: dim=${queryVec.length}`);
            }
            
            diagnostics.rerankCandidateCount = Math.min(topResults.length, retrievalTopN);
            
            // With embedding: use WikiSearchEngine.rerank (handles embedding + chunk extraction)
            chunks = await searchEngine.rerank(
                question,
                topResults,
                embedFn,
                retrievalRerankTopK
            );

            diagnostics.rerankResultCount = chunks.length;
            diagnostics.rerankTopResults = chunks.slice(0, 5).map(c => ({
                path: c.path,
                title: c.title,
                score: Math.round(c.score * 100) / 100,
            }));
            
            console.log(`[WikiChat] Rerank complete: ${chunks.length} chunks (topK=${retrievalRerankTopK})`);
        } else {
            console.log('[WikiChat] No embedding model configured, using BM25-only mode');
            // Without embedding: parallel chunk extraction from top BM25 results
            const topCandidates = topResults.slice(0, retrievalRerankTopK);
            chunks = await extractChunksParallel(app, topCandidates, queryTerms);
            
            console.log(`[WikiChat] BM25-only extraction: ${chunks.length} chunks`);
        }

        if (chunks.length === 0) {
            diagnostics.errors.push('No chunks extracted');
            lastDiagnostics = diagnostics;
            diagnostics.retrievalTimeMs = Date.now() - startTime;
            console.log('[WikiChat Retrieval Diagnostics]', JSON.stringify(diagnostics, null, 2));
            return null;
        }

        // Format output
        const result = chunks
            .map(c => `### [[${c.path.replace(/\.md$/, '')}|${c.title}]]\n${c.chunk}`)
            .join('\n\n---\n\n');
        
        diagnostics.retrievalTimeMs = Date.now() - startTime;
        lastDiagnostics = diagnostics;
        
        console.log(`[WikiChat] Retrieval complete in ${diagnostics.retrievalTimeMs}ms`);
        console.log('[WikiChat Retrieval Diagnostics]', JSON.stringify(diagnostics, null, 2));
        
        return result;
    } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        diagnostics.errors.push(`Exception: ${errorMsg}`);
        diagnostics.retrievalTimeMs = Date.now() - startTime;
        lastDiagnostics = diagnostics;
        console.warn('[WikiChat] Retrieval error:', e);
        console.log('[WikiChat Retrieval Diagnostics]', JSON.stringify(diagnostics, null, 2));
        return null;
    }
}

/**
 * Build BM25 context from search results (lightweight version for queryWiki).
 * Pre-fetches summaries in parallel.
 */
export async function buildBM25Context(
    app: App,
    settings: LLMWikiSettings,
    question: string,
    searchEngine: WikiSearchEngine,
    topN: number = DEFAULT_RETRIEVAL_RERANK_TOP_K
): Promise<{ contextText: string; sources: string[] }> {
    const results = searchEngine.search(question, topN);
    if (results.length === 0) {
        return { contextText: '(No matching pages found in BM25 index)', sources: [] };
    }

    const sources: string[] = [];
    const lines: string[] = [];

    // Fetch summaries for all results in parallel
    const summaries = await Promise.all(
        results.map(async (result) => {
            if (result.summary) return result.summary;
            try {
                const file = app.vault.getAbstractFileByPath(result.path);
                if (file instanceof TFile) {
                    const raw = await app.vault.read(file);
                    const m = raw.match(/^## Summary\s*\n([\s\S]*?)(?=^##|\z)/m);
                    return m ? m[1].replace(/\s+/g, ' ').trim() : '';
                }
            } catch {
                // ignore read errors
            }
            return '';
        })
    );

    for (let i = 0; i < results.length; i++) {
        const result = results[i];
        sources.push(result.path);
        const summary = summaries[i];

        lines.push(`### [[${result.path.replace(/\.md$/, '')}|${result.title}]]`);
        if (summary) {
            lines.push(summary);
        }
        lines.push('');
    }

    return { contextText: lines.join('\n'), sources };
}
