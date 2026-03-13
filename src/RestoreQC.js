/**
 * RestoreQC.js - AI-Powered Photo Restoration Quality Validation
 * Uses Gemini for quality scoring of restored photos.
 * Scores: Face ≥9/10, Objects ≥8/10, Clothing ≥8/10, Color ≥8/10
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

// Compress base64 image for QC (don't need full res for analysis)
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
 * Validate Restoration Quality
 * @param {string} originalB64 - Original damaged photo
 * @param {string} restoredB64 - Restored photo
 * @param {string} apiKey - Gemini API Key
 * @returns {Promise<{pass: boolean, scores: {face: number, objects: number, clothing: number, color: number}, issues: string}>}
 */
export async function validateRestoration(originalB64, restoredB64, apiKey) {
    if (!apiKey) return { pass: true, scores: { face: 0, objects: 0, clothing: 0, color: 0 }, issues: 'No API Key' };

    const [compOriginal, compResult] = await Promise.all([
        compressForQC(originalB64, 768),
        compressForQC(restoredB64, 768)
    ]);

    const prompt = `Compare RESTORED photo vs ORIGINAL damaged photo. This is a photo restoration task.
Score each category 1-10 based on how well the restoration preserves the original content:
1) FACE: facial features accuracy, proportions, expression, identity match (threshold: 9/10)
2) OBJECTS: objects, background elements, structural accuracy (threshold: 8/10)
3) CLOTHING: clothing, accessories, fabric patterns, textures (threshold: 8/10)
4) COLOR: natural colors, skin tones, overall color fidelity and harmony (threshold: 8/10)

If no face is visible, score face as 10.
Return JSON only:
{"face":number,"objects":number,"clothing":number,"color":number,"pass":boolean,"issue":"brief description of what needs fixing"}
pass = face>=9 AND objects>=8 AND clothing>=8 AND color>=8`;

    try {
        let res = null;
        for (let retry = 1; retry <= 3; retry++) {
            res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{
                        parts: [
                            { text: "ORIGINAL (damaged):" },
                            { inlineData: { mimeType: 'image/jpeg', data: compOriginal } },
                            { text: "RESTORED:" },
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

        if (!res || !res.ok) return { pass: true, scores: { face: 0, objects: 0, clothing: 0, color: 0 }, issues: 'API Fail' };

        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
        const result = extractJson(text);

        if (result) {
            const scores = {
                face: result.face || 0,
                objects: result.objects || 0,
                clothing: result.clothing || 0,
                color: result.color || 0,
            };
            return {
                pass: result.pass ?? (scores.face >= 9 && scores.objects >= 8 && scores.clothing >= 8 && scores.color >= 8),
                scores,
                issues: result.issue || 'Unknown issue'
            };
        }
        return { pass: true, scores: { face: 0, objects: 0, clothing: 0, color: 0 }, issues: 'Parse Fail' };

    } catch (e) {
        console.warn('RestoreQC Error:', e);
        return { pass: true, scores: { face: 0, objects: 0, clothing: 0, color: 0 }, issues: 'Error' };
    }
}
