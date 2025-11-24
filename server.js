require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const { 
    decodeUlaw, 
    encodeUlaw, 
    upsample8kTo16k, 
    downsample24kTo8k,
    base64ToUint8, 
    uint8ToBase64 
} = require('./audio-utils');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY; // Must be set in .env
const ORDERS_FILE = path.join(__dirname, 'orders.json');

// --- HELPER: LOGGING WITH COLORS ---
const LOG_COLORS = {
    reset: "\x1b[0m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    red: "\x1b[31m",
    cyan: "\x1b[36m"
};

function log(type, message) {
    // Clear line if we were printing dots
    if (process.stdout.clearLine) {
        process.stdout.clearLine();
        process.stdout.cursorTo(0);
    }
    
    const timestamp = new Date().toLocaleTimeString();
    let color = LOG_COLORS.reset;
    let label = type.toUpperCase();

    switch (type) {
        case 'user': color = LOG_COLORS.blue; break;
        case 'agent': color = LOG_COLORS.yellow; break;
        case 'system': color = LOG_COLORS.cyan; break;
        case 'tool': color = LOG_COLORS.green; break;
        case 'error': color = LOG_COLORS.red; break;
    }

    console.log(`${LOG_COLORS.reset}[${timestamp}] ${color}[${label}] ${message}${LOG_COLORS.reset}`);
}

// --- HELPER: SAVE ORDER TO FILE ---
function saveOrderToFile(order) {
    let orders = [];
    if (fs.existsSync(ORDERS_FILE)) {
        try {
            const data = fs.readFileSync(ORDERS_FILE, 'utf8');
            orders = JSON.parse(data);
        } catch (e) {
            log('error', 'Could not read orders file, starting new.');
        }
    }
    orders.unshift(order); // Add to top
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
    log('tool', `Order #${order.id} saved to orders.json`);
}

// --- SYSTEM PROMPT ---
const SYSTEM_INSTRUCTION = `
SYSTEM: You are BakeCall AI — a short-sentence voice booking assistant for bakeries. Use very short sentences (1–6 words). Detect caller language (Nepali or English) from first utterance and continue in that language. Your primary goal: capture required slots quickly: name, phone, address.

SLOT RULES:
- customer_name: required. Ask "May I have your name?"
- phone_number: required. Ask "Please tell me your phone number."
- address: required. Ask "Please tell your delivery address."
- items: optional. If requested, ask "Which cake?" "Size?" "Quantity?"

ACTION RULES:
- Confirm all collected facts before saving.
- If confirmed, call tool:create_order.
- If user says "agent", call tool:transfer_to_agent.
- TTS STYLE: Very short sentences, neutral, polite.
`;

const tools = [{
    functionDeclarations: [{
        name: "create_order",
        description: "Create order",
        parameters: {
            type: "OBJECT",
            properties: {
                customer_name: { type: "STRING" },
                phone_number: { type: "STRING" },
                address: { type: "STRING" },
                items: { type: "ARRAY", items: { type: "OBJECT", properties: { product: { type: "STRING" }, quantity: { type: "NUMBER" } } } }
            },
            required: ["customer_name", "phone_number", "address"]
        }
    }, {
        name: "transfer_to_agent",
        description: "Transfer call",
        parameters: { type: "OBJECT", properties: { reason: { type: "STRING" } } }
    }]
}];

// --- HTTP ROUTES ---

app.get('/', (req, res) => {
    res.send('BakeCall AI Backend is running.');
});

// Twilio Webhook
app.post('/incoming', (req, res) => {
    const host = req.headers.host;
    const twiml = `
    <Response>
        <Say>Hello, connecting you to BakeCall.</Say>
        <Connect>
            <Stream url="wss://${host}/media-stream" />
        </Connect>
    </Response>
    `;
    res.type('text/xml');
    res.send(twiml);
});

// --- WEBSOCKET SERVER ---

wss.on('connection', async (ws) => {
    log('system', 'Twilio media stream connected');
    
    let streamSid = null;
    let geminiSession = null;
    let isSessionOpen = false;

    const ai = new GoogleGenAI({ apiKey: API_KEY });
    
    const config = {
        responseModalities: ["AUDIO"],
        systemInstruction: SYSTEM_INSTRUCTION,
        tools: tools,
        speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
        },
    };

    try {
        const sessionPromise = ai.live.connect({
            model: 'gemini-2.5-flash-native-audio-preview-09-2025',
            config,
            callbacks: {
                onopen: () => {
                    log('system', "Gemini Session Opened");
                    isSessionOpen = true;
                    // SEND INITIAL HELLO to break silence
                    sessionPromise.then(s => s.sendRealtimeInput([{ text: "Say 'Hello! How can I help you order today?'" }]));
                },
                onmessage: async (msg) => {
                    // Audio Output
                    if (msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data) {
                        log('agent', 'Agent speaking...');
                        const base64Pcm24k = msg.serverContent.modelTurn.parts[0].inlineData.data;
                        const pcm24k = new Int16Array(base64ToUint8(base64Pcm24k).buffer);
                        const pcm8k = downsample24kTo8k(pcm24k);
                        const ulaw = encodeUlaw(pcm8k);
                        const payload = uint8ToBase64(ulaw);

                        if (streamSid) {
                            ws.send(JSON.stringify({
                                event: 'media',
                                streamSid: streamSid,
                                media: { payload: payload }
                            }));
                        }
                    }
                    
                    // Tool Execution
                    if (msg.toolCall) {
                        log('system', `Tool call received`);
                        for (const fc of msg.toolCall.functionCalls) {
                            let result = { status: "success" };
                            
                            if (fc.name === 'create_order') {
                                const orderId = "ord_" + Date.now();
                                const newOrder = {
                                    id: orderId,
                                    ...fc.args,
                                    created_at: new Date().toISOString()
                                };
                                saveOrderToFile(newOrder);
                                result = { status: "created", order_id: orderId };
                            } else if (fc.name === 'transfer_to_agent') {
                                log('tool', 'Transfer requested: ' + fc.args.reason);
                            }

                            sessionPromise.then(s => s.sendToolResponse({
                                functionResponses: {
                                    id: fc.id,
                                    name: fc.name,
                                    response: { result }
                                }
                            }));
                        }
                    }

                    if (msg.serverContent?.interrupted) {
                        log('system', "Agent interrupted");
                        if (streamSid) {
                            ws.send(JSON.stringify({ event: 'clear', streamSid }));
                        }
                    }
                },
                onclose: () => {
                    log('system', "Gemini Session Closed");
                    isSessionOpen = false;
                    ws.close();
                },
                onerror: (e) => {
                    log('error', "Gemini Error: " + e.message);
                }
            }
        });

        geminiSession = sessionPromise;

        ws.on('message', (message) => {
            const data = JSON.parse(message);
            
            if (data.event === 'start') {
                streamSid = data.start.streamSid;
                log('system', `Stream started: ${streamSid}`);
            } else if (data.event === 'media') {
                // Visual feedback that audio is coming in (prints dots .....)
                process.stdout.write('.'); 
                
                if (isSessionOpen && geminiSession) {
                    const ulawBytes = base64ToUint8(data.media.payload);
                    const pcm8k = decodeUlaw(ulawBytes);
                    const pcm16k = upsample8kTo16k(pcm8k);
                    const base64Pcm16k = uint8ToBase64(new Uint8Array(pcm16k.buffer));

                    geminiSession.then(s => s.sendRealtimeInput({
                        media: {
                            mimeType: "audio/pcm;rate=16000",
                            data: base64Pcm16k
                        }
                    }));
                }
            } else if (data.event === 'stop') {
                log('system', 'Stream stopped');
                geminiSession.then(s => s.close());
            }
        });

    } catch (err) {
        log('error', "Connection failed: " + err.message);
        ws.close();
    }
});

server.listen(PORT, () => {
    console.log(`${LOG_COLORS.green}BakeCall Backend listening on port ${PORT}${LOG_COLORS.reset}`);
});