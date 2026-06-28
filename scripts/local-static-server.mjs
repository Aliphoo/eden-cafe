import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';

const root = resolve(process.argv[2] || '.');
const port = Number(process.argv[3] || 4173);
const host = process.argv[4] || '127.0.0.1';

const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webp': 'image/webp',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8'
};

function resolveFile(urlPath) {
    let pathname = decodeURIComponent(new URL(urlPath, `http://${host}`).pathname);
    if (pathname === '/') pathname = '/index.html';

    const direct = resolve(root, `.${pathname}`);
    if (!extname(direct)) {
        const cleanHtml = `${direct}.html`;
        const indexHtml = join(direct, 'index.html');
        if (existsSync(cleanHtml)) return cleanHtml;
        if (existsSync(indexHtml)) return indexHtml;
    }
    if (/^\/blog\/[^/]+\/?$/.test(pathname)) {
        const blogReader = resolve(root, './blog-post.html');
        if (existsSync(blogReader)) return blogReader;
    }
    return direct;
}

createServer((request, response) => {
    const file = resolveFile(request.url || '/');
    if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        return;
    }

    response.writeHead(200, {
        'Content-Type': contentTypes[extname(file).toLowerCase()] || 'application/octet-stream'
    });
    createReadStream(file).pipe(response);
}).listen(port, host, () => {
    console.log(`Static server running at http://${host}:${port}/`);
});
