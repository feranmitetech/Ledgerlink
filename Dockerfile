FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY index.html server.js README.md ./

RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=8787

EXPOSE 8787

CMD ["node", "server.js"]
