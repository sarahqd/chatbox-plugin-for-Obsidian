# WikiChat - Obsidian Plugin

<p align="center">
  <strong>Transform Obsidian into an AI-driven, self-maintaining knowledge base</strong>
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#installation">Installation</a> •
  <a href="#usage">Usage</a> •
  <a href="#llm-support">LLM Support</a> •
  <a href="#ecosystem">Ecosystem</a>
</p>

---

## The Problem

As you accumulate notes, research materials, and documentation, they often remain fragmented:

- **Scattered content**: Markdown files, PDFs, snippets, and web clips scattered across different folders and formats
- **Information silos**: Related concepts exist in your notes but lack connections
- **Format inconsistency**: Content from different sources (web, emails, documents) lacks unified structure
- **Privacy concerns**: Using cloud AI services means uploading personal notes to third-party servers
- **Recurring costs**: Subscriptions add up when relying on commercial LLM APIs

## The Solution

WikiChat automates the process of **normalizing and connecting** your personal knowledge base. Using local LLMs running on your machine, it:

- Automatically extracts key concepts and entities from documents
- Establishes bidirectional links between related pages
- Standardizes all content into a consistent Wiki page structure
- Stores knowledge directly as Markdown files in your vault (no external database)
- Keeps everything on your computer—complete privacy, zero cloud dependency

**Inspiration**: This project is inspired by [Andrej Karpathy's LLM Wiki concept](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f#file-llm-wiki-md).

## Key Features

### 📥 Ingest & Normalize
- Automatically analyze new documents and extract key information
- Convert mixed formats into standardized Wiki pages
- Identify entities, concepts, and relationships
- Create bidirectional links between related topics

### 🔍 Query & Discover
- Search your knowledge base using natural language
- Get synthesized answers drawing from multiple pages
- Source citations with `[[wikilink]]` references
- Uncover connections you didn't notice before

### 🔧 Maintain Quality
- Detect broken links and disconnected pages
- Identify contradictions and duplicate content
- Mark pages that need updating
- Receive auto-fix suggestions

### 🔐 Privacy & Cost
- **All processing runs locally** — your data never leaves your computer
- **Use free, open-source models** — no API subscriptions required
- **Offline capable** — works without internet connection
- **Your data, your rules** — complete control over your knowledge base

## Who Uses WikiChat?

### Students & Researchers
Organize lecture notes, papers, and research materials into a structured knowledge base. Quickly find related concepts and references across semesters of accumulated content.

### Engineers & Technical Writers
Manage code snippets, technical documentation, solutions, and best practices. Discover connections between different problems and approaches you've encountered.

### Content Creators & Writers
Consolidate inspiration, references, and source material. Rapidly locate related ideas and maintain a searchable archive of your creative work.

## Vault Structure

WikiChat organizes your Obsidian vault into three areas:

```
your-vault/
├── Sources/       # Original documents you want to process
├── templates/     # Wiki page templates
└── Wiki/          # Structured knowledge base (auto-generated)
    └── index.md   # Index of all pages
```

## Installation

### From Release

1. Download the latest release from [GitHub Release](https://github.com/sarahqd/chatbox-plugin-for-Obsidian/release)
2. Extract the files to `.obsidian/plugins/WikiChat/` in your Obsidian vault
3. Open Obsidian Settings → Reload plugins
4. Enable **WikiChat** plugin

### From Source

```bash
# Clone the repository
git clone https://github.com/sarahqd/chatbox-plugin-for-Obsidian.git

# Navigate to the project directory
cd chatbox-plugin-for-Obsidian

# Install dependencies
npm install

# Build the plugin
npm run build 

# Copy main files to WikiChat folder
cp main.js WikiChat/
cp manifest.json WikiChat/
cp styles.css WikiChat/

# Copy to your Obsidian vault
cp -r WikiChat /path/to/your/vault/.obsidian/plugins/
```

## Getting Started

### Basic Workflow

1. **Prepare documents**: Move markdown files to your `Sources/` folder (see format notes below)
2. **Ingest**: Run the `WikiChat: Ingest` command to analyze and normalize
3. **Query**: Use `WikiChat: Query` to ask questions about your knowledge base
4. **Maintain**: Periodically run `WikiChat: Lint` to check for issues

### Supported Formats

- **✅ Markdown** - Native support, formatting preserved
- **Other formats** (PDF, Word, web articles): Convert to Markdown first using tools like Pandoc or online converters, then place in `Sources/` folder

### Storage Model

- **Markdown-only knowledge base**: WikiChat manages content as Markdown files in your Obsidian vault
- **No external database**: There is no additional DB layer to maintain or migrate

### Section-Aware Tooling

When the model only needs one part of a Wiki page, prefer the narrowest tool instead of reading or rewriting the full page.

For local inference, choose a model/runtime that supports **tool (function) calling**, so WikiChat can run file search and file editing workflows reliably.

## LLM Support

WikiChat is designed for local, privacy-first operation:

| Provider | Status | Best For | Requirement |
|----------|--------|----------|-------------|
| **Ollama** | ✅ Recommended | Local models, complete privacy, zero cost | Model must support tool/function calling |
| **OpenAI Compatible** | ✅ Available | When you prefer cloud-based models | Tool/function calling strongly recommended |

> Note: For local models, tool/function calling is required for file-level operations such as searching and updating Wiki files.

### Configuring Ollama

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull a model
ollama pull llama2

# Start the server
ollama serve
```

In WikiChat settings, set the Ollama endpoint (default: `http://localhost:11434`).

## Ecosystem

WikiChat works great with these Obsidian tools:

### Plugins
- **[Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api)** - Enable external integrations

### Browser Extensions
- **Obsidian AI Explorer** - Enhanced AI-powered browsing
- **Obsidian Web Clipper** - Save web content directly to your vault

## Wiki Page Format

WikiChat creates pages following this structure:

```markdown
---
title: Page Title
created: YYYY-MM-DD
updated: YYYY-MM-DD
summary: Summary
tags: [tag1, tag2]
related: [Page1, Page2]
---

# Page Title

## Content
<!-- Main content with proper formatting -->

## Related Links
- [[related-page-1]]
- [[related-page-2]]
```

## Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| `llmProvider` | LLM backend to use | `ollama` |
| `ollamaEndpoint` | Ollama server URL | `http://localhost:11434` |
| `modelName` | Model to use | `gemma4:E4b` |
| `wikiFolder` | Wiki storage folder | `Wiki` |
| `sourcesFolder` | Sources folder | `Sources` |

## Development

```bash
# Development build with watch mode
npm run dev

# Production build
npm run build
```

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Inspired by [Andrej Karpathy's LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
- Built with [Obsidian API](https://docs.obsidian.md/Reference/Manifest)
- Powered by local LLMs via [Ollama](https://ollama.com/)
