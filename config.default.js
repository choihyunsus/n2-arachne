// config.default.js — Arachne default configuration (for distribution)
// Local override: config.local.js (gitignored)
module.exports = {
    // Data storage path
    dataDir: './data',

    // Indexing settings
    indexing: {
        autoIndex: true,
        incremental: true,
        maxFileSize: 1024 * 1024,   // Skip files over 1MB
        maxFiles: 50000,
        chunkStrategy: 'regex',     // 'regex' | 'ast'
        tokenMultiplier: 3.5,       // Chars per token. English/code: 3.5, CJK (ko/zh/ja): 1.5
        supportedLanguages: ['js', 'ts', 'jsx', 'tsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'rb', 'php', 'swift', 'kt'],
        alsoIndexAsText: ['md', 'json', 'yaml', 'yml', 'toml', 'xml', 'html', 'css', 'sql', 'sh', 'bat', 'ps1'],
    },

    // Context assembly settings
    assembly: {
        defaultBudget: 40000,
        layers: {
            fixed: 0.10,
            shortTerm: 0.30,
            associative: 0.40,
            spare: 0.20,
        },
        dependencyDepth: 2,
    },

    // Search settings
    search: {
        bm25: { k1: 1.2, b: 0.75 },
        topK: 10,
    },

    // Embedding settings (Phase 3)
    embedding: {
        enabled: false,
        provider: 'ollama',
        model: 'nomic-embed-text',
        endpoint: 'http://localhost:11434',
    },

    // File exclusion patterns
    ignore: {
        useGitignore: true,
        useContextignore: true,
        patterns: [
            'node_modules/**', 'vendor/**', '__pycache__/**', '.venv/**',
            'dist/**', 'build/**', 'out/**', '.next/**', 'target/**',
            '.git/**',
            '*.png', '*.jpg', '*.jpeg', '*.gif', '*.ico', '*.svg', '*.bmp', '*.webp',
            '*.woff', '*.woff2', '*.ttf', '*.eot',
            '*.mp3', '*.mp4', '*.wav', '*.avi', '*.mkv', '*.webm',
            '*.zip', '*.tar', '*.gz', '*.rar', '*.7z',
            '*.exe', '*.dll', '*.so', '*.dylib', '*.bin',
            '*.class', '*.jar', '*.war', '*.ear',
            '*.min.js', '*.min.css', '*.map',
            'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
            'soul/data/**', 'data/**',
        ],
    },

    // Backup settings
    backup: {
        enabled: true,
        dir: './data/backups',
        maxBackups: 10,
        maxAgeDays: 30,
        autoBackupOnReindex: true,
        externalBackupDir: null,
    },

    // Integration settings
    integrations: {
        soul: { enabled: true, dataDir: null },
        qln: { enabled: false },
        ark: { enabled: true, rulesDir: null },
    },
};
