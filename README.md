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

## Overview

WikiChat is an Obsidian plugin that transforms your notes into an intelligent, self-maintaining knowledge base. Powered by local LLMs or cloud LLM API, it helps you ingest, query, and maintain your Wiki with minimal effort.

**Inspiration**: This project is inspired by [Andrej Karpathy's LLM Wiki concept](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f#file-llm-wiki-md).

## Features

### 📥 Ingest
- Automatically analyze and integrate new documents into your Wiki
- Extract entities, concepts, and relationships
- Create and update Wiki pages with proper structure
- Establish bidirectional links between related pages

### 🔍 Query
- Ask questions in natural language
- Get answers synthesized from multiple Wiki pages
- Source citations with `[[wikilink]]` references
- Context-aware responses based on your knowledge base

### 🔧 Maintain
- Detect broken links and orphaned pages
- Identify content contradictions
- Find duplicate content
- Mark stale pages for review
- Auto-fix suggestions with user confirmation

## Notebook Structure

WikiChat organizes your vault into three main areas:

```
your-vault/
├── Sources/       # Original documents and imported content
├── templates/     # Wiki page templates
└── Wiki/          # Structured knowledge base pages
    └── index.md   # Auto-generated index of all Wiki pages
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

## Usage

### Basic Workflow

1. **Ingest Documents**: Add documents to your `Sources/` folder
2. **Process with WikiChat**: Use the plugin to analyze and create Wiki pages
3. **Query Knowledge**: Ask questions and get AI-powered answers
4. **Maintain Quality**: Run lint checks to keep your Wiki healthy

### Commands

| Command | Description |
|---------|-------------|
| `WikiChat: Ingest` | Process and integrate new documents |
| `WikiChat: Query` | Open the query interface |
| `WikiChat: Lint` | Run maintenance checks |
| `WikiChat: Open Chat` | Open the AI chat interface |

## LLM Support

WikiChat supports multiple LLM backends:

| Provider | Status | Notes |
|----------|--------|-------|
| **Ollama** | ✅ Supported | Recommended for local, private AI |
| **OpenAI Compatible** | ✅ Supported |  |

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
tags: [tag1, tag2]
---

# Page Title

## Summary
<!-- Brief summary, max 200 characters -->

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
| `modelName` | Model to use | `llama2` |
| `wikiFolder` | Wiki storage folder | `Wiki` |
| `sourcesFolder` | Sources folder | `Sources` |

## Development

```bash
# Development build with watch mode
npm run dev

# Production build
npm run build
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Inspired by [Andrej Karpathy's LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
- Built with [Obsidian API](https://docs.obsidian.md/Reference/Manifest)
- Powered by local LLMs via [Ollama](https://ollama.com/)
