# OATH IT Service Desk — single-container build.
# No frontend build step: the frontend is a self-contained static
# index.html (no React/Vite), so we just copy it into backend/public.

FROM node:20-slim

WORKDIR /app

# Install backend dependencies
COPY backend/package.json ./
RUN npm install --omit=dev

# Copy backend source
COPY backend/ ./

# Copy the static frontend into backend/public — this is what server.js serves
COPY frontend/public/ ./public/

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
