// ========== Supabase Storage Helper (REST API only, no SDK needed) ==========

const BUCKET = 'photos';
const MAX_STORAGE_MB = 900;

// Hardcoded Supabase config (service_role key - bypasses RLS for internal tool)
const SUPABASE_URL = 'https://grmofxaelrangzcbfifb.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdybW9meGFlbHJhbmd6Y2JmaWZiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTQ3MTE3MywiZXhwIjoyMDg3MDQ3MTczfQ.P_5X2Qz4M0-d1V3VL1MiYhajP9ScDnJ_xxqSuXM0tGA';

function getConfig() { return { url: SUPABASE_URL, key: SUPABASE_KEY }; }
function saveConfig() { /* no-op */ }
function isConfigured() { return true; }

// ========== Core Storage ==========

async function storageHeaders() {
    const { key } = getConfig();
    return { 'Authorization': `Bearer ${key}`, 'apikey': key };
}

function storageUrl(path) {
    return `${SUPABASE_URL}/storage/v1${path}`;
}

function getPublicUrl(filename) {
    return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${filename}`;
}

// Helper: base64 to blob
function base64ToBlob(b64, type = 'image/jpeg') {
    const bc = atob(b64);
    const ba = new Uint8Array(bc.length);
    for (let i = 0; i < bc.length; i++) ba[i] = bc.charCodeAt(i);
    return new Blob([ba], { type });
}

// Helper: upload blob (upsert)
async function uploadBlob(path, blob, contentType) {
    const headers = await storageHeaders();
    headers['Content-Type'] = contentType;
    let res = await fetch(storageUrl(`/object/${BUCKET}/${path}`), { method: 'PUT', headers, body: blob });
    if (!res.ok) res = await fetch(storageUrl(`/object/${BUCKET}/${path}`), { method: 'POST', headers, body: blob });
    return res.ok;
}

// Upload base64 JPEG image
async function uploadImage(base64Data, filename) {
    try {
        const blob = base64ToBlob(base64Data);
        const ok = await uploadBlob(filename, blob, 'image/jpeg');
        return ok ? { success: true, filename, size: blob.size } : { error: 'Upload failed' };
    } catch (e) { return { error: e.message }; }
}

// List files in bucket
async function listFiles(sortBy = 'created_at', order = 'asc') {
    try {
        const headers = await storageHeaders();
        headers['Content-Type'] = 'application/json';
        const res = await fetch(storageUrl(`/object/list/${BUCKET}`), {
            method: 'POST', headers,
            body: JSON.stringify({ prefix: '', limit: 1000, offset: 0, sortBy: { column: sortBy, order } }),
        });
        if (!res.ok) return [];
        const files = await res.json();
        return files.filter(f => f.name && !f.name.endsWith('/'));
    } catch { return []; }
}

// Delete file(s)
async function deleteFile(filename) {
    try {
        const headers = await storageHeaders();
        headers['Content-Type'] = 'application/json';
        const res = await fetch(storageUrl(`/object/${BUCKET}`), {
            method: 'DELETE', headers, body: JSON.stringify({ prefixes: [filename] }),
        });
        return res.ok;
    } catch { return false; }
}

async function deleteFiles(filenames) {
    if (filenames.length === 0) return false;
    try {
        const headers = await storageHeaders();
        headers['Content-Type'] = 'application/json';
        const res = await fetch(storageUrl(`/object/${BUCKET}`), {
            method: 'DELETE', headers, body: JSON.stringify({ prefixes: filenames }),
        });
        return res.ok;
    } catch { return false; }
}

// Storage usage
async function getStorageUsed() {
    const files = await listFiles();
    const totalBytes = files.reduce((sum, f) => sum + (f.metadata?.size || 0), 0);
    return { totalMB: totalBytes / (1024 * 1024), totalFiles: files.length, files };
}

// Auto-cleanup oldest files
async function autoCleanup(logFn = null) {
    const { totalMB, files } = await getStorageUsed();
    if (totalMB < MAX_STORAGE_MB) {
        if (logFn) logFn(`Storage: ${totalMB.toFixed(1)}MB / ${MAX_STORAGE_MB}MB — OK`);
        return 0;
    }
    if (logFn) logFn(`⚠ Storage ${totalMB.toFixed(1)}MB > ${MAX_STORAGE_MB}MB — Cleaning...`);
    // Only delete photo files, not template config
    const deletable = files.filter(f => !f.name.startsWith('_templates/')).sort((a, b) =>
        new Date(a.created_at || 0) - new Date(b.created_at || 0)
    );
    let currentMB = totalMB;
    const toDelete = [];
    for (const file of deletable) {
        if (currentMB < MAX_STORAGE_MB * 0.8) break;
        toDelete.push(file.name);
        currentMB -= (file.metadata?.size || 0) / (1024 * 1024);
    }
    if (toDelete.length > 0) {
        await deleteFiles(toDelete);
        if (logFn) logFn(`🗑 Deleted ${toDelete.length} old photos. Now ~${currentMB.toFixed(1)}MB`);
    }
    return toDelete.length;
}

// Upload with auto-cleanup
async function uploadWithCleanup(base64Data, filename, logFn = null) {
    await autoCleanup(logFn);
    const result = await uploadImage(base64Data, filename);
    if (result.success && logFn) logFn(`☁️ Uploaded: ${filename} (${(result.size / 1024).toFixed(0)}KB)`);
    if (result.error && logFn) logFn(`☁️ Upload failed: ${result.error}`);
    return result;
}

// Test connection
async function testConnection() {
    try {
        const headers = await storageHeaders();
        headers['Content-Type'] = 'application/json';
        const res = await fetch(storageUrl(`/object/list/${BUCKET}`), {
            method: 'POST', headers, body: JSON.stringify({ prefix: '', limit: 1 }),
        });
        if (res.ok) return { ok: true };
        if (res.status === 404) return { ok: false, error: `Bucket "${BUCKET}" chưa tạo` };
        return { ok: false, error: `Error: ${res.status}` };
    } catch (e) { return { ok: false, error: e.message }; }
}

// ========== Template Cloud Storage ==========
const TEMPLATE_DIR = '_templates';
const TEMPLATE_CONFIG = `${TEMPLATE_DIR}/config.json`;

// Save template config JSON (metadata only, no image data)
async function saveTemplateConfig(templateData) {
    const config = {};
    for (const [id, data] of Object.entries(templateData)) {
        config[id] = {};
        for (const k of ['name', 'prompt', 'description', 'icon', 'category', 'isCustom', 'bgColor']) {
            if (data[k] !== undefined) config[id][k] = data[k];
        }
        const refs = data.refImages || data.refImageUrls || [];
        config[id].refCount = refs.filter(r => r).length;
        config[id].hasThumbnail = !!(data.thumbnail || data.thumbnailUrl);
    }
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    return (await uploadBlob(TEMPLATE_CONFIG, blob, 'application/json')) ? { success: true } : { error: 'fail' };
}

// Load template config JSON
async function loadTemplateConfig() {
    try {
        const res = await fetch(getPublicUrl(TEMPLATE_CONFIG) + '?t=' + Date.now());
        if (!res.ok) return null;
        return await res.json();
    } catch { return null; }
}

// Save thumbnail image
async function saveTemplateThumbnail(templateId, base64Data) {
    const ok = await uploadBlob(`${TEMPLATE_DIR}/thumb_${templateId}.jpg`, base64ToBlob(base64Data), 'image/jpeg');
    return ok ? { success: true } : { error: 'fail' };
}

// Save ref images (array of base64)
async function saveTemplateRefImages(templateId, base64Images) {
    const results = [];
    for (let i = 0; i < base64Images.length; i++) {
        if (!base64Images[i]) continue;
        const ok = await uploadBlob(`${TEMPLATE_DIR}/ref_${templateId}_${i}.jpg`, base64ToBlob(base64Images[i]), 'image/jpeg');
        results.push({ index: i, ok });
    }
    return results;
}

// Delete all files for a template
async function deleteTemplateFiles(templateId) {
    const files = [`${TEMPLATE_DIR}/thumb_${templateId}.jpg`];
    for (let i = 0; i < 5; i++) files.push(`${TEMPLATE_DIR}/ref_${templateId}_${i}.jpg`);
    await deleteFiles(files);
}

// URL generators
function getTemplateThumbnailUrl(id) { return getPublicUrl(`${TEMPLATE_DIR}/thumb_${id}.jpg`); }
function getTemplateRefImageUrl(id, i) { return getPublicUrl(`${TEMPLATE_DIR}/ref_${id}_${i}.jpg`); }

// Load FULL template data (config + construct image URLs)
async function loadFullTemplateData() {
    const config = await loadTemplateConfig();
    if (!config) return null;
    const result = {};
    for (const [id, data] of Object.entries(config)) {
        result[id] = { ...data };
        if (data.hasThumbnail) result[id].thumbnailUrl = getTemplateThumbnailUrl(id);
        if (data.refCount > 0) {
            result[id].refImageUrls = [];
            for (let i = 0; i < data.refCount; i++) result[id].refImageUrls.push(getTemplateRefImageUrl(id, i));
        }
    }
    return result;
}

// Fetch image URL as base64 (for Gemini API)
async function fetchImageBase64(url) {
    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const blob = await res.blob();
        return new Promise(resolve => {
            const r = new FileReader();
            r.onload = () => resolve(r.result.split(',')[1]);
            r.onerror = () => resolve(null);
            r.readAsDataURL(blob);
        });
    } catch { return null; }
}

// Fetch all ref images for a template as base64
async function fetchRefImagesBase64(templateId, count) {
    const promises = [];
    for (let i = 0; i < count; i++) promises.push(fetchImageBase64(getTemplateRefImageUrl(templateId, i)));
    return (await Promise.all(promises)).filter(r => r);
}

export {
    getConfig, saveConfig, isConfigured,
    uploadImage, uploadWithCleanup,
    listFiles, deleteFile, deleteFiles,
    getPublicUrl, getStorageUsed, autoCleanup, testConnection,
    saveTemplateConfig, loadTemplateConfig, saveTemplateThumbnail,
    saveTemplateRefImages, deleteTemplateFiles,
    getTemplateThumbnailUrl, getTemplateRefImageUrl,
    loadFullTemplateData, fetchImageBase64, fetchRefImagesBase64,
    BUCKET, MAX_STORAGE_MB,
};
