import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { ApiError, asyncHandler } from '../lib/errors';
import { prisma } from '../lib/prisma';
import { saveScreenshotBill, screenshotBillSchema } from '../modules/bills/screenshot-bills';
import { createScreenshotCapture, getScreenshotCapture, readScreenshotUpload, SCREENSHOT_UPLOAD_LIMIT } from '../modules/bills/screenshot-upload';
import { requireAuth, type AuthedRequest } from './middleware';
import { attemptLimit } from './security.middleware';

const router = Router();
const SHORTCUT_KEY = 'billImageShortcutKey';
const captureId = z.uuid();
const shortcutKeySchema = z.object({ owner: z.number().int().positive(), hash: z.string().regex(/^[0-9a-f]{64}$/) });
const upload = express.raw({
  type: ['image/png', 'image/jpeg', 'application/zip', 'application/x-zip-compressed', 'application/octet-stream', 'multipart/form-data'],
  limit: SCREENSHOT_UPLOAD_LIMIT,
});

const ownerOf = (req: Request) => (req as AuthedRequest).adminId!;
const digest = (token: string) => createHash('sha256').update(token).digest();

async function uploadBatch(req: Request, owner: number) {
  const images = await readScreenshotUpload(req.get('Content-Type') ?? '', req.body);
  const id = createScreenshotCapture(owner, images);
  return { id, reviewPath: '/bills?capture=' + id };
}

router.post('/shortcut', attemptLimit(20, 60_000, { countSuccess: true }),
  asyncHandler(async (req, res, next) => {
    const token = req.get('Authorization')?.match(/^Bearer ([0-9a-f]{64})$/i)?.[1];
    if (!token) throw new ApiError(401, '请在快捷指令里设置截图上传密钥');
    const row = await prisma.appSetting.findUnique({ where: { key: SHORTCUT_KEY } });
    const key = shortcutKeySchema.safeParse(row ? JSON.parse(row.value) : null);
    if (!key.success || !timingSafeEqual(digest(token), Buffer.from(key.data.hash, 'hex'))) {
      throw new ApiError(401, '截图上传密钥无效或已停用');
    }
    (req as AuthedRequest).adminId = key.data.owner;
    next();
  }), upload, asyncHandler(async (req, res) => {
    res.status(202).json(await uploadBatch(req, ownerOf(req)));
  }),
);

router.use(requireAuth);

router.post('/shortcut-key', asyncHandler(async (req, res) => {
  const token = randomBytes(32).toString('hex');
  const value = JSON.stringify({ owner: ownerOf(req), hash: digest(token).toString('hex') });
  await prisma.appSetting.upsert({ where: { key: SHORTCUT_KEY }, update: { value }, create: { key: SHORTCUT_KEY, value } });
  res.status(201).json({ token });
}));

router.delete('/shortcut-key', asyncHandler(async (_req, res) => {
  await prisma.appSetting.deleteMany({ where: { key: SHORTCUT_KEY } });
  res.json({ ok: true });
}));

router.post('/', attemptLimit(20, 60_000, { countSuccess: true }), upload, asyncHandler(async (req, res) => {
  res.status(202).json(await uploadBatch(req, ownerOf(req)));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  res.json(getScreenshotCapture(ownerOf(req), captureId.parse(req.params.id)));
}));

router.post('/:id/bills', asyncHandler(async (req, res) => {
  const capture = getScreenshotCapture(ownerOf(req), captureId.parse(req.params.id));
  if (capture.status !== 'ready') throw new ApiError(409, '截图仍在识别，请稍等');
  res.json(await saveScreenshotBill(screenshotBillSchema.parse(req.body)));
}));

export default router;
