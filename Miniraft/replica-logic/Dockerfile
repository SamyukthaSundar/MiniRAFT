FROM node:20-alpine

WORKDIR /app

# Install dependencies first (cached layer — only re-runs when package.json changes)
COPY package*.json ./
RUN npm install

# In dev, source is bind-mounted from the host — nodemon handles hot-reload.
# CMD below is the dev default; production can override with "node src/index.js".
EXPOSE 3000

CMD ["npx", "nodemon", "--watch", "src", "src/index.js"]
