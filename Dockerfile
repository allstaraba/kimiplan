FROM node:22-alpine

WORKDIR /app

# Install build tools for native modules
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm install

COPY . .

# Build client
RUN cd client && npm install && npm run build

EXPOSE 3000

CMD ["node", "server.js"]
