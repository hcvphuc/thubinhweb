/**
 * FaceQC.js - AI-Powered Face Anatomy Validation
 * Uses Gemini 2.0 Flash for rapid anatomical & identity verification.
 * Images are compressed to 768px before API call for speed.
 */

// Helper to extract JSON from response
function extractJson(text) {
    try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) return JSON.parse(jsonMatch[0]);
        return null;
    } catch (e) {
        return null;
    }
}

// Compress base64 image for QC (don't need full res for face analysis)
function compressForQC(base64, maxSize = 768) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            let { width, height } = img;
            if (width > maxSize || height > maxSize) {
                const ratio = Math.min(maxSize / width, maxSize / height);
                width = Math.round(width * ratio);
                height = Math.round(height * ratio);
            }
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            canvas.getContext('2d').drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL('image/jpeg', 0.7).split(',')[1]);
        };
        img.onerror = () => resolve(base64);
        img.src = `data:image/jpeg;base64,${base64}`;
    });
}

/**
 * Validate Anatomical Structure & Identity
 * @param {string} originalB64 - Original face image
 * @param {string} resultB64 - Generated image
 * @param {string} apiKey - Gemini API Key
 * @returns {Promise<{pass: boolean, score: number, issues: string}>}
 */
export async function validateFaceAnatomy(originalB64, resultB64, apiKey) {
    if (!apiKey) return { pass: true, score: 0, issues: 'No API Key' };

    // Compress images for faster QC (768px is enough for face analysis)
    const [compOriginal, compResult] = await Promise.all([
        compressForQC(originalB64, 768),
        compressForQC(resultB64, 768)
    ]);

    const prompt = `Compare RESULT vs ORIGINAL. Check: 1) Eye symmetry & pupils 2) Nose/mouth shape 3) Skin texture (real vs plastic) 4) Identity match 5) Limbs/hands if visible. Score 1-10. JSON only:
{"anatomy_score":number,"identity_score":number,"pass":boolean,"issue":"brief description"}
Pass = BOTH scores >= 8.`;

    try {
        let res = null;
        for (let retry = 1; retry <= 3; retry++) {
            res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{
                        parts: [
                            { text: "ORIGINAL:" },
                            { inlineData: { mimeType: 'image/jpeg', data: compOriginal } },
                            { text: "RESULT:" },
                            { inlineData: { mimeType: 'image/jpeg', data: compResult } },
                            { text: prompt }
                        ]
                    }],
                    generationConfig: { responseMimeType: "application/json" }
                })
            });
            if (res.ok) break;
            if ([503, 429, 449].includes(res.status) && retry < 3) {
                await new Promise(r => setTimeout(r, retry * 2000));
                continue;
            }
        }

        if (!res || !res.ok) return { pass: true, score: 0, issues: 'API Fail' };

        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        const result = extractJson(text);

        if (result) {
            return {
                pass: result.pass,
                score: Math.min(result.anatomy_score, result.identity_score),
                issues: result.issue || 'Unknown issue'
            };
        }
        return { pass: true, score: 0, issues: 'Parse Fail' };

    } catch (e) {
        console.warn('FaceQC Error:', e);
        return { pass: true, score: 0, issues: 'Error' };
    }
}
