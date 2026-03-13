import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import './App.css';
import { saveTemplateData, getAllTemplateData, deleteTemplateData, migrateOldRefs } from './db.js';
import { validateFaceAnatomy } from './FaceQC.js';
import { validateRestoration } from './RestoreQC.js';
import { compareFaces, preloadFaceCompare } from './FaceCompare.js';
import * as supa from './supabaseStorage.js';

// ========== HELPER: Read file as base64 ==========
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = dataUrl.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ========== HELPER: Compress base64 image for API (resize + JPEG quality) ==========
function compressBase64Image(base64, maxSize = 1024, quality = 0.8) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      // Resize if larger than maxSize
      if (width > maxSize || height > maxSize) {
        const ratio = Math.min(maxSize / width, maxSize / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      const compressed = canvas.toDataURL('image/jpeg', quality).split(',')[1];
      resolve(compressed);
    };
    img.onerror = () => resolve(base64); // Fallback to original on error
    img.src = `data:image/jpeg;base64,${base64}`;
  });
}

// ========== HELPER: Fetch with timeout + auto-retry on 503/429/500/449 ==========
async function fetchWithRetry(url, options, maxRetries = 3, logFn = null) {
  const RETRY_DELAY = 15000; // 15s between retries
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000); // 180s timeout
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) return res;
      // Retry on server overload / rate limit errors
      if ([503, 429, 500, 449, 502, 504].includes(res.status) && attempt < maxRetries) {
        if (logFn) logFn(`⏳ API lỗi ${res.status} — chờ 15s rồi thử lại (${attempt}/${maxRetries})...`);
        // Countdown timer in logs
        for (let s = 15; s > 0; s--) {
          await new Promise(r => setTimeout(r, 1000));
          if (logFn && s % 5 === 0) logFn(`⏳ Thử lại sau ${s}s...`);
        }
        continue;
      }
      throw new Error(`API: ${res.status}${attempt > 1 ? ` (sau ${attempt} lần thử)` : ''}`);
    } catch (e) {
      clearTimeout(timeout);
      if (e.name === 'AbortError') {
        if (attempt < maxRetries) {
          if (logFn) logFn(`⏳ Timeout — chờ 15s rồi thử lại (${attempt}/${maxRetries})...`);
          await new Promise(r => setTimeout(r, RETRY_DELAY));
          continue;
        }
        throw new Error('Request timeout (180s) — API quá chậm. Thử lại sau.');
      }
      // Network error — also retry
      if (attempt < maxRetries && (e.message.includes('Failed to fetch') || e.message.includes('NetworkError') || e.message.includes('network'))) {
        if (logFn) logFn(`⏳ Lỗi mạng: ${e.message} — chờ 15s rồi thử lại (${attempt}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY));
        continue;
      }
      throw e;
    }
  }
}

// ========== HELPER: Download base64 image (converts to JPEG for compatibility) ==========
function downloadBase64(base64Data, mimeType, filename) {
  // Convert to JPEG for Photoshop compatibility (PS7 can't read WebP/modern PNG)
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    // White background (JPEG doesn't support transparency)
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    // Convert to JPEG 95% quality
    const jpegUrl = canvas.toDataURL('image/jpeg', 0.95);
    const link = document.createElement('a');
    link.href = jpegUrl;
    link.download = (filename || `thubinh_${Date.now()}`).replace(/\.\w+$/, '.jpg');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };
  img.onerror = () => {
    // Fallback: download as-is if conversion fails
    const link = document.createElement('a');
    link.href = `data:${mimeType};base64,${base64Data}`;
    link.download = filename || `thubinh_${Date.now()}.jpg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };
  img.src = `data:${mimeType};base64,${base64Data}`;
}

// ========== HELPER: Extract image from Gemini response ==========
function extractImage(data) {
  if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) {
    for (let i = 0; i < data.candidates[0].content.parts.length; i++) {
      const part = data.candidates[0].content.parts[i];
      if (part.inlineData && part.inlineData.data) {
        return part.inlineData;
      }
    }
  }
  return null;
}

// ========== HELPER: Extract text from Gemini response ==========
function extractText(data) {
  if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) {
    for (let i = 0; i < data.candidates[0].content.parts.length; i++) {
      if (data.candidates[0].content.parts[i].text) {
        return data.candidates[0].content.parts[i].text;
      }
    }
  }
  return '';
}

// ========== DEFAULT TEMPLATES ==========
const DEFAULT_TEMPLATES = [
  { id: 'baby_studio_mai', name: 'Studio Hoa Mai', icon: '🌼', bgColor: 'linear-gradient(135deg, #f9a825, #fff176)', category: 'baby', description: 'Set studio với cành mai vàng lớn, gối nhung đỏ, ánh sáng ấm', prompt: 'Studio set with large yellow apricot blossom branches (hoa mai), red velvet cushions, warm golden lighting, polished wooden floor, soft bokeh. No text, no banners, no logos, no numbers, no watermarks.' },
  { id: 'baby_studio_lantern', name: 'Studio Đèn Lồng', icon: '🏮', bgColor: 'linear-gradient(135deg, #c62828, #ef5350)', category: 'baby', description: 'Set đèn lồng đỏ treo lơ lửng, nền nhung đỏ, ánh sáng mềm', prompt: 'Studio set with red silk lanterns hanging at different heights, red velvet backdrop, soft diffused lighting, scattered flower petals on floor, dreamy bokeh. No text, no banners, no logos, no numbers, no watermarks.' },
  { id: 'baby_studio_peach', name: 'Studio Hoa Đào', icon: '🌸', bgColor: 'linear-gradient(135deg, #f48fb1, #fce4ec)', category: 'baby', description: 'Cành đào hồng, sàn gỗ, backdrop pastel mềm mại', prompt: 'Studio set with pink peach blossom branches, soft pastel pink and cream backdrop, warm lighting, light wooden floor with scattered pink petals, gentle dreamy atmosphere. No text, no banners, no logos, no numbers, no watermarks.' },
  { id: 'baby_studio_golden', name: 'Studio Vàng Son', icon: '✨', bgColor: 'linear-gradient(135deg, #ff8f00, #ffe082)', category: 'baby', description: 'Background vàng ánh kim, đạo cụ vàng, bokeh lung linh', prompt: 'Studio set with shimmering gold fabric backdrop, golden decorative props and silk ribbons, beautiful golden bokeh lights, warm amber lighting, polished reflective floor. No text, no banners, no logos, no numbers, no watermarks.' },
  { id: 'baby_studio_garden', name: 'Studio Vườn Xuân', icon: '🪴', bgColor: 'linear-gradient(135deg, #66bb6a, #c8e6c9)', category: 'baby', description: 'Set vườn mini, cây kumquat, hoa cúc, thảm cỏ xanh', prompt: 'Studio set with miniature spring garden, small kumquat tree with orange fruits, yellow chrysanthemum flowers, green grass carpet, bright natural lighting, fresh cheerful atmosphere. No text, no banners, no logos, no numbers, no watermarks.' },
  { id: 'family_studio_classic', name: 'Studio Cổ Điển', icon: '🎭', bgColor: 'linear-gradient(135deg, #b71c1c, #d32f2f)', category: 'family', description: 'Backdrop đỏ sang trọng, ghế sofa cổ điển', prompt: 'Studio set with deep red velvet backdrop, classic vintage sofa, professional studio lighting with rim light, red and gold color palette, silk tassels and embroidered cushions, formal portrait atmosphere. No text, no banners, no logos, no numbers, no watermarks.' },
  { id: 'family_studio_blossom', name: 'Studio Hoa Xuân', icon: '💐', bgColor: 'linear-gradient(135deg, #e91e63, #ffd54f)', category: 'family', description: 'Set hoa đào + hoa mai hỗn hợp, thảm đỏ', prompt: 'Studio set with mixed pink peach blossoms and yellow apricot blossoms, red carpet, warm red-to-gold gradient backdrop, elegant studio lighting highlighting flowers, spacious for group photo. No text, no banners, no logos, no numbers, no watermarks.' },
  { id: 'family_studio_elegant', name: 'Studio Thanh Lịch', icon: '🪞', bgColor: 'linear-gradient(135deg, #e0e0e0, #fafafa)', category: 'family', description: 'Nền trắng ngà, rèm voan mỏng, tối giản sang trọng', prompt: 'Minimalist studio with ivory white backdrop, sheer voile curtains, subtle red and gold flower accents, soft diffused lighting, clean sophisticated atmosphere, modern luxury aesthetic. No text, no banners, no logos, no numbers, no watermarks.' },
  { id: 'family_studio_warm', name: 'Studio Ấm Áp', icon: '🕯️', bgColor: 'linear-gradient(135deg, #795548, #d7ccc8)', category: 'family', description: 'Set phòng khách ấm cúng, ánh nến, fairy lights', prompt: 'Cozy studio set with warm brown and cream tones, fairy string lights with soft bokeh, decorative candles, plush cushions, wooden props and ceramic vases with spring flowers, intimate warm atmosphere. No text, no banners, no logos, no numbers, no watermarks.' },
  { id: 'family_studio_royal', name: 'Studio Hoàng Gia', icon: '👑', bgColor: 'linear-gradient(135deg, #4a148c, #ce93d8)', category: 'family', description: 'Backdrop nhung đỏ đậm, khung tranh vàng, trụ đá cẩm thạch', prompt: 'Grand royal studio set with dark burgundy velvet draping, ornate golden picture frames, marble columns, dramatic studio lighting with strong key light and moody shadows, opulent majestic atmosphere. No text, no banners, no logos, no numbers, no watermarks.' },
];

const ASPECT_RATIOS = [
  { id: '1:1', label: '1:1' },
  { id: '2:3', label: '2:3' },
  { id: '3:2', label: '3:2' },
  { id: '3:4', label: '3:4' },
  { id: '4:3', label: '4:3' },
  { id: '16:9', label: '16:9' },
  { id: '9:16', label: '9:16' },
];

const PRICING = {
  textInput: 2.00 / 1000000,
  textOutput: 12.00 / 1000000,
  image: 0.134,
};

