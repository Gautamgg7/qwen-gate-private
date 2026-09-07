import crypto from 'node:crypto';
import { getTokenWithAccount } from './auth.ts';
import { browserlessFetch } from './browserlessFetch.ts';
import { logStore } from './logStore.ts';
import { QWEN_API_BASE } from './qwen.ts';

/**
 * Character limit enforced by Qwen on message content.
 * When a message exceeds this, it must be uploaded as a file instead.
 * Source: Qwen web UI error message — "more than 131072 characters".
 */
export const QWEN_CONTENT_CHAR_LIMIT = 131_072;

// --- Types ---

interface StsTokenResponse {
  access_key_id: string;
  access_key_secret: string;
  security_token: string;
  bucketname: string;
  region: string;
  endpoint: string;
  file_id: string;
  file_path: string;
  file_url: string;
}

/**
 * Qwen web UI file attachment format — exact structure from browser HAR capture.
 * The web UI sends this complex nested object in messages[].files[].
 */
export interface QwenFileAttachment {
  type: string;
  file: {
    created_at: number;
    data: Record<string, unknown>;
    filename: string;
    hash: string | null;
    id: string;
    user_id: string;
    meta: {
      name: string;
      size: number;
      content_type: string;
      parse_meta?: { parse_status: string };
    };
    update_at: number;
    lastModified: number;
    name: string;
    webkitRelativePath: string;
    size: number;
    type: string; // MIME type
  };
  id: string;
  url: string;
  name: string;
  collection_name: string;
  progress: number;
  status: string;
  greenNet: string;
  size: number;
  error: string;
  itemId: string;
  file_type: string;
  showType: string;
  file_class: string;
  uploadTaskId: string;
}

// --- Step 1: Get STS credentials for OSS upload ---

