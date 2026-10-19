FROM node:24-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8790 DB_PATH=/app/data/minichat.db
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY bin ./bin
COPY prompts ./prompts
EXPOSE 8790
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
