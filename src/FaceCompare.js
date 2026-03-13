/**
 * FaceCompare.js — So sánh khuôn mặt bằng ArcFace ONNX + MediaPipe Face Detector
 * 
 * Flow: base64 → Image → MediaPipe Face Detector (crop mặt) → ArcFace ONNX (512D embedding) → cosine similarity
 * 
 * ArcFace: model chuyên dụng cho FACE IDENTITY
 * - Trained nhận diện "cùng 1 người" bất kể B&W/color, lighting, damage
 * - Output: 512-dim embedding vector
 * - So sánh: cosine similarity
 */

import { FilesetResolver, FaceDetector } from '@mediapipe/tasks-vision';
import * as ort from 'onnxruntime-web';

const ARCFACE_MODEL_URL = 'https://huggingface.co/garavv/arcface-onnx/resolve/main/arc.onnx';

let faceDetector = null;
let arcfaceSession = null;
let isInitialized = false;
let isInitializing = false;

// Mutex to prevent concurrent MediaPipe calls ("Session already started" error)
let detectLock = false;

async function initModels() {
  if (isInitialized) return;
  if (isInitializing) {
    while (isInitializing) await new Promise(r => setTimeout(r, 100));
    return;
  }
  isInitializing = true;

  try {
    // 1. MediaPipe Face Detector
    const vision = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
    );
    faceDetector = await FaceDetector.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
      },
      runningMode: 'IMAGE',
      minDetectionConfidence: 0.5
    });

    // 2. ArcFace ONNX
    ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@latest/dist/';
    arcfaceSession = await ort.InferenceSession.create(ARCFACE_MODEL_URL, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all'
    });

    isInitialized = true;
    console.log('✅ FaceCompare initialized (MediaPipe + ArcFace ONNX)');
  } catch (err) {
    console.error('FaceCompare init error:', err);
    throw err;
  } finally {
    isInitializing = false;
  }
}

// ========== Convert base64 to HTMLImageElement ==========
function base64ToImage(base64Data) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = base64Data.startsWith('data:') ? base64Data : `data:image/jpeg;base64,${base64Data}`;
  });
}

// ========== Detect face with mutex (prevent "Session already started") ==========
async function safeDetectFace(img) {
  if (!faceDetector) return null;

  // Wait for lock to be released
  while (detectLock) await new Promise(r => setTimeout(r, 50));
  detectLock = true;

  try {
    const detections = faceDetector.detect(img);
    if (!detections.detections || detections.detections.length === 0) return null;

    const face = detections.detections[0];
    const bbox = face.boundingBox;

    // Expand bounding box by 20%
    const expand = 0.2;
    const expandW = bbox.width * expand;
    const expandH = bbox.height * expand;
    const x = Math.max(0, bbox.originX - expandW / 2);
    const y = Math.max(0, bbox.originY - expandH / 2);
    const w = Math.min(img.width - x, bbox.width + expandW);
    const h = Math.min(img.height - y, bbox.height + expandH);

    // Crop and resize to 112x112 (ArcFace input)
    const canvas = document.createElement('canvas');
    canvas.width = 112;
    canvas.height = 112;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, x, y, w, h, 0, 0, 112, 112);
    return canvas;
  } catch (err) {
    console.warn('Face detect error:', err);
    return null;
  } finally {
    detectLock = false;
  }
}

// ========== Get 512D ArcFace embedding ==========
async function getArcFaceEmbedding(faceCanvas) {
  if (!arcfaceSession) return null;

  const ctx = faceCanvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, 112, 112);
  const pixels = imageData.data;

  // Preprocess: RGB, normalize (pixel - 127.5) / 128.0, shape (1, 112, 112, 3)
  const inputData = new Float32Array(1 * 112 * 112 * 3);
  for (let i = 0; i < 112 * 112; i++) {
    inputData[i * 3 + 0] = (pixels[i * 4 + 0] - 127.5) / 128.0;
    inputData[i * 3 + 1] = (pixels[i * 4 + 1] - 127.5) / 128.0;
    inputData[i * 3 + 2] = (pixels[i * 4 + 2] - 127.5) / 128.0;
  }

  const inputTensor = new ort.Tensor('float32', inputData, [1, 112, 112, 3]);
  const inputName = arcfaceSession.inputNames[0];
  const outputName = arcfaceSession.outputNames[0];

  const results = await arcfaceSession.run({ [inputName]: inputTensor });
  const embedding = results[outputName].data;

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < embedding.length; i++) norm += embedding[i] * embedding[i];
  norm = Math.sqrt(norm);
  const normalized = new Float32Array(embedding.length);
  for (let i = 0; i < embedding.length; i++) normalized[i] = embedding[i] / norm;

  return normalized;
}

// ========== Cosine similarity ==========
function cosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

// ========== Main: Compare faces ==========
export async function compareFaces(originalBase64, restoredBase64) {
  try {
    await initModels();

    const [origImg, restImg] = await Promise.all([
      base64ToImage(originalBase64),
      base64ToImage(restoredBase64)
    ]);

    // Detect faces SEQUENTIALLY (not parallel) to avoid "Session already started"
    const origFace = await safeDetectFace(origImg);
    const restFace = await safeDetectFace(restImg);

    if (!origFace && !restFace) {
      return { score: 8, cosine: null, hasFace: false, details: 'Không phát hiện khuôn mặt trong cả 2 ảnh — bỏ qua face check' };
    }
    if (!origFace) {
      return { score: 7, cosine: null, hasFace: false, details: 'Không phát hiện khuôn mặt ảnh gốc (quá hư hại) — giảm yêu cầu' };
    }
    if (!restFace) {
      return { score: 3, cosine: null, hasFace: true, details: 'Không phát hiện khuôn mặt ảnh phục hồi — cần làm lại!' };
    }

    // ArcFace embeddings (can run parallel since ONNX handles concurrency)
    const [origEmbed, restEmbed] = await Promise.all([
      getArcFaceEmbedding(origFace),
      getArcFaceEmbedding(restFace)
    ]);

    if (!origEmbed || !restEmbed) {
      return { score: 6, cosine: null, hasFace: true, details: 'Không trích xuất được embedding — fallback Gemini' };
    }

    const cosine = cosineSimilarity(origEmbed, restEmbed);

    // Score mapping for damaged → restored context
    let score;
    if (cosine >= 0.5) score = 10;
    else if (cosine >= 0.4) score = 9;
    else if (cosine >= 0.3) score = 8;
    else if (cosine >= 0.2) score = 6;
    else if (cosine >= 0.1) score = 4;
    else score = 2;

    let details = '';
    if (score >= 9) details = 'Khuôn mặt giống gốc — PASS ✅';
    else if (score >= 8) details = 'Khuôn mặt khá giống, ảnh hưởng từ hư hại';
    else if (score >= 6) details = 'Khuôn mặt có sai khác — có thể do ảnh gốc hư nặng';
    else details = 'Khuôn mặt sai lệch nhiều — cần làm lại!';

    return {
      score,
      cosine: Math.round(cosine * 1000) / 1000,
      hasFace: true,
      details
    };
  } catch (err) {
    console.error('FaceCompare error:', err);
    return { score: 0, cosine: null, hasFace: false, details: `Error: ${err.message}` };
  }
}

export async function preloadFaceCompare() {
  try {
    await initModels();
    return true;
  } catch {
    return false;
  }
}
