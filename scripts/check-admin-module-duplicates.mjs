import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
if (!files.length) files.push('js/admin.js');

function scanTopLevelDeclarations(source) {
    const declarations = new Map();
    const lines = source.split(/\r?\n/);
    let depth = 0;
    let inBlockComment = false;

    lines.forEach((line, index) => {
        let clean = '';
        let inString = '';
        let escaped = false;
        let inLineComment = false;
        const depthAtLineStart = depth;

        for (let i = 0; i < line.length; i += 1) {
            const char = line[i];
            const next = line[i + 1];

            if (inLineComment) break;
            if (inBlockComment) {
                if (char === '*' && next === '/') {
                    inBlockComment = false;
                    i += 1;
                }
                continue;
            }
            if (inString) {
                clean += ' ';
                if (escaped) {
                    escaped = false;
                } else if (char === '\\') {
                    escaped = true;
                } else if (char === inString) {
                    inString = '';
                }
                continue;
            }
            if (char === '/' && next === '/') {
                inLineComment = true;
                break;
            }
            if (char === '/' && next === '*') {
                inBlockComment = true;
                i += 1;
                continue;
            }
            if (char === '"' || char === "'" || char === '`') {
                inString = char;
                clean += ' ';
                continue;
            }

            clean += char;
            if (char === '{') depth += 1;
            if (char === '}') depth = Math.max(0, depth - 1);
        }

        if (depthAtLineStart !== 0) return;
        const match = clean.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/)
            || clean.match(/^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/)
            || clean.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[=;]/);
        if (!match) return;

        const name = match[1];
        if (!declarations.has(name)) declarations.set(name, []);
        declarations.get(name).push(index + 1);
    });

    return Array.from(declarations.entries())
        .filter(([, locations]) => locations.length > 1)
        .map(([name, locations]) => ({ name, locations }));
}

let failed = false;
files.forEach(file => {
    const duplicates = scanTopLevelDeclarations(readFileSync(file, 'utf8'));
    if (!duplicates.length) {
        console.log(`PASS ${file}: no duplicate top-level declarations`);
        return;
    }
    failed = true;
    console.error(`FAIL ${file}: duplicate top-level declarations`);
    duplicates.forEach(({ name, locations }) => {
        console.error(`  ${name}: lines ${locations.join(', ')}`);
    });
});

process.exit(failed ? 1 : 0);
