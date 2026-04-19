FROM node:20-alpine
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy gateway source
COPY src/ ./src/

# Copy the frontend HTML into the public folder that express.static serves
# The frontend/index.html sits at the repo root level, one directory up from gateway/
# Docker build context is ./gateway so we use a build arg to reach ../frontend
# Instead: we copy it during docker-compose via a volume OR we include it here.
# Solution: the Dockerfile copies src/public/ which is where we place index.html.
# See docker-compose.yml — it bind-mounts ./frontend to /app/src/public at runtime.

EXPOSE 4000 4001
CMD ["node", "src/index.js"]