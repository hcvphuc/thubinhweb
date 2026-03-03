// ========== IndexedDB for ThuBinh Studio ==========
// Stores: template_data (all template customizations, custom templates, thumbnails, ref images)
const DB_NAME = 'thubinh_studio';
const DB_VERSION = 2;
const STORE_NAME = 'template_data';

function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            // Create new unified store
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
        };
    });
}

/**
 * Save template data (merge with existing)
 * Used for: custom prompts, ref images, thumbnails, custom templates
 * @param {string} id - Template ID
 * @param {Object} data - Partial data to merge
 */
export async function saveTemplateData(id, data) {
    const db = await openDB();
    // Get existing data first to merge
    const existing = await getTemplateData(id);
    const merged = { ...(existing || {}), ...data, id, updatedAt: Date.now() };
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(merged);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Get data for a single template
 */
export async function getTemplateData(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    });
}

/**
 * Get all template data as a map { id: data }
 */
export async function getAllTemplateData() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).getAll();
        req.onsuccess = () => {
            const map = {};
            (req.result || []).forEach(item => { map[item.id] = item; });
            resolve(map);
        };
        req.onerror = () => reject(req.error);
    });
}

/**
 * Delete template data
 */
export async function deleteTemplateData(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Migrate old template_refs store data to new template_data store
 * Call once on app init - safely does nothing if old store doesn't exist
 */
export async function migrateOldRefs() {
    const db = await openDB();
    if (!db.objectStoreNames.contains('template_refs')) return {};
    return new Promise((resolve) => {
        try {
            const tx = db.transaction('template_refs', 'readonly');
            const req = tx.objectStore('template_refs').getAll();
            req.onsuccess = () => {
                const migrated = {};
                (req.result || []).forEach(item => {
                    if (item.images && item.images.length > 0) {
                        migrated[item.id] = item.images;
                    }
                });
                resolve(migrated);
            };
            req.onerror = () => resolve({});
        } catch {
            resolve({});
        }
    });
}