async function getstsToken(email: string, filename: string, filesize: number, filetype: string = 'file'): Promise<StsTokenResponse> {
  const url = `${QWEN_API_BASE}/api/v2/files/getstsToken`;
  const body = JSON.stringify({
    filename,
    filesize: String(filesize),
    filetype,
  });

  const tokenInfo = await getTokenWithAccount(email);
  const cookieStr = tokenInfo ? `token=${tokenInfo.token}` : '';
  const response = await browserlessFetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/plain, */*',
      source: 'web',
      cookie: cookieStr,
      origin: QWEN_API_BASE,
    },
    body,
    accountEmail: email,
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`getstsToken failed: ${response.status} — ${errText.substring(0, 200)}`);
  }
  const resText = await response.text();
  const resData = JSON.parse(resText);
  if (!resData.data) {
    throw new Error(`getstsToken returned unexpected response: ${resText.substring(0, 200)}`);
  }
  return resData.data;
}

// --- Step 2: Upload file content to Alibaba Cloud OSS ---

function hmacSha1Base64(key: string, message: string): string {
  return crypto.createHmac('sha1', key).update(message).digest('base64');
}

function buildOssCanonicalRequest(
  method: string,
  contentType: string,
  date: string,
  securityToken: string,
  bucket: string,
  key: string,
): string {
  return [
    method,
    '', // Content-MD5 (empty)
    contentType,
    date, // Date header
    `x-oss-security-token:${securityToken}`,
    `/${bucket}/${key}`,
  ].join('\n');
}

async function uploadToOss(sts: StsTokenResponse, fileContent: Buffer, contentType: string): Promise<string> {
  const date = new Date().toUTCString();
  const key = sts.file_path;

  // file_path may or may not include the bucket prefix.
  // CanonicalizedResource = /{bucket}/{objectKey} where objectKey is WITHOUT the bucket prefix.
  // If file_path starts with bucket name + '/', strip it to get the object key.
  let objectKey = key;
  const bucketPrefix = `${sts.bucketname}/`;
  if (objectKey.startsWith(bucketPrefix)) {
    objectKey = objectKey.substring(bucketPrefix.length);
  }

  logStore.log(
    'debug',
    'upload',
    `[FileUpload] OSS upload — endpoint=${sts.endpoint}, bucket=${sts.bucketname}, key=${key}, objectKey=${objectKey}`,
  );

  const canonicalRequest = buildOssCanonicalRequest('PUT', contentType, date, sts.security_token, sts.bucketname, objectKey);

  logStore.log('debug', 'upload', `[FileUpload] OSS canonical request:\n${canonicalRequest}`);

  const signature = hmacSha1Base64(sts.access_key_secret, canonicalRequest);

  // Build OSS endpoint URL: https://{bucket}.{endpoint}/{objectKey}
  let endpoint = sts.endpoint.replace(/\/+$/, '');
  if (!endpoint.includes(sts.bucketname)) {
    endpoint = `https://${sts.bucketname}.${endpoint.replace(/^https?:\/\//, '')}`;
  }
  const uploadUrl = `${endpoint}/${objectKey}`;

  logStore.log('debug', 'upload', `[FileUpload] OSS upload URL: ${uploadUrl}`);

  const authHeader = `OSS ${sts.access_key_id}:${signature}`;

  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      Date: date,
      Authorization: authHeader,
      'x-oss-security-token': sts.security_token,
    },
    body: fileContent as any,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`OSS upload failed: ${response.status} ${response.statusText} — ${errText.substring(0, 200)}`);
  }

  return sts.file_url;
}

// --- Step 3: Trigger server-side file parsing ---

async function parseFile(email: string, fileId: string): Promise<void> {
  const url = `${QWEN_API_BASE}/api/v2/files/parse`;
  const body = JSON.stringify({ file_id: fileId });

  const tokenInfo = await getTokenWithAccount(email);
  const cookieStr = tokenInfo ? `token=${tokenInfo.token}` : '';

  // Retry parse trigger up to 3 times — Qwen's /files/parse endpoint is flaky
  // and sometimes times out (30s) on first call, then succeeds in <1s on retry.
  // Use a longer per-attempt timeout (60s) so transient upstream slowness is tolerated.
  const PARSE_MAX_RETRIES = 3;
  const PARSE_ATTEMPT_TIMEOUT_MS = 60_000;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < PARSE_MAX_RETRIES; attempt++) {
    const attemptController = new AbortController();
    const attemptTimer = setTimeout(() => attemptController.abort(new Error(`parseFile attempt ${attempt + 1} timed out`)), PARSE_ATTEMPT_TIMEOUT_MS);
    try {
      const response = await browserlessFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/plain, */*',
          source: 'web',
          cookie: cookieStr,
          origin: QWEN_API_BASE,
        },
        body,
        accountEmail: email,
        signal: attemptController.signal,
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`parseFile failed: ${response.status} — ${errText.substring(0, 200)}`);
      }
      // Success — drain body so the connection can be reused
      await response.text().catch(() => {});
      clearTimeout(attemptTimer);
      return;
    } catch (err: any) {
      clearTimeout(attemptTimer);
      lastErr = err instanceof Error ? err : new Error(String(err));
      // If it was an AbortError (timeout) and we have retries left, retry
      const isAbort = err?.name === 'AbortError' || /timeout|aborted/i.test(err?.message || '');
      if (!isAbort || attempt === PARSE_MAX_RETRIES - 1) {
        throw lastErr;
      }
      // Brief backoff before retry (500ms, 1s, 2s)
      await Bun.sleep(500 * Math.pow(2, attempt));
      logStore.log('warn', 'upload', `[FileUpload] parseFile retry ${attempt + 2}/${PARSE_MAX_RETRIES} for ${fileId} after: ${lastErr.message}`);
    }
  }
  if (lastErr) throw lastErr;
}

// --- Step 4: Poll parse status until complete ---

interface ParseStatusResponse {
  file_id: string;
  status: 'running' | 'success' | 'failed';
}

