import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import * as yauzl from 'yauzl';
import { ApiError } from '../../lib/errors';
import { listParsers } from '../../parsers/registry';
import { parseScreenshotText } from './screenshot-parser';

export const SCREENSHOT_UPLOAD_LIMIT = 24 * 1024 * 1024;
const FILE_LIMIT = 10;
const MAX_PIXELS = 24_000_000;
const TTL_MS = 45 * 60_000;
interface ImageFile { name: string; data: Buffer }
interface CapturePage extends ReturnType<typeof parseScreenshotText> {
  index: number;
  name: string;
  duplicateOf?: number;
  error?: string;
}
interface Capture {
  owner: number;
  expiresAt: number;
  status: 'processing' | 'ready';
  total: number;
  pages: CapturePage[];
}

const captures = new Map<string, Capture>();
let running = 0;

function safeName(name: string) {
  return basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100) || '截图';
}

async function readZip(buffer: Buffer): Promise<ImageFile[]> {
  const files: ImageFile[] = [];
  let size = 0;
  try {
    const zip = await yauzl.fromBufferPromise(buffer, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true });
    try {
      if (zip.entryCount > 48) throw new ApiError(400, '压缩包包含过多文件');
      for await (const entry of zip.eachEntry()) {
        if (entry.fileName.endsWith('/') || entry.fileName.startsWith('__MACOSX/') || basename(entry.fileName).startsWith('.')) continue;
        if (files.length >= FILE_LIMIT) throw new ApiError(400, '每批最多上传 10 张截图');
        const kind = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (kind && kind !== 0o100000) throw new ApiError(400, '压缩包只能包含普通文件');
        if (entry.uncompressedSize > SCREENSHOT_UPLOAD_LIMIT - size) throw new ApiError(413, '截图解压后的总大小不能超过 24 MB');
        const data: Buffer[] = [];
        for await (const chunk of await zip.openReadStreamPromise(entry)) {
          const bytes = Buffer.from(chunk);
          size += bytes.length;
          if (size > SCREENSHOT_UPLOAD_LIMIT) throw new ApiError(413, '截图解压后的总大小不能超过 24 MB');
          data.push(bytes);
        }
        files.push({ name: safeName(entry.fileName), data: Buffer.concat(data) });
      }
    } finally { zip.close(); }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(400, '无法读取截图压缩包');
  }
  return files;
}

export async function readScreenshotUpload(contentType: string, data: unknown): Promise<ImageFile[]> {
  if (!Buffer.isBuffer(data) || data.length === 0) throw new ApiError(400, '请选择要上传的截图');
  if (contentType.startsWith('multipart/form-data')) {
    let form: FormData;
    try {
      form = await new Request('http://localhost', {
        method: 'POST', headers: { 'Content-Type': contentType }, body: new Uint8Array(data),
      }).formData();
    } catch {
      throw new ApiError(400, '无法读取上传的图片');
    }
    const values = form.getAll('images');
    if (values.length === 0 || values.some((value) => typeof value === 'string')) throw new ApiError(400, '请选择要上传的截图');
    if (values.length > FILE_LIMIT) throw new ApiError(400, '每批最多上传 10 张截图');
    return Promise.all(values.filter((value): value is File => typeof value !== 'string')
      .map(async (file) => ({ name: safeName(file.name), data: Buffer.from(await file.arrayBuffer()) })));
  }
  if (data.readUIntLE(0, Math.min(4, data.length)) === 0x04034b50 || contentType.includes('zip')) {
    return readZip(data);
  }
  return [{ name: '截图', data }];
}

function imagePixels(data: Buffer): number {
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      data.toString('ascii', 12, 16) === 'IHDR') {
    return data.readUInt32BE(16) * data.readUInt32BE(20);
  }
  if (data.length < 4 || data.readUInt16BE(0) !== 0xffd8) return 0;
  let offset = 2;
  while (offset + 3 < data.length && data[offset++] === 0xff) {
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (marker === 0xda || marker === 0xd9 || offset + 2 > data.length) break;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) break;
    if ((marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker) && length >= 8) {
      return data.readUInt16BE(offset + 3) * data.readUInt16BE(offset + 5);
    }
    offset += length;
  }
  return 0;
}

function recognizeImage(data: Buffer): Promise<string> {
  const pixels = imagePixels(data);
  if (!pixels) throw new ApiError(400, '请使用 PNG 或 JPEG 截图');
  if (pixels > MAX_PIXELS) throw new ApiError(400, '截图像素过多，请裁剪或分成几张上传');
  return new Promise((resolve, reject) => {
    const child = execFile('tesseract', ['stdin', 'stdout', '-l', 'chi_sim+eng', '--psm', '6'], {
      timeout: 30_000, maxBuffer: 1024 * 1024, env: { ...process.env, OMP_THREAD_LIMIT: '1' },
    }, (error, stdout) => {
      if (!error) resolve(stdout);
      else reject(new ApiError(422, error.code === 'ENOENT' ? '服务端未安装截图识别组件' : '没能识别这张截图，请检查清晰度或手动补填'));
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(data);
  });
}

export async function recognizeOfferScreenshot(data: Buffer): Promise<string> {
  if (running >= 2) throw new ApiError(429, '还有截图正在识别，请稍后再试');
  running++;
  try { return await recognizeImage(data); } finally { running--; }
}

async function recognizeBatch(capture: Capture, files: ImageFile[]) {
  const seen = new Map<string, number>();
  const bankNames = listParsers().map((parser) => parser.bankName).filter((name) => name.endsWith('银行'));
  for (const [index, file] of files.entries()) {
    const page: CapturePage = { index: index + 1, name: file.name, fields: {}, transactions: [] };
    const hash = createHash('sha256').update(file.data).digest('hex');
    const previous = seen.get(hash);
    try {
      if (previous !== undefined) page.duplicateOf = previous;
      else {
        seen.set(hash, page.index);
        const text = await recognizeImage(file.data);
        Object.assign(page, parseScreenshotText(text, bankNames));
        if (text.trim() === '') page.error = '未识别到文字，请手动补填或重新上传';
      }
    } catch (error) {
      page.error = error instanceof ApiError ? error.message : '未识别到这张截图';
    }
    capture.pages.push(page);
  }
}

export function createScreenshotCapture(owner: number, files: ImageFile[]): string {
  if (files.length === 0 || files.length > FILE_LIMIT) throw new ApiError(400, '每批请选择 1–10 张截图');
  if (running >= 2) throw new ApiError(429, '还有截图正在识别，请稍后再试');
  for (const [id, capture] of captures) {
    if (capture.expiresAt <= Date.now() && capture.status === 'ready') captures.delete(id);
  }
  if (captures.size >= 16) throw new ApiError(429, '待核对批次过多，请稍后再上传');
  const id = randomUUID();
  const capture: Capture = { owner, expiresAt: Date.now() + TTL_MS, status: 'processing', total: files.length, pages: [] };
  captures.set(id, capture);
  running++;
  void recognizeBatch(capture, files).finally(() => {
    capture.status = 'ready';
    capture.expiresAt = Date.now() + TTL_MS;
    running--;
    setTimeout(() => captures.delete(id), TTL_MS).unref();
  });
  return id;
}

export function getScreenshotCapture(owner: number, id: string) {
  const capture = captures.get(id);
  if (!capture || capture.owner !== owner || capture.expiresAt <= Date.now()) throw new ApiError(404, '截图批次已过期或不存在，请重新上传');
  return { status: capture.status, total: capture.total, pages: capture.pages };
}
