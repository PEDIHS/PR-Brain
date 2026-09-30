FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build
EXPOSE 3000 3001
CMD ["sh", "-c", "node scripts/init-db.mjs && npm start"]
