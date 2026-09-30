FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --include=dev
COPY . .
RUN npm run build
ENV NODE_ENV=production
EXPOSE 3000 3001
CMD ["sh", "-c", "node scripts/init-db.mjs && npm start"]
