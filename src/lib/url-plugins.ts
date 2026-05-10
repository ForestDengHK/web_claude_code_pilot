import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
const PLUGINS_ROOT = path.join(os.homedir(), '.claude', 'plugins');
const URL_CACHE_DIR = path.join(PLUGINS_ROOT, '.codepilot-url-cache');
const REGISTRY_PATH = path.join(PLUGINS_ROOT, 'codepilot-url-plugins.json');

export interface UrlPluginEntry {
  url: string;
  urlHash: string;
  name: string;
  version: string;
  description?: string;
  installPath: string;
  installedAt: string;
}

interface Registry {
  plugins: UrlPluginEntry[];
}

function readRegistry(): Registry {
  if (!fs.existsSync(REGISTRY_PATH)) return { plugins: [] };
  try {
    const data = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
    if (data && Array.isArray(data.plugins)) return { plugins: data.plugins };
  } catch {
    // Corrupt registry — start over
  }
  return { plugins: [] };
}

function writeRegistry(reg: Registry): void {
  fs.mkdirSync(PLUGINS_ROOT, { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2));
}

export function listUrlPlugins(): UrlPluginEntry[] {
  return readRegistry().plugins;
}

function hashUrl(url: string): string {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
}

function validateUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('URL must use http or https');
  }
  return url;
}

async function downloadToFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Download failed: HTTP ${res.status}`);
  }
  const contentLength = res.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_DOWNLOAD_BYTES) {
    throw new Error(`Plugin too large (>${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB)`);
  }
  if (!res.body) throw new Error('Empty response body');

  const reader = res.body.getReader();
  const file = fs.createWriteStream(destPath);
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_DOWNLOAD_BYTES) {
        throw new Error(`Plugin exceeded ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB during download`);
      }
      await new Promise<void>((resolve, reject) => {
        file.write(value, err => (err ? reject(err) : resolve()));
      });
    }
  } finally {
    await new Promise<void>(resolve => file.end(resolve));
  }
}

async function verifyZipMagic(zipPath: string): Promise<void> {
  const fd = await fs.promises.open(zipPath, 'r');
  try {
    const buf = Buffer.alloc(4);
    await fd.read(buf, 0, 4, 0);
    // ZIP magic: PK\x03\x04 (or PK\x05\x06 for empty, PK\x07\x08 spanning)
    if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
      throw new Error('Downloaded file is not a valid zip archive');
    }
  } finally {
    await fd.close();
  }
}

/**
 * Locate the plugin root inside an extracted directory. Many GitHub release
 * zips wrap content in a single top-level folder, so accept either:
 *   <extractDir>/plugin.json  — direct
 *   <extractDir>/<single-subdir>/plugin.json  — wrapped
 */
function findPluginRoot(extractDir: string): string {
  if (fs.existsSync(path.join(extractDir, 'plugin.json'))) {
    return extractDir;
  }
  const entries = fs.readdirSync(extractDir, { withFileTypes: true });
  const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'));
  if (dirs.length === 1) {
    const inner = path.join(extractDir, dirs[0].name);
    if (fs.existsSync(path.join(inner, 'plugin.json'))) return inner;
  }
  throw new Error('No plugin.json found in archive root');
}

interface PluginManifest {
  name?: string;
  version?: string;
  description?: string;
}

function readManifest(pluginRoot: string): PluginManifest {
  const manifestPath = path.join(pluginRoot, 'plugin.json');
  const raw = fs.readFileSync(manifestPath, 'utf-8');
  try {
    return JSON.parse(raw) as PluginManifest;
  } catch {
    throw new Error('plugin.json is not valid JSON');
  }
}

export async function installFromUrl(rawUrl: string): Promise<UrlPluginEntry> {
  validateUrl(rawUrl);

  const urlHash = hashUrl(rawUrl);
  const tmpDir = path.join(URL_CACHE_DIR, `.tmp-${urlHash}-${Date.now()}`);
  const finalDir = path.join(URL_CACHE_DIR, urlHash);

  fs.mkdirSync(tmpDir, { recursive: true });
  const zipPath = path.join(tmpDir, 'plugin.zip');
  const extractDir = path.join(tmpDir, 'extracted');
  fs.mkdirSync(extractDir, { recursive: true });

  try {
    await downloadToFile(rawUrl, zipPath);
    await verifyZipMagic(zipPath);
    await execFileAsync('unzip', ['-q', '-o', zipPath, '-d', extractDir], {
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const pluginRoot = findPluginRoot(extractDir);
    const manifest = readManifest(pluginRoot);
    if (!manifest.name) throw new Error('plugin.json is missing "name"');

    // Replace any prior install at the same URL hash
    if (fs.existsSync(finalDir)) {
      fs.rmSync(finalDir, { recursive: true, force: true });
    }
    fs.mkdirSync(URL_CACHE_DIR, { recursive: true });
    fs.renameSync(pluginRoot, finalDir);

    const entry: UrlPluginEntry = {
      url: rawUrl,
      urlHash,
      name: manifest.name,
      version: manifest.version || 'unknown',
      description: manifest.description,
      installPath: finalDir,
      installedAt: new Date().toISOString(),
    };

    const reg = readRegistry();
    reg.plugins = reg.plugins.filter(p => p.urlHash !== urlHash);
    reg.plugins.push(entry);
    writeRegistry(reg);

    return entry;
  } finally {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }
}

export function removeUrlPlugin(url: string): boolean {
  const urlHash = hashUrl(url);
  const reg = readRegistry();
  const before = reg.plugins.length;
  reg.plugins = reg.plugins.filter(p => p.urlHash !== urlHash);
  writeRegistry(reg);

  const installPath = path.join(URL_CACHE_DIR, urlHash);
  if (fs.existsSync(installPath)) {
    fs.rmSync(installPath, { recursive: true, force: true });
  }
  return reg.plugins.length < before;
}
