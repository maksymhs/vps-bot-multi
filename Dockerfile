FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (production only)
RUN npm install --production

# Copy application code
COPY src/ ./src/
COPY .env .env

# Run the bot
CMD ["node", "src/bot.js"]
