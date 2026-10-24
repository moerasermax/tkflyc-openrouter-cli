// 測試共用：在系統暫存資料夾建一個假專案，測完刪掉；不碰使用者的真實資料位置。
// 所有 junction 都指向同一個暫存資料夾裡的位置，刪除時就算被跟進也只會刪到測試資料。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const PROJECT_DIR = path.resolve(import.meta.dirname, '..');
export const CLI = path.join(PROJECT_DIR, 'bin', 'openrouter.js');
export const MOCK = pathToFileURL(path.join(import.meta.dirname, 'mock-fetch.mjs')).href;
export const FAKE_KEY = `sk-or-v1-${'0'.repeat(64)}`;

export const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
export const removeDir = (dir) => fs.rmSync(dir, { recursive: true, force: true });

export function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// 用 TextDecoder 反查出 Big5 編碼，做出真正的 Big5 檔案（Node 只有 Big5 解碼器、沒有編碼器）
let big5Map;
export function toBig5(text) {
  if (!big5Map) {
    big5Map = new Map();
    const decoder = new TextDecoder('big5');
    for (let lead = 0x81; lead <= 0xfe; lead++) {
      for (let trail = 0x40; trail <= 0xfe; trail++) {
        if (trail > 0x7e && trail < 0xa1) continue;
        const ch = decoder.decode(Uint8Array.of(lead, trail));
        if (ch.length === 1 && ch !== '�' && !big5Map.has(ch)) big5Map.set(ch, [lead, trail]);
      }
    }
  }
  return Buffer.from([...text].flatMap((ch) => (ch.charCodeAt(0) < 128 ? [ch.charCodeAt(0)] : big5Map.get(ch))));
}

// 假專案：proj 是工作資料夾；outside 在它外面；deny 模擬「拒讀位置」（例如 CLI 的資料位置）
export function makeProject(base) {
  const root = path.join(base, 'proj');
  const outside = path.join(base, 'outside');
  const deny = path.join(base, 'deny');
  write(path.join(root, 'README.md'), '# 測試專案\nMOCK-README-MARKER\n');
  write(path.join(root, 'src/server.cs'), Array.from({ length: 600 }, (_, i) => (i === 299 ? 'public class GameServer { }' : `// line ${i + 1}`)).join('\n'));
  write(path.join(root, 'legacy/big5.txt'), toBig5('黃易群俠傳 伺服器設定\r\nport=7000\r\n'));
  write(path.join(root, 'legacy/utf16.xml'), Buffer.from('﻿<config name="登入器"/>', 'utf16le'));
  write(path.join(root, '.env'), 'SECRET=1');
  write(path.join(root, '.env.example'), 'SECRET=');
  write(path.join(root, 'keys/server.pem'), '-----BEGIN-----');
  write(path.join(root, 'bin.dat'), Buffer.from([1, 0, 2, 0, 3]));
  write(path.join(root, 'node_modules/x/index.js'), 'GameServer in node_modules');
  write(path.join(root, 'data-deny/config.json'), '{"apiKey":"sk-or-v1-fake"}');
  write(path.join(outside, 'secret.txt'), 'OUTSIDE SECRET');
  write(path.join(deny, 'config.json'), '{"apiKey":"sk-or-v1-fake-deny"}');
  fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
  fs.symlinkSync(deny, path.join(root, 'deny-link'), 'junction');
  return { root, outside, deny };
}

// Windows 的 8.3 短路徑；沒有短檔名（或不是 Windows）時回傳 null
export function shortPath(p) {
  if (process.platform !== 'win32') return null;
  try {
    const out = execSync(`chcp 65001>nul & for %I in ("${p}") do @echo %~sI`, { encoding: 'utf8', shell: 'cmd.exe' }).trim();
    return out && out.toLowerCase() !== p.toLowerCase() ? out : null;
  } catch {
    return null;
  }
}
