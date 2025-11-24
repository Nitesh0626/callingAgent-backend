// Lookup table for u-law to linear PCM (16-bit)
const ulawToLinear = new Int16Array(256);
// Lookup table for linear PCM (16-bit) to u-law
const linearToUlaw = new Uint8Array(65536);

(function initTables() {
  const BIAS = 0x84;
  const CLIP = 8159;
  const SEG_MASK = 0x70;
  const SEG_SHIFT = 4;
  const SIGN_BIT = 0x80;

  for (let i = 0; i < 256; i++) {
    let ulaw = ~i;
    let t = ((ulaw & 0x0f) << 3) + BIAS;
    t <<= (ulaw & SEG_MASK) >>> SEG_SHIFT;
    ulawToLinear[i] = (ulaw & SIGN_BIT) ? (BIAS - t) : (t - BIAS);
  }

  for (let i = -32768; i <= 32767; i++) {
    let sample = i;
    let sign = (sample >> 8) & 0x80;
    if (sample < 0) sample = -sample;
    if (sample > CLIP) sample = CLIP;
    sample += BIAS;
    let exponent = 0;
    if (sample > 0x1F) {
        exponent = 1;
        if (sample > 0x3F) {
            exponent = 2;
            if (sample > 0x7F) {
                exponent = 3;
                if (sample > 0xFF) {
                    exponent = 4;
                    if (sample > 0x1FF) {
                        exponent = 5;
                        if (sample > 0x3FF) {
                            exponent = 6;
                            if (sample > 0x7FF) {
                                exponent = 7;
                            }
                        }
                    }
                }
            }
        }
    }
    let mantissa = (sample >> (exponent + 3)) & 0x0F;
    let ulawByte = ~(sign | (exponent << 4) | mantissa);
    linearToUlaw[i + 32768] = ulawByte & 0xFF;
  }
})();

function decodeUlaw(buffer) {
  const len = buffer.length;
  const result = new Int16Array(len);
  for (let i = 0; i < len; i++) {
    result[i] = ulawToLinear[buffer[i]];
  }
  return result;
}

function encodeUlaw(buffer) {
  const len = buffer.length;
  const result = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    let val = buffer[i]; 
    result[i] = linearToUlaw[val + 32768];
  }
  return result;
}

function upsample8kTo16k(pcm8k) {
    const len = pcm8k.length;
    const result = new Int16Array(len * 2);
    for (let i = 0; i < len; i++) {
        const current = pcm8k[i];
        const next = (i < len - 1) ? pcm8k[i + 1] : current;
        result[i * 2] = current;
        result[i * 2 + 1] = (current + next) / 2;
    }
    return result;
}

/**
 * CRITICAL FIX: Weighted Average Downsampling
 * Instead of a simple average, we use weights [0.25, 0.5, 0.25]
 * This acts as a low-pass filter, significantly smoothing digital artifacts.
 */
function downsample24kTo8k(pcm24k) {
    const len = pcm24k.length;
    const targetLen = Math.floor(len / 3);
    const result = new Int16Array(targetLen);
    
    for (let i = 0; i < targetLen; i++) {
        const idx = i * 3;
        // Safety check for array bounds
        if (idx + 2 < len) {
            const p1 = pcm24k[idx];
            const p2 = pcm24k[idx + 1];
            const p3 = pcm24k[idx + 2];
            
            // Weighted Triangle Filter
            // Center sample has more weight.
            result[i] = (p1 * 0.25) + (p2 * 0.5) + (p3 * 0.25);
        } else {
            result[i] = pcm24k[idx];
        }
    }
    return result;
}

function base64ToUint8(base64) {
    return Buffer.from(base64, 'base64');
}

function uint8ToBase64(bytes) {
    return Buffer.from(bytes).toString('base64');
}

module.exports = {
    decodeUlaw,
    encodeUlaw,
    upsample8kTo16k,
    downsample24kTo8k,
    base64ToUint8,
    uint8ToBase64
};
