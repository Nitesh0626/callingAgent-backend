require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
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
const API_KEY = process.env.API_KEY; 
const ORDERS_FILE = path.join(__dirname, 'orders.json');

app.use(cors());
app.use(express.json()); // Enable JSON body parsing for status updates

// --- LOGGING ---
const LOG_COLORS = {
    reset: "\x1b[0m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    red: "\x1b[31m"
};

function log(type, message) {
    const timestamp = new Date().toLocaleTimeString();
    let color = LOG_COLORS.reset;
    switch (type) {
        case 'user': color = LOG_COLORS.blue; break;
        case 'agent': color = LOG_COLORS.yellow; break;
        case 'system': color = LOG_COLORS.cyan; break;
        case 'order': color = LOG_COLORS.magenta; break;
        case 'error': color = LOG_COLORS.red; break;
    }
    console.log(`${LOG_COLORS.reset}[${timestamp}] ${color}[${type.toUpperCase()}] ${message}${LOG_COLORS.reset}`);
}

// --- DATA LAYER ---
function getSavedOrders() {
    if (fs.existsSync(ORDERS_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
        } catch (e) { return []; }
    }
    return [];
}

function saveOrderToFile(order) {
    const orders = getSavedOrders();
    orders.unshift(order);
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
    log('order', `New Order #${order.id} saved.`);
}

function updateOrderStatus(orderId, status) {
    const orders = getSavedOrders();
    const index = orders.findIndex(o => o.id === orderId);
    if (index !== -1) {
        orders[index].status = status;
        fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
        log('order', `Order #${orderId} updated to ${status}`);
        return true;
    }
    return false;
}

// --- PROMPT & TOOLS ---
const SYSTEM_INSTRUCTION_TEMPLATE = `
SYSTEM: You are the front-desk voice assistant for 'BakeryGhar'.
VOICE: Female, Indian/Nepali accent. Warm, energetic, and professional.
ROLE: efficient order taker. Do not be chatty. Get the details accurately.

CONTEXT: 
- User Phone Number: {{CALLER_NUMBER}} (Already known, verify only if needed).
- Current Date: ${new Date().toDateString()}

MENU:
- Cakes: Black Forest, Red Velvet, Truffle, Pineapple, White Forest.
- Sizes: 1lb, 2lb, 1kg, 2kg.
- Pastries: Chocolate, Vanilla, Strawberry.

PROCESS:
1. Greet: "Namaste! Welcome to BakeryGhar. How can I help you today?"
2. Order Taking:
   - Ask for **Product** and **Flavor**.
   - Ask for **Weight/Size** (Required for cakes).
   - Ask for **Quantity**.
3. Logistics (Crucial):
   - Ask **When do you need this?** (Date and Time).
   - Ask **Delivery Address**.
   - Ask **Name**.
4. Confirmation:
   - Repeat the order summary: "1kg Black Forest Cake for [Time] at [Address]."
   - Ask "Is this correct?"
5. Closing:
   - If confirmed, save the order.
   - Say "Order placed! We will send an SMS shortly. Thank you!"

RULES:
- Handle dates intelligently.
- If the user speaks Nepali, switch to Nepali immediately.
- If asked for custom designs or prices, transfer to a human agent.
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
                delivery_datetime: { type: "STRING" },
                items: { 
                    type: "ARRAY", 
                    items: { 
                        type: "OBJECT", 
                        properties: { 
                            product: { type: "STRING" },
                            flavor: { type: "STRING" },
                            weight: { type: "STRING" },
                            quantity: { type: "NUMBER" } 
                        } 
                    } 
                }
            },
            required: ["customer_name", "phone_number", "address", "items", "delivery_datetime"]
        }
    }, {
        name: "transfer_to_agent",
        description: "Transfer call",
        parameters: { type: "OBJECT", properties: { reason: { type: "STRING" } } }
    }]
}];

// --- ROUTES ---

app.get('/', (req, res) => res.send('BakeryGhar AI Backend Live'));

app.get('/api/orders', (req, res) => {
    res.json(getSavedOrders());
});

app.post('/api/orders/:id/status', (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    if (updateOrderStatus(id, status)) {
        res.json({ success: true });
    } else {
        res.status(404).json({ error: "Order not found" });
    }
});

// Twilio Webhook
app.post('/incoming', (req, res) => {
    const host = req.headers.host;
    // Extract Caller ID (e.g., +977...)
    const caller = req.body.Caller || "Unknown";
    
    // TwiML Strategy:
    // 1. Say "Namaste..." immediately (0 latency).
    // 2. Connect to Stream.
    // 3. Pass Caller ID in the Stream URL parameters.
    const twiml = `
    <Response>
        <Say voice="alice" language="en-IN">Namaste! Welcome to Bakery Ghar.</Say>
        <Connect>
            <Stream url="wss://${host}/media-stream">
                <Parameter name="caller" value="${caller}" />
            </Stream>
        </Connect>
    </Response>
    `;
    res.type('text/xml');
    res.send(twiml);
});

// --- WEBSOCKET ---

wss.on('connection', async (ws) => {
    log('system', 'Twilio connected');
    
    let streamSid = null;
    let geminiSession = null;
    let isSessionOpen = false;
    let callerId = "Unknown";

    const ai = new GoogleGenAI({ apiKey: API_KEY });

    // Handle initial Twilio messages to get parameters
    ws.on('message', async (message) => {
        const data = JSON.parse(message);
        
        if (data.event === 'start') {
            streamSid = data.start.streamSid;
            // Retrieve Caller ID passed from TwiML
            callerId = data.start.customParameters?.caller || "Unknown";
            log('system', `Call Started from: ${callerId}`);
            
            // Initialize Gemini AFTER we have the Caller ID context
            startGeminiSession();
        } else if (data.event === 'media' && isSessionOpen && geminiSession) {
            // Forward Audio
            const ulawBytes = base64ToUint8(data.media.payload);
            const pcm8k = decodeUlaw(ulawBytes);
            const pcm16k = upsample8kTo16k(pcm8k);
            const base64Pcm16k = uint8ToBase64(new Uint8Array(pcm16k.buffer));

            geminiSession.then(s => s.sendRealtimeInput({
                media: { mimeType: "audio/pcm;rate=16000", data: base64Pcm16k }
            }));
        } else if (data.event === 'stop') {
            log('system', 'Call Ended');
            if (geminiSession) geminiSession.then(s => s.close());
        }
    });

    async function startGeminiSession() {
        // Inject Caller ID into System Prompt
        const dynamicSystemInstruction = SYSTEM_INSTRUCTION_TEMPLATE.replace('{{CALLER_NUMBER}}', callerId);

        const config = {
            responseModalities: ["AUDIO"],
            systemInstruction: dynamicSystemInstruction,
            tools: tools,
            speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
            },
        };

        const sessionPromise = ai.live.connect({
            model: 'gemini-2.5-flash-native-audio-preview-09-2025',
            config,
            callbacks: {
                onopen: () => {
                    log('system', "Gemini Connected");
                    isSessionOpen = true;
                    // Send a silent signal or short prompt to wake the model, 
                    // but rely on TwiML for the main greeting to avoid "double speak"
                    // Or, ask Gemini to wait for user input.
                },
                onmessage: async (msg) => {
                    // Audio Output
                    if (msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data) {
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
                        for (const fc of msg.toolCall.functionCalls) {
                            let result = { status: "success" };
                            if (fc.name === 'create_order') {
                                const orderId = "ord_" + Date.now();
                                const newOrder = {
                                    id: orderId,
                                    ...fc.args,
                                    created_at: new Date().toISOString(),
                                    status: 'created'
                                };
                                saveOrderToFile(newOrder);
                                result = { status: "created", order_id: orderId };
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
                    
                    // Interruption
                    if (msg.serverContent?.interrupted) {
                        log('system', "Interrupted");
                        if (streamSid) ws.send(JSON.stringify({ event: 'clear', streamSid }));
                    }
                },
                onclose: () => {
                    isSessionOpen = false;
                },
                onerror: (e) => log('error', e.message)
            }
        });
        geminiSession = sessionPromise;
    }
});

server.listen(PORT, () => {
    console.log(`${LOG_COLORS.green}BakeryGhar AI Backend Ready on ${PORT}${LOG_COLORS.reset}`);
});
