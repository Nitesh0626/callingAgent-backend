// Lookup table for u-law to linear PCM (16-bit)
const ulawToLinear = new Int16Array(256);
// Lookup table for linear PCM (16-bit) to u-law
const linearToUlaw = new Uint8Array(65536);

// Initialize tables
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
    // Determine exponent (segment)
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

/**
 * Decodes u-law (8kHz) to Linear PCM (16-bit).
 * Returns Int16Array
 */
function decodeUlaw(buffer) {
  const len = buffer.length;
  const result = new Int16Array(len);
  for (let i = 0; i < len; i++) {
    result[i] = ulawToLinear[buffer[i]];
  }
  return result;
}

/**
 * Encodes Linear PCM (16-bit) to u-law (8kHz).
 * Input should be Int16Array.
 */
function encodeUlaw(buffer) {
  const len = buffer.length;
  const result = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    let val = buffer[i]; 
    result[i] = linearToUlaw[val + 32768];
  }
  return result;
}

/**
 * Upsample 8kHz -> 16kHz using Linear Interpolation
 * This creates much smoother audio than simple repetition.
 */
function upsample8kTo16k(pcm8k) {
    const len = pcm8k.length;
    const result = new Int16Array(len * 2);
    for (let i = 0; i < len; i++) {
        const current = pcm8k[i];
        const next = (i < len - 1) ? pcm8k[i + 1] : current;
        
        // Sample 1: The original point
        result[i * 2] = current;
        // Sample 2: The midpoint (average) between current and next
        result[i * 2 + 1] = (current + next) * 0.5; // Linear Interpolation
    }
    return result;
}

/**
 * Downsample 24kHz -> 8kHz (Take every 3rd sample)
 */
function downsample24kTo8k(pcm24k) {
    const len = pcm24k.length;
    const targetLen = Math.floor(len / 3);
    const result = new Int16Array(targetLen);
    for (let i = 0; i < targetLen; i++) {
        result[i] = pcm24k[i * 3];
    }
    return result;
}

/**
 * Helper: Convert Base64 string to Uint8Array (u-law bytes)
 */
function base64ToUint8(base64) {
    return Buffer.from(base64, 'base64');
}

/**
 * Helper: Convert Uint8Array (u-law bytes) to Base64 string
 */
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