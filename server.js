{
  "name": "bakecall-backend",
  "version": "1.0.0",
  "description": "Twilio + Gemini Live API Backend",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  },
  "dependencies": {
    "@google/genai": "^1.0.0",
    "dotenv": "^16.4.5",
    "express": "^4.21.1",
    "ws": "^8.18.0",
    "cors": "^2.8.5"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