async function pollParseStatus(email: string, fileId: string, maxWaitMs = 10_000, fileSize = 0): Promise<void> {
  const url = `${QWEN_API_BASE}/api/v2/files/parse/status`;
  const startTime = Date.now();
  const pollInterval = 1_000;

  // Adaptive wait: large context files take longer to parse on Qwen's side.
  // A fixed 5s floor was too short for multi-hundred-KB files (the model was
  // called before parsing finished, which correlates with empty responses).
  // Bumped max from 30s → 90s and floor from 5s → 10s — large 100KB+ uploads
  // routinely took 40-60s to flip to "success" under load.
  const adaptiveMs = Math.min(90_000, Math.max(maxWaitMs, Math.round((fileSize / 20_000) * 1000)));

  let lastStatus: string = '';
  let successConfirmed = false;

  while (Date.now() - startTime < adaptiveMs) {
    const body = JSON.stringify({ file_id_list: [fileId] });

    const tokenInfo = await getTokenWithAccount(email);
    const cookieStr = tokenInfo ? `token=${tokenInfo.token}` : '';
    const response = await browserlessFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/plain, */*',
        source: 'web',
        cookie: cookieStr,
        origin: QWEN_API_BASE,
      },
      body,
      accountEmail: email,
    });
    if (response.ok) {
      try {
        const resText = await response.text();
        const data = JSON.parse(resText);
        const status: string = data.data?.[0]?.status || data.status || '';
        if (status === 'success') {
          logStore.log('debug', 'upload', `[FileUpload] Parse complete for ${fileId} in ${Date.now() - startTime}ms`);
          successConfirmed = true;
          return;
        }
        if (status === 'failed') throw new Error(`File parsing failed for ${fileId}`);
        lastStatus = status || lastStatus;
      } catch (parseErr) {
        // JSON parse error or missing field — keep polling unless the parse
        // explicitly returned "failed" (handled above)
        if (parseErr instanceof Error && /File parsing failed/.test(parseErr.message)) throw parseErr;
      }
    }

    await Bun.sleep(pollInterval);
  }

  // ponytail: file upload succeeded, parse may still finish async.
  // Qwen will include the file content once parsing completes on its side.
  // NOTE: We do NOT throw — the previous behavior of silently continuing is correct:
  // the file IS uploaded, and Qwen's chat endpoint can sometimes pick it up after a
  // short delay. We just log a warning.
  logStore.log(
    'warn',
    'upload',
    `[FileUpload] Parse poll timed out after ${Date.now() - startTime}ms for ${fileId} (status=${lastStatus || 'unknown'}, was waiting up to ${adaptiveMs}ms) — continuing, parse may finish async`,
  );
}

// --- Shared internal: upload arbitrary file content ---

/**
 * Upload arbitrary content (buffer) as a file to Qwen's file system.
 * Runs the full 4-step pipeline: STS token -> OSS upload -> parse trigger -> poll status.
 */
async function uploadFileContent(
  email: string,
  buffer: Buffer,
  fileName: string,
  contentType: string,
  fileClass: string,
  showType: string,
  filetype: string = 'file',
  attachmentType: string = 'file',
): Promise<QwenFileAttachment> {
  const fileSize = buffer.length;

  logStore.log('debug', 'upload', `[FileUpload] Uploading ${fileSize} bytes as "${fileName}" (${contentType}) for ${email}`);

  // Step 1: Get STS credentials
  const sts = await getstsToken(email, fileName, fileSize, filetype);
  logStore.log(
    'debug',
    'upload',
    `[FileUpload] Got STS token — bucket=${sts.bucketname}, file_id=${sts.file_id}, file_url=${sts.file_url}, endpoint=${sts.endpoint}, file_path=${sts.file_path}`,
  );

  // Step 2: Upload to OSS
  const fileUrl = await uploadToOss(sts, buffer, contentType);
  logStore.log('debug', 'upload', `[FileUpload] Uploaded to OSS — url=${fileUrl.substring(0, 80)}...`);

  // Images don't need server-side parsing — Qwen processes them directly from OSS
  if (attachmentType === 'file') {
    // Step 3: Trigger parsing
    await parseFile(email, sts.file_id);
    logStore.log('debug', 'upload', `[FileUpload] Parse triggered for ${sts.file_id}`);

    // Step 4: Poll until parsed (adaptive wait based on file size)
    await pollParseStatus(email, sts.file_id, 10_000, fileSize);
    logStore.log('debug', 'upload', `[FileUpload] Parse complete for ${sts.file_id}`);
  }

  return buildQwenFileAttachment(sts, fileName, fileSize, contentType, fileClass, showType, attachmentType);
}

// --- Orchestrator: upload large text as a Qwen file attachment ---

/**
 * Build the exact file attachment object matching Qwen web UI format.
 * Extracts user_id from file_path (format: "<user_id>/<file_id>_<filename>").
 */
function buildQwenFileAttachment(
  sts: StsTokenResponse,
  fileName: string,
  fileSize: number,
  contentType: string,
  fileClass: string,
  showType: string,
  attachmentType: string = 'file',
): QwenFileAttachment {
  // Extract user_id from file_path: "5309db52-.../370e7cdc-..._filename" → first segment
  const userId = sts.file_path.split('/')[0] || '';
  const now = Date.now();

  const meta: QwenFileAttachment['file']['meta'] = {
    name: fileName,
    size: fileSize,
    content_type: contentType,
    ...(attachmentType === 'file' ? { parse_meta: { parse_status: 'success' as const } } : {}),
  };

  return {
    type: attachmentType,
    file: {
      created_at: now,
      data: {},
      filename: fileName,
      hash: null,
      id: sts.file_id,
      user_id: userId,
      meta,
      update_at: now,
      lastModified: now,
      name: fileName,
      webkitRelativePath: '',
      size: fileSize,
      type: contentType,
    },
    id: sts.file_id,
    url: sts.file_url,
    name: fileName,
    collection_name: '',
    progress: 0,
    status: 'uploaded',
    greenNet: 'success',
    size: fileSize,
    error: '',
    itemId: crypto.randomUUID(),
    file_type: contentType,
    showType,
    file_class: fileClass,
    uploadTaskId: crypto.randomUUID(),
  };
}

export async function uploadLargeTextAsFile(email: string, text: string, fileName: string): Promise<QwenFileAttachment> {
  const encoder = new TextEncoder();
  const content = encoder.encode(text);
  const contentType = 'text/plain';

  // B3: Content-hash reuse — if the exact same blob was uploaded to this
  // account before, reuse the cached attachment instead of re-uploading.
  // Agents re-send the same conversation history every turn, so this saves
  // 4+ RTTs (STS + OSS upload + parse + parse-status poll) per repeated turn.
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const cacheKey = `${email.toLowerCase().trim()}::${hash}`;
  const cached = contextFileCache.get(cacheKey);
  if (cached && Date.now() - cached.createdAt < CONTEXT_FILE_CACHE_TTL_MS) {
    return cached.attachment;
  }

  const attachment = await uploadFileContent(email, Buffer.from(content), fileName, contentType, 'document', 'file');

  // Cache with size cap (LRU-style: oldest entry evicted)
  if (contextFileCache.size >= CONTEXT_FILE_CACHE_MAX) {
    let oldestKey: string | undefined;
    let oldestTs = Number.POSITIVE_INFINITY;
    for (const [k, v] of contextFileCache) {
      if (v.createdAt < oldestTs) {
        oldestTs = v.createdAt;
        oldestKey = k;
      }
    }
    if (oldestKey) contextFileCache.delete(oldestKey);
  }
  contextFileCache.set(cacheKey, { attachment, createdAt: Date.now() });

  return attachment;
}

/** Per-account content-hash cache for context.txt uploads (B3). */
const contextFileCache = new Map<string, { attachment: QwenFileAttachment; createdAt: number }>();
const CONTEXT_FILE_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CONTEXT_FILE_CACHE_MAX = 50;

/**
 * Download an image (data URI or remote URL) and upload it to Qwen's file system.
 * Returns a QwenFileAttachment ready to attach to messages.
 */
export async function uploadImageAsFile(email: string, imageUrl: string): Promise<QwenFileAttachment> {
  let buffer: Buffer;
  let mimeType: string;
  let fileName: string;

  if (imageUrl.startsWith('data:')) {
    // Data URI: data:image/png;base64,iVBOR...
    const match = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) throw new Error('Invalid data URI format');
    mimeType = match[1];
    buffer = Buffer.from(match[2], 'base64');
    fileName = `image.${mimeType.split('/')[1] || 'png'}`;
  } else {
    // Remote URL — fetch with timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(imageUrl, { signal: controller.signal });
      if (!response.ok) throw new Error(`Failed to download image: ${response.status}`);
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) throw new Error(`Not an image: ${contentType}`);
      const arrayBuffer = await response.arrayBuffer();
      buffer = Buffer.from(arrayBuffer);
      mimeType = contentType;
      fileName = `image.${mimeType.split('/')[1] || 'png'}`;
    } finally {
      clearTimeout(timeout);
    }
  }

  // Reject images over 10MB
  if (buffer.length > 10 * 1024 * 1024) {
    throw new Error(`Image too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB (max 10MB)`);
  }

  return uploadFileContent(email, buffer, fileName, mimeType, 'vision', 'image', 'image', 'image');
}