function App() {
  // Core state
  const [key, setKey] = useState(localStorage.getItem('gemini_key') || '');
  const [keyValid, setKeyValid] = useState(null);
  const [status, setStatus] = useState('Sẵn sàng');
  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState([]);
  const [activeTab, setActiveTab] = useState('edit');

  // Result
  const [resultImage, setResultImage] = useState(null); // { data, mimeType }

  // Edit tab
  const [editImage, setEditImage] = useState('');
  const [userPrompt, setUserPrompt] = useState('');
  const [refinedPrompt, setRefinedPrompt] = useState('');
  const [editAspectRatio, setEditAspectRatio] = useState('1:1');

  // Composite tab
  const [bgImage, setBgImage] = useState('');
  const [subjectImage, setSubjectImage] = useState('');
  const [compositePrompt, setCompositePrompt] = useState('');
  const [compositeAspectRatio, setCompositeAspectRatio] = useState('1:1');
  const [optKeepFace, setOptKeepFace] = useState(true);
  const [optKeepPose, setOptKeepPose] = useState(true);
  const [optMatchLight, setOptMatchLight] = useState(true);

  // Template tab
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [templateSubjectImage, setTemplateSubjectImage] = useState('');
  const [templateAspectRatio, setTemplateAspectRatio] = useState('3:4');
  const [templateData, setTemplateData] = useState({}); // { templateId: { prompt, refImages, thumbnail, isCustom, name, ... } }
  const [editingTemplate, setEditingTemplate] = useState(null); // template being edited
  const [editForm, setEditForm] = useState({ name: '', prompt: '', description: '', icon: '', category: '' });
  const templateRefFileRef = useRef(null);
  const [refUploadTarget, setRefUploadTarget] = useState(null);

  // Upscale tab
  const [upscaleImage, setUpscaleImage] = useState('');

  // Face Swap tab
  const [faceRefImage, setFaceRefImage] = useState('');
  const [faceTargetImage, setFaceTargetImage] = useState('');

  // Restore tab
  const [restoreImage, setRestoreImage] = useState('');
  const [restoreDamageLevel, setRestoreDamageLevel] = useState(2);
  const [restoreCustomPrompt, setRestoreCustomPrompt] = useState('');
  const [restoreScores, setRestoreScores] = useState(null);
  const [restoreAttempts, setRestoreAttempts] = useState([]); // { attempt, imgData, mimeType, scores, avgScore, passed }

  // Batch tab
  const [batchFiles, setBatchFiles] = useState([]); // File objects
  const [batchMode, setBatchMode] = useState('composite'); // 'composite' or 'template'
  const [batchBgImage, setBatchBgImage] = useState('');
  const [batchSelectedTemplate, setBatchSelectedTemplate] = useState(null);
  const [batchPrompt, setBatchPrompt] = useState('');
  const [batchAspectRatio, setBatchAspectRatio] = useState('1:1');
  const [batchOptKeepFace, setBatchOptKeepFace] = useState(true);
  const [batchOptKeepPose, setBatchOptKeepPose] = useState(true);
  const [batchOptMatchLight, setBatchOptMatchLight] = useState(true);
  const [enableQC, setEnableQC] = useState(false); // QC mặc định TẮT cho nhanh
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0, running: false });
  const [batchResults, setBatchResults] = useState([]); // { fileName, status, message, imageData, mimeType }

  // Cost tracking
  const [costs, setCosts] = useState({ textInputTokens: 0, textOutputTokens: 0, imageCount: 0 });

  // Refs for file inputs
  const editFileRef = useRef(null);
  const bgFileRef = useRef(null);
  const subjectFileRef = useRef(null);
  const templateFileRef = useRef(null);
  const upscaleFileRef = useRef(null);
  const faceRefFileRef = useRef(null);
  const faceTargetFileRef = useRef(null);
  const batchFileRef = useRef(null);
  const batchBgFileRef = useRef(null);
  const restoreFileRef = useRef(null);

  // Logs toggle
  const [showLogs, setShowLogs] = useState(false);

  // Gallery (Library)
  const [galleryFiles, setGalleryFiles] = useState([]);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [galleryFilter, setGalleryFilter] = useState('all');
  const [galleryPreview, setGalleryPreview] = useState(null); // URL for lightbox

  // Supabase Storage
  const [supaStorageInfo, setSupaStorageInfo] = useState(null); // { totalMB, totalFiles }

  // Auto-upload to Supabase after image generation
  const autoUploadToSupabase = useCallback(async (imageData, mimeType, prefix = 'thubinh') => {
    if (!supa.isConfigured()) return;
    try {
      // Convert to JPEG via canvas for consistency
      const filename = `${prefix}_${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.jpg`;
      // Compress to reasonable size for storage
      const compressed = await compressBase64Image(imageData, 2048, 0.9);
      await supa.uploadWithCleanup(compressed, filename, addLog);
      // Update storage info
      const info = await supa.getStorageUsed();
      setSupaStorageInfo({ totalMB: info.totalMB, totalFiles: info.totalFiles });
    } catch (e) {
      addLog(`☁️ Upload error: ${e.message}`);
    }
  }, []);

  // ========== Load template data from cloud (primary) + IndexedDB (fallback + auto-migrate) ==========
  useEffect(() => {
    (async () => {
      try {
        // 1. Try cloud first
        const cloudData = await supa.loadFullTemplateData();
        if (cloudData && Object.keys(cloudData).length > 0) {
          setTemplateData(cloudData);
          console.log(`☁️ Loaded ${Object.keys(cloudData).length} templates from cloud`);
          return; // Cloud has data, done
        }
      } catch (e) {
        console.warn('Cloud load error:', e);
      }

      // 2. Cloud empty → load from IndexedDB
      try {
        const data = await getAllTemplateData();
        const oldRefs = await migrateOldRefs();
        if (Object.keys(oldRefs).length > 0) {
          for (const [id, images] of Object.entries(oldRefs)) {
            if (!data[id]) data[id] = {};
            if (!data[id].refImages) {
              data[id].refImages = images;
              await saveTemplateData(id, { refImages: images });
            }
          }
        }
        setTemplateData(data);
        const count = Object.keys(data).length;
        if (count > 0) {
          console.log(`📦 Loaded ${count} templates from IndexedDB`);
          // 3. Auto-migrate to cloud!
          console.log('☁️ Migrating templates to cloud...');
          for (const [id, d] of Object.entries(data)) {
            // Upload thumbnail
            if (d.thumbnail) {
              try {
                await supa.saveTemplateThumbnail(id, d.thumbnail);
                console.log(`☁️ Thumb ${id}: OK`);
              } catch (e) { console.warn(`Thumb ${id}: FAIL`, e); }
            }
            // Upload ref images
            if (d.refImages && d.refImages.length > 0) {
              try {
                await supa.saveTemplateRefImages(id, d.refImages);
                console.log(`☁️ Refs ${id}: OK (${d.refImages.length})`);
              } catch (e) { console.warn(`Refs ${id}: FAIL`, e); }
            }
          }
          // Upload config
          await supa.saveTemplateConfig(data);
          console.log('☁️ Migration complete!');
        }
      } catch (err) {
        console.warn('IndexedDB load error:', err);
      }
    })();
  }, []);

  // Auto-load Supabase storage info on mount
  useEffect(() => {
    supa.getStorageUsed().then(info => {
      setSupaStorageInfo({ totalMB: info.totalMB, totalFiles: info.totalFiles });
    }).catch(() => { });
  }, []);

  // ========== Merged template list ==========
  // Helper: detect URL vs base64
  const isUrl = (s) => s && (s.startsWith('http://') || s.startsWith('https://'));
  const getImgSrc = (data) => isUrl(data) ? data : `data:image/jpeg;base64,${data}`;

  const allTemplates = useMemo(() => {
    const merged = DEFAULT_TEMPLATES.map(t => {
      const d = templateData[t.id];
      if (!d) return { ...t, refImages: [], refImageUrls: [], thumbnail: null, thumbnailUrl: null };
      return {
        ...t,
        name: d.name || t.name,
        prompt: d.prompt || t.prompt,
        description: d.description || t.description,
        icon: d.icon || t.icon,
        thumbnail: d.thumbnail || null,
        thumbnailUrl: d.thumbnailUrl || null,
        refImages: d.refImages || [],
        refImageUrls: d.refImageUrls || [],
        refCount: d.refCount || (d.refImages || []).length || (d.refImageUrls || []).length,
      };
    });
    // Add custom templates
    Object.entries(templateData).forEach(([key, d]) => {
      if (d.isCustom && !merged.find(t => t.id === key)) {
        merged.push({
          id: key,
          name: d.name || 'Custom Template',
          icon: d.icon || '🎨',
          bgColor: d.bgColor || 'linear-gradient(135deg, #667eea, #764ba2)',
          category: d.category || 'custom',
          description: d.description || '',
          prompt: d.prompt || '',
          thumbnail: d.thumbnail || null,
          thumbnailUrl: d.thumbnailUrl || null,
          refImages: d.refImages || [],
          refImageUrls: d.refImageUrls || [],
          refCount: d.refCount || (d.refImages || []).length || (d.refImageUrls || []).length,
          isCustom: true,
        });
      }
    });
    return merged;
  }, [templateData]);

  // ========== UTILITY FUNCTIONS ==========
  const addLog = useCallback((msg) => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [`[${time}] ${msg}`, ...prev].slice(0, 50));
  }, []);

  function addCost(type, amount) {
    setCosts(prev => {
      const n = { ...prev };
      if (type === 'textInput') n.textInputTokens += amount;
      else if (type === 'textOutput') n.textOutputTokens += amount;
      else if (type === 'image') n.imageCount += amount;
      return n;
    });
  }

  function getTotalCost() {
    return (costs.textInputTokens * PRICING.textInput) + (costs.textOutputTokens * PRICING.textOutput) + (costs.imageCount * PRICING.image);
  }

  const apiUrl = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key.trim()}`;

  // ========== FILE UPLOAD HANDLER ==========
  async function handleFileUpload(e, setter) {
    const file = e.target.files[0];
    if (!file) return;
    addLog(`File selected: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);
    const b64 = await readFileAsBase64(file);
    setter(b64);
    addLog(`Loaded: ${b64.length} chars`);
  }

  // ========== DRAG & DROP ==========
  function handleDrop(e, setter) {
    e.preventDefault();
    e.stopPropagation();
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
      readFileAsBase64(file).then(b64 => {
        setter(b64);
        addLog(`Dropped: ${file.name}`);
      });
    }
  }

  function handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  // ========== VERIFY KEY ==========
  async function handleVerifyKey() {
    const cleanKey = key.trim();
    if (!cleanKey) { alert('Vui lòng nhập API Key'); return; }
    setLoading(true);
    setStatus('Đang kiểm tra Key...');
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${cleanKey}`);
      if (res.ok) {
        setKeyValid(true);
        setStatus('Key hợp lệ!');
        localStorage.setItem('gemini_key', cleanKey);
        addLog('Key verified OK');
      } else {
        setKeyValid(false);
        setStatus('Key sai!');
        addLog('Key invalid');
      }
    } catch (e) {
      setKeyValid(false);
      setStatus('Lỗi mạng');
      addLog('Network error: ' + e.message);
    } finally {
      setLoading(false);
    }
  }

  // ========== EDIT: REFINE PROMPT ==========
  async function handleRefinePrompt() {
    if (!key.trim()) { alert('Thiếu Key'); return; }
    if (!userPrompt) { alert('Nhập yêu cầu'); return; }
    if (!editImage) { alert('Chưa upload ảnh'); return; }

    setLoading(true);
    addLog('=== REFINE PROMPT ===');
    try {
      setStatus('Gửi Gemini...');
      const res = await fetchWithRetry(apiUrl('gemini-3.1-pro-preview'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: `Based on this image, create a prompt for AI to: "${userPrompt}". Return ONLY the English prompt.` },
              { inlineData: { mimeType: 'image/jpeg', data: editImage } }
            ]
          }]
        })
      });
      if (!res.ok) throw new Error('API failed: ' + res.status);
      const data = await res.json();
      const text = extractText(data);
      if (text) {
        setRefinedPrompt(text);
        setStatus('Prompt đã tinh chỉnh!');
        addLog('Got refined prompt');
        addCost('textInput', 500);
        addCost('textOutput', 100);
      } else throw new Error('No result');
    } catch (e) {
      addLog('Error: ' + e.message);
      setStatus('Lỗi');
    } finally {
      setLoading(false);
    }
  }

  // ========== EDIT: GENERATE ==========
  async function handleGenerate() {
    if (!refinedPrompt) return;
    if (!editImage) { alert('Chưa có ảnh gốc.'); return; }

    setLoading(true);
    addLog('=== GENERATE ===');
    try {
      setStatus('Chỉnh sửa ảnh...');
      const res = await fetchWithRetry(apiUrl('gemini-3.1-flash-image-preview'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inlineData: { mimeType: 'image/jpeg', data: editImage } },
              { text: refinedPrompt }
            ]
          }],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { imageSize: '4K', aspectRatio: editAspectRatio } }
        })
      });
      if (!res.ok) throw new Error('API failed: ' + res.status);
      const data = await res.json();
      const img = extractImage(data);
      if (img) {
        setResultImage(img);
        setStatus('Xong!');
        addCost('image', 1);
        addCost('textInput', 1000);
        addLog('Image generated!');
        autoUploadToSupabase(img.data, img.mimeType, 'edit');
      } else throw new Error('No image returned');
    } catch (e) {
      addLog('Error: ' + e.message);
      setStatus('Lỗi');
      alert(e.message);
    } finally {
      setLoading(false);
    }
  }

  // ========== COMPOSITE ==========
  async function handleComposite() {
    if (!subjectImage) { alert('Chưa upload subject!'); return; }
    if (!bgImage) { alert('Chưa upload background!'); return; }

    setLoading(true);
    addLog('=== COMPOSITE ===');
    try {
      let prompt = 'Composite the subject onto this background.';
      if (optKeepFace) prompt += ' Keep the subject face exactly the same.';
      if (optKeepPose) prompt += ' Maintain exact same body pose.';
      if (optMatchLight) prompt += ' Match lighting and color temperature.';
      prompt += ' Make it photorealistic.';
      if (compositePrompt) prompt += ' ' + compositePrompt;

      let finalResult = null;
      // Pre-compress images for faster API
      setStatus('Đang nén ảnh...');
      const compBg = await compressBase64Image(bgImage, 1536, 0.85);
      const compSubject = await compressBase64Image(subjectImage, 1536, 0.85);
      addLog(`Compressed: BG=${(compBg.length / 1024).toFixed(0)}KB Subject=${(compSubject.length / 1024).toFixed(0)}KB`);

      const doGenerate = async (fixPrompt) => {
        setStatus(fixPrompt ? 'Đang sửa lỗi...' : 'Ghép nền với AI...');
        const finalPrompt = fixPrompt ? prompt + ' FIX: ' + fixPrompt : prompt;
        const res = await fetchWithRetry(apiUrl('gemini-3.1-flash-image-preview'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: 'BACKGROUND:' },
                { inlineData: { mimeType: 'image/jpeg', data: compBg } },
                { text: 'SUBJECT:' },
                { inlineData: { mimeType: 'image/jpeg', data: compSubject } },
                { text: finalPrompt }
              ]
            }],
            generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { imageSize: '4K', aspectRatio: compositeAspectRatio } }
          })
        }, 3, addLog);
        const data = await res.json();
        const img = extractImage(data);
        if (!img) throw new Error('No image');
        addCost('image', 1);
        addCost('textInput', 2000);
        return img;
      };

      finalResult = await doGenerate(null);

      // Optional QC
      if (enableQC) {
        setStatus('Kiểm tra giải phẫu...');
        addLog('QC Check...');
        const qc = await validateFaceAnatomy(compSubject, finalResult.data, key.trim());
        addCost('textInput', 800);
        if (qc.pass) {
          addLog(`✓ QC Passed (Score: ${qc.score})`);
        } else {
          addLog(`⚠ QC Fail: ${qc.issues} — Retrying...`);
          finalResult = await doGenerate(qc.issues);
        }
      }

      setResultImage(finalResult);
      setStatus('Xong!');
      addLog('Composite done!');
      autoUploadToSupabase(finalResult.data, finalResult.mimeType, 'composite');
    } catch (e) {
      addLog('Error: ' + e.message);
      setStatus('Lỗi');
      alert(e.message);
    } finally {
      setLoading(false);
    }
  }

  // ========== TEMPLATE (BG REPLACE) ==========
  async function handleTemplateComposite() {
    if (!templateSubjectImage) { alert('Chưa upload subject!'); return; }
    if (!selectedTemplate) { alert('Chưa chọn template!'); return; }

    setLoading(true);
    addLog('=== TEMPLATE BG REPLACE ===');
    try {
      const template = allTemplates.find(t => t.id === selectedTemplate);
      if (!template) throw new Error('Template không tìm thấy');
      addLog('Template: ' + template.name);

      // Pre-compress images - fetch from cloud if needed
      let refImages = template.refImages || [];
      if (refImages.length === 0 && template.refCount > 0) {
        setStatus('Đang tải ảnh mẫu từ cloud...');
        addLog('☁️ Fetching ref images from cloud...');
        refImages = await supa.fetchRefImagesBase64(selectedTemplate, template.refCount);
        addLog(`☁️ Fetched ${refImages.length} ref images`);
      }
      const hasRefs = refImages.length > 0;
      setStatus('Đang nén ảnh...');
      const compressedRefs = hasRefs ? await Promise.all(refImages.map(img => compressBase64Image(img, 1024, 0.75))) : [];
      const compressedSubject = await compressBase64Image(templateSubjectImage, 1536, 0.85);
      addLog(`Compressed: subject=${(compressedSubject.length / 1024).toFixed(0)}KB, refs=${compressedRefs.length}`);

      // === SINGLE STEP: Generate background replacement ===
      const doReplace = async (attempt, qcFix) => {
        setStatus(attempt === 1 ? 'Đang thay background...' : 'Đang sửa lỗi...');
        addLog(`--- BG Replace #${attempt} ---`);

        let editPrompt = `Replace ONLY the background. Keep person(s) 100% unchanged (face, body, pose, clothes). NEW BG: ${template.prompt}. Match original DOF/bokeh, camera angle, lighting. Natural ground contact. Photorealistic.`;
        if (hasRefs) editPrompt += ' Match REFERENCE IMAGES style exactly.';
        if (qcFix) editPrompt += ' FIX: ' + qcFix;

        const parts = [];
        if (hasRefs) {
          parts.push({ text: 'REFERENCE IMAGES:' });
          compressedRefs.forEach(refB64 => {
            parts.push({ inlineData: { mimeType: 'image/jpeg', data: refB64 } });
          });
        }
        parts.push({ text: 'SUBJECT (keep unchanged):' });
        parts.push({ inlineData: { mimeType: 'image/jpeg', data: compressedSubject } });
        parts.push({ text: editPrompt });

        const res = await fetchWithRetry(apiUrl('gemini-3.1-flash-image-preview'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { imageSize: '4K', aspectRatio: templateAspectRatio } }
          })
        }, 3, addLog);
        const data = await res.json();
        const img = extractImage(data);
        if (!img) throw new Error('No image returned');
        addLog('Done! ' + (img.data.length / 1024).toFixed(0) + 'KB');
        addCost('image', 1);
        addCost('textInput', 1500);
        return img;
      };

      let result = await doReplace(1, null);

      // === OPTIONAL QC ===
      if (enableQC) {
        setStatus('QC kiểm tra...');
        addLog('--- QC Check ---');
        const qc = await validateFaceAnatomy(compressedSubject, result.data, key.trim());
        addCost('textInput', 800);
        if (qc.pass) {
          addLog(`✓ QC Passed (Score: ${qc.score})`);
        } else {
          addLog(`⚠ QC Fail: ${qc.issues} — Retrying...`);
          result = await doReplace(2, qc.issues);
        }
      }

      setResultImage(result);
      setStatus('Xong!');
      addLog('DONE!');
      autoUploadToSupabase(result.data, result.mimeType, 'template');
    } catch (e) {
      addLog('Error: ' + e.message);
      setStatus('Lỗi');
      alert(e.message);
    } finally {
      setLoading(false);
    }
  }

  // ========== UPSCALE 4K ==========
  async function handleUpscale() {
    if (!upscaleImage) { alert('Chưa upload ảnh!'); return; }
    if (!key.trim()) { alert('Thiếu Key'); return; }

    setLoading(true);
    addLog('=== UPSCALE 4K ===');
    try {
      setStatus('Đang upscale lên 4K...');
      const res = await fetchWithRetry(apiUrl('gemini-3.1-flash-image-preview'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inlineData: { mimeType: 'image/jpeg', data: upscaleImage } },
              { text: 'Upscale this image to 4K resolution while preserving all details, colors, textures and quality. Keep the exact same content, composition and style. Do not add, remove or modify any elements. Just enhance the resolution and clarity to 4K quality.' }
            ]
          }],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { imageSize: '4K' } }
        })
      });
      if (!res.ok) throw new Error('API failed: ' + res.status);
      const data = await res.json();
      const img = extractImage(data);
      if (img) {
        setResultImage(img);
        setStatus('Upscale 4K xong!');
        addCost('image', 1);
        addCost('textInput', 1000);
        addLog('Upscaled!');
        autoUploadToSupabase(img.data, img.mimeType, 'upscale');
      } else throw new Error('No image');
    } catch (e) {
      addLog('Error: ' + e.message);
      setStatus('Lỗi');
      alert(e.message);
    } finally {
      setLoading(false);
    }
  }

  // ========== FACE SWAP ==========
  async function handleFaceSwap() {
    if (!faceRefImage) { alert('Chưa upload khuôn mặt mẫu!'); return; }
    if (!faceTargetImage) { alert('Chưa upload ảnh mục tiêu!'); return; }
    if (!key.trim()) { alert('Thiếu Key'); return; }

    setLoading(true);
    addLog('=== FACE SWAP ===');
    try {
      const basePrompt = `Replace the face in TARGET with REFERENCE face. Keep pose/body from TARGET. Match lighting. Natural result. IMAGE 1 = REFERENCE FACE. IMAGE 2 = TARGET.`;

      // Pre-compress
      setStatus('Đang nén ảnh...');
      const compRef = await compressBase64Image(faceRefImage, 1536, 0.85);
      const compTarget = await compressBase64Image(faceTargetImage, 1536, 0.85);
      addLog(`Compressed: Ref=${(compRef.length / 1024).toFixed(0)}KB Target=${(compTarget.length / 1024).toFixed(0)}KB`);

      const doSwap = async (fixPrompt) => {
        setStatus(fixPrompt ? 'Đang sửa lỗi...' : 'Đang thay thế khuôn mặt...');
        const finalPrompt = fixPrompt ? basePrompt + ' FIX: ' + fixPrompt : basePrompt;
        const res = await fetchWithRetry(apiUrl('gemini-3.1-flash-image-preview'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: finalPrompt },
                { inlineData: { mimeType: 'image/jpeg', data: compRef } },
                { inlineData: { mimeType: 'image/jpeg', data: compTarget } }
              ]
            }],
            generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { imageSize: '4K' } }
          })
        }, 3, addLog);
        const data = await res.json();
        const img = extractImage(data);
        if (!img) throw new Error('No image');
        addCost('image', 1);
        addCost('textInput', 2000);
        return img;
      };

      let result = await doSwap(null);

      // Optional QC
      if (enableQC) {
        setStatus('Kiểm tra giải phẫu...');
        addLog('QC Check...');
        const qc = await validateFaceAnatomy(compRef, result.data, key.trim());
        addCost('textInput', 800);
        if (qc.pass) {
          addLog(`✓ QC Passed (Score: ${qc.score})`);
        } else {
          addLog(`⚠ QC Fail: ${qc.issues} — Retrying...`);
          result = await doSwap(qc.issues);
        }
      }

      setResultImage(result);
      setStatus('Xong!');
      addLog('Face swapped!');
      autoUploadToSupabase(result.data, result.mimeType, 'faceswap');
    } catch (e) {
      addLog('Error: ' + e.message);
      setStatus('Lỗi');
      alert(e.message);
    } finally {
      setLoading(false);
    }
  }

  // ========== RESTORE: Damage level definitions with level-specific prompts ==========
  const DAMAGE_LEVELS = [
    {
      level: 1, icon: '🟢', name: 'Nhẹ', desc: 'Hơi ngả vàng, bụi nhẹ, nhạt màu',
      strategy: [
        'This photo has MINOR damage: slight yellowing, light dust, mild color fading.',
        'STRATEGY: Gentle color correction only. Keep 95% of the original pixels unchanged.',
        'Fix white balance, remove yellow/sepia cast, restore original vibrant colors.',
        'Remove only visible dust spots and minor scratches. Do NOT alter any details.',
        'Preserve every facial feature, texture, wrinkle, and expression exactly as-is.',
      ]
    },
    {
      level: 2, icon: '🟡', name: 'Trung bình', desc: 'Phai màu, vết gấp, nhiễu hạt',
      strategy: [
        'This photo has MODERATE damage: faded colors, visible creases/fold lines, film grain, age spots.',
        'STRATEGY: Color restoration + crease removal. Keep 85% of original content unchanged.',
        'Restore full color spectrum — make colors vivid and natural as when originally taken.',
        'Remove fold creases, grain, and age spots while keeping all underlying details intact.',
        'Preserve all facial features, clothing patterns, and background objects with high fidelity.',
      ]
    },
    {
      level: 3, icon: '🟠', name: 'Nặng', desc: 'Rách, vết ố lớn, mất chi tiết',
      strategy: [
        'This photo has HEAVY damage: tears, large stains/water damage, missing details in some areas.',
        'STRATEGY: Inpainting + reconstruction. Rebuild damaged areas based on surrounding context.',
        'For torn/missing sections: intelligently reconstruct using visible context clues nearby.',
        'For stained areas: remove stains completely and restore original content underneath.',
        'CRITICAL: Faces must be reconstructed to match remaining visible facial features exactly — same bone structure, same proportions. Use visible parts as reference.',
      ]
    },
    {
      level: 4, icon: '🔴', name: 'Rất nặng', desc: 'Hư hại nghiêm trọng, mất phần lớn',
      strategy: [
        'This photo has SEVERE damage: large missing areas, heavy deterioration, barely visible content.',
        'STRATEGY: Full AI reconstruction. Use any remaining visible content as the strict reference.',
        'Reconstruct all missing areas — faces, bodies, backgrounds — based on what is still visible.',
        'For faces: match any remaining facial features (even partial) to rebuild a consistent, realistic face. Same age, same ethnicity, same expression if detectable.',
        'For backgrounds/objects: reconstruct logically consistent scenery based on context clues.',
        'IMPORTANT: Even with heavy reconstruction, the result must look like a REAL vintage photograph restored — not AI-generated art.',
      ]
    },
  ];

  // ========== RESTORE: Handle photo restoration ==========
  async function handleRestore() {
    if (!restoreImage) { alert('Chưa upload ảnh!'); return; }
    if (!key.trim()) { alert('Thiếu Key'); return; }

    setLoading(true);
    setRestoreScores(null);
    setRestoreAttempts([]);
    addLog('=== PHOTO RESTORE ===');
    const damageInfo = DAMAGE_LEVELS.find(d => d.level === restoreDamageLevel) || DAMAGE_LEVELS[1];
    addLog(`Damage level: ${damageInfo.name} (${damageInfo.level}/4)`);

    try {
      setStatus('Đang nén ảnh...');
      const compressedOrig = await compressBase64Image(restoreImage, 1536, 0.85);
      addLog(`Compressed: ${(compressedOrig.length / 1024).toFixed(0)}KB`);

      // Build restoration prompt — level-specific strategy + professional quality keywords
      const basePrompt = [
        // LEVEL-SPECIFIC STRATEGY
        ...damageInfo.strategy,
        // UNIVERSAL QUALITY — applies to all levels
        'Preserve original identity, facial structure, proportions and composition exactly.',
        'High-fidelity photo restoration, ultra-realistic, natural skin texture, accurate details, professional photographic look.',
        '4K output, sharp but natural focus, professional color grading, HDR. Shot on Arri Alexa, raw photo aesthetic, masterpiece.',
        // SEMANTIC NEGATIVE — what to avoid
        'Do NOT creatively reinterpret, change style, alter identity, reshape faces, or exaggerate features.',
        'The result must look like a real restored photograph — not a painting, illustration, or cartoon.',
        'Avoid over-sharpening, plastic skin, film grain, jpeg artifacts, distortion, bad anatomy, overexposure, underexposure, or washed out colors.',
        // CUSTOM from user
        restoreCustomPrompt || ''
      ].filter(Boolean).join(' ');

      // Preload ArcFace + MediaPipe models while generating image
      preloadFaceCompare().then(ok => addLog(ok ? '✅ ArcFace + MediaPipe ready' : '⚠ FaceCompare unavailable'));

      // Restore + QC loop (max 3 attempts)
      let bestResult = null;
      let bestScores = null;
      let bestScore = -1;
      const MAX_ATTEMPTS = 3;

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        setStatus(`Phục hồi ảnh (lần ${attempt}/${MAX_ATTEMPTS})...`);
        addLog(`--- Attempt ${attempt}/${MAX_ATTEMPTS} ---`);

        // Build prompt with detailed fix instructions for retry
        let finalPrompt = basePrompt;
        let requestParts = [
          { inlineData: { mimeType: 'image/jpeg', data: compressedOrig } },
        ];

        if (attempt > 1 && bestResult && bestScores && !bestScores.pass) {
          // === RETRY: send original + failed result + specific fix instructions ===
          const fixInstructions = [];
          fixInstructions.push('I am providing TWO images: the ORIGINAL damaged photo (first) and your PREVIOUS restoration attempt (second).');
          fixInstructions.push('Your previous attempt had these problems that MUST be fixed:');

          let priority = 1;
          if (bestScores.face < 9) {
            fixInstructions.push(`${priority}. FACE IDENTITY MISMATCH (score: ${bestScores.face}/10, needs ≥9): The restored face does NOT look like the same person. You MUST preserve the EXACT same facial bone structure, eye shape, nose shape, mouth shape, jawline, and facial proportions from the original photo. Do not make the person look younger, older, or different.`);
            priority++;
          }
          if (bestScores.objects < 8) {
            fixInstructions.push(`${priority}. OBJECTS/BACKGROUND WRONG (score: ${bestScores.objects}/10, needs ≥8): Background objects, furniture, or environment elements are missing, changed, or incorrectly reconstructed. Keep all objects exactly as they appear in the original.`);
            priority++;
          }
          if (bestScores.clothing < 8) {
            fixInstructions.push(`${priority}. CLOTHING/ACCESSORIES WRONG (score: ${bestScores.clothing}/10, needs ≥8): Clothing pattern, style, or accessories have been altered. Preserve the exact same outfit, jewelry, hat, glasses, etc.`);
            priority++;
          }
          if (bestScores.color < 8) {
            fixInstructions.push(`${priority}. COLOR FIDELITY POOR (score: ${bestScores.color}/10, needs ≥8): Colors are unnatural, washed out, or don't match what the original colors would have been. Make colors vivid, realistic, and consistent.`);
            priority++;
          }

          fixInstructions.push('Please generate a NEW restoration that fixes ALL of the above issues while keeping the good aspects of the previous attempt.');

          finalPrompt = basePrompt + '\n\n' + fixInstructions.join('\n');

          // Compress previous result to avoid 503 (raw can be 40MB+)
          const compressedPrevResult = await compressBase64Image(bestResult.data, 1536, 0.8);
          addLog(`Compressed previous result: ${(compressedPrevResult.length / 1024).toFixed(0)}KB`);

          // Send both: original (first) + compressed previous result (second)
          requestParts = [
            { inlineData: { mimeType: 'image/jpeg', data: compressedOrig } },
            { inlineData: { mimeType: 'image/jpeg', data: compressedPrevResult } },
            { text: finalPrompt }
          ];

          addLog(`Retry with fix: sending original + previous result + ${priority - 1} fix instructions`);
        } else {
          requestParts.push({ text: finalPrompt });
        }

        const restoreRes = await fetchWithRetry(apiUrl('gemini-3.1-flash-image-preview'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: requestParts }],
            generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { imageSize: '4K' } }
          })
        }, 3, addLog);
        const restoreData = await restoreRes.json();

        const responseText = extractText(restoreData);
        if (responseText) addLog(`API text: ${responseText.substring(0, 200)}`);

        const img = extractImage(restoreData);
        if (!img) {
          const blockReason = restoreData?.candidates?.[0]?.finishReason || restoreData?.promptFeedback?.blockReason || 'unknown';
          addLog(`⚠ No image returned. Reason: ${blockReason}`);
          if (attempt === MAX_ATTEMPTS && bestResult) break;
          continue;
        }
        addCost('image', 1);
        addCost('textInput', 1500);
        addLog(`✓ Image restored! ${(img.data.length / 1024).toFixed(0)}KB`);

        // 💾 Save immediately (even before QC scoring)
        autoUploadToSupabase(img.data, img.mimeType, `restore_attempt${attempt}`);
        addLog(`💾 Saved attempt ${attempt} to cloud`);

        // ====== QC: ArcFace for face identity + Gemini for objects/clothing/color ======
        setStatus(`Chấm điểm (lần ${attempt}/${MAX_ATTEMPTS})...`);

        // Step A: ArcFace face identity comparison (FREE, local, 512D embedding)
        addLog(`🔍 ArcFace face identity check...`);
        const faceResult = await compareFaces(compressedOrig, img.data);
        addLog(`Face: ${faceResult.score}/10 (cosine: ${faceResult.cosine ?? 'N/A'}) — ${faceResult.details}`);

        // Step B: Gemini QC for objects/clothing/color
        addLog(`🔍 Gemini QC (objects/clothing/color)...`);
        const qc = await validateRestoration(compressedOrig, img.data, key.trim());
        addCost('textInput', 800);

        // Combine: ArcFace for face, Gemini for rest
        const combinedScores = {
          face: faceResult.hasFace ? faceResult.score : qc.scores.face,
          objects: qc.scores.objects,
          clothing: qc.scores.clothing,
          color: qc.scores.color
        };

        const avgScore = (combinedScores.face + combinedScores.objects + combinedScores.clothing + combinedScores.color) / 4;
        const facePassed = combinedScores.face >= 9;
        const objectsPassed = combinedScores.objects >= 8 && combinedScores.clothing >= 8 && combinedScores.color >= 8;
        const allPassed = facePassed && objectsPassed;

        addLog(`Scores — Face: ${combinedScores.face}/10${faceResult.hasFace ? ' (ArcFace)' : ' (Gemini)'}, Objects: ${combinedScores.objects}/10, Clothing: ${combinedScores.clothing}/10, Color: ${combinedScores.color}/10`);

        // Build issues
        const issues = [];
        if (!facePassed) issues.push(`Face ${combinedScores.face}/10 (cần ≥9) — ${faceResult.details}`);
        if (combinedScores.objects < 8) issues.push(`Objects ${combinedScores.objects}/10 (cần ≥8)`);
        if (combinedScores.clothing < 8) issues.push(`Clothing ${combinedScores.clothing}/10 (cần ≥8)`);
        if (combinedScores.color < 8) issues.push(`Color ${combinedScores.color}/10 (cần ≥8)`);
        const issueText = issues.join('; ') || qc.issues;

        // Save attempt to state for gallery display
        setRestoreAttempts(prev => [...prev, {
          attempt,
          imgData: img.data,
          mimeType: img.mimeType || 'image/jpeg',
          scores: { ...combinedScores },
          avgScore: Math.round(avgScore * 10) / 10,
          passed: allPassed,
          cosine: faceResult.cosine,
          faceMethod: faceResult.hasFace ? 'ArcFace' : 'Gemini'
        }]);

        if (avgScore > bestScore) {
          bestScore = avgScore;
          bestResult = img;
          bestScores = { ...combinedScores, issues: issueText, pass: allPassed, faceMethod: faceResult.hasFace ? 'ArcFace' : 'Gemini', cosine: faceResult.cosine };
        }

        if (allPassed) {
          addLog(`✓ Quality PASSED on attempt ${attempt}! 🎉`);
          break;
        } else {
          addLog(`⚠ Quality not met: ${issueText}`);
          if (attempt < MAX_ATTEMPTS) {
            addLog(`Retrying with detailed fix instructions + previous result image...`);
          } else {
            addLog(`⚠ Max attempts reached. Using best result (avg: ${bestScore.toFixed(1)})`);
          }
        }
      }

      if (bestResult) {
        setResultImage(bestResult);
        setRestoreScores(bestScores);
        setStatus(bestScores.pass ? '✅ Phục hồi hoàn tất!' : '⚠️ Phục hồi xong (chưa đạt tối đa)');
        addLog('RESTORE COMPLETE!');
        autoUploadToSupabase(bestResult.data, bestResult.mimeType, 'restore_best');
      } else {
        throw new Error('API không trả về hình ảnh. Kiểm tra logs để biết chi tiết. Thử ảnh khác hoặc giảm mức độ tổn hại.');
      }
    } catch (e) {
      addLog('Error: ' + e.message);
      setStatus('Lỗi');
      alert(e.message);
    } finally {
      setLoading(false);
    }
  }

  // ========== DOWNLOAD RESULT ==========
  function handleDownload() {
    if (!resultImage) return;
    downloadBase64(resultImage.data, resultImage.mimeType || 'image/png', `thubinh_${activeTab}_${Date.now()}.png`);
    addLog('Downloaded');
  }

  // ========== BATCH: Select multiple files ==========
  function handleBatchFilesSelect(e) {
    const files = Array.from(e.target.files).filter(f => f.type.startsWith('image/'));
    setBatchFiles(files);
    addLog(`Batch: selected ${files.length} images`);
    setStatus(`Đã chọn ${files.length} ảnh`);
  }

  // ========== BATCH PROCESS ==========
  async function handleBatchProcess() {
    if (batchFiles.length === 0) { alert('Chưa chọn ảnh!'); return; }
    if (batchMode === 'composite' && !batchBgImage) { alert('Chưa upload background!'); return; }
    if (batchMode === 'template' && !batchSelectedTemplate) { alert('Chưa chọn template!'); return; }
    const cleanKey = key.trim();
    if (!cleanKey) { alert('Vui lòng nhập API Key!'); return; }

    setLoading(true);
    setBatchProgress({ current: 0, total: batchFiles.length, running: true });
    setBatchResults([]);
    addLog('=== AUTO BATCH START ===');
    addLog(`Mode: ${batchMode}, Files: ${batchFiles.length}`);

    const results = [];

    // Pre-compress batch background (once, outside the loop)
    const compBatchBg = batchMode === 'composite' ? await compressBase64Image(batchBgImage, 1536, 0.85) : null;
    // Pre-compress batch template refs (once, outside the loop)
    let compBatchRefs = [];
    if (batchMode === 'template') {
      const template = allTemplates.find(t => t.id === batchSelectedTemplate);
      if (template) {
        let refImages = [...(template.refImages || [])];
        // Fetch from cloud if no local base64
        if (refImages.length === 0 && template.refCount > 0) {
          addLog('☁️ Fetching batch ref images from cloud...');
          refImages = await supa.fetchRefImagesBase64(batchSelectedTemplate, template.refCount);
        }
        if (template.thumbnail) refImages = [template.thumbnail, ...refImages];
        refImages = [...new Set(refImages)];
        compBatchRefs = await Promise.all(refImages.map(img => compressBase64Image(img, 1024, 0.75)));
      }
    }
    addLog(`Pre-compressed: bg=${compBatchBg ? (compBatchBg.length / 1024).toFixed(0) + 'KB' : 'N/A'}, refs=${compBatchRefs.length}`);

    for (let i = 0; i < batchFiles.length; i++) {
      const file = batchFiles[i];
      const baseName = file.name.replace(/\.[^/.]+$/, '');
      setBatchProgress({ current: i + 1, total: batchFiles.length, running: true });
      setStatus(`Đang xử lý ${i + 1}/${batchFiles.length}: ${file.name}`);
      addLog(`--- [${i + 1}/${batchFiles.length}]: ${file.name} ---`);

      try {
        const subjectB64 = await readFileAsBase64(file);
        const compSubject = await compressBase64Image(subjectB64, 1536, 0.85);
        let requestBody;

        if (batchMode === 'composite') {
          let prompt = 'Composite the subject onto this background.';
          if (batchOptKeepFace) prompt += ' Keep the subject face exactly the same.';
          if (batchOptKeepPose) prompt += ' Maintain exact same body pose.';
          if (batchOptMatchLight) prompt += ' Match lighting and color temperature.';
          prompt += ' Make it photorealistic.';
          if (batchPrompt) prompt += ' ' + batchPrompt;

          requestBody = {
            contents: [{
              parts: [
                { text: 'BACKGROUND IMAGE:' },
                { inlineData: { mimeType: 'image/jpeg', data: compBatchBg } },
                { text: 'SUBJECT TO COMPOSITE:' },
                { inlineData: { mimeType: 'image/jpeg', data: compSubject } },
                { text: 'INSTRUCTION: ' + prompt }
              ]
            }],
            generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { imageSize: '4K', aspectRatio: batchAspectRatio } }
          };
        } else {
          const template = allTemplates.find(t => t.id === batchSelectedTemplate);
          if (!template) throw new Error('Template không tìm thấy');

          const hasRefs = compBatchRefs.length > 0;

          let tplPrompt = `Generate a background based on: ${template.prompt}. Composite the subject onto it. Keep all faces, poses exactly same. Match lighting. Photorealistic. 4K.`;
          if (hasRefs) tplPrompt += ' Match REFERENCE IMAGES style exactly.';

          const parts = [];
          if (hasRefs) {
            parts.push({ text: 'REFERENCE STUDIO IMAGES:' });
            compBatchRefs.forEach(img => {
              parts.push({ inlineData: { mimeType: 'image/jpeg', data: img } });
            });
          }
          parts.push({ text: 'SUBJECT(S) TO COMPOSITE:' });
          parts.push({ inlineData: { mimeType: 'image/jpeg', data: compSubject } });
          parts.push({ text: 'INSTRUCTION: ' + tplPrompt });

          requestBody = {
            contents: [{ parts }],
            generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { imageSize: '4K', aspectRatio: batchAspectRatio } }
          };
        }



        // ========== QC LOOP (Max 2 attempts) ==========
        let qcIssues = '';
        let finalImg = null;
        let success = false;

        const maxAttempts = enableQC ? 2 : 1;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          if (attempt > 1) {
            addLog(`⟳ Retry #${attempt} fixing: ${qcIssues}`);
            const parts = requestBody.contents[0].parts;
            const lastTextPart = parts[parts.length - 1];
            if (lastTextPart && lastTextPart.text) {
              lastTextPart.text += ` FIX: ${qcIssues}`;
            }
          }

          const res = await fetchWithRetry(apiUrl('gemini-3.1-flash-image-preview'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
          }, 3, addLog);
          const data = await res.json();
          const img = extractImage(data);

          if (!img) break;

          // QC Check (only if enabled)
          if (enableQC) {
            addLog(`QC Check (${attempt}/${maxAttempts})...`);
            const qc = await validateFaceAnatomy(compSubject, img.data, key.trim());
            if (qc.pass) {
              finalImg = img;
              success = true;
              addLog(`✓ QC Passed (Score: ${qc.score})`);
              break;
            } else {
              addLog(`⚠ QC Fail: ${qc.issues}`);
              qcIssues = qc.issues;
              if (attempt === maxAttempts) {
                finalImg = img;
                addLog('⚠ Accepting after retry limit.');
              }
            }
          } else {
            finalImg = img;
            success = true;
            break;
          }
        }

        if (finalImg) {
          addLog(`✓ ${file.name} saved`);
          results.push({
            fileName: file.name,
            baseName,
            status: success ? 'success' : 'warning',
            message: success ? 'OK' : `QC Issues: ${qcIssues}`,
            imageData: finalImg.data,
            mimeType: finalImg.mimeType || 'image/png'
          });
          // Cost: count actual attempts (image gen + QC per attempt)
          const numAttempts = success ? 1 : 2;
          addCost('image', numAttempts);
          addCost('textInput', numAttempts * 2500);
        } else throw new Error('No image returned');
      } catch (e) {
        addLog(`✗ ${file.name}: ${e.message}`);
        results.push({ fileName: file.name, baseName, status: 'error', message: e.message });
      }
      setBatchResults([...results]);
    }

    const ok = results.filter(r => r.status === 'success').length;
    const fail = results.filter(r => r.status === 'error').length;
    setBatchProgress({ current: batchFiles.length, total: batchFiles.length, running: false });
    setStatus(`Batch xong! ${ok} thành công, ${fail} lỗi`);
    addLog(`=== BATCH DONE: ${ok} OK / ${fail} ERR ===`);
    setLoading(false);
  }

  // ========== BATCH: Download one result ==========
  function handleBatchDownloadOne(result) {
    downloadBase64(result.imageData, result.mimeType, `${result.baseName}_batch.png`);
  }

  // ========== BATCH: Download all results ==========
  function handleBatchDownloadAll() {
    const successResults = batchResults.filter(r => r.status === 'success' || r.status === 'warning');
    successResults.forEach((r, i) => {
      setTimeout(() => downloadBase64(r.imageData, r.mimeType, `${r.baseName}_batch.png`), i * 300);
    });
    addLog(`Downloading ${successResults.length} files...`);
  }

  // ========== UPLOAD ZONE COMPONENT ==========
  function UploadZone({ image, setter, fileRef, label }) {
    return (
      <div
        className={`upload-zone ${image ? 'has-image' : ''}`}
        onClick={() => fileRef.current?.click()}
        onDrop={(e) => handleDrop(e, setter)}
        onDragOver={handleDragOver}
      >
        {image ? (
          <img src={`data:image/jpeg;base64,${image}`} alt="uploaded" />
        ) : (
          <>
            <div className="upload-icon">📷</div>
            <div className="upload-text">
              <strong>Click</strong> hoặc <strong>kéo thả</strong> ảnh vào đây<br />
              {label}
            </div>
          </>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={(e) => handleFileUpload(e, setter)}
        />
      </div>
    );
  }

  // ========== ASPECT RATIO SELECTOR ==========
  function RatioSelector({ value, onChange }) {
    return (
      <div className="ratio-grid">
        {ASPECT_RATIOS.map(r => (
          <button
            key={r.id}
            className={`ratio-btn ${value === r.id ? 'active' : ''}`}
            onClick={() => onChange(r.id)}
          >
            {r.label}
          </button>
        ))}
      </div>
    );
  }

  // ========== RENDER TABS ==========
  function renderEditTab() {
    return (
      <div className="fade-in">
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title"><span>🖼️</span> Ảnh gốc</div>
          <UploadZone image={editImage} setter={setEditImage} fileRef={editFileRef} label="Upload ảnh cần chỉnh sửa" />
        </div>
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title"><span>✏️</span> Yêu cầu chỉnh sửa</div>
          <div className="input-group">
            <textarea
              className="input-field"
              placeholder="Ví dụ: Thay đổi nền thành bãi biển, thêm ánh hoàng hôn..."
              value={userPrompt}
              onChange={e => setUserPrompt(e.target.value)}
            />
          </div>
          <button className="btn btn-secondary" onClick={handleRefinePrompt} disabled={loading} style={{ marginBottom: 12 }}>
            🔍 Bước 1: Tinh chỉnh Prompt
          </button>
          {refinedPrompt && (
            <div className="input-group">
              <label>Prompt đã tinh chỉnh</label>
              <textarea
                className="input-field"
                value={refinedPrompt}
                onChange={e => setRefinedPrompt(e.target.value)}
                rows={4}
              />
            </div>
          )}
        </div>
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title"><span>📐</span> Tỉ lệ</div>
          <RatioSelector value={editAspectRatio} onChange={setEditAspectRatio} />
        </div>
        <button className="btn btn-primary btn-lg" onClick={handleGenerate} disabled={loading || !refinedPrompt} style={{ width: '100%' }}>
          🎨 Bước 2: Tạo ảnh
        </button>
      </div>
    );
  }

  function renderCompositeTab() {
    return (
      <div className="fade-in">
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title"><span>🎭</span> Upload ảnh</div>
          <div className="upload-grid">
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6, display: 'block' }}>Background</label>
              <UploadZone image={bgImage} setter={setBgImage} fileRef={bgFileRef} label="Ảnh nền" />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6, display: 'block' }}>Subject</label>
              <UploadZone image={subjectImage} setter={setSubjectImage} fileRef={subjectFileRef} label="Ảnh người" />
            </div>
          </div>
        </div>
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title"><span>⚙️</span> Tùy chọn</div>
          <div className="toggle-group">
            <div className="toggle-item" onClick={() => setOptKeepFace(!optKeepFace)}>
              <div className={`toggle-switch ${optKeepFace ? 'active' : ''}`}></div>
              <span className="toggle-label">Giữ khuôn mặt</span>
            </div>
            <div className="toggle-item" onClick={() => setOptKeepPose(!optKeepPose)}>
              <div className={`toggle-switch ${optKeepPose ? 'active' : ''}`}></div>
              <span className="toggle-label">Giữ tư thế</span>
            </div>
            <div className="toggle-item" onClick={() => setOptMatchLight(!optMatchLight)}>
              <div className={`toggle-switch ${optMatchLight ? 'active' : ''}`}></div>
              <span className="toggle-label">Match ánh sáng</span>
            </div>
          </div>
          <div className="input-group">
            <label>Yêu cầu thêm (tuỳ chọn)</label>
            <input className="input-field" value={compositePrompt} onChange={e => setCompositePrompt(e.target.value)} placeholder="Thêm yêu cầu..." />
          </div>
          <RatioSelector value={compositeAspectRatio} onChange={setCompositeAspectRatio} />
        </div>
        <button className="btn btn-primary btn-lg" onClick={handleComposite} disabled={loading || !subjectImage || !bgImage} style={{ width: '100%' }}>
          🎨 Ghép ảnh
        </button>
      </div>
    );
  }

  // ========== TEMPLATE MANAGEMENT ==========

  // Upload reference images for a template
  async function handleRefImageUpload(e) {
    if (!refUploadTarget) return;
    const files = Array.from(e.target.files).filter(f => f.type.startsWith('image/'));
    if (files.length === 0) return;

    const newImages = [];
    for (const file of files.slice(0, 3)) {
      const b64 = await readFileAsBase64(file);
      const compressed = await compressBase64Image(b64, 1024, 0.8);
      newImages.push(compressed);
      addLog(`Ref compressed: ${(b64.length / 1024).toFixed(0)}KB → ${(compressed.length / 1024).toFixed(0)}KB`);
    }

    const existing = (templateData[refUploadTarget]?.refImages) || [];
    const merged = [...existing, ...newImages].slice(0, 3);

    // Save to IndexedDB as backup
    await saveTemplateData(refUploadTarget, { refImages: merged });

    // Upload to cloud
    addLog(`☁️ Uploading ${merged.length} ref images...`);
    supa.saveTemplateRefImages(refUploadTarget, merged).then(results => {
      const ok = results.filter(r => r.ok).length;
      addLog(`☁️ Uploaded ${ok}/${merged.length} ref images`);
      // Update to URL-based refs
      const refImageUrls = [];
      for (let i = 0; i < merged.length; i++) refImageUrls.push(supa.getTemplateRefImageUrl(refUploadTarget, i));
      const newData = { ...templateData, [refUploadTarget]: { ...(templateData[refUploadTarget] || {}), refImages: merged, refImageUrls, refCount: merged.length } };
      setTemplateData(newData);
      supa.saveTemplateConfig(newData);
    });

    setTemplateData(prev => ({ ...prev, [refUploadTarget]: { ...(prev[refUploadTarget] || {}), refImages: merged, refCount: merged.length } }));
    addLog(`Saved ${merged.length} ref image(s) for: ${refUploadTarget}`);
    setRefUploadTarget(null);
  }

  // Delete reference images
  async function handleDeleteRefImages(templateId) {
    await saveTemplateData(templateId, { refImages: [] });
    setTemplateData(prev => ({ ...prev, [templateId]: { ...(prev[templateId] || {}), refImages: [], refImageUrls: [], refCount: 0 } }));
    addLog(`Deleted ref images for: ${templateId}`);
    // Delete from cloud
    supa.deleteTemplateFiles(templateId).then(() => addLog('☁️ Cloud ref images deleted'));
    const newData = { ...templateData, [templateId]: { ...(templateData[templateId] || {}), refImages: [], refImageUrls: [], refCount: 0 } };
    supa.saveTemplateConfig(newData);
  }

  // Start editing a template
  function startEditTemplate(templateId) {
    const t = allTemplates.find(x => x.id === templateId);
    if (!t) return;
    setEditingTemplate(templateId);
    setEditForm({
      name: t.name || '',
      prompt: t.prompt || '',
      description: t.description || '',
      icon: t.icon || '🎨',
      category: t.category || 'custom',
    });
  }

  // Save template edit
  async function handleSaveTemplateEdit() {
    if (!editingTemplate) return;
    const updates = { ...editForm };
    await saveTemplateData(editingTemplate, updates);
    const newData = { ...templateData, [editingTemplate]: { ...(templateData[editingTemplate] || {}), ...updates } };
    setTemplateData(newData);
    addLog(`Template saved: ${editForm.name}`);
    setEditingTemplate(null);
    // Sync to cloud
    supa.saveTemplateConfig(newData).then(r => { if (r.success) addLog('☁️ Templates synced'); });
  }

  // Add new custom template
  async function handleAddTemplate() {
    const id = 'custom_' + Date.now();
    const data = {
      isCustom: true,
      name: 'Template mới',
      icon: '🎨',
      bgColor: 'linear-gradient(135deg, #667eea, #764ba2)',
      category: 'custom',
      description: 'Mô tả template...',
      prompt: 'Professional studio setup with...',
      refImages: [],
      thumbnail: null,
    };
    await saveTemplateData(id, data);
    const newData = { ...templateData, [id]: data };
    setTemplateData(newData);
    setSelectedTemplate(id);
    startEditTemplate(id);
    addLog(`New template created: ${id}`);
    // Sync to cloud
    supa.saveTemplateConfig(newData).then(r => { if (r.success) addLog('☁️ Templates synced'); });
  }

  // Delete custom template
  async function handleDeleteTemplate(templateId) {
    const t = allTemplates.find(x => x.id === templateId);
    if (!t) return;
    if (!confirm(`Xoá template "${t.name}"?`)) return;
    await deleteTemplateData(templateId);
    const newData = { ...templateData };
    delete newData[templateId];
    setTemplateData(newData);
    if (selectedTemplate === templateId) setSelectedTemplate(null);
    setEditingTemplate(null);
    addLog(`Deleted template: ${t.name}`);
    // Sync to cloud
    supa.saveTemplateConfig(newData).then(r => { if (r.success) addLog('☁️ Templates synced'); });
  }

  // Reset built-in template to defaults
  async function handleResetTemplate(templateId) {
    const def = DEFAULT_TEMPLATES.find(t => t.id === templateId);
    if (!def) return;
    // Keep refImages and thumbnail, reset text fields
    const data = templateData[templateId] || {};
    const reset = { refImages: data.refImages || [], thumbnail: data.thumbnail || null };
    await saveTemplateData(templateId, reset);
    setTemplateData(prev => ({ ...prev, [templateId]: reset }));
    setEditingTemplate(null);
    addLog(`Reset template to default: ${def.name}`);
  }

  // Generate thumbnail from ref images + prompt
  async function handleGenerateThumbnail(templateId) {
    const template = allTemplates.find(t => t.id === templateId);
    if (!template) return;
    if (!key.trim()) { alert('Thiếu API Key'); return; }

    setLoading(true);
    setStatus('Tạo thumbnail...');
    addLog(`Generating thumbnail for: ${template.name}`);

    try {
      let refImages = template.refImages || [];
      if (refImages.length === 0 && template.refCount > 0) {
        setStatus('Đang tải ảnh mẫu từ cloud...');
        refImages = await supa.fetchRefImagesBase64(templateId, template.refCount);
      }
      const parts = [];
      if (refImages.length > 0) {
        parts.push({ text: 'Based on these reference studio images:' });
        refImages.forEach(img => parts.push({ inlineData: { mimeType: 'image/jpeg', data: img } }));
      }
      parts.push({ text: `Generate a beautiful EMPTY studio preview (NO people, NO faces, NO human figures) for: ${template.prompt}. Show only the background setup, props, lighting, and atmosphere. This is a thumbnail preview of the studio set.` });

      const res = await fetchWithRetry(apiUrl('gemini-3.1-flash-image-preview'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: '1:1' } }
        })
      });
      if (!res.ok) throw new Error('API: ' + res.status);
      const data = await res.json();
      const img = extractImage(data);
      if (img) {
        await saveTemplateData(templateId, { thumbnail: img.data });
        const thumbnailUrl = supa.getTemplateThumbnailUrl(templateId);
        const newData = { ...templateData, [templateId]: { ...(templateData[templateId] || {}), thumbnail: img.data, thumbnailUrl, hasThumbnail: true } };
        setTemplateData(newData);
        addLog('Thumbnail generated!');
        setStatus('Thumbnail đã tạo!');
        addCost('image', 1);
        // Upload thumbnail to cloud
        const compressed = await compressBase64Image(img.data, 512, 0.8);
        supa.saveTemplateThumbnail(templateId, compressed).then(r => { if (r.success) addLog('☁️ Thumbnail uploaded'); });
        supa.saveTemplateConfig(newData).then(r => { if (r.success) addLog('☁️ Templates synced'); });
      } else throw new Error('No image');
    } catch (e) {
      addLog('Thumbnail error: ' + e.message);
      setStatus('Lỗi tạo thumbnail');
    } finally {
      setLoading(false);
    }
  }

  // ========== TEMPLATE CARD with thumbnail ==========
  function TemplateCard({ t, selected, onSelect }) {
    const thumbSrc = t.thumbnailUrl || (t.thumbnail ? `data:image/png;base64,${t.thumbnail}` : null);
    const hasThumbnail = !!thumbSrc;
    const refCount = t.refCount || (t.refImages || []).length || (t.refImageUrls || []).length;
    const isCustom = t.isCustom;

    return (
      <div
        className={`template-card ${selected ? 'selected' : ''}`}
        style={{ background: hasThumbnail ? 'none' : t.bgColor, padding: hasThumbnail ? 0 : undefined, overflow: 'hidden' }}
        onClick={() => onSelect(t.id)}
      >
        {hasThumbnail && (
          <img src={thumbSrc} alt={t.name}
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'cover', opacity: 0.7 }} />
        )}
        {refCount > 0 && (
          <div style={{ position: 'absolute', top: 4, right: 4, background: 'rgba(0,230,118,0.9)', color: '#000', fontSize: 9, fontWeight: 700, padding: '2px 5px', borderRadius: 4, zIndex: 2 }}>📸 {refCount}</div>
        )}
        {isCustom && (
          <div style={{ position: 'absolute', top: 4, left: 4, background: 'rgba(124,77,255,0.9)', color: '#fff', fontSize: 9, fontWeight: 700, padding: '2px 5px', borderRadius: 4, zIndex: 2 }}>✨</div>
        )}
        <div className="template-icon" style={{ position: 'relative', zIndex: 1 }}>{t.icon}</div>
        <div className="template-name" style={{ position: 'relative', zIndex: 1, textShadow: hasThumbnail ? '0 1px 4px rgba(0,0,0,0.8)' : 'none' }}>{t.name}</div>
        {!hasThumbnail && <div className="template-desc" style={{ position: 'relative', zIndex: 1 }}>{t.description}</div>}
      </div>
    );
  }

  function renderTemplateTab() {
    const babyTemplates = allTemplates.filter(t => t.category === 'baby');
    const familyTemplates = allTemplates.filter(t => t.category === 'family');
    const customTemplates = allTemplates.filter(t => t.isCustom);
    const selTemplate = selectedTemplate ? allTemplates.find(t => t.id === selectedTemplate) : null;
    const selRefs = selTemplate?.refImages?.length > 0 ? selTemplate.refImages : (selTemplate?.refImageUrls || []);
    const selRefsAreUrls = selRefs.length > 0 && isUrl(selRefs[0]);
    const isCustom = selTemplate?.isCustom;
    const isEditing = editingTemplate === selectedTemplate;
    const hasOverride = selectedTemplate && templateData[selectedTemplate] && (templateData[selectedTemplate].prompt || templateData[selectedTemplate].name);

    return (
      <div className="fade-in">
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title"><span>📷</span> Subject</div>
          <UploadZone image={templateSubjectImage} setter={setTemplateSubjectImage} fileRef={templateFileRef} label="Ảnh người cần ghép" />
        </div>

        {/* Template Grid */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title" style={{ justifyContent: 'space-between' }}>
            <span><span>🎭</span> Chọn Template</span>
            <button className="btn btn-sm btn-secondary" onClick={handleAddTemplate}>➕ Thêm mới</button>
          </div>
          <div className="template-category">👶 Em Bé</div>
          <div className="template-grid">
            {babyTemplates.map(t => (
              <TemplateCard key={t.id} t={t} selected={selectedTemplate === t.id} onSelect={setSelectedTemplate} />
            ))}
          </div>
          <div className="template-category">👨‍👩‍👧‍👦 Gia Đình</div>
          <div className="template-grid">
            {familyTemplates.map(t => (
              <TemplateCard key={t.id} t={t} selected={selectedTemplate === t.id} onSelect={setSelectedTemplate} />
            ))}
          </div>
          {customTemplates.length > 0 && (
            <>
              <div className="template-category">✨ Tùy chỉnh</div>
              <div className="template-grid">
                {customTemplates.map(t => (
                  <TemplateCard key={t.id} t={t} selected={selectedTemplate === t.id} onSelect={setSelectedTemplate} />
                ))}
              </div>
            </>
          )}
        </div>

        {/* Template Editor */}
        {selectedTemplate && selTemplate && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-title" style={{ justifyContent: 'space-between' }}>
              <span><span>⚙️</span> {isEditing ? 'Chỉnh sửa Template' : selTemplate.name}</span>
              <div style={{ display: 'flex', gap: 6 }}>
                {!isEditing && (
                  <button className="btn btn-sm btn-secondary" onClick={() => startEditTemplate(selectedTemplate)}>
                    ✏️ Sửa
                  </button>
                )}
                {isCustom && (
                  <button className="btn btn-sm btn-danger" onClick={() => handleDeleteTemplate(selectedTemplate)}>🗑️</button>
                )}
                {!isCustom && hasOverride && !isEditing && (
                  <button className="btn btn-sm btn-secondary" onClick={() => handleResetTemplate(selectedTemplate)}>↩️ Reset</button>
                )}
              </div>
            </div>

            {isEditing ? (
              <div>
                <div className="input-group">
                  <label>Tên</label>
                  <input className="input-field" value={editForm.name} onChange={e => setEditForm(p => ({ ...p, name: e.target.value }))} />
                </div>
                <div className="input-group">
                  <label>Icon (emoji)</label>
                  <input className="input-field" value={editForm.icon} onChange={e => setEditForm(p => ({ ...p, icon: e.target.value }))} style={{ width: 60 }} />
                </div>
                <div className="input-group">
                  <label>Danh mục</label>
                  <div className="ratio-grid">
                    {['baby', 'family', 'custom'].map(c => (
                      <button key={c} className={`ratio-btn ${editForm.category === c ? 'active' : ''}`}
                        onClick={() => setEditForm(p => ({ ...p, category: c }))}>
                        {c === 'baby' ? '👶 Em bé' : c === 'family' ? '👨‍👩‍👧‍👦 Gia đình' : '✨ Tùy chỉnh'}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="input-group">
                  <label>Mô tả (Tiếng Việt)</label>
                  <input className="input-field" value={editForm.description} onChange={e => setEditForm(p => ({ ...p, description: e.target.value }))} />
                </div>
                <div className="input-group">
                  <label>Prompt (English — mô tả background cho AI)</label>
                  <textarea className="input-field" rows={4} value={editForm.prompt} onChange={e => setEditForm(p => ({ ...p, prompt: e.target.value }))} />
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button className="btn btn-primary btn-sm" onClick={handleSaveTemplateEdit}>💾 Lưu</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => setEditingTemplate(null)}>Huỷ</button>
                </div>
              </div>
            ) : (
              <div>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
                  <strong>Prompt:</strong> {selTemplate.prompt?.substring(0, 150)}{selTemplate.prompt?.length > 150 ? '...' : ''}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Reference Images */}
        {selectedTemplate && selTemplate && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-title">
              <span>📸</span> Ảnh mẫu studio
              <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8 }}>(Lưu trên cloud)</span>
            </div>

            {selRefs.length > 0 ? (
              <>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                  {selRefs.map((img, i) => (
                    <div key={i} style={{ position: 'relative', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)' }}>
                      <img src={getImgSrc(img)} alt={`ref-${i}`} style={{ width: 100, height: 100, objectFit: 'cover', display: 'block' }} />
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {selRefs.length < 3 && (
                    <button className="btn btn-sm btn-secondary" onClick={() => { setRefUploadTarget(selectedTemplate); templateRefFileRef.current?.click(); }}>
                      ➕ Thêm ảnh
                    </button>
                  )}
                  <button className="btn btn-sm btn-danger" onClick={() => handleDeleteRefImages(selectedTemplate)}>
                    🗑️ Xoá ảnh mẫu
                  </button>
                  <button className="btn btn-sm btn-primary" onClick={() => handleGenerateThumbnail(selectedTemplate)} disabled={loading}>
                    🖼️ Tạo Thumbnail
                  </button>
                </div>
              </>
            ) : (
              <div>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.6 }}>
                  Upload 1-3 ảnh mẫu studio thật để AI tạo background chính xác hơn.<br />
                  Sau đó nhấn <strong style={{ color: 'var(--accent-light)' }}>"Tạo Thumbnail"</strong> để xem preview.
                </p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-sm btn-secondary" onClick={() => { setRefUploadTarget(selectedTemplate); templateRefFileRef.current?.click(); }}>
                    📷 Upload ảnh mẫu
                  </button>
                  <button className="btn btn-sm btn-primary" onClick={() => handleGenerateThumbnail(selectedTemplate)} disabled={loading}>
                    🖼️ Tạo Thumbnail (từ prompt)
                  </button>
                </div>
              </div>
            )}

            {/* Thumbnail preview */}
            {(selTemplate.thumbnail || selTemplate.thumbnailUrl) && (
              <div style={{ marginTop: 12 }}>
                <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>Thumbnail hiện tại:</label>
                <img src={selTemplate.thumbnailUrl || `data:image/png;base64,${selTemplate.thumbnail}`} alt="thumbnail" style={{ width: 140, height: 140, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)' }} />
              </div>
            )}

            <input
              ref={templateRefFileRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: 'none' }}
              onChange={handleRefImageUpload}
            />
          </div>
        )}

        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title"><span>📐</span> Tỉ lệ</div>
          <RatioSelector value={templateAspectRatio} onChange={setTemplateAspectRatio} />
        </div>
        <button className="btn btn-primary btn-lg" onClick={handleTemplateComposite} disabled={loading || !templateSubjectImage || !selectedTemplate} style={{ width: '100%' }}>
          🎨 Tạo ảnh Template {selRefs.length > 0 ? `(📸 ${selRefs.length} mẫu)` : ''}
        </button>
      </div>
    );
  }

  function renderUpscaleTab() {
    return (
      <div className="fade-in">
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title"><span>🔍</span> Ảnh cần Upscale</div>
          <UploadZone image={upscaleImage} setter={setUpscaleImage} fileRef={upscaleFileRef} label="Upload ảnh cần nâng cấp 4K" />
        </div>
        <button className="btn btn-primary btn-lg" onClick={handleUpscale} disabled={loading || !upscaleImage} style={{ width: '100%' }}>
          ⬆️ Upscale 4K
        </button>
      </div>
    );
  }

  function renderFaceSwapTab() {
    return (
      <div className="fade-in">
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title"><span>🔄</span> Face Swap</div>
          <div className="upload-grid">
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6, display: 'block' }}>Khuôn mặt mẫu</label>
              <UploadZone image={faceRefImage} setter={setFaceRefImage} fileRef={faceRefFileRef} label="Mặt cần lấy" />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6, display: 'block' }}>Ảnh mục tiêu</label>
              <UploadZone image={faceTargetImage} setter={setFaceTargetImage} fileRef={faceTargetFileRef} label="Ảnh cần thay mặt" />
            </div>
          </div>
        </div>
        <button className="btn btn-primary btn-lg" onClick={handleFaceSwap} disabled={loading || !faceRefImage || !faceTargetImage} style={{ width: '100%' }}>
          🔄 Thay mặt
        </button>
      </div>
    );
  }

  function renderRestoreTab() {
    const damageInfo = DAMAGE_LEVELS.find(d => d.level === restoreDamageLevel) || DAMAGE_LEVELS[1];
    return (
      <div className="fade-in">
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title"><span>📸</span> Ảnh cũ cần phục hồi</div>
          <UploadZone image={restoreImage} setter={setRestoreImage} fileRef={restoreFileRef} label="Upload ảnh cũ / hư hại" />
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title"><span>⚡</span> Mức độ tổn hại</div>
          <div className="ratio-grid">
            {DAMAGE_LEVELS.map(d => (
              <button
                key={d.level}
                className={`ratio-btn ${restoreDamageLevel === d.level ? 'active' : ''}`}
                onClick={() => setRestoreDamageLevel(d.level)}
                title={d.desc}
              >
                {d.icon} {d.name}
              </button>
            ))}
          </div>
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            {damageInfo.icon} <strong>{damageInfo.name}</strong>: {damageInfo.desc}
          </div>
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title"><span>💬</span> Yêu cầu bổ sung <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-muted)' }}>(tuỳ chọn)</span></div>
          <input
            className="input-field"
            value={restoreCustomPrompt}
            onChange={e => setRestoreCustomPrompt(e.target.value)}
            placeholder="Ví dụ: ảnh đen trắng, tô màu tự nhiên..."
          />
        </div>

        {/* Quality Scores */}
        {restoreScores && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-title"><span>📊</span> Điểm chất lượng</div>
            {[
              { key: 'face', label: '👤 Khuôn mặt', threshold: 9, method: restoreScores.faceMethod },
              { key: 'objects', label: '🏠 Vật thể', threshold: 8 },
              { key: 'clothing', label: '👔 Trang phục', threshold: 8 },
              { key: 'color', label: '🎨 Màu sắc', threshold: 8 },
            ].map(item => {
              const score = restoreScores[item.key] || 0;
              const passed = score >= item.threshold;
              const pct = (score / 10) * 100;
              const color = passed ? '#4caf50' : score >= item.threshold - 1 ? '#ff9800' : '#f44336';
              return (
                <div key={item.key} style={{ marginBottom: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
                    <span>{item.label} {item.method && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>({item.method}{restoreScores.cosine != null && item.key === 'face' ? ` · cos: ${restoreScores.cosine}` : ''})</span>}</span>
                    <span style={{ fontWeight: 700, color }}>
                      {score}/10 {passed ? '✓' : '✗'}
                      <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 4 }}>(cần ≥{item.threshold})</span>
                    </span>
                  </div>
                  <div style={{ height: 6, background: 'rgba(255,255,255,0.1)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 3, transition: 'width 0.5s ease' }} />
                  </div>
                </div>
              );
            })}
            {restoreScores.pass
              ? <div style={{ marginTop: 8, padding: '8px 12px', background: 'rgba(76,175,80,0.15)', borderRadius: 8, fontSize: 13, color: '#4caf50' }}>✅ Đạt chuẩn chất lượng!</div>
              : <div style={{ marginTop: 8, padding: '8px 12px', background: 'rgba(255,152,0,0.15)', borderRadius: 8, fontSize: 13, color: '#ff9800' }}>⚠️ Chưa đạt tối đa — đây là kết quả tốt nhất sau 3 lần thử</div>
            }
          </div>
        )}

        <button className="btn btn-primary btn-lg" onClick={handleRestore} disabled={loading || !restoreImage} style={{ width: '100%' }}>
          🔧 Phục hồi ảnh
        </button>
      </div>
    );
  }

  function renderBatchTab() {
    const babyTemplates = allTemplates.filter(t => t.category === 'baby');
    const familyTemplates = allTemplates.filter(t => t.category === 'family');
    const customTemplates = allTemplates.filter(t => t.isCustom);
    const successCount = batchResults.filter(r => r.status === 'success').length;

    return (
      <div className="fade-in">
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title"><span>📂</span> Chọn ảnh</div>
          <div
            className={`upload-zone ${batchFiles.length > 0 ? 'has-image' : ''}`}
            onClick={() => batchFileRef.current?.click()}
          >
            {batchFiles.length > 0 ? (
              <div style={{ padding: 16 }}>
                <div style={{ fontSize: 28, marginBottom: 8 }}>📷 × {batchFiles.length}</div>
                <div className="upload-text">
                  {batchFiles.map(f => f.name).join(', ').substring(0, 150)}{batchFiles.length > 5 ? '...' : ''}
                </div>
                <button className="btn btn-sm btn-secondary" style={{ marginTop: 8 }} onClick={e => { e.stopPropagation(); setBatchFiles([]); }}>🗑️ Xoá</button>
              </div>
            ) : (
              <>
                <div className="upload-icon">📂</div>
                <div className="upload-text"><strong>Click</strong> chọn nhiều ảnh<br />Hỗ trợ JPG, PNG, WebP</div>
              </>
            )}
            <input ref={batchFileRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={handleBatchFilesSelect} />
          </div>
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title"><span>⚙️</span> Chế độ</div>
          <div className="ratio-grid" style={{ marginBottom: 12 }}>
            <button className={`ratio-btn ${batchMode === 'composite' ? 'active' : ''}`} onClick={() => setBatchMode('composite')}>🎭 Ghép nền</button>
            <button className={`ratio-btn ${batchMode === 'template' ? 'active' : ''}`} onClick={() => setBatchMode('template')}>🏮 Template</button>
          </div>

          {batchMode === 'composite' && (
            <>
              <label style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6, display: 'block' }}>Background chung</label>
              <UploadZone image={batchBgImage} setter={setBatchBgImage} fileRef={batchBgFileRef} label="Ảnh nền dùng chung" />
              <div className="toggle-group" style={{ marginTop: 12 }}>
                <div className="toggle-item" onClick={() => setBatchOptKeepFace(!batchOptKeepFace)}>
                  <div className={`toggle-switch ${batchOptKeepFace ? 'active' : ''}`}></div>
                  <span className="toggle-label">Giữ khuôn mặt</span>
                </div>
                <div className="toggle-item" onClick={() => setBatchOptKeepPose(!batchOptKeepPose)}>
                  <div className={`toggle-switch ${batchOptKeepPose ? 'active' : ''}`}></div>
                  <span className="toggle-label">Giữ tư thế</span>
                </div>
                <div className="toggle-item" onClick={() => setBatchOptMatchLight(!batchOptMatchLight)}>
                  <div className={`toggle-switch ${batchOptMatchLight ? 'active' : ''}`}></div>
                  <span className="toggle-label">Match ánh sáng</span>
                </div>
              </div>
              <div className="input-group">
                <label>Yêu cầu thêm</label>
                <input className="input-field" value={batchPrompt} onChange={e => setBatchPrompt(e.target.value)} placeholder="Tuỳ chọn..." />
              </div>
            </>
          )}

          {batchMode === 'template' && (
            <>
              <div className="template-category">👶 Em Bé</div>
              <div className="template-grid">
                {babyTemplates.map(t => (
                  <TemplateCard key={t.id} t={t} selected={batchSelectedTemplate === t.id} onSelect={setBatchSelectedTemplate} />
                ))}
              </div>
              <div className="template-category">👨‍👩‍👧‍👦 Gia Đình</div>
              <div className="template-grid">
                {familyTemplates.map(t => (
                  <TemplateCard key={t.id} t={t} selected={batchSelectedTemplate === t.id} onSelect={setBatchSelectedTemplate} />
                ))}
              </div>
              {customTemplates.length > 0 && (
                <>
                  <div className="template-category">✨ Tùy chỉnh</div>
                  <div className="template-grid">
                    {customTemplates.map(t => (
                      <TemplateCard key={t.id} t={t} selected={batchSelectedTemplate === t.id} onSelect={setBatchSelectedTemplate} />
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title"><span>📐</span> Tỉ lệ</div>
          <RatioSelector value={batchAspectRatio} onChange={setBatchAspectRatio} />
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
          <div className="toggle-item" onClick={() => setEnableQC(!enableQC)}>
            <div className={`toggle-switch ${enableQC ? 'active' : ''}`}></div>
            <span className="toggle-label">🔍 QC kiểm tra giải phẫu {enableQC ? '(Chậm hơn 2-3x)' : '(TẮT — Nhanh)'}</span>
          </div>
        </div>

        <button className="btn btn-primary btn-lg" onClick={handleBatchProcess} disabled={loading || batchFiles.length === 0} style={{ width: '100%', marginBottom: 16 }}>
          🚀 Chạy Batch ({batchFiles.length} ảnh)
        </button>

        {/* Progress */}
        {batchProgress.total > 0 && (
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-title"><span>📊</span> Tiến trình {batchProgress.current}/{batchProgress.total}</div>
            <div style={{ background: 'var(--bg-input)', borderRadius: 6, height: 8, overflow: 'hidden', marginBottom: 12 }}>
              <div style={{ width: `${(batchProgress.current / batchProgress.total) * 100}%`, height: '100%', background: 'var(--gradient-accent)', borderRadius: 6, transition: 'width 0.3s' }}></div>
            </div>
            {successCount > 0 && (
              <button className="btn btn-success btn-sm" onClick={handleBatchDownloadAll}>
                💾 Tải tất cả ({successCount} ảnh)
              </button>
            )}
          </div>
        )}

        {/* Results */}
        {batchResults.length > 0 && (
          <div className="card">
            <div className="card-title"><span>📋</span> Kết quả</div>
            <div style={{ maxHeight: 400, overflowY: 'auto' }}>
              {batchResults.map((r, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 16 }}>{r.status === 'success' ? '✅' : r.status === 'warning' ? '⚠️' : '❌'}</span>
                    <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{r.fileName}</span>
                  </div>
                  {(r.status === 'success' || r.status === 'warning') && (
                    <button className="btn btn-sm btn-secondary" onClick={() => handleBatchDownloadOne(r)}>💾</button>
                  )}
                  {r.status === 'warning' && (
                    <span style={{ fontSize: 11, color: '#ff9800' }}>{r.message.substring(0, 50)}</span>
                  )}
                  {r.status === 'error' && (
                    <span style={{ fontSize: 11, color: 'var(--danger)' }}>{r.message.substring(0, 40)}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ========== LIBRARY TAB (Gallery) ==========
  const loadGallery = useCallback(async () => {
    if (!supa.isConfigured()) return;
    setGalleryLoading(true);
    try {
      const files = await supa.listFiles('created_at', 'desc');
      setGalleryFiles(files);
      const info = await supa.getStorageUsed();
      setSupaStorageInfo({ totalMB: info.totalMB, totalFiles: info.totalFiles });
    } catch (e) {
      console.error('Gallery load error:', e);
    }
    setGalleryLoading(false);
  }, []);

  // Auto-load gallery when switching to library tab
  useEffect(() => {
    if (activeTab === 'library') loadGallery();
  }, [activeTab, loadGallery]);

  const handleDeleteGalleryFile = async (filename) => {
    if (!confirm(`Xóa ảnh ${filename}?`)) return;
    const ok = await supa.deleteFile(filename);
    if (ok) {
      setGalleryFiles(prev => prev.filter(f => f.name !== filename));
      const info = await supa.getStorageUsed();
      setSupaStorageInfo({ totalMB: info.totalMB, totalFiles: info.totalFiles });
    }
  };

  const handleDownloadGalleryFile = (filename) => {
    const url = supa.getPublicUrl(filename);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.target = '_blank';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  function renderLibraryTab() {
    if (!supa.isConfigured()) {
      return (
        <div className="card" style={{ textAlign: 'center', padding: 32 }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>☁️</div>
          <h3 style={{ marginBottom: 8 }}>Chưa kết nối Cloud Storage</h3>
          <p style={{ color: 'var(--text-muted)', marginBottom: 16 }}>Cấu hình Supabase ở header để sử dụng thư viện</p>
        </div>
      );
    }

    const FILTERS = [
      { id: 'all', label: 'Tất cả' },
      { id: 'template', label: '🏮 Template' },
      { id: 'composite', label: '🎭 Ghép nền' },
      { id: 'edit', label: '✏️ Chỉnh sửa' },
      { id: 'upscale', label: '⬆️ Upscale' },
      { id: 'faceswap', label: '🔄 Face Swap' },
    ];

    const filtered = galleryFilter === 'all' ? galleryFiles : galleryFiles.filter(f => f.name.startsWith(galleryFilter));

    return (
      <div style={{ width: '100%' }}>
        {/* Header stats */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
            <div>
              <div className="card-title" style={{ marginBottom: 4 }}><span>🖼️</span> Thư viện ảnh</div>
              {supaStorageInfo && (
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {supaStorageInfo.totalFiles} ảnh • {supaStorageInfo.totalMB.toFixed(1)}MB / {supa.MAX_STORAGE_MB}MB
                </span>
              )}
            </div>
            <button className="btn btn-secondary btn-sm" onClick={loadGallery} disabled={galleryLoading}>
              🔄 {galleryLoading ? 'Đang tải...' : 'Làm mới'}
            </button>
          </div>

          {/* Storage bar */}
          {supaStorageInfo && (
            <div style={{ marginTop: 12, background: 'var(--bg-input)', borderRadius: 6, height: 6, overflow: 'hidden' }}>
              <div style={{
                width: `${Math.min((supaStorageInfo.totalMB / supa.MAX_STORAGE_MB) * 100, 100)}%`,
                height: '100%',
                background: supaStorageInfo.totalMB > supa.MAX_STORAGE_MB * 0.8 ? '#ff5252' : 'var(--gradient-accent)',
                borderRadius: 6,
                transition: 'width 0.3s'
              }}></div>
            </div>
          )}
        </div>

        {/* Filters */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
          {FILTERS.map(f => (
            <button
              key={f.id}
              className={`btn btn-sm ${galleryFilter === f.id ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setGalleryFilter(f.id)}
              style={{ fontSize: 12, padding: '4px 10px' }}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Gallery Grid */}
        {galleryLoading ? (
          <div style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>
            <div className="loading-spinner" style={{ margin: '0 auto 12px' }}></div>
            Đang tải thư viện...
          </div>
        ) : filtered.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', padding: 32 }}>
            <div style={{ fontSize: 48, marginBottom: 8 }}>📭</div>
            <p style={{ color: 'var(--text-muted)' }}>Chưa có ảnh nào{galleryFilter !== 'all' ? ' trong danh mục này' : ''}</p>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
            {filtered.map((file, i) => {
              const url = supa.getPublicUrl(file.name);
              const sizeMB = ((file.metadata?.size || 0) / (1024 * 1024)).toFixed(1);
              const date = file.created_at ? new Date(file.created_at) : null;
              const dateStr = date ? `${date.getDate()}/${date.getMonth() + 1} ${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}` : '';
              const typeIcon = file.name.startsWith('template') ? '🏮' : file.name.startsWith('composite') ? '🎭' : file.name.startsWith('edit') ? '✏️' : file.name.startsWith('upscale') ? '⬆️' : file.name.startsWith('faceswap') ? '🔄' : file.name.startsWith('restore') ? '🔧' : '📷';
              return (
                <div key={i} className="card" style={{ padding: 0, overflow: 'hidden', cursor: 'pointer', transition: 'transform 0.2s', position: 'relative' }}
                  onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.03)'}
                  onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
                >
                  <img
                    src={url}
                    alt={file.name}
                    style={{ width: '100%', aspectRatio: '3/4', objectFit: 'cover', display: 'block', borderRadius: '8px 8px 0 0' }}
                    onClick={() => setGalleryPreview(url)}
                    loading="lazy"
                  />
                  <div style={{ padding: '6px 8px' }}>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span>{typeIcon} {dateStr}</span>
                      <span>{sizeMB}MB</span>
                    </div>
                    <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                      <button className="btn btn-sm btn-secondary" style={{ flex: 1, fontSize: 11, padding: '2px 0' }} onClick={(e) => { e.stopPropagation(); handleDownloadGalleryFile(file.name); }}>💾</button>
                      <button className="btn btn-sm" style={{ flex: 1, fontSize: 11, padding: '2px 0', background: 'rgba(255,82,82,0.15)', color: '#ff5252', border: 'none' }} onClick={(e) => { e.stopPropagation(); handleDeleteGalleryFile(file.name); }}>🗑</button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Lightbox */}
        {galleryPreview && (
          <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.9)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
            onClick={() => setGalleryPreview(null)}
          >
            <img src={galleryPreview} alt="preview" style={{ maxWidth: '90vw', maxHeight: '90vh', objectFit: 'contain', borderRadius: 8 }} />
            <button style={{ position: 'absolute', top: 16, right: 16, background: 'rgba(255,255,255,0.2)', border: 'none', color: 'white', fontSize: 24, borderRadius: '50%', width: 40, height: 40, cursor: 'pointer' }}>✕</button>
          </div>
        )}
      </div>
    );
  }

  // ========== MAIN RENDER ==========
  return (
    <div className="app-container">
      {/* Header */}
      <header className="app-header">
        <h1><span>📷</span> Thu Bình Camera <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8 }}>📞 0914003345</span></h1>
        <div className="api-key-bar">
          {keyValid !== null && <span className={`key-status ${keyValid ? 'valid' : 'invalid'}`}></span>}
          <input
            type="password"
            value={key}
            onChange={e => setKey(e.target.value)}
            placeholder="Gemini API Key..."
            onKeyDown={e => e.key === 'Enter' && handleVerifyKey()}
          />
          <button className="btn btn-secondary btn-sm" onClick={handleVerifyKey} disabled={loading}>
            ✓ Xác thực
          </button>
        </div>

        {/* Cloud Storage Status (auto-connected) */}
        {supaStorageInfo && (
          <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: '#4caf50' }}>●</span>
            ☁️ {supaStorageInfo.totalFiles} ảnh • {supaStorageInfo.totalMB.toFixed(0)}MB / {supa.MAX_STORAGE_MB}MB
          </div>
        )}
      </header>

      {/* Tabs */}
      <div className="tabs-container">
        {[
          { id: 'edit', icon: '✏️', label: 'Chỉnh sửa' },
          { id: 'composite', icon: '🎭', label: 'Ghép nền' },
          { id: 'template', icon: '🏮', label: 'Template' },
          { id: 'upscale', icon: '⬆️', label: 'Upscale 4K' },
          { id: 'faceswap', icon: '🔄', label: 'Face Swap' },
          { id: 'restore', icon: '🔧', label: 'Phục hồi' },
          { id: 'batch', icon: '📂', label: 'Batch' },
          { id: 'library', icon: '🖼️', label: 'Thư viện' },
        ].map(tab => (
          <button
            key={tab.id}
            className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.icon} {tab.label}
          </button>
        ))}
      </div>

      {/* Main Content */}
      <div className="main-content">
        {/* Left - Controls */}
        <div>
          {activeTab === 'edit' && renderEditTab()}
          {activeTab === 'composite' && renderCompositeTab()}
          {activeTab === 'template' && renderTemplateTab()}
          {activeTab === 'upscale' && renderUpscaleTab()}
          {activeTab === 'faceswap' && renderFaceSwapTab()}
          {activeTab === 'restore' && renderRestoreTab()}
          {activeTab === 'batch' && renderBatchTab()}
          {activeTab === 'library' && renderLibraryTab()}
        </div>

        {/* Right - Result + Logs */}
        <div className="sidebar">
          <div className="card">
            <div className="card-title"><span>🖼️</span> Kết quả</div>
            <div className="result-area">
              {resultImage ? (
                <>
                  <img src={`data:${resultImage.mimeType || 'image/png'};base64,${resultImage.data}`} alt="result" />
                  <button className="download-btn" onClick={handleDownload}>
                    💾 Tải về
                  </button>
                </>
              ) : (
                <div className="result-placeholder">
                  <div className="placeholder-icon">🎨</div>
                  <p>Kết quả sẽ hiện ở đây</p>
                </div>
              )}
            </div>
          </div>

          {/* Status Bar */}
          <div className="status-bar">
            <div className="status-text">
              <span className={`status-dot ${loading ? 'loading' : ''}`}></span>
              {status}
            </div>
            <div className="cost-display">
              <span>🖼️ {costs.imageCount}</span>
              <span className="cost-value">${getTotalCost().toFixed(3)}</span>
            </div>
          </div>

          {/* Logs */}
          <div className="logs-panel">
            <div className="logs-header" onClick={() => setShowLogs(!showLogs)}>
              <h3>📋 Logs {logs.length > 0 && `(${logs.length})`}</h3>
              <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{showLogs ? '▼' : '▶'}</span>
            </div>
            {showLogs && (
              <div className="logs-body">
                {logs.map((log, i) => (
                  <div key={i} className="log-entry">{log}</div>
                ))}
                {logs.length === 0 && <div className="log-entry" style={{ color: 'var(--text-muted)' }}>Chưa có log...</div>}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Loading Overlay — 2 columns: Image Gallery + Realtime Logs */}
      {loading && (
        <div className="loading-overlay" style={{ flexDirection: 'column', gap: 0, padding: '16px 20px', alignItems: 'center' }}>
          {/* Status bar */}
          <div style={{ textAlign: 'center', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
            <div className="loading-spinner" style={{ width: 24, height: 24, borderWidth: 3 }}></div>
            <div className="loading-text" style={{ fontSize: 14 }}>{status}</div>
          </div>

          {/* 2-column layout */}
          <div style={{
            display: 'flex', gap: 12, width: '100%', maxWidth: 1100, maxHeight: '75vh',
            flex: 1, minHeight: 0
          }}>
            {/* LEFT: Image comparison gallery */}
            <div style={{
              flex: '0 0 55%', background: 'rgba(0,0,0,0.85)', borderRadius: 12,
              border: '1px solid rgba(255,255,255,0.1)', overflow: 'hidden',
              display: 'flex', flexDirection: 'column'
            }}>
              <div style={{ padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.1)', fontSize: 13, fontWeight: 600, color: 'var(--text-muted)' }}>
                🖼️ So sánh versions {restoreAttempts.length > 0 && `(${restoreAttempts.length} lần)`}
              </div>
              <div style={{
                flex: 1, overflowY: 'auto', padding: 12,
                display: 'flex', flexWrap: 'wrap', gap: 10, alignContent: 'flex-start'
              }}>
                {/* Original image */}
                {restoreImage && (
                  <div style={{
                    width: 'calc(50% - 5px)', background: 'rgba(255,255,255,0.05)',
                    borderRadius: 10, overflow: 'hidden', border: '2px solid rgba(100,181,246,0.4)'
                  }}>
                    <div style={{ position: 'relative' }}>
                      <img
                        src={restoreImage.startsWith('data:') ? restoreImage : `data:image/jpeg;base64,${restoreImage}`}
                        alt="Original"
                        style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', display: 'block' }}
                      />
                      <div style={{
                        position: 'absolute', top: 6, left: 6, background: '#1976d2',
                        color: '#fff', fontSize: 10, fontWeight: 700, padding: '2px 8px',
                        borderRadius: 4
                      }}>GỐC</div>
                    </div>
                    <div style={{ padding: '6px 8px', fontSize: 10, color: 'var(--text-muted)' }}>
                      Ảnh gốc (trước phục hồi)
                    </div>
                  </div>
                )}

                {/* Generated versions */}
                {restoreAttempts.map((ver) => {
                  const scoreColor = ver.passed ? '#4caf50' : ver.avgScore >= 7 ? '#ff9800' : '#f44336';
                  return (
                    <div key={ver.attempt} style={{
                      width: 'calc(50% - 5px)', background: 'rgba(255,255,255,0.05)',
                      borderRadius: 10, overflow: 'hidden',
                      border: `2px solid ${ver.passed ? 'rgba(76,175,80,0.5)' : 'rgba(255,255,255,0.1)'}`
                    }}>
                      <div style={{ position: 'relative' }}>
                        <img
                          src={`data:${ver.mimeType};base64,${ver.imgData}`}
                          alt={`Attempt ${ver.attempt}`}
                          style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', display: 'block' }}
                        />
                        <div style={{
                          position: 'absolute', top: 6, left: 6, background: scoreColor,
                          color: '#fff', fontSize: 10, fontWeight: 700, padding: '2px 8px',
                          borderRadius: 4
                        }}>{ver.passed ? '✓ PASS' : `#${ver.attempt}`}</div>
                        <div style={{
                          position: 'absolute', top: 6, right: 6, background: 'rgba(0,0,0,0.7)',
                          color: scoreColor, fontSize: 12, fontWeight: 700, padding: '2px 8px',
                          borderRadius: 4
                        }}>{ver.avgScore}/10</div>
                      </div>
                      <div style={{ padding: '6px 8px' }}>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {[
                            { key: 'face', icon: '👤', threshold: 9 },
                            { key: 'objects', icon: '🏠', threshold: 8 },
                            { key: 'clothing', icon: '👔', threshold: 8 },
                            { key: 'color', icon: '🎨', threshold: 8 }
                          ].map(s => {
                            const val = ver.scores[s.key];
                            const ok = val >= s.threshold;
                            return (
                              <span key={s.key} style={{
                                fontSize: 9, padding: '1px 5px', borderRadius: 3,
                                background: ok ? 'rgba(76,175,80,0.15)' : 'rgba(244,67,54,0.15)',
                                color: ok ? '#4caf50' : '#f44336',
                                fontWeight: 600
                              }}>{s.icon}{val}</span>
                            );
                          })}
                        </div>
                        {ver.cosine != null && (
                          <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 3 }}>
                            {ver.faceMethod} cos: {ver.cosine}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}

                {/* Placeholder when no attempts yet */}
                {restoreAttempts.length === 0 && (
                  <div style={{
                    width: 'calc(50% - 5px)', background: 'rgba(255,255,255,0.03)',
                    borderRadius: 10, border: '2px dashed rgba(255,255,255,0.1)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    aspectRatio: '1', color: 'var(--text-muted)', fontSize: 12
                  }}>
                    Đang tạo ảnh...
                  </div>
                )}
              </div>
            </div>

            {/* RIGHT: Realtime Logs */}
            <div style={{
              flex: '0 0 45%', background: 'rgba(0,0,0,0.85)', borderRadius: 12,
              border: '1px solid rgba(255,255,255,0.1)', overflow: 'hidden',
              display: 'flex', flexDirection: 'column'
            }}>
              <div style={{ padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.1)', fontSize: 13, fontWeight: 600, color: 'var(--text-muted)' }}>
                📋 Realtime Logs ({logs.length})
              </div>
              <div
                ref={el => { if (el) el.scrollTop = el.scrollHeight; }}
                style={{
                  flex: 1, overflowY: 'auto', padding: '8px 14px',
                  fontFamily: 'monospace', fontSize: 11, lineHeight: 1.6
                }}
              >
                {[...logs].reverse().map((log, i, arr) => (
                  <div key={arr.length - 1 - i} style={{
                    color: log.includes('✓') || log.includes('✅') || log.includes('PASS') ? '#4caf50'
                      : log.includes('⚠') || log.includes('❌') ? '#ff9800'
                      : log.includes('Error') ? '#f44336'
                      : log.includes('🔍') || log.includes('💾') ? '#64b5f6'
                      : 'rgba(255,255,255,0.75)',
                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                    padding: '2px 0'
                  }}>{log}</div>
                ))}
                {logs.length === 0 && <div style={{ color: 'var(--text-muted)' }}>Đang khởi tạo...</div>}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
