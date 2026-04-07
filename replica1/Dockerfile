FROM node:24-alpine
WORKDIR /app
COPY package.json .
RUN npm install
CMD ["npx", "nodemon", "--legacy-watch", "index.js"]