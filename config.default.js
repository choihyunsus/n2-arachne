// config.default.js — Context Assembler 기본 설정 (배포용)
// 로컬 오버라이드: config.local.js (gitignored)
module.exports = {
    // 데이터 저장 경로
    dataDir: './data',

    // 인덱싱 설정
    indexing: {
        autoIndex: true,
        incremental: true,
        maxFileSize: 1024 * 1024,   // 1MB 초과 파일 무시
        maxFiles: 50000,
        chunkStrategy: 'regex',     // 'regex' | 'ast'
        supportedLanguages: ['js', 'ts', 'jsx', 'tsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'rb', 'php', 'swift', 'kt'],
        alsoIndexAsText: ['md', 'json', 'yaml', 'yml', 'toml', 'xml', 'html', 'css', 'sql', 'sh', 'bat', 'ps1'],
    },

    // 컨텍스트 조립 설정
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

    // 검색 설정
    search: {
        bm25: { k1: 1.2, b: 0.75 },
        topK: 10,
    },

    // 임베딩 설정 (Phase 3)
    embedding: {
        enabled: false,
        provider: 'ollama',
        model: 'nomic-embed-text',
        endpoint: 'http://localhost:11434',
    },

    // 파일 제외 패턴
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
            '*.min.js', '*.min.css', '*.map',
            'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
            'soul/data/**', 'data/**',
        ],
    },

    // 백업 설정
    backup: {
        enabled: true,
        dir: './data/backups',
        maxBackups: 10,
        maxAgeDays: 30,
        autoBackupOnReindex: true,
        externalBackupDir: null,
    },

    // 통합 설정
    integrations: {
        soul: { enabled: false, dataDir: null },
        qln: { enabled: false },
        ark: { enabled: false, rulesDir: null },
    },
};
