// ignore.js — 파일 제외 규칙 (.gitignore + .contextignore)
const fs = require('fs');
const path = require('path');

class IgnoreFilter {
    /**
     * @param {object} config - ignore 설정 (config.ignore)
     * @param {string} projectDir - 프로젝트 루트 경로
     */
    constructor(config, projectDir) {
        this._patterns = [];
        this._projectDir = projectDir;

        // 1. 기본 패턴 (config.default.js에서)
        if (config.patterns && config.patterns.length > 0) {
            this._patterns.push(...config.patterns);
        }

        // 2. .gitignore 로드
        if (config.useGitignore) {
            this._loadIgnoreFile(path.join(projectDir, '.gitignore'));
        }

        // 3. .contextignore 로드 (최우선)
        if (config.useContextignore) {
            this._loadIgnoreFile(path.join(projectDir, '.contextignore'));
        }

        // 패턴 → 정규식으로 사전 컴파일
        this._compiled = this._patterns.map(p => this._globToRegex(p));
    }

    /**
     * 파일 경로가 제외 대상인지 판단
     * @param {string} relativePath - 프로젝트 루트 기준 상대 경로
     * @returns {boolean} true면 제외
     */
    isIgnored(relativePath) {
        // 경로 정규화 (Windows 백슬래시 → 슬래시)
        const normalized = relativePath.replace(/\\/g, '/');

        for (const regex of this._compiled) {
            if (regex.test(normalized)) {
                return true;
            }
        }
        return false;
    }

    /**
     * 파일 목록에서 제외 대상을 필터링
     * @param {string[]} paths - 상대 경로 배열
     * @returns {string[]} 포함할 경로만 반환
     */
    filter(paths) {
        return paths.filter(p => !this.isIgnored(p));
    }

    /** @returns {number} 로드된 패턴 수 */
    get patternCount() {
        return this._compiled.length;
    }

    /**
     * ignore 파일 로드 (.gitignore / .contextignore)
     */
    _loadIgnoreFile(filePath) {
        if (!fs.existsSync(filePath)) return;

        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');

        for (const rawLine of lines) {
            const line = rawLine.trim();
            // 빈 줄, 주석 무시
            if (!line || line.startsWith('#')) continue;
            // 부정 패턴(!) — 아직 미지원, 무시
            if (line.startsWith('!')) continue;
            this._patterns.push(line);
        }
    }

    /**
     * glob 패턴 → 정규식 변환
     * 지원: *, **, ?, 경로 구분자
     */
    _globToRegex(pattern) {
        // 앞뒤 슬래시 정리
        let p = pattern.replace(/\\/g, '/').replace(/^\/+/, '');

        // 디렉토리 패턴 처리 (끝이 /로 끝나면 하위 전체)
        if (p.endsWith('/')) {
            p += '**';
        }

        let regex = '';
        let i = 0;
        while (i < p.length) {
            const c = p[i];
            if (c === '*') {
                if (p[i + 1] === '*') {
                    if (p[i + 2] === '/') {
                        regex += '(?:.*\\/)?';
                        i += 3;
                    } else {
                        regex += '.*';
                        i += 2;
                    }
                } else {
                    regex += '[^/]*';
                    i++;
                }
            } else if (c === '?') {
                regex += '[^/]';
                i++;
            } else if (c === '.') {
                regex += '\\.';
                i++;
            } else {
                regex += c;
                i++;
            }
        }

        // 파일 확장자 패턴(*.js)이면 경로 어디서든 매칭
        if (pattern.startsWith('*.')) {
            return new RegExp(`(?:^|\\/)${regex}$`, 'i');
        }

        return new RegExp(`^${regex}$`, 'i');
    }
}

module.exports = { IgnoreFilter };
