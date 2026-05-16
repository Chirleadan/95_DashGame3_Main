import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env.local');
const desired = 'VITE_API_BASE_URL=http://localhost:3001';

let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

if (/^VITE_API_BASE_URL=/m.test(content)) {
  content = content.replace(/^VITE_API_BASE_URL=.*$/m, desired);
} else {
  content = content.trimEnd();
  if (content.length > 0) content += '\n';
  content += `${desired}\n`;
}

if (!content.endsWith('\n')) content += '\n';
fs.writeFileSync(envPath, content, 'utf8');
console.log(`[setup] ${envPath} → ${desired}`);
